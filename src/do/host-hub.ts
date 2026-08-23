import { DurableObject } from "cloudflare:workers";
import { type ChannelEnvelope, renderEnvelope, renderFull } from "../lib/transit/envelope";
import { createRoom } from "../lib/transit/rooms";


import {
  AddressError,
  formatAgentAddress,
  formatRoomAddress,
  parseAddress,
  parseRoomTarget,
} from "../lib/transit/addr";
import {
  type AlarmBudgetStatus,
  alarmBudgetStatus,
  budgetedAlarm,
} from "../lib/transit/alarm-budget";
import {
  type DaemonFrame,
  type RosterAgent,
  type SendNakCode,
  WireError,
  decodeDaemonFrame,
} from "../lib/transit/wire";
import {
  type TokenBucketState,
  consumeStoredToken,
  consumeToken,
} from "../lib/transit/token-bucket";
import {
  organizationConnectionIsActive,
  resolveConnectedOrganization,
} from "../lib/transit/organizations";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_DELIVERY_ATTEMPTS = 40;
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_RETRY_MS = 5 * 60 * 1_000;
const DRAFT_HOLD_BACKSTOP_MS = 5 * 60 * 1_000;
const QUEUE_BATCH_SIZE = 128;
const textEncoder = new TextEncoder();

export type HostIdentity = {
  hostId: string;
  org: string;
  slug: string;
};
export type HostHubStatus = {
  connected: boolean;
  agents: RosterAgent[];
  queueDepth: number;
  budgetExhausted: AlarmBudgetStatus | null;
};

type DaemonAttachment = HostIdentity & {
  role: "daemon";
  ready: boolean;
  frameRate: TokenBucketState;
};

type ViewerAttachment = {
  role: "viewer";
  org: string;
  scope: string;
};

type SocketAttachment = DaemonAttachment | ViewerAttachment;

export type QueueDeliveryInput = {
  messageId: string;
  org: string;
  agent: string;
  targetAddr: string;
  envelope: string;
  // Channel envelopes carry a `redelivery` counter that is only true for the
  // send it was rendered for. Carrying the inputs lets a retry re-render with
  // the real count instead of re-sending bytes that claim to be a first
  // sighting. Absent for DMs and room posts, which have no such counter.
  render?: ChannelEnvelope;
  enqueuedAt?: number;
  roomName?: string;
  roomSeq?: number;
  redelivery?: boolean;
  connectionId?: string;
};

type QueuedDelivery = {
  messageId: string;
  org: string;
  agent: string;
  targetAddr: string;
  envelope: string;
  render?: ChannelEnvelope;
  attempts: number;
  enqueuedAt: number;
  roomName?: string;
  roomSeq?: number;
  lastAttemptAt?: number;
  lastError?: string;
  connectionId?: string;
};

type DeliveryMarker = {
  status: "queued" | "injected" | "dead";
  updatedAt: number;
  queueKey?: string;
  item?: QueuedDelivery;
};

type SendState = {
  status: "processing" | "ack" | "nak";
  code?: SendNakCode;
};

type ActivityEvent = {
  type: string;
  at: number;
  [key: string]: unknown;
};

