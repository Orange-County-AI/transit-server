import { DurableObject } from "cloudflare:workers";
import type {
  Connector,
  ConnectorCtx,
  ConnectorEvent,
  ConnectorStorage,
  PollResult,
  ReplyRequest,
} from "transit-connector-kit";
import { connectorFor } from "../connectors/registry";
import { parseAddress } from "../lib/transit/addr";
import {
  ALARM_BUDGET_PER_HOUR,
  budgetedAlarm,
  POLL_ALARM_BUDGET_PER_HOUR,
} from "../lib/transit/alarm-budget";
import { openSecret, sealSecret, sha256hex } from "../lib/transit/crypto";
import {
  type ChannelEnvelope,
  renderEnvelope,
  renderFull,
} from "../lib/transit/envelope";
import { dlvId, eventId } from "../lib/transit/ids";
import { consumeStoredToken } from "../lib/transit/token-bucket";

const BASE_REDELIVERY_MS = 5 * 60 * 1_000;
const MAX_REDELIVERY_MS = 30 * 60 * 1_000;
const READ_REDELIVERY_MULTIPLIER = 4;
const REPLY_RETRY_MS = 60_000;

// Poll cadence. A polling connector never holds an upstream socket open, so
// the Durable Object hibernates between wakeups and is billed only for the
// milliseconds a poll actually takes. Cadence therefore trades latency for
// wakeups, not for a standing duration charge.
//
//   burst   — a conversation is live; poll every second
//   active  — normal cadence, 2.5s average latency on a cold conversation
//   idle    — nothing for 15 minutes
//   dormant — nothing for an hour
//
// Burst cadence runs *inside* one alarm invocation rather than as a 1s alarm
// stream: one wakeup covers a whole burst window, so a busy conversation costs
// active duration (which we want to pay) instead of 3,600 alarm writes an hour
// (which we do not).
const POLL_BURST_MS = 1_000;
const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 30_000;
const POLL_DORMANT_MS = 60_000;
const POLL_HOT_FOR_MS = 60_000;
const POLL_IDLE_AFTER_MS = 15 * 60_000;
const POLL_DORMANT_AFTER_MS = 60 * 60_000;
// Wall-clock ceiling for one burst window. Bounded well under the alarm
// handler's CPU ceiling; the loop is almost entirely awaiting the network.
const POLL_BURST_WINDOW_MS = 30_000;
// Consecutive quiet cycles that end a burst early. Holding 1s cadence for a
// full window after a single message would bill active duration for silence;
// five quiet seconds is enough to catch a human's immediate follow-up before
// handing the wait back to the alarm.
const POLL_QUIET_EXIT_CYCLES = 5;
const POLL_MAX_BACKOFF_MS = 60_000;
const POLL_STATE_KEY = "poll:state";

export type IntegrationMeta = {
  org: string;
  id: string;
  connector: string;
  name: string;
  targetAddr: string;
  status: "active" | "paused";
  configEnc: string;
  createdAt: number;
};

type StoredEvent = ConnectorEvent & {
  id: string;
  integrationId: string;
  receivedAt: number;
};

type DeliveryStatus =
  | "pending"
  | "dispatched"
  | "read"
  | "replied"
  | "handled"
  | "dead";

type DeliveryRecord = {
  id: string;
  eventId: string;
  targetAddr: string;
  status: DeliveryStatus;
  attempts: number;
  createdAt: number;
  lastDispatchAt?: number;
  nextAttemptAt?: number;
  readAt?: number;
  // How and when this delivery actually reached its agent, reported by the
  // HostHub from the daemon's wire ack. A native adapter's ack means the
  // envelope is durably queued inside the agent's session, which is a
  // stronger fact than "typed into a pane" and the one that ends redelivery.
  injectedAt?: number;
  injectedVia?: string;
  // Arrivals, not dispatches. The HostHub resolves each queued entry exactly
  // once, so one report here is one envelope that reached an agent.
  injections?: number;
  settledAt?: number;
  lastError?: string;
};

type ReplyRecord = {
  deliveryId: string;
  conversationId: string;
  caller: string;
  message: string;
  replyMode?: "root" | "thread";
  createdAt: number;
  postedAt?: number;
  postError?: string;
  nextAttemptAt?: number;
};

// Cadence state for `mode: "poll"` connectors. Persisted (not runtime) because
// the object hibernates between wakeups and must not restart hot after every
// eviction.
type PollState = {
  lastActivityAt: number;
  backoffUntil: number;
  failures: number;
};

type ConnectorStatus = {
  state: "connected" | "polling" | "webhook" | "error" | "paused";
  detail?: string;
  updatedAt: number;
};

export type IntegrationDetail = {
  meta: Omit<IntegrationMeta, "configEnc">;
  config: Record<string, string>;
  secretFingerprints: Record<string, string>;
  connectorStatus: ConnectorStatus | null;
  deliveries: Record<DeliveryStatus, number>;
  configFields: Connector["configFields"];
  mode: Connector["mode"];
};

export type ChatReplyResult = {
  status: "handled" | "post_pending";
  duplicate: boolean;
  message: string;
  postError?: string;
};

