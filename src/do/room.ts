import { DurableObject } from "cloudflare:workers";
import { parseAddress } from "../lib/transit/addr";
import { renderEnvelope } from "../lib/transit/envelope";
import { txId } from "../lib/transit/ids";


const MAX_ROOM_MEMBERS = 64;
const MAX_MESSAGE_BYTES = 64 * 1024;
const ROOM_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const textEncoder = new TextEncoder();

export type RoomPolicy = "open" | "invite";

export type RoomMember = {
  address: string;
  joinedAt: number;
  lastAckedSeq: number;
};

export type RoomEntry = {
  id: string;
  seq: number;
  from: string;
  body: string;
  replyTo?: string;
  createdAt: number;
};

export type RoomDetail = {
  org: string;
  name: string;
  policy: RoomPolicy;
  sequence: number;
  members: RoomMember[];
  messages: RoomEntry[];
};

type RoomConfig = {
  org: string;
  name: string;
  policy: RoomPolicy;
  createdAt: number;
};

export type RoomChannelDelivery = {
  deliveryId: string;
  org: string;
  envelope: string;
  redelivery?: boolean;
};

type RoomViewerAttachment = {
  role: "viewer";
  org: string;
};

export class Room extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (
      request.headers.get("x-transit-role") !== "viewer" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Not found", { status: 404 });
    }
    const org = request.headers.get("x-transit-org") ?? "";
    const config = await this.config();
    if (!config || !org || config.org !== org) {
      return new Response("Not found", { status: 404 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["viewer"]);
    server.serializeAttachment({ role: "viewer", org } satisfies RoomViewerAttachment);
    server.send(JSON.stringify({ type: "snapshot", at: Date.now(), room: await this.detail() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async configure(config: RoomConfig): Promise<void> {
    const existing = await this.config();
    if (existing && (existing.org !== config.org || existing.name !== config.name)) {
      throw new Error("room identity cannot change");
    }
    await this.ctx.storage.put("config", config);
  }

  async status(): Promise<{ sequence: number; members: number }> {
    const sequence = (await this.ctx.storage.get<number>("sequence")) ?? 0;
    const members = await this.ctx.storage.list({ prefix: "member:" });
    return { sequence, members: members.size };
  }

  async detail(limit = 200): Promise<RoomDetail> {
    const config = await this.requireConfig();
    const members = await this.ctx.storage.list<RoomMember>({ prefix: "member:" });
    const messages = await this.ctx.storage.list<RoomEntry>({
      prefix: "message:",
      reverse: true,
      limit: Math.min(500, Math.max(1, limit)),
    });
    return {
      org: config.org,
      name: config.name,
      policy: config.policy,
      sequence: (await this.ctx.storage.get<number>("sequence")) ?? 0,
      members: [...members.values()].sort((left, right) =>
        left.address.localeCompare(right.address),
      ),
      messages: [...messages.values()].sort((left, right) => left.seq - right.seq),
    };
  }

  async hasMember(address: string): Promise<boolean> {
    return (await this.ctx.storage.get<RoomMember>(`member:${address}`)) !== undefined;
  }

  async join(
    address: string,
    source: "agent" | "creator" | "operator",
  ): Promise<{ joined: boolean; error?: "invite_only" | "room_full" }> {
    const config = await this.requireConfig();
    const parsed = parseAddress(address);
    if (parsed.kind !== "agent") throw new Error("room members must be agents");
    if (config.policy === "invite" && source === "agent") {
      return { joined: false, error: "invite_only" };
    }
    if (await this.hasMember(parsed.address)) return { joined: false };

    const members = await this.ctx.storage.list({ prefix: "member:" });
    if (members.size >= MAX_ROOM_MEMBERS) return { joined: false, error: "room_full" };
    const member: RoomMember = {
      address: parsed.address,
      joinedAt: Date.now(),
      lastAckedSeq: 0,
    };
    await this.ctx.storage.put(`member:${parsed.address}`, member);
    this.background(
      "room_member_write_failed",
      this.env.DB.prepare(
        `INSERT INTO room_member (org_id, room, address, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id, room, address) DO NOTHING`,
      )
        .bind(config.org, config.name, parsed.address, member.joinedAt)
        .run(),
    );
    this.broadcast({ type: "member_joined", at: Date.now(), member });
    return { joined: true };
  }

  async leave(address: string): Promise<{ left: boolean }> {
    const config = await this.requireConfig();
    const left = await this.ctx.storage.delete(`member:${address}`);
    if (!left) return { left: false };
    this.background(
      "room_member_delete_failed",
      this.env.DB.prepare(
        "DELETE FROM room_member WHERE org_id = ? AND room = ? AND address = ?",
      )
        .bind(config.org, config.name, address)
        .run(),
    );
    this.broadcast({ type: "member_left", at: Date.now(), address });
    return { left: true };
  }

  async canPost(): Promise<boolean> {
    const config = await this.requireConfig();
    return this.canAcceptMessage(config.org);
  }

  async post(
    from: string,
    body: string,
    replyTo?: string,
    messageId?: string,
  ): Promise<RoomEntry> {
    const config = await this.requireConfig();
    if (textEncoder.encode(body).byteLength > MAX_MESSAGE_BYTES) {
      throw new Error("body_too_large");
    }
    if (from !== "operator@transit" && !(await this.hasMember(from))) {
      throw new Error("not_member");
    }
    if (messageId) {
      const existingSequence = await this.ctx.storage.get<number>(`message_id:${messageId}`);
      if (existingSequence !== undefined) {
        const existing = await this.ctx.storage.get<RoomEntry>(
          `message:${String(existingSequence).padStart(16, "0")}`,
        );
        if (existing) return existing;
      }
    }
    if (!(await this.canAcceptMessage(config.org))) throw new Error("plan_limit");

    const committed = await this.ctx.storage.transaction(async (transaction) => {
      const id = messageId ?? txId();
      const existingSequence = await transaction.get<number>(`message_id:${id}`);
      if (existingSequence !== undefined) {
        const existing = await transaction.get<RoomEntry>(
          `message:${String(existingSequence).padStart(16, "0")}`,
        );
        if (existing) return { entry: existing, duplicate: true };
      }

      const sequence = ((await transaction.get<number>("sequence")) ?? 0) + 1;
      const entry: RoomEntry = {
        id,
        seq: sequence,
        from,
        body,
        ...(replyTo ? { replyTo } : {}),
        createdAt: Date.now(),
      };
      await transaction.put("sequence", sequence);
      await transaction.put(`message:${String(sequence).padStart(16, "0")}`, entry);
      await transaction.put(`message_id:${id}`, sequence);
      return { entry, duplicate: false };
    });
    const entry = committed.entry;
    if (committed.duplicate) return entry;

    const members = await this.ctx.storage.list<RoomMember>({ prefix: "member:" });
    const targets = [...members.values()].filter((member) => member.address !== from);
    const deliveries = await Promise.allSettled(
      targets.map(async (member) => {
        const target = parseAddress(member.address);
        if (target.kind !== "agent") throw new Error("invalid member address");
        const hub = this.env.HOST_HUB.getByName(
          `org:${config.org}:host:${target.host}`,
        );
        const result = await hub.queueDelivery({
          messageId: entry.id,
          org: config.org,
          agent: target.name,
          targetAddr: target.address,
          envelope: renderEnvelope({
            from,
            id: entry.id,
            ts: new Date(entry.createdAt).toISOString(),
            kind: "room",
            room: config.name,
            seq: entry.seq,
            body,
            replyTo,
            replyTarget: from === "operator@transit" ? `#${config.name}` : undefined,
          }),
          roomName: config.name,
          roomSeq: entry.seq,
        });
        if (result.status === "no_route") throw new Error("no_route");
        return member.address;
      }),
    );

    this.mirrorEntry(config, entry, targets, deliveries);

    this.broadcast({ type: "message", at: Date.now(), message: entry });
    this.ctx.waitUntil(this.pruneLedger());
    return entry;
  }
  async queueChannelDelivery(
    input: RoomChannelDelivery,
  ): Promise<{ queued: number }> {
    const config = await this.requireConfig();
    if (input.org !== config.org) throw new Error("room organization mismatch");
    const members = await this.ctx.storage.list<RoomMember>({ prefix: "member:" });
    const results = await Promise.all(
      [...members.values()].map(async (member) => {
        const target = parseAddress(member.address);
        if (target.kind !== "agent") return false;
        const queued = await this.env.HOST_HUB.getByName(
          `org:${config.org}:host:${target.host}`,
        ).queueDelivery({
          messageId: input.deliveryId,
          org: config.org,
          agent: target.name,
          targetAddr: target.address,
          envelope: input.envelope,
          redelivery: input.redelivery,
        });
        return queued.status !== "no_route";
      }),
    );
    return { queued: results.filter(Boolean).length };
  }

  async acknowledge(address: string, sequence: number): Promise<void> {
    const key = `member:${address}`;
    const member = await this.ctx.storage.get<RoomMember>(key);
    if (!member || sequence <= member.lastAckedSeq) return;
    member.lastAckedSeq = sequence;
    await this.ctx.storage.put(key, member);
    this.broadcast({ type: "member_ack", at: Date.now(), address, sequence });
  }

  async cancelChannelDelivery(deliveryId: string): Promise<void> {
    const config = await this.requireConfig();
    const members = await this.ctx.storage.list<RoomMember>({ prefix: "member:" });
    await Promise.allSettled(
      [...members.values()].map(async (member) => {
        const target = parseAddress(member.address);
        if (target.kind !== "agent") return;
        await this.env.HOST_HUB.getByName(
          `org:${config.org}:host:${target.host}`,
        ).cancelDelivery(deliveryId);
      }),
    );
  }

  async destroy(): Promise<void> {
    const config = await this.requireConfig();
    await this.ctx.storage.deleteAll();
    this.background(
      "room_delete_failed",
      this.env.DB.batch([
        this.env.DB.prepare("DELETE FROM room_member WHERE org_id = ? AND room = ?").bind(
          config.org,
          config.name,
        ),
        this.env.DB.prepare("DELETE FROM room WHERE org_id = ? AND name = ?").bind(
          config.org,
          config.name,
        ),
      ]),
    );
    for (const viewer of this.ctx.getWebSockets("viewer")) {
      viewer.close(4004, "room deleted");
    }
  }

  /**
   * Metering seam. This distribution accepts every post; a deployment that
   * meters volume subclasses `Room` and overrides this together with
   * {@link meterMessages}. `post()` throws `plan_limit` when it returns false,
   * and `canPost()` lets a caller check before composing.
   */
  protected async canAcceptMessage(_org: string): Promise<boolean> {
    return true;
  }

  private async config(): Promise<RoomConfig | null> {
    return (await this.ctx.storage.get<RoomConfig>("config")) ?? null;
  }

  private async requireConfig(): Promise<RoomConfig> {
    const config = await this.config();
    if (!config) throw new Error("room_not_configured");
    return config;
  }

  /**
   * Metering seam — mirrors `HostHub.meterMessages`. Returning a statement
   * appends it to the archive batch directly after the message insert, whose
   * `changes()` it keys off so a replayed post does not count twice.
   */
  protected meterMessages(_org: string, _count: number): D1PreparedStatement | null {
    return null;
  }

  private mirrorEntry(
    config: RoomConfig,
    entry: RoomEntry,
    targets: RoomMember[],
    deliveries: PromiseSettledResult<string>[],
  ): void {
    const meter = this.meterMessages(config.org, 1);
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO message
         (id, org_id, kind, from_addr, to_addr, room_seq, body, reply_to, created_at)
         VALUES (?, ?, 'room', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        entry.id,
        config.org,
        entry.from,
        `#${config.name}`,
        entry.seq,
        entry.body,
        entry.replyTo ?? null,
        entry.createdAt,
      ),
    ];
    if (meter) statements.push(meter);
    for (const [index, target] of targets.entries()) {
      const outcome = deliveries[index];
      const failed = outcome?.status === "rejected";
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO message_delivery
           (message_id, target_addr, status, attempts, last_error, updated_at)
           VALUES (?, ?, ?, 0, ?, ?)
           ON CONFLICT(message_id, target_addr) DO NOTHING`,
        ).bind(
          entry.id,
          target.address,
          failed ? "dead" : "queued",
          failed ? String(outcome.reason) : null,
          Date.now(),
        ),
      );
    }
    this.background("room_message_write_failed", this.env.DB.batch(statements));
  }

  private async pruneLedger(): Promise<void> {
    const cutoff = Date.now() - ROOM_RETENTION_MS;
    const messages = await this.ctx.storage.list<RoomEntry>({
      prefix: "message:",
      limit: 256,
    });
    const expired = [...messages]
      .filter(([, message]) => message.createdAt < cutoff)
      .flatMap(([key, message]) => [key, `message_id:${message.id}`]);
    if (expired.length > 0) await this.ctx.storage.delete(expired);
  }

  private broadcast(event: Record<string, unknown>): void {
    const payload = JSON.stringify(event);
    for (const viewer of this.ctx.getWebSockets("viewer")) {
      if (viewer.readyState === 1) viewer.send(payload);
    }
  }

  /** Fire-and-forget with a logged failure. `protected` so a subclass that
   * overrides the metering seam can report its own background work the same way. */
  protected background(event: string, promise: Promise<unknown>): void {
    this.ctx.waitUntil(
      promise.catch((error) => {
        console.error(
          JSON.stringify({
            event,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
    );
  }
}