export class HostHub extends DurableObject<Env> {

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The daemon emits a pong heartbeat every 30 seconds. Auto-responding with
    // ping keeps the settled wire directions while allowing this object to
    // hibernate; no alarm is consumed for connection liveness.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"pong"}', '{"t":"ping"}'),
    );
  }
  override async fetch(request: Request): Promise<Response> {
    const role = request.headers.get("x-transit-role");
    if (role === "daemon") {
      return this.acceptDaemon(request, {
        hostId: request.headers.get("x-transit-host-id") ?? "",
        org: request.headers.get("x-transit-org") ?? "",
        slug: request.headers.get("x-transit-slug") ?? "",
      });
    }
    if (role === "viewer") {
      return this.acceptViewer(
        request,
        request.headers.get("x-transit-org") ?? "",
        request.headers.get("x-transit-scope") ?? "",
      );
    }
    return new Response("Not found", { status: 404 });
  }

  private async acceptDaemon(request: Request, identity: HostIdentity): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    if (!identity.org || !identity.hostId || !identity.slug) {
      return new Response("Invalid host identity", { status: 400 });
    }

    for (const existing of this.ctx.getWebSockets("daemon")) {
      existing.close(4000, "replaced by a new daemon connection");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["daemon"]);
    server.serializeAttachment({
      role: "daemon",
      ready: false,
      frameRate: { tokens: 100, updatedAt: Date.now() },
      ...identity,
    } satisfies DaemonAttachment);
    await this.broadcast({ type: "host_connected", at: Date.now(), host: identity.slug }, identity.org);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptViewer(request: Request, org: string, scope: string): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    if (!org || !scope) return new Response("Invalid viewer identity", { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["viewer"]);
    server.serializeAttachment({ role: "viewer", org, scope } satisfies ViewerAttachment);
    server.send(JSON.stringify({ type: "snapshot", at: Date.now(), ...(await this.status()) }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async publishViewerEvent(payload: string): Promise<void> {
    for (const viewer of this.ctx.getWebSockets("viewer")) {
      if (viewer.readyState === 1) viewer.send(payload);
    }
  }

  async hasAgent(name: string): Promise<boolean> {
    return (await this.ctx.storage.get<RosterAgent>(`roster:${name}`)) !== undefined;
  }

  async queueDelivery(input: QueueDeliveryInput): Promise<{ status: "queued" | "duplicate" | "no_route" }> {
    if (!(await this.hasAgent(input.agent))) return { status: "no_route" };

    const result = await this.ctx.storage.transaction(async (transaction) => {
      // The dedupe marker is per recipient: one message id may legitimately be
      // queued to several agents on this host (room fan-out), and each of
      // those entries settles independently.
      const markerKey = `d:${input.messageId}:${input.agent}`;
      const marker = await transaction.get<DeliveryMarker>(markerKey);
      if (marker && (!input.redelivery || marker.status === "queued")) {
        return { status: "duplicate" as const };
      }

      const sequence = ((await transaction.get<number>("queue:sequence")) ?? 0) + 1;
      const queueKey = `q:${input.agent}:${String(sequence).padStart(16, "0")}`;
      const item: QueuedDelivery = {
        messageId: input.messageId,
        org: input.org,
        agent: input.agent,
        targetAddr: input.targetAddr,
        envelope: input.envelope,
        ...(input.render ? { render: input.render } : {}),
        attempts: 0,
        enqueuedAt: input.enqueuedAt ?? Date.now(),
        ...(input.roomName ? { roomName: input.roomName } : {}),
        ...(input.roomSeq === undefined ? {} : { roomSeq: input.roomSeq }),
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      };
      await transaction.put({
        "queue:sequence": sequence,
        [queueKey]: item,
        [markerKey]: {
          status: "queued",
          updatedAt: Date.now(),
          queueKey,
        } satisfies DeliveryMarker,
      });
      return { status: "queued" as const };
    });

    if (result.status === "queued") {
      await this.broadcast(
        {
          type: "delivery_queued",
          at: Date.now(),
          id: input.messageId,
          target: input.targetAddr,
        },
        input.org,
      );
      await this.dispatchQueued();
    }
    return result;
  }

  async requeue(messageId: string): Promise<boolean> {
    const requeued = await this.ctx.storage.transaction(async (transaction) => {
      const dead = await this.findDeadMarker(transaction, messageId);
      if (!dead) return false;
      const { key: markerKey, marker } = dead;
      if (!marker.item || !marker.queueKey) return false;
      const item: QueuedDelivery = {
        ...marker.item,
        attempts: 0,
        enqueuedAt: Date.now(),
        lastAttemptAt: undefined,
        lastError: undefined,
      };
      await transaction.put(marker.queueKey, item);
      await transaction.put<DeliveryMarker>(markerKey, {
        status: "queued",
        updatedAt: Date.now(),
        queueKey: marker.queueKey,
      });
      return true;
    });
    if (requeued) await this.dispatchQueued();
    return requeued;
  }

  /**
   * Drops every queued entry for a message id on this host and marks its
   * markers injected. Settlement paths that complete upstream of the daemon
   * ack (chat_reply, mark_handled) call this so a settled delivery is never
   * dispatched again, even while its last dispatch is still unacked.
   */
  async cancelDelivery(messageId: string): Promise<number> {
    let cancelled = 0;
    for (const [key, marker] of await this.ctx.storage.list<DeliveryMarker>({
      prefix: `d:${messageId}`,
    })) {
      if (key !== `d:${messageId}` && !key.startsWith(`d:${messageId}:`)) continue;
      if (marker.status !== "queued") continue;
      await this.ctx.storage.transaction(async (transaction) => {
        if (marker.queueKey) await transaction.delete(marker.queueKey);
        await transaction.put<DeliveryMarker>(key, {
          status: "injected",
          updatedAt: Date.now(),
        });
      });
      cancelled += 1;
    }
    return cancelled;
  }

  async revoke(org?: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets("daemon")) {
      socket.close(4001, "host revoked");
    }
    await this.broadcast({ type: "host_revoked", at: Date.now() }, org);
  }

  async status(): Promise<HostHubStatus> {
    const roster = await this.ctx.storage.list<RosterAgent>({ prefix: "roster:" });
    const queued = await this.ctx.storage.list<QueuedDelivery>({ prefix: "q:" });
    return {
      connected: this.daemonSocket() !== null,
      agents: [...roster.values()],
      queueDepth: queued.size,
      budgetExhausted: await alarmBudgetStatus(this.ctx.storage),
    };
  }

  override async alarm(): Promise<void> {
    await this.dispatchQueued();
  }

  override async webSocketMessage(socket: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    const attachment = this.socketAttachment(socket);
    if (attachment?.role !== "daemon") return;
    if (typeof raw !== "string") {
      socket.close(1003, "text frames required");
      return;
    }
    const frameRate = attachment.frameRate ?? {
      tokens: 100,
      updatedAt: Date.now(),
    };
    const frameAllowed = consumeToken(frameRate, 50, 100);
    attachment.frameRate = frameRate;
    socket.serializeAttachment(attachment);
    if (!frameAllowed) {
      socket.close(4008, "rate_limited");
      return;
    }

    this.touchLastSeen(attachment);
    let frame: DaemonFrame | null;
    try {
      frame = decodeDaemonFrame(raw);
    } catch (error) {
      if (error instanceof WireError) {
        socket.close(error.code === "frame_too_large" ? 1009 : 4002, error.code);
        return;
      }
      throw error;
    }
    if (!frame) return;

    if (frame.t === "hello") {
      await this.handleHello(socket, attachment, frame);
      return;
    }
    if (!attachment.ready) {
      this.sendFrame(socket, { t: "hello_err", code: "hello_required" });
      socket.close(4002, "hello required");
      return;
    }

    switch (frame.t) {
      case "roster":
        await this.applyRoster(attachment, frame.agents);
        break;
      case "send":
        await this.handleSend(socket, attachment, frame);
        break;
      case "deliver_ack":
        await this.handleDeliveryAck(frame.id, frame.agent, frame.via);
        break;
      case "deliver_nak":
        await this.handleDeliveryNak(frame.id, frame.code, frame.retryable, frame.agent);
        break;
      case "rpc":
        await this.handleRpc(socket, attachment, frame.rid, frame.method, frame.params);
        break;
      case "pong":
        break;
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const attachment = this.socketAttachment(socket);
    if (attachment?.role === "daemon") {
      await this.broadcast(
        { type: "host_disconnected", at: Date.now(), host: attachment.slug },
        attachment.org,
      );
    }
  }

  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    const attachment = this.socketAttachment(socket);
    console.error(
      JSON.stringify({
        event: "host_hub_websocket_error",
        host: attachment?.role === "daemon" ? attachment.slug : undefined,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  private socketAttachment(socket: WebSocket): SocketAttachment | null {
    const value: unknown = socket.deserializeAttachment();
    if (!value || typeof value !== "object" || !("role" in value)) return null;
    if (value.role === "daemon" || value.role === "viewer") {
      return value as SocketAttachment;
    }
    return null;
  }

  private daemonSocket(): WebSocket | null {
    return this.ctx.getWebSockets("daemon").find((socket) => socket.readyState === 1) ?? null;
  }

  private sendFrame(socket: WebSocket, frame: object): void {
    socket.send(JSON.stringify(frame));
  }

  private async broadcast(event: ActivityEvent, org?: string): Promise<void> {
    const payload = JSON.stringify(event);
    for (const viewer of this.ctx.getWebSockets("viewer")) {
      if (viewer.readyState === 1) viewer.send(payload);
    }
    if (!org) return;
    try {
      await this.env.HOST_HUB.getByName(
        `org:${org}:host:transit`,
      ).publishViewerEvent(payload);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "fleet_viewer_publish_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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

  private touchLastSeen(identity: HostIdentity): void {
    this.background(
      "host_last_seen_write_failed",
      this.env.DB.prepare("UPDATE host SET last_seen_at = ? WHERE id = ? AND org_id = ?")
        .bind(Date.now(), identity.hostId, identity.org)
        .run(),
    );
  }

  private async handleHello(
    socket: WebSocket,
    attachment: DaemonAttachment,
    frame: Extract<DaemonFrame, { t: "hello" }>,
  ): Promise<void> {
    if (frame.host !== attachment.slug) {
      this.sendFrame(socket, { t: "hello_err", code: "host_mismatch" });
      socket.close(4003, "host mismatch");
      return;
    }
    attachment.ready = true;
    socket.serializeAttachment(attachment);
    this.sendFrame(socket, {
      t: "hello_ok",
      host_id: attachment.hostId,
      org: attachment.org,
    });
    this.background(
      "host_hello_write_failed",
      this.env.DB.prepare(
        "UPDATE host SET daemon_ver = ?, last_seen_at = ? WHERE id = ? AND org_id = ?",
      )
        .bind(frame.daemon_ver, Date.now(), attachment.hostId, attachment.org)
        .run(),
    );
    await this.dispatchQueued();
  }

  private async applyRoster(identity: HostIdentity, agents: RosterAgent[]): Promise<void> {
    const previous = await this.ctx.storage.list<RosterAgent>({ prefix: "roster:" });
    const currentByPane = new Map(agents.map((agent) => [agent.pane_id, agent]));
    const renames = new Map<string, string>();
    for (const [key, oldAgent] of previous) {
      const current = currentByPane.get(oldAgent.pane_id);
      if (current && current.name !== oldAgent.name) renames.set(oldAgent.name, current.name);
      await this.ctx.storage.delete(key);
    }
    if (agents.length > 0) {
      await this.ctx.storage.put(
        Object.fromEntries(agents.map((agent) => [`roster:${agent.name}`, agent])),
      );
    }

    if (renames.size > 0) {
      const queue = await this.ctx.storage.list<QueuedDelivery>({ prefix: "q:" });
      for (const [key, item] of queue) {
        const renamed = renames.get(item.agent);
        if (!renamed) continue;
        const newKey = key.replace(`q:${item.agent}:`, `q:${renamed}:`);
        const renamedItem = {
          ...item,
          agent: renamed,
          targetAddr: `${renamed}@${identity.slug}`,
        };
        await this.ctx.storage.transaction(async (transaction) => {
          await transaction.delete(key);
          await transaction.put(newKey, renamedItem);
          await transaction.delete(`d:${item.messageId}:${item.agent}`);
          await transaction.put<DeliveryMarker>(`d:${item.messageId}:${renamed}`, {
            status: "queued",
            updatedAt: Date.now(),
            queueKey: newKey,
          });
        });
        this.background(
          "delivery_rename_write_failed",
          this.env.DB.prepare(
            "UPDATE message_delivery SET target_addr = ?, updated_at = ? WHERE message_id = ? AND target_addr = ?",
          )
            .bind(renamedItem.targetAddr, Date.now(), item.messageId, item.targetAddr)
            .run(),
        );
      }
    }

    const statements = [
      this.env.DB.prepare("DELETE FROM agent_snapshot WHERE host_id = ?").bind(identity.hostId),
      ...agents.map((agent) =>
        this.env.DB.prepare(
          `INSERT INTO agent_snapshot
           (host_id, name, kind, pane_id, status, named_by, title, cwd, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          identity.hostId,
          agent.name,
          agent.kind,
          agent.pane_id,
          agent.status,
          agent.named_by,
          agent.title,
          agent.cwd,
          Date.now(),
        ),
      ),
    ];
    this.background("roster_write_failed", this.env.DB.batch(statements));
    await this.broadcast(
      { type: "roster_changed", at: Date.now(), host: identity.slug, agents },
      identity.org,
    );
    await this.dispatchQueued();
  }

  /**
   * Metering seam. This distribution accepts every message; a deployment that
   * meters volume subclasses `HostHub` and overrides these three together —
   * `canAcceptMessage` reads the meter, `recordAcceptedMessage` keeps a
   * per-object cache warm across the commit, and `meterMessages` contributes a
   * statement to the archive batch in `mirrorMessage`.
   */
  protected async canAcceptMessage(_org: string): Promise<boolean> {
    return true;
  }

  protected recordAcceptedMessage(): void {}

  protected meterMessages(_org: string, _count: number): D1PreparedStatement | null {
    return null;
  }

  private async handleSend(
    socket: WebSocket,
    identity: HostIdentity,
    frame: Extract<DaemonFrame, { t: "send" }>,
  ): Promise<void> {
    const stateKey = `s:${frame.id}`;
    const prior = await this.ctx.storage.get<SendState>(stateKey);
    if (prior?.status === "ack") {
      this.sendFrame(socket, { t: "send_ack", id: frame.id });
      return;
    }
    if (prior?.status === "nak" && prior.code) {
      this.sendFrame(socket, { t: "send_nak", id: frame.id, code: prior.code });
      return;
    }
    await this.ctx.storage.put<SendState>(stateKey, { status: "processing" });

    let from;
    let target;
    try {
      from = parseAddress(frame.from);
      target = parseAddress(frame.to);
    } catch (error) {
      const code: SendNakCode =
        error instanceof AddressError && error.code === "reserved_name"
          ? "reserved_name"
          : "no_route";
      await this.rejectSend(socket, stateKey, frame.id, code);
      return;
    }

    if (
      from.kind !== "agent" ||
      from.organization !== undefined ||
      from.host !== identity.slug ||
      !(await this.hasAgent(from.name))
    ) {
      await this.rejectSend(socket, stateKey, frame.id, "no_route");
      return;
    }
    if (
      !(await consumeStoredToken(
        this.ctx.storage,
        `rate:send:${from.name}`,
        10,
        10,
      ))
    ) {
      await this.rejectSend(socket, stateKey, frame.id, "rate_limited");
      return;
    }
    if (textEncoder.encode(frame.body).byteLength > MAX_MESSAGE_BYTES) {
      await this.rejectSend(socket, stateKey, frame.id, "body_too_large");
      return;
    }
    if (!(await this.canAcceptMessage(identity.org))) {
      await this.rejectSend(socket, stateKey, frame.id, "plan_limit");
      return;
    }
    if (target.kind === "room") {
      let roomOrg = identity.org;
      let memberAddress = from.address;
      if (target.organization) {
        const connected = await resolveConnectedOrganization(
          this.env.DB,
          identity.org,
          target.organization,
        );
        if (!connected) {
          await this.rejectSend(socket, stateKey, frame.id, "no_route");
          return;
        }
        roomOrg = connected.targetOrgId;
        memberAddress = formatAgentAddress(
          from.name,
          from.host,
          connected.sourceSlug,
        );
      }
      const roomExists = await this.env.DB.prepare(
        "SELECT 1 AS present FROM room WHERE org_id = ? AND name = ? LIMIT 1",
      )
        .bind(roomOrg, target.room)
        .first<{ present: number }>();
      const room = this.env.ROOM.getByName(
        `org:${roomOrg}:room:${target.room}`,
      );
      if (!roomExists || !(await room.hasMember(memberAddress))) {
        await this.rejectSend(socket, stateKey, frame.id, "not_member");
        return;
      }
      try {
        await room.post(memberAddress, frame.body, frame.reply_to, frame.id);
      } catch (error) {
        const code: SendNakCode =
          error instanceof Error && error.message === "body_too_large"
            ? "body_too_large"
            : error instanceof Error && error.message === "plan_limit"
              ? "plan_limit"
              : "not_member";
        await this.rejectSend(socket, stateKey, frame.id, code);
        return;
      }
      this.recordAcceptedMessage();
      await this.ctx.storage.put<SendState>(stateKey, { status: "ack" });
      this.sendFrame(socket, { t: "send_ack", id: frame.id });
      await this.broadcast(
        {
          type: "message_committed",
          at: Date.now(),
          id: frame.id,
          from: frame.from,
          to: frame.to,
        },
        identity.org,
      );
      return;
    }

    let targetOrg = identity.org;
    let envelopeFrom = from.address;
    let connectionId: string | undefined;
    if (target.organization) {
      const connected = await resolveConnectedOrganization(
        this.env.DB,
        identity.org,
        target.organization,
      );
      if (!connected) {
        await this.rejectSend(socket, stateKey, frame.id, "no_route");
        return;
      }
      targetOrg = connected.targetOrgId;
      connectionId = connected.connectionId;
      envelopeFrom = formatAgentAddress(
        from.name,
        from.host,
        connected.sourceSlug,
      );
    }

    const targetHost = await this.env.DB.prepare(
      "SELECT id FROM host WHERE org_id = ? AND slug = ? AND revoked_at IS NULL LIMIT 1",
    )
      .bind(targetOrg, target.host)
      .first<{ id: string }>();
    if (!targetHost) {
      await this.rejectSend(socket, stateKey, frame.id, "no_route");
      return;
    }

    const targetHub = this.env.HOST_HUB.getByName(
      `org:${targetOrg}:host:${target.host}`,
    );
    if (!(await targetHub.hasAgent(target.name))) {
      await this.rejectSend(socket, stateKey, frame.id, "no_route");
      return;
    }

    const queued = await targetHub.queueDelivery({
      messageId: frame.id,
      org: identity.org,
      agent: target.name,
      targetAddr: target.address,
      envelope: renderEnvelope({
        from: envelopeFrom,
        id: frame.id,
        ts: frame.ts,
        kind: "dm",
        body: frame.body,
        replyTo: frame.reply_to,
      }),
      ...(connectionId ? { connectionId } : {}),
    });
    if (queued.status === "no_route") {
      await this.rejectSend(socket, stateKey, frame.id, "no_route");
      return;
    }

    await this.ctx.storage.put<SendState>(stateKey, { status: "ack" });
    this.sendFrame(socket, { t: "send_ack", id: frame.id });
    this.recordAcceptedMessage();
    this.mirrorMessage(
      identity.org,
      targetOrg === identity.org ? null : targetOrg,
      envelopeFrom,
      frame,
      target.address,
    );
    await this.broadcast(
      {
        type: "message_committed",
        at: Date.now(),
        id: frame.id,
        from: frame.from,
        to: frame.to,
      },
      identity.org,
    );
  }

  private async rejectSend(
    socket: WebSocket,
    stateKey: string,
    id: string,
    code: SendNakCode,
  ): Promise<void> {
    await this.ctx.storage.put<SendState>(stateKey, { status: "nak", code });
    this.sendFrame(socket, { t: "send_nak", id, code });
  }

  private mirrorMessage(
    org: string,
    recipientOrg: string | null,
    fromAddr: string,
    frame: Extract<DaemonFrame, { t: "send" }>,
    targetAddr: string,
  ): void {
    const createdAt = Number.isNaN(Date.parse(frame.ts))
      ? Date.now()
      : Date.parse(frame.ts);
    // The meter statement, when a deployment supplies one, must stay directly
    // after the message insert: it keys off `changes()` so a replayed frame
    // that the `INSERT OR IGNORE` swallowed does not count twice.
    const meter = this.meterMessages(org, 1);
    this.background(
      "message_archive_write_failed",
      this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO message
           (id, org_id, recipient_org_id, kind, from_addr, to_addr,
            room_seq, body, reply_to, created_at)
           VALUES (?, ?, ?, 'dm', ?, ?, NULL, ?, ?, ?)`,
        ).bind(
          frame.id,
          org,
          recipientOrg,
          fromAddr,
          targetAddr,
          frame.body,
          frame.reply_to ?? null,
          createdAt,
        ),
        ...(meter ? [meter] : []),
        this.env.DB.prepare(
          `INSERT INTO message_delivery
           (message_id, target_addr, status, attempts, last_error, updated_at)
           VALUES (?, ?, 'queued', 0, NULL, ?)
           ON CONFLICT(message_id, target_addr) DO NOTHING`,
        ).bind(frame.id, targetAddr, Date.now()),
      ]),
    );
  }

  private async dispatchQueued(): Promise<void> {
    const queue = await this.ctx.storage.list<QueuedDelivery>({
      prefix: "q:",
      limit: QUEUE_BATCH_SIZE,
    });
    if (queue.size === 0) return;

    const socket = this.daemonSocket();
    const now = Date.now();
    let nextAlarm: number | null = null;
    for (const [key, item] of queue) {
      if (item.attempts >= MAX_DELIVERY_ATTEMPTS || now - item.enqueuedAt >= DELIVERY_TTL_MS) {
        await this.markDead(key, item, item.lastError ?? "delivery limit exceeded");
        continue;
      }

      if (
        item.connectionId &&
        !(await organizationConnectionIsActive(this.env.DB, item.connectionId))
      ) {
        await this.markDead(key, item, "organization_connection_revoked");
        continue;
      }

      if (!socket || !(await this.hasAgent(item.agent))) {
        const expiresAt = item.enqueuedAt + DELIVERY_TTL_MS;
        nextAlarm = nextAlarm === null ? expiresAt : Math.min(nextAlarm, expiresAt);
        continue;
      }

      const retryDelay = Math.min(5_000 * 2 ** Math.max(item.attempts - 1, 0), MAX_RETRY_MS);
      const dueAt = item.lastAttemptAt === undefined ? now : item.lastAttemptAt + retryDelay;
      if (dueAt > now) {
        nextAlarm = nextAlarm === null ? dueAt : Math.min(nextAlarm, dueAt);
        continue;
      }

      // Claim the entry before sending: dispatchQueued is re-entrant (every
      // queueDelivery, roster, and hello triggers it), and two runs can hold
      // snapshots taken before the other recorded its attempt. Without the
      // compare-and-set both runs would dispatch the same entry.
      const attempted: QueuedDelivery = {
        ...item,
        attempts: item.attempts + 1,
        lastAttemptAt: now,
        lastError: undefined,
      };
      const claimed = await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<QueuedDelivery>(key);
        if (!current || current.attempts !== item.attempts) return false;
        await transaction.put(key, attempted);
        return true;
      });
      if (!claimed) continue;
      // `item.attempts` is the number of sends that already went out, so the
      // first send re-renders to exactly the bytes the dispatcher produced and
      // every retry says how many times the agent has now been handed this.
      const envelope = item.render
        ? renderEnvelope({
            ...item.render,
            redelivery: (item.render.redelivery ?? 0) + item.attempts,
          })
        : item.envelope;
      try {
        this.sendFrame(socket, {
          t: "deliver",
          id: item.messageId,
          agent: item.agent,
          envelope,
        });
      } catch (error) {
        attempted.lastError = error instanceof Error ? error.message : String(error);
        await this.ctx.storage.put(key, attempted);
      }
      const retryAt = now + Math.min(5_000 * 2 ** Math.max(attempted.attempts - 1, 0), MAX_RETRY_MS);
      nextAlarm = nextAlarm === null ? retryAt : Math.min(nextAlarm, retryAt);
      if (attempted.messageId.startsWith("tx_")) {
      this.background(
        "delivery_attempt_write_failed",
        this.env.DB.prepare(
          `INSERT INTO message_delivery
           (message_id, target_addr, status, attempts, last_error, updated_at)
           VALUES (?, ?, 'queued', ?, ?, ?)
           ON CONFLICT(message_id, target_addr) DO UPDATE SET
             attempts = excluded.attempts,
             last_error = excluded.last_error,
             updated_at = excluded.updated_at`,
        )
          .bind(
            attempted.messageId,
            attempted.targetAddr,
            attempted.attempts,
            attempted.lastError ?? null,
            now,
          )
          .run(),
      );
      }
      if (attempted.messageId.startsWith("dlv_")) {
        // A channel delivery is ledgered by the Integration DO, which counts
        // its own dispatches and never sees the socket. Without this the ledger
        // reads one attempt while the host has pushed the envelope four times,
        // and the duplicates an agent sees are recorded nowhere at all.
        this.background(
          "channel_wire_send_write_failed",
          this.env.DB.prepare(
            "UPDATE integration_delivery SET wire_sends = ? WHERE id = ?",
          )
            .bind(attempted.attempts, attempted.messageId)
            .run(),
        );
      }
    }

    if (queue.size === QUEUE_BATCH_SIZE) nextAlarm = now;
    if (nextAlarm !== null) await budgetedAlarm(this.ctx.storage, nextAlarm);
  }

  private async handleDeliveryAck(messageId: string, agent?: string, via?: string): Promise<void> {
    const resolved = await this.resolveQueuedMarker(messageId, agent);
    if (!resolved) return;
    const { key: markerKey, marker } = resolved;
    const item = await this.ctx.storage.get<QueuedDelivery>(marker.queueKey!);
    if (!item) return;

    const queueKey = marker.queueKey!;
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete(queueKey);
      await transaction.put<DeliveryMarker>(markerKey, {
        status: "injected",
        updatedAt: Date.now(),
      });
    });
    if (messageId.startsWith("tx_")) {
    this.background(
      "delivery_ack_write_failed",
      this.env.DB.prepare(
        `INSERT INTO message_delivery
         (message_id, target_addr, status, attempts, last_error, via, updated_at)
         VALUES (?, ?, 'injected', ?, NULL, ?, ?)
         ON CONFLICT(message_id, target_addr) DO UPDATE SET
           status = 'injected',
           attempts = excluded.attempts,
           last_error = NULL,
           via = excluded.via,
           updated_at = excluded.updated_at`,
      )
        .bind(messageId, item.targetAddr, item.attempts, via ?? null, Date.now())
        .run(),
    );
    }
    // A channel delivery is ledgered by the Integration DO, which never sees
    // the wire ack and so cannot know the transport. Only the transport column
    // is touched here, so the DO's own status machine is not raced.
    if (messageId.startsWith("dlv_") && via) {
      this.background(
        "channel_delivery_via_write_failed",
        this.env.DB.prepare("UPDATE integration_delivery SET via = ? WHERE id = ?")
          .bind(via, messageId)
          .run(),
      );
      // Tell the owning integration that the envelope is in the agent's
      // session, so it stops redelivering a message that already arrived.
      // An ack must never fail on this, so it takes the background seam.
      this.background(
        "channel_injection_report_failed",
        this.reportInjection(item.org, messageId, item.targetAddr, via),
      );
    }
    if (item.roomName && item.roomSeq !== undefined) {
      try {
        await this.env.ROOM.getByName(
          `org:${item.org}:room:${item.roomName}`,
        ).acknowledge(item.targetAddr, item.roomSeq);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "room_ack_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    await this.broadcast({ type: "delivery_injected", at: Date.now(), id: messageId }, item.org);
  }

  private async handleDeliveryNak(
    messageId: string,
    code: string,
    retryable: boolean,
    agent?: string,
  ): Promise<void> {
    const resolved = await this.resolveQueuedMarker(messageId, agent);
    if (!resolved) return;
    const { marker } = resolved;
    const item = await this.ctx.storage.get<QueuedDelivery>(marker.queueKey!);
    if (!item) return;
    if (!retryable) {
      await this.markDead(marker.queueKey!, item, code);
      return;
    }
    if (code === "draft_busy") {
      // A hold is not an attempt: a person composing for a few minutes would
      // otherwise exhaust the 40-attempt budget and leave the message dead.
      item.attempts = Math.max(item.attempts - 1, 0);
      item.lastError = code;
      await this.ctx.storage.put(marker.queueKey!, item);
      if (messageId.startsWith("tx_")) {
        this.background(
          "delivery_hold_write_failed",
          this.env.DB.prepare(
            `INSERT INTO message_delivery
             (message_id, target_addr, status, attempts, last_error, updated_at)
             VALUES (?, ?, 'queued', ?, ?, ?)
             ON CONFLICT(message_id, target_addr) DO UPDATE SET
               status = 'queued',
               attempts = excluded.attempts,
               last_error = excluded.last_error,
               updated_at = excluded.updated_at`,
          )
            .bind(messageId, item.targetAddr, item.attempts, item.lastError, Date.now())
            .run(),
        );
      }
      // Polling a composer from here would be the wrong side of the wire: the
      // daemon watches the held pane for free and sends a roster frame the
      // moment it clears, which dispatches immediately. This alarm is only the
      // backstop for a daemon that died still holding, so it is spaced to
      // spend a twelfth of the hourly alarm budget rather than all of it.
      await budgetedAlarm(this.ctx.storage, Date.now() + DRAFT_HOLD_BACKSTOP_MS);
      return;
    }
    item.lastError = code;
    await this.ctx.storage.put(marker.queueKey!, item);
    const retryAt = Date.now() + Math.min(5_000 * 2 ** Math.max(item.attempts - 1, 0), MAX_RETRY_MS);
    await budgetedAlarm(this.ctx.storage, retryAt);
  }

  /**
   * Locates the queued marker an ack/nak refers to. A current daemon echoes
   * the recipient agent, so the marker is addressed directly. Without the
   * echo (older daemon, or an entry queued before the per-recipient split)
   * fall back to the oldest queued entry for the id — each ack settles one
   * entry, so a legacy daemon drains same-host fan-out one ack at a time.
   */
  private async resolveQueuedMarker(
    messageId: string,
    agent?: string,
  ): Promise<{ key: string; marker: DeliveryMarker } | null> {
    if (agent) {
      const key = `d:${messageId}:${agent}`;
      const marker = await this.ctx.storage.get<DeliveryMarker>(key);
      if (marker?.status === "queued" && marker.queueKey) return { key, marker };
    }
    const queued: [string, DeliveryMarker][] = [];
    for (const [key, marker] of await this.ctx.storage.list<DeliveryMarker>({
      prefix: `d:${messageId}`,
    })) {
      if (key !== `d:${messageId}` && !key.startsWith(`d:${messageId}:`)) continue;
      if (marker.status === "queued" && marker.queueKey) queued.push([key, marker]);
    }
    if (queued.length === 0) return null;
    queued.sort((left, right) => left[1].queueKey!.localeCompare(right[1].queueKey!));
    const [key, marker] = queued[0]!;
    return { key, marker };
  }

  private async findDeadMarker(
    storage: Pick<DurableObjectStorage, "list">,
    messageId: string,
  ): Promise<{ key: string; marker: DeliveryMarker } | null> {
    for (const [key, marker] of await storage.list<DeliveryMarker>({
      prefix: `d:${messageId}`,
    })) {
      if (key !== `d:${messageId}` && !key.startsWith(`d:${messageId}:`)) continue;
      if (marker.status === "dead") return { key, marker };
    }
    return null;
  }

  private async markDead(key: string, item: QueuedDelivery, error: string): Promise<void> {
    const deadItem = { ...item, lastError: error };
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete(key);
      await transaction.put<DeliveryMarker>(`d:${item.messageId}:${item.agent}`, {
        status: "dead",
        updatedAt: Date.now(),
        queueKey: key,
        item: deadItem,
      });
    });
    if (item.messageId.startsWith("tx_")) {
    this.background(
      "delivery_dead_write_failed",
      this.env.DB.prepare(
        `INSERT INTO message_delivery
         (message_id, target_addr, status, attempts, last_error, updated_at)
         VALUES (?, ?, 'dead', ?, ?, ?)
         ON CONFLICT(message_id, target_addr) DO UPDATE SET
           status = 'dead',
           attempts = excluded.attempts,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
        .bind(item.messageId, item.targetAddr, item.attempts, error, Date.now())
        .run(),
    );
    }
    await this.broadcast(
      {
        type: "delivery_dead",
        at: Date.now(),
        id: item.messageId,
        target: item.targetAddr,
        error,
      },
      item.org,
    );
  }

  private async rpcCaller(
    identity: HostIdentity,
    params: Record<string, unknown>,
  ): Promise<string> {
    if (typeof params.caller !== "string") throw new Error("caller is required");
    const caller = parseAddress(params.caller);
    if (
      caller.kind !== "agent" ||
      caller.organization !== undefined ||
      caller.host !== identity.slug ||
      !(await this.hasAgent(caller.name))
    ) {
      throw new Error("invalid rpc caller");
    }
    return caller.address;
  }

  private async integrationForDelivery(
    org: string,
    deliveryId: string,
  ): Promise<string> {
    const row = await this.env.DB.prepare(
      `SELECT e.integration_id
       FROM integration_delivery d
       JOIN integration_event e ON e.id = d.event_id
       JOIN integration i ON i.id = e.integration_id
       WHERE d.id = ? AND i.org_id = ? LIMIT 1`,
    )
      .bind(deliveryId, org)
      .first<{ integration_id: string }>();
    if (!row) throw new Error("delivery not found");
    return row.integration_id;
  }

  private async reportInjection(
    org: string,
    deliveryId: string,
    targetAddr: string,
    via: string,
  ): Promise<void> {
    const integrationId = await this.integrationForDelivery(org, deliveryId);
    await this.env.INTEGRATION.getByName(
      `org:${org}:integration:${integrationId}`,
    ).recordInjection(deliveryId, targetAddr, via);
  }

  private async handleRpc(
    socket: WebSocket,
    identity: HostIdentity,
    rid: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      let result: unknown;
      if (method === "read_message") {
        if (typeof params.id !== "string") throw new Error("id is required");
        if (params.id.startsWith("dlv_")) {
          const caller = await this.rpcCaller(identity, params);
          const integrationId = await this.integrationForDelivery(identity.org, params.id);
          result = await this.env.INTEGRATION.getByName(
            `org:${identity.org}:integration:${integrationId}`,
          ).readMessage(params.id, caller);
        } else {
          const row = await this.env.DB.prepare(
            `SELECT id, from_addr, body FROM message
             WHERE id = ? AND (org_id = ? OR recipient_org_id = ?) LIMIT 1`,
          )
            .bind(params.id, identity.org, identity.org)
            .first<{ id: string; from_addr: string; body: string }>();
          if (!row) throw new Error("message not found");
          result = renderFull({
            id: row.id,
            conversationId: row.id,
            user: row.from_addr,
            connector: "transit",
            status: "injected",
            firstRead: false,
            settled: true,
            body: row.body,
          });
        }
      } else if (method === "chat_reply") {
        if (
          typeof params.delivery_id !== "string" ||
          typeof params.conversation_id !== "string" ||
          typeof params.message !== "string"
        ) {
          throw new Error("delivery_id, conversation_id, and message are required");
        }
        const caller = await this.rpcCaller(identity, params);
        const integrationId = await this.integrationForDelivery(
          identity.org,
          params.delivery_id,
        );
        const replyMode =
          params.reply_mode === "root" || params.reply_mode === "thread"
            ? params.reply_mode
            : undefined;
        result = await this.env.INTEGRATION.getByName(
          `org:${identity.org}:integration:${integrationId}`,
        ).chatReply({
          deliveryId: params.delivery_id,
          conversationId: params.conversation_id,
          caller,
          message: params.message,
          ...(replyMode ? { replyMode } : {}),
        });
      } else if (method === "mark_handled") {
        if (typeof params.delivery_id !== "string") {
          throw new Error("delivery_id is required");
        }
        const caller = await this.rpcCaller(identity, params);
        const integrationId = await this.integrationForDelivery(
          identity.org,
          params.delivery_id,
        );
        result = await this.env.INTEGRATION.getByName(
          `org:${identity.org}:integration:${integrationId}`,
        ).markHandled(params.delivery_id, caller);
      } else if (method === "list_agents") {
        const hostFilter = typeof params.host === "string" ? params.host : null;
        const requestedOrganization =
          typeof params.organization === "string" && params.organization
            ? params.organization
            : null;
        let rosterOrg = identity.org;
        let addressOrganization: string | null = null;
        if (requestedOrganization) {
          const connected = await resolveConnectedOrganization(
            this.env.DB,
            identity.org,
            requestedOrganization,
          );
          if (!connected) throw new Error("organization is not connected");
          rosterOrg = connected.targetOrgId;
          addressOrganization = connected.targetSlug;
        }
        const query = hostFilter
          ? this.env.DB.prepare(
              `SELECT a.name, a.kind, a.pane_id, a.status, a.named_by, a.title, a.cwd,
                      h.slug AS host, a.updated_at
               FROM agent_snapshot a JOIN host h ON h.id = a.host_id
               WHERE h.org_id = ? AND h.slug = ? AND h.revoked_at IS NULL
               ORDER BY h.slug, a.name`,
            ).bind(rosterOrg, hostFilter)
          : this.env.DB.prepare(
              `SELECT a.name, a.kind, a.pane_id, a.status, a.named_by, a.title, a.cwd,
                      h.slug AS host, a.updated_at
               FROM agent_snapshot a JOIN host h ON h.id = a.host_id
               WHERE h.org_id = ? AND h.revoked_at IS NULL
               ORDER BY h.slug, a.name`,
            ).bind(rosterOrg);
        const agents = (
          await query.all<{
            name: string;
            kind: string;
            pane_id: string;
            status: string;
            named_by: "user" | "auto";
            title: string;
            cwd: string;
            host: string;
            updated_at: number;
          }>()
        ).results;
        result = addressOrganization
          ? agents.map((agent) => ({
              ...agent,
              organization: addressOrganization,
              address: formatAgentAddress(
                agent.name,
                agent.host,
                addressOrganization,
              ),
            }))
          : agents;
      } else if (method === "list_rooms") {
        const requestedOrganization =
          typeof params.organization === "string" && params.organization
            ? params.organization
            : null;
        let roomOrg = identity.org;
        let addressOrganization: string | null = null;
        if (requestedOrganization) {
          const connected = await resolveConnectedOrganization(
            this.env.DB,
            identity.org,
            requestedOrganization,
          );
          if (!connected) throw new Error("organization is not connected");
          roomOrg = connected.targetOrgId;
          addressOrganization = connected.targetSlug;
        }
        // room_member.org_id is the room owner's organization, not the member's.
        const rooms = (
          await this.env.DB.prepare(
            `SELECT r.name, r.policy, r.created_at, COUNT(m.address) AS members
             FROM room r LEFT JOIN room_member m
               ON m.org_id = r.org_id AND m.room = r.name
             WHERE r.org_id = ?
             GROUP BY r.org_id, r.name
             ORDER BY r.name`,
          )
            .bind(roomOrg)
            .all<{ name: string; policy: string; created_at: number; members: number }>()
        ).results;
        result = addressOrganization
          ? rooms.map((room) => ({
              ...room,
              organization: addressOrganization,
              address: `${addressOrganization}/${formatRoomAddress(room.name)}`,
            }))
          : rooms;
      } else if (
        method === "create_room" ||
        method === "join_room" ||
        method === "leave_room"
      ) {
        if (typeof params.room !== "string" || typeof params.address !== "string") {
          throw new Error("room and address are required");
        }
        const parsedRoom = parseRoomTarget(params.room);
        const caller = parseAddress(params.address);
        if (
          caller.kind !== "agent" ||
          caller.organization !== undefined ||
          caller.host !== identity.slug ||
          !(await this.hasAgent(caller.name))
        ) {
          throw new Error("invalid room caller");
        }
        if (method === "create_room") {
          if (parsedRoom.organization) {
            throw new Error("cannot create a room in another organization");
          }
          const policy = params.policy ?? "open";
          if (policy !== "open" && policy !== "invite") {
            throw new Error("room policy must be open or invite");
          }
          const created = await createRoom(this.env, {
            org: identity.org,
            name: parsedRoom.room,
            policy,
            creator: caller.address,
          });
          if (!created.created) throw new Error("room_exists");
          result = { room: created.room, joined: true };
        } else {
          let roomOrg = identity.org;
          let memberAddress = caller.address;
          let member:
            | { org: string; orgSlug: string; connectionId: string }
            | undefined;
          if (parsedRoom.organization) {
            const connected = await resolveConnectedOrganization(
              this.env.DB,
              identity.org,
              parsedRoom.organization,
            );
            if (!connected) throw new Error("organization is not connected");
            roomOrg = connected.targetOrgId;
            memberAddress = formatAgentAddress(
              caller.name,
              caller.host,
              connected.sourceSlug,
            );
            member = {
              org: identity.org,
              orgSlug: connected.sourceSlug,
              connectionId: connected.connectionId,
            };
          }
          const room = this.env.ROOM.getByName(
            `org:${roomOrg}:room:${parsedRoom.room}`,
          );
          if (method === "join_room") {
            const joined = await room.join(memberAddress, "agent", member);
            if (joined.error) throw new Error(joined.error);
            result = joined;
          } else {
            result = await room.leave(memberAddress);
          }
        }
      } else {
        throw new Error("unknown rpc method");
      }
      this.sendFrame(socket, { t: "rpc_result", rid, result });
    } catch (error) {
      this.sendFrame(socket, {
        t: "rpc_result",
        rid,
        error: {
          code: "rpc_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