export class Integration extends DurableObject<Env> {
  private readonly runtime = new Map<string, unknown>();
  // Last status written, so a 1s burst loop does not turn into a 1s storage
  // write loop. Lost on eviction, which only costs one redundant write.
  private lastStatus: string | null = null;
  private pollBudget: number | null = null;

  async configure(input: {
    org: string;
    id: string;
    connector: string;
    name: string;
    targetAddr: string;
    config: Record<string, string>;
    status?: "active" | "paused";
    createdAt?: number;
  }): Promise<IntegrationDetail> {
    const connector = connectorFor(input.connector);
    const previous = await this.meta();
    if (previous && (previous.org !== input.org || previous.id !== input.id)) {
      throw new Error("integration identity cannot change");
    }

    const existingConfig = previous
      ? JSON.parse(await openSecret(previous.configEnc, this.env.TRANSIT_MASTER_KEY)) as Record<string, string>
      : {};
    const config: Record<string, string> = {};
    const secretFingerprints: Record<string, string> = {};
    for (const field of connector.configFields) {
      const supplied = input.config[field.key];
      const value = field.secret && !supplied ? existingConfig[field.key] : supplied;
      if (field.required && !value) throw new Error(`${field.key} is required`);
      if (value) config[field.key] = value;
      if (field.secret && value) secretFingerprints[field.key] = await sha256hex(value);
    }

    if (previous) {
      const previousConnector = connectorFor(previous.connector);
      if (previousConnector.stop) {
        await previousConnector.stop(await this.connectorContext(previousConnector, existingConfig));
      }
    }

    const configEnc = await sealSecret(
      JSON.stringify(config),
      this.env.TRANSIT_MASTER_KEY,
    );
    const meta: IntegrationMeta = {
      org: input.org,
      id: input.id,
      connector: input.connector,
      name: input.name,
      targetAddr: input.targetAddr,
      status: input.status ?? previous?.status ?? "active",
      configEnc,
      createdAt: input.createdAt ?? previous?.createdAt ?? Date.now(),
    };
    await this.ctx.storage.put({ meta, secretFingerprints });
    // The connector kind can change on reconfigure, and with it the alarm
    // budget and the last written status.
    this.pollBudget = null;
    this.lastStatus = null;
    await this.env.DB.prepare(
      `INSERT INTO integration
       (id, org_id, connector, name, config_enc, target_addr, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         connector = excluded.connector,
         name = excluded.name,
         config_enc = excluded.config_enc,
         target_addr = excluded.target_addr,
         status = excluded.status`,
    )
      .bind(
        meta.id,
        meta.org,
        meta.connector,
        meta.name,
        meta.configEnc,
        meta.targetAddr,
        meta.status,
        meta.createdAt,
      )
      .run();
    if (meta.status === "active" && connector.start) {
      try {
        await connector.start(await this.connectorContext(connector, config));
      } catch (error) {
        await this.setConnectorStatus({
          state: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (meta.status === "active") await this.armPoll(connector);
    return this.detail();
  }

  async detail(): Promise<IntegrationDetail> {
    const meta = await this.requireMeta();
    const connector = connectorFor(meta.connector);
    const config = JSON.parse(
      await openSecret(meta.configEnc, this.env.TRANSIT_MASTER_KEY),
    ) as Record<string, string>;
    const visibleConfig: Record<string, string> = {};
    for (const field of connector.configFields) {
      const value = config[field.key];
      if (!field.secret && value) visibleConfig[field.key] = value;
    }
    const deliveries: Record<DeliveryStatus, number> = {
      pending: 0,
      dispatched: 0,
      read: 0,
      replied: 0,
      handled: 0,
      dead: 0,
    };
    for (const delivery of (
      await this.ctx.storage.list<DeliveryRecord>({ prefix: "delivery:" })
    ).values()) {
      deliveries[delivery.status] += 1;
    }
    const { configEnc: _configEnc, ...publicMeta } = meta;
    return {
      meta: publicMeta,
      config: visibleConfig,
      secretFingerprints:
        (await this.ctx.storage.get<Record<string, string>>("secretFingerprints")) ?? {},
      connectorStatus:
        (await this.ctx.storage.get<ConnectorStatus>("connectorStatus")) ?? null,
      deliveries,
      configFields: connector.configFields,
      mode: connector.mode,
    };
  }

  async ingestEvent(
    event: ConnectorEvent,
  ): Promise<{
    status: "queued" | "duplicate" | "rate_limited" | "plan_limit";
    eventId: string;
    deliveryId: string;
  }> {
    const meta = await this.requireMeta();
    if (meta.status !== "active") throw new Error("integration_paused");
    if (
      meta.connector === "ingest" &&
      !(await consumeStoredToken(this.ctx.storage, "rate:ingest", 5, 20))
    ) {
      return { status: "rate_limited", eventId: "", deliveryId: "" };
    }
    const existing = await this.ctx.storage.get<{ eventId: string; deliveryId: string }>(
      `event_key:${event.eventKey}`,
    );
    if (existing) return { status: "duplicate", ...existing };
    if (!(await this.canAcceptMessage(meta.org))) {
      return { status: "plan_limit", eventId: "", deliveryId: "" };
    }
    const committed = await this.ctx.storage.transaction(async (transaction) => {
      const dedupeKey = `event_key:${event.eventKey}`;
      const existing = await transaction.get<{ eventId: string; deliveryId: string }>(
        dedupeKey,
      );
      if (existing) return { status: "duplicate" as const, ...existing };

      const storedEvent: StoredEvent = {
        ...event,
        id: eventId(),
        integrationId: meta.id,
        receivedAt: Date.now(),
      };
      const delivery: DeliveryRecord = {
        id: dlvId(),
        eventId: storedEvent.id,
        targetAddr: meta.targetAddr,
        status: "pending",
        attempts: 0,
        createdAt: Date.now(),
      };
      await transaction.put(dedupeKey, {
        eventId: storedEvent.id,
        deliveryId: delivery.id,
      });
      await transaction.put(`event:${storedEvent.id}`, storedEvent);
      await transaction.put(`delivery:${delivery.id}`, delivery);
      return {
        status: "queued" as const,
        eventId: storedEvent.id,
        deliveryId: delivery.id,
      };
    });
    if (committed.status === "duplicate") return committed;

    const storedEvent = await this.requireEvent(committed.eventId);
    const delivery = await this.requireDelivery(committed.deliveryId);
    this.mirrorIngest(meta, storedEvent, delivery);
    if (meta.status === "active") await this.dispatchDelivery(delivery.id);
    return committed;
  }

  async webhook(request: Request): Promise<Response> {
    const meta = await this.requireMeta();
    if (meta.status !== "active") return new Response("Integration paused", { status: 409 });
    const connector = connectorFor(meta.connector);
    if (!connector.webhook) return new Response("Connector has no webhook", { status: 404 });
    const config = await this.openConfig(meta);
    try {
      return await connector.webhook(await this.connectorContext(connector, config), request);
    } catch (error) {
      if (error instanceof Error && error.message === "plan_limit") {
        return Response.json({ error: "plan_limit" }, { status: 402 });
      }
      throw error;
    }
  }

  async readMessage(deliveryId: string, caller: string): Promise<string> {
    const meta = await this.requireMeta();
    const delivery = await this.requireDelivery(deliveryId);
    await this.assertOwner(delivery, caller, meta.org);
    const event = await this.requireEvent(delivery.eventId);
    const firstRead = delivery.readAt === undefined;
    if (firstRead && !delivery.settledAt) {
      delivery.readAt = Date.now();
      delivery.status = "read";
      await this.ctx.storage.put(`delivery:${delivery.id}`, delivery);
      this.background(
        "integration_read_write_failed",
        this.deliveryStatement(delivery).run(),
      );
      await this.scheduleDelivery(delivery);
    }
    const config = await this.openConfig(meta);
    return renderFull({
      id: delivery.id,
      conversationId: event.conversationId,
      user: event.user,
      connector: meta.connector,
      status: delivery.status,
      firstRead,
      settled: delivery.settledAt !== undefined,
      body: event.content,
      instructions: config.instructions,
    });
  }

  async chatReply(input: {
    deliveryId: string;
    conversationId: string;
    caller: string;
    message: string;
    replyMode?: "root" | "thread";
  }): Promise<ChatReplyResult> {
    const prior = await this.ctx.storage.get<ReplyRecord>(`reply:${input.deliveryId}`);
    if (prior) {
      return {
        status: prior.postedAt ? "handled" : "post_pending",
        duplicate: true,
        message: prior.message,
        ...(prior.postError ? { postError: prior.postError } : {}),
      };
    }

    const meta = await this.requireMeta();
    if (!(await this.canAcceptMessage(meta.org))) throw new Error("plan_limit");
    const delivery = await this.requireDelivery(input.deliveryId);
    await this.assertOwner(delivery, input.caller, meta.org);
    const event = await this.requireEvent(delivery.eventId);
    if (event.conversationId !== input.conversationId) {
      throw new Error("conversation_id mismatch");
    }
    const connector = connectorFor(meta.connector);
    const connectorContext = await this.connectorContext(
      connector,
      await this.openConfig(meta),
    );
    if (connector.canReply && !(await connector.canReply(connectorContext, event))) {
      throw new Error(`${meta.name} is one-way; use mark_handled`);
    }

    const reply: ReplyRecord = {
      deliveryId: delivery.id,
      conversationId: event.conversationId,
      caller: input.caller,
      message: input.message,
      ...(input.replyMode ? { replyMode: input.replyMode } : {}),
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
    };
    delivery.status = "replied";
    delivery.nextAttemptAt = undefined;
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(`reply:${delivery.id}`, reply);
      await transaction.put(`delivery:${delivery.id}`, delivery);
    });
    this.mirrorReplyCreated(meta, delivery, reply);

    try {
      await this.postRecordedReply(meta, event, delivery, reply);
      return { status: "handled", duplicate: false, message: reply.message };
    } catch (error) {
      reply.postError = error instanceof Error ? error.message : String(error);
      reply.nextAttemptAt = Date.now() + REPLY_RETRY_MS;
      await this.ctx.storage.put(`reply:${reply.deliveryId}`, reply);
      await this.scheduleAt(reply.nextAttemptAt);
      this.background(
        "integration_reply_error_write_failed",
        this.replyStatement(reply).run(),
      );
      return {
        status: "post_pending",
        duplicate: false,
        message: reply.message,
        postError: reply.postError,
      };
    }
  }

  /**
   * The HostHub reports that a dispatched delivery reached its agent, and by
   * which transport, taken from the daemon's wire ack. This object queues
   * deliveries but never sees the socket that drains them, so this is the only
   * way it can learn the difference between "sent to a host" and "sitting in
   * an agent's session".
   *
   * One call is one arrival. The HostHub resolves each queued entry exactly
   * once — a repeat ack finds the entry already drained and never gets here —
   * so this is the honest arrival count that `attempts` is not: a dispatch the
   * host answers "duplicate" still counts an attempt and injects nothing.
   */
  async recordInjection(
    deliveryId: string,
    targetAddr: string,
    via: string,
  ): Promise<void> {
    const delivery = await this.ctx.storage.get<DeliveryRecord>(
      `delivery:${deliveryId}`,
    );
    if (!delivery || delivery.targetAddr !== targetAddr) return;
    if (delivery.settledAt !== undefined || delivery.status === "dead") return;
    delivery.injections = (delivery.injections ?? 0) + 1;
    delivery.injectedVia = via;
    delivery.injectedAt = Date.now();
    // Only suspension is applied here. Leaving a live schedule untouched keeps
    // an ack from silently postponing a retry that was already due.
    if (this.sessionHeld(delivery)) delivery.nextAttemptAt = undefined;
    await this.ctx.storage.put(`delivery:${deliveryId}`, delivery);
    this.background(
      "integration_injection_write_failed",
      this.deliveryStatement(delivery).run(),
    );
  }

  async markHandled(deliveryId: string, caller: string): Promise<{ duplicate: boolean }> {
    const meta = await this.requireMeta();
    const delivery = await this.requireDelivery(deliveryId);
    await this.assertOwner(delivery, caller, meta.org);
    return this.finishHandled(delivery, meta.org);
  }

  async operatorMarkHandled(deliveryId: string): Promise<{ duplicate: boolean }> {
    const meta = await this.requireMeta();
    return this.finishHandled(await this.requireDelivery(deliveryId), meta.org);
  }

  private async finishHandled(
    delivery: DeliveryRecord,
    org: string,
  ): Promise<{ duplicate: boolean }> {
    if (delivery.settledAt !== undefined) return { duplicate: true };
    delivery.status = "handled";
    delivery.settledAt = Date.now();
    delivery.nextAttemptAt = undefined;
    await this.ctx.storage.put(`delivery:${delivery.id}`, delivery);
    this.background(
      "integration_handle_write_failed",
      this.deliveryStatement(delivery).run(),
    );
    // The daemon may still hold an unacked dispatch of this delivery; a
    // settled delivery must never be injected again, so drain the host queue.
    await this.cancelHostQueue(delivery, org);
    return { duplicate: false };
  }

  async settleConversation(conversationId: string): Promise<void> {
    const meta = await this.requireMeta();
    const deliveries = await this.ctx.storage.list<DeliveryRecord>({ prefix: "delivery:" });
    for (const [key, delivery] of deliveries) {
      if (delivery.settledAt !== undefined) continue;
      const event = await this.requireEvent(delivery.eventId);
      if (event.conversationId !== conversationId) continue;
      delivery.status = "handled";
      delivery.settledAt = Date.now();
      delivery.nextAttemptAt = undefined;
      await this.ctx.storage.put(key, delivery);
      this.background(
        "conversation_settle_write_failed",
        this.deliveryStatement(delivery).run(),
      );
      await this.cancelHostQueue(delivery, meta.org);
    }
  }

  async pause(paused: boolean): Promise<void> {
    const meta = await this.requireMeta();
    const connector = connectorFor(meta.connector);
    const config = await this.openConfig(meta);
    meta.status = paused ? "paused" : "active";
    await this.ctx.storage.put("meta", meta);
    if (paused) {
      if (connector.stop) await connector.stop(await this.connectorContext(connector, config));
      await this.setConnectorStatus({ state: "paused" });
    } else {
      if (connector.start) await connector.start(await this.connectorContext(connector, config));
      await this.dispatchDue();
      await this.armPoll(connector);
    }
    this.background(
      "integration_pause_write_failed",
      this.env.DB.prepare("UPDATE integration SET status = ? WHERE id = ?")
        .bind(meta.status, meta.id)
        .run(),
    );
  }

  async requeue(deliveryId: string): Promise<void> {
    const delivery = await this.requireDelivery(deliveryId);
    if (delivery.status !== "dead") throw new Error("delivery is not dead");
    delivery.status = "pending";
    delivery.attempts = 0;
    delivery.lastError = undefined;
    delivery.settledAt = undefined;
    delivery.nextAttemptAt = Date.now();
    await this.ctx.storage.put(`delivery:${delivery.id}`, delivery);
    await this.dispatchDelivery(delivery.id);
  }

  async destroy(): Promise<void> {
    const meta = await this.requireMeta();
    const connector = connectorFor(meta.connector);
    if (connector.stop) {
      await connector.stop(
        await this.connectorContext(connector, await this.openConfig(meta)),
      );
    }
    await this.ctx.storage.deleteAll();
    this.runtime.clear();
    this.pollBudget = null;
    this.lastStatus = null;
    this.background(
      "integration_delete_failed",
      this.env.DB.batch([
        this.env.DB.prepare(
          `DELETE FROM integration_reply
           WHERE delivery_id IN (
             SELECT d.id FROM integration_delivery d
             JOIN integration_event e ON e.id = d.event_id
             WHERE e.integration_id = ?
           )`,
        ).bind(meta.id),
        this.env.DB.prepare(
          `DELETE FROM integration_delivery
           WHERE event_id IN (
             SELECT id FROM integration_event WHERE integration_id = ?
           )`,
        ).bind(meta.id),
        this.env.DB.prepare(
          "DELETE FROM integration_event WHERE integration_id = ?",
        ).bind(meta.id),
        this.env.DB.prepare("DELETE FROM integration WHERE id = ?").bind(meta.id),
      ]),
    );
  }

  override async alarm(): Promise<void> {
    const meta = await this.meta();
    if (!meta || meta.status !== "active") return;
    await this.retryReplies(meta);
    await this.dispatchDue();
    const connector = connectorFor(meta.connector);
    if (connector.wake) {
      try {
        await connector.wake(
          await this.connectorContext(connector, await this.openConfig(meta)),
        );
      } catch (error) {
        await this.setConnectorStatus({
          state: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (connector.poll) await this.runPollWindow(meta, connector);
    await this.scheduleNext();
  }

  private async meta(): Promise<IntegrationMeta | null> {
    return (await this.ctx.storage.get<IntegrationMeta>("meta")) ?? null;
  }

  private async requireMeta(): Promise<IntegrationMeta> {
    const meta = await this.meta();
    if (!meta) throw new Error("integration_not_configured");
    return meta;
  }

  private async openConfig(meta: IntegrationMeta): Promise<Record<string, string>> {
    return JSON.parse(
      await openSecret(meta.configEnc, this.env.TRANSIT_MASTER_KEY),
    ) as Record<string, string>;
  }

  private async requireEvent(id: string): Promise<StoredEvent> {
    const event = await this.ctx.storage.get<StoredEvent>(`event:${id}`);
    if (!event) throw new Error("event_not_found");
    return event;
  }

  private async requireDelivery(id: string): Promise<DeliveryRecord> {
    const delivery = await this.ctx.storage.get<DeliveryRecord>(`delivery:${id}`);
    if (!delivery) throw new Error("delivery_not_found");
    return delivery;
  }

  private async assertOwner(
    delivery: DeliveryRecord,
    caller: string,
    org: string,
  ): Promise<void> {
    if (delivery.targetAddr === caller) return;
    const target = parseAddress(delivery.targetAddr);
    if (
      target.kind === "room" &&
      (await this.env.ROOM.getByName(
        `org:${org}:room:${target.room}`,
      ).hasMember(caller))
    ) {
      return;
    }
    throw new Error("delivery owner mismatch");
  }

  private async connectorContext(
    connector: Connector,
    config: Record<string, string>,
  ): Promise<ConnectorCtx> {
    const storage: ConnectorStorage = {
      get: <T>(key: string) => this.ctx.storage.get<T>(`cx:${key}`),
      put: (key: string, value: unknown) => this.ctx.storage.put(`cx:${key}`, value),
      delete: async (key: string) => {
        await this.ctx.storage.delete(`cx:${key}`);
      },
      list: async <T>(prefix: string) => {
        const stored = await this.ctx.storage.list<T>({ prefix: `cx:${prefix}` });
        return new Map(
          [...stored].map(([key, value]) => [key.slice(3), value]),
        );
      },
    };
    return {
      config,
      storage,
      runtime: {
        get: <T>(key: string) => this.runtime.get(key) as T | undefined,
        set: (key: string, value: unknown) => {
          this.runtime.set(key, value);
        },
        delete: (key: string) => {
          this.runtime.delete(key);
        },
      },
      ingest: async (event) => {
        const result = await this.ingestEvent(event);
        if (result.status === "rate_limited" || result.status === "plan_limit") {
          throw new Error(result.status);
        }
        return { status: result.status };
      },
      fetch: (input, init) => fetch(input, init),
      scheduleWake: (afterMs) => {
        this.ctx.waitUntil(this.scheduleAt(Date.now() + Math.max(0, afterMs)));
      },
      settleConversation: (conversationId) => this.settleConversation(conversationId),
      setStatus: (status) => {
        this.ctx.waitUntil(this.setConnectorStatus(status));
      },
      log: (level, message, fields) => {
        console.log(
          JSON.stringify({
            level,
            event: "connector_log",
            connector: connector.name,
            message,
            ...fields,
          }),
        );
      },
      openWebSocket: async (url, protocols, headers) => {
        if (!headers) return new WebSocket(url, protocols);
        const response = await fetch(url, {
          headers: { ...headers, Upgrade: "websocket" },
        });
        if (response.status !== 101 || !response.webSocket) {
          throw new Error(`WebSocket upgrade failed (${response.status})`);
        }
        response.webSocket.accept();
        return response.webSocket;
      },
    };
  }

  private async setConnectorStatus(
    status: Omit<ConnectorStatus, "updatedAt">,
  ): Promise<void> {
    // A 1s burst loop calls this every cycle. Only an actual state change is
    // worth a storage write.
    const fingerprint = `${status.state}\u0000${status.detail ?? ""}`;
    if (this.lastStatus === fingerprint) return;
    this.lastStatus = fingerprint;
    await this.ctx.storage.put<ConnectorStatus>("connectorStatus", {
      ...status,
      updatedAt: Date.now(),
    });
  }

  private async dispatchDelivery(id: string): Promise<void> {
    const meta = await this.requireMeta();
    if (meta.status !== "active") return;
    const delivery = await this.requireDelivery(id);
    if (delivery.settledAt !== undefined || delivery.status === "dead") return;
    const event = await this.requireEvent(delivery.eventId);
    const render: ChannelEnvelope = {
      from: meta.connector,
      id: delivery.id,
      ts: new Date(event.receivedAt).toISOString(),
      kind: "channel",
      body: event.content,
      conversationId: event.conversationId,
      connector: meta.connector,
      user: event.user,
      trigger: event.trigger,
      redelivery: delivery.attempts,
      read: delivery.readAt !== undefined,
    };
    // The rendered string is what a first send emits; the inputs travel with it
    // so a queue retry can restate the count instead of repeating "redelivery
    // 0" at an agent that has already been handed this.
    const envelope = renderEnvelope(render);

    try {
      const target = parseAddress(delivery.targetAddr);
      if (target.kind === "agent") {
        const result = await this.env.HOST_HUB.getByName(
          `org:${meta.org}:host:${target.host}`,
        ).queueDelivery({
          messageId: delivery.id,
          org: meta.org,
          targetOrg: meta.org,
          targetHost: target.host,
          agent: target.name,
          targetAddr: target.address,
          envelope,
          render,
          redelivery: delivery.attempts > 0,
        });
        if (result.status === "no_route") throw new Error("no_route");
      } else {
        const result = await this.env.ROOM.getByName(
          `org:${meta.org}:room:${target.room}`,
        ).queueChannelDelivery({
          deliveryId: delivery.id,
          org: meta.org,
          envelope,
          render,
          redelivery: delivery.attempts > 0,
        });
        if (result.queued === 0) throw new Error("no_route");
      }
      delivery.attempts += 1;
      delivery.status = delivery.readAt ? "read" : "dispatched";
      delivery.lastDispatchAt = Date.now();
      delivery.lastError = undefined;
    } catch (error) {
      delivery.lastError = error instanceof Error ? error.message : String(error);
      if (delivery.status === "pending") delivery.status = "pending";
    }
    this.armRedelivery(delivery);
    await this.ctx.storage.put(`delivery:${delivery.id}`, delivery);
    this.background(
      "integration_dispatch_write_failed",
      this.deliveryStatement(delivery).run(),
    );
    if (delivery.nextAttemptAt !== undefined) {
      await this.scheduleAt(delivery.nextAttemptAt);
    }
  }

  private redeliveryDelay(delivery: DeliveryRecord): number {
    const attempt = Math.max(1, delivery.attempts);
    const readMultiplier = delivery.readAt ? READ_REDELIVERY_MULTIPLIER : 1;
    return Math.min(
      BASE_REDELIVERY_MS * readMultiplier * 2 ** (attempt - 1),
      MAX_REDELIVERY_MS,
    );
  }

  /**
   * A delivery whose envelope is durably queued inside its agent's session
   * needs no further injection: the agent has it, and re-sending only invites
   * a second reply to one message. Redelivery exists for the deliveries that
   * never landed, so it stays armed for every other transport — a pane the
   * daemon typed into can lose the text, and an unacked dispatch never
   * arrived at all. Settlement is still owed either way.
   *
   * Room fan-out is deliberately excluded: one member's adapter acking says
   * nothing about the others, so those keep the conservative schedule.
   */
  private sessionHeld(delivery: DeliveryRecord): boolean {
    if (delivery.injectedVia !== "adapter") return false;
    return parseAddress(delivery.targetAddr).kind === "agent";
  }

  private armRedelivery(delivery: DeliveryRecord): void {
    delivery.nextAttemptAt = this.sessionHeld(delivery)
      ? undefined
      : Date.now() + this.redeliveryDelay(delivery);
  }

  private async scheduleDelivery(delivery: DeliveryRecord): Promise<void> {
    this.armRedelivery(delivery);
    await this.ctx.storage.put(`delivery:${delivery.id}`, delivery);
    if (delivery.nextAttemptAt !== undefined) {
      await this.scheduleAt(delivery.nextAttemptAt);
    }
  }

  private async scheduleAt(at: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null && existing <= at) return;
    await budgetedAlarm(this.ctx.storage, at, await this.alarmLimit());
  }

  /**
   * Alarm budget for this integration. Polling connectors get the larger
   * budget; everything else keeps the conservative redelivery budget. Resolved
   * once per object lifetime — the connector kind cannot change without a
   * `configure()` that resets the object anyway.
   */
  private async alarmLimit(): Promise<number> {
    if (this.pollBudget !== null) return this.pollBudget;
    const meta = await this.meta();
    const polls = meta ? Boolean(connectorFor(meta.connector).poll) : false;
    this.pollBudget = polls ? POLL_ALARM_BUDGET_PER_HOUR : ALARM_BUDGET_PER_HOUR;
    return this.pollBudget;
  }

  private async pollState(): Promise<PollState> {
    return (
      (await this.ctx.storage.get<PollState>(POLL_STATE_KEY)) ?? {
        lastActivityAt: 0,
        backoffUntil: 0,
        failures: 0,
      }
    );
  }

  /** Cadence for the next poll, derived from how long activity has been absent. */
  private pollInterval(state: PollState, now: number): number {
    const quiet = now - state.lastActivityAt;
    if (quiet < POLL_HOT_FOR_MS) return POLL_BURST_MS;
    if (quiet < POLL_IDLE_AFTER_MS) return POLL_ACTIVE_MS;
    if (quiet < POLL_DORMANT_AFTER_MS) return POLL_IDLE_MS;
    return POLL_DORMANT_MS;
  }

  /** Put a freshly configured or resumed polling connector on the clock. */
  private async armPoll(connector: Connector): Promise<void> {
    if (!connector.poll) return;
    const state = await this.pollState();
    const now = Date.now();
    await this.scheduleAt(Math.max(state.backoffUntil, now + POLL_ACTIVE_MS));
  }

  /**
   * Run poll cycles until the burst window closes or the cadence relaxes past
   * burst speed, then hand the remaining wait back to the alarm.
   *
   * Staying inside one invocation while a conversation is live is the whole
   * point: it buys 1s latency for the price of active duration, without paying
   * for a 1s alarm stream or for an idle socket.
   */
  private async runPollWindow(meta: IntegrationMeta, connector: Connector): Promise<void> {
    const windowEnd = Date.now() + POLL_BURST_WINDOW_MS;
    const state = await this.pollState();
    let quiet = 0;
    for (;;) {
      const now = Date.now();
      if (state.backoffUntil > now) break;
      const result = await this.pollOnce(meta, connector, state);
      if (result.activity) {
        state.lastActivityAt = Date.now();
        quiet = 0;
      } else {
        quiet += 1;
      }
      const interval = this.pollInterval(state, Date.now());
      if (
        quiet >= POLL_QUIET_EXIT_CYCLES ||
        interval > POLL_BURST_MS ||
        state.backoffUntil > Date.now() ||
        Date.now() + interval >= windowEnd
      ) {
        break;
      }
      await scheduler.wait(interval);
    }
    await this.ctx.storage.put(POLL_STATE_KEY, state);
    const now = Date.now();
    await this.scheduleAt(
      Math.max(state.backoffUntil, now + this.pollInterval(state, now)),
    );
  }

  /** One poll cycle, with connector-requested and failure backoff folded in. */
  private async pollOnce(
    meta: IntegrationMeta,
    connector: Connector,
    state: PollState,
  ): Promise<PollResult> {
    if (!connector.poll) return { activity: false };
    try {
      const result = await connector.poll(
        await this.connectorContext(connector, await this.openConfig(meta)),
      );
      state.failures = 0;
      if (result.backoffMs && result.backoffMs > 0) {
        state.backoffUntil = Date.now() + Math.min(result.backoffMs, POLL_MAX_BACKOFF_MS);
      }
      await this.setConnectorStatus({ state: "polling" });
      return result;
    } catch (error) {
      state.failures += 1;
      state.backoffUntil =
        Date.now() + Math.min(POLL_MAX_BACKOFF_MS, 2 ** state.failures * 1_000);
      await this.setConnectorStatus({
        state: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
      return { activity: false };
    }
  }

  private async scheduleNext(): Promise<void> {
    let next: number | null = null;
    for (const delivery of (
      await this.ctx.storage.list<DeliveryRecord>({ prefix: "delivery:" })
    ).values()) {
      if (delivery.settledAt !== undefined || delivery.nextAttemptAt === undefined) continue;
      next = next === null ? delivery.nextAttemptAt : Math.min(next, delivery.nextAttemptAt);
    }
    for (const reply of (
      await this.ctx.storage.list<ReplyRecord>({ prefix: "reply:" })
    ).values()) {
      if (reply.postedAt || reply.nextAttemptAt === undefined) continue;
      next = next === null ? reply.nextAttemptAt : Math.min(next, reply.nextAttemptAt);
    }
    if (next !== null) await this.scheduleAt(next);
  }

  private async dispatchDue(): Promise<void> {
    const now = Date.now();
    for (const delivery of (
      await this.ctx.storage.list<DeliveryRecord>({ prefix: "delivery:" })
    ).values()) {
      if (
        delivery.settledAt === undefined &&
        delivery.status !== "dead" &&
        delivery.nextAttemptAt !== undefined &&
        delivery.nextAttemptAt <= now
      ) {
        await this.dispatchDelivery(delivery.id);
      }
    }
  }

  private async retryReplies(meta: IntegrationMeta): Promise<void> {
    const now = Date.now();
    for (const [key, reply] of await this.ctx.storage.list<ReplyRecord>({
      prefix: "reply:",
    })) {
      if (reply.postedAt || (reply.nextAttemptAt ?? 0) > now) continue;
      const delivery = await this.requireDelivery(reply.deliveryId);
      const event = await this.requireEvent(delivery.eventId);
      try {
        await this.postRecordedReply(meta, event, delivery, reply);
      } catch (error) {
        reply.postError = error instanceof Error ? error.message : String(error);
        reply.nextAttemptAt = Date.now() + REPLY_RETRY_MS;
        await this.ctx.storage.put(key, reply);
        this.background(
          "integration_reply_retry_write_failed",
          this.replyStatement(reply).run(),
        );
      }
    }
  }

  private async postRecordedReply(
    meta: IntegrationMeta,
    event: StoredEvent,
    delivery: DeliveryRecord,
    reply: ReplyRecord,
  ): Promise<void> {
    const connector = connectorFor(meta.connector);
    const request: ReplyRequest = {
      deliveryId: delivery.id,
      conversationId: event.conversationId,
      agent: reply.caller,
      message: reply.message,
      ...(reply.replyMode ? { replyMode: reply.replyMode } : {}),
      event,
    };
    await connector.postReply(
      await this.connectorContext(connector, await this.openConfig(meta)),
      request,
    );
    const postedAt = Date.now();
    reply.postedAt = postedAt;
    reply.postError = undefined;
    reply.nextAttemptAt = undefined;
    delivery.status = "handled";
    delivery.settledAt = postedAt;
    delivery.nextAttemptAt = undefined;
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(`reply:${reply.deliveryId}`, reply);
      await transaction.put(`delivery:${delivery.id}`, delivery);
    });
    this.background(
      "integration_reply_posted_write_failed",
      this.env.DB.batch([
        this.replyStatement(reply),
        this.deliveryStatement(delivery),
      ]),
    );
    // The reply is posted, so the delivery is settled; the agent may still be
    // mid-turn with an unacked dispatch pending. Drain the host queue so the
    // settled delivery is never injected again.
    await this.cancelHostQueue(delivery, meta.org);
  }

  private async cancelHostQueue(delivery: DeliveryRecord, org: string): Promise<void> {
    try {
      const target = parseAddress(delivery.targetAddr);
      if (target.kind === "agent") {
        await this.env.HOST_HUB.getByName(
          `org:${org}:host:${target.host}`,
        ).cancelDelivery(delivery.id);
      } else {
        await this.env.ROOM.getByName(
          `org:${org}:room:${target.room}`,
        ).cancelChannelDelivery(delivery.id);
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "delivery_cancel_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * Metering seam — mirrors `HostHub` and `Room`. This distribution accepts
   * every ingested event and reply; a deployment that meters volume subclasses
   * `Integration` and overrides both methods together.
   */
  protected async canAcceptMessage(_org: string): Promise<boolean> {
    return true;
  }

  protected meterMessages(_org: string, _count: number): D1PreparedStatement | null {
    return null;
  }

  private mirrorIngest(
    meta: IntegrationMeta,
    event: StoredEvent,
    delivery: DeliveryRecord,
  ): void {
    // A meter statement, when a deployment supplies one, must stay directly
    // after the event insert: it keys off `changes()` so a replayed event that
    // the `INSERT OR IGNORE` swallowed is not counted twice.
    const meter = this.meterMessages(meta.org, 1);
    this.background(
      "integration_ingest_write_failed",
      this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO integration_event
           (id, integration_id, event_key, conversation_id, user, trigger, content, meta_json, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          event.id,
          meta.id,
          event.eventKey,
          event.conversationId,
          event.user ?? null,
          event.trigger ?? null,
          event.content,
          JSON.stringify(event.meta ?? {}),
          event.receivedAt,
        ),
        ...(meter ? [meter] : []),
        this.deliveryStatement(delivery),
      ]),
    );
  }

  private mirrorReplyCreated(
    meta: IntegrationMeta,
    delivery: DeliveryRecord,
    reply: ReplyRecord,
  ): void {
    const meter = this.meterMessages(meta.org, 1);
    this.background(
      "integration_reply_write_failed",
      this.env.DB.batch([
        this.replyStatement(reply),
        ...(meter ? [meter] : []),
        this.deliveryStatement(delivery),
      ]),
    );
  }

  private deliveryStatement(delivery: DeliveryRecord): D1PreparedStatement {
    return this.env.DB.prepare(
      `INSERT INTO integration_delivery
       (id, event_id, target_addr, status, attempts, injections, read_at, settled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         attempts = excluded.attempts,
         injections = excluded.injections,
         read_at = excluded.read_at,
         settled_at = excluded.settled_at`,
    ).bind(
      delivery.id,
      delivery.eventId,
      delivery.targetAddr,
      delivery.status,
      delivery.attempts,
      delivery.injections ?? 0,
      delivery.readAt ?? null,
      delivery.settledAt ?? null,
      delivery.createdAt,
    );
  }

  private replyStatement(reply: ReplyRecord): D1PreparedStatement {
    return this.env.DB.prepare(
      `INSERT INTO integration_reply
       (delivery_id, message, reply_mode, posted_at, post_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(delivery_id) DO UPDATE SET
         message = excluded.message,
         reply_mode = excluded.reply_mode,
         posted_at = excluded.posted_at,
         post_error = excluded.post_error`,
    ).bind(
      reply.deliveryId,
      reply.message,
      reply.replyMode ?? null,
      reply.postedAt ?? null,
      reply.postError ?? null,
      reply.createdAt,
    );
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
