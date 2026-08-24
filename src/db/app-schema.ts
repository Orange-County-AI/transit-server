import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Hand-written app tables. Unlike schema.ts (regenerated wholesale by
// `bun run auth:generate`), this file is never touched by the Better Auth
// CLI — put custom tables here, not in schema.ts.

export const host = sqliteTable(
  "host",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    slug: text("slug").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenIssuedAt: integer("token_issued_at", { mode: "timestamp_ms" }).notNull(),
    daemonVer: text("daemon_ver").notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("host_org_slug_unique").on(table.orgId, table.slug),
    uniqueIndex("host_token_hash_unique").on(table.tokenHash),
    index("host_org_revoked_idx").on(table.orgId, table.revokedAt),
  ],
);

/**
 * An OAuth client that IS an agent.
 *
 * A device token proves a host and says nothing about who is acting on it; this
 * says exactly who. The subject of the token minted from it is the agent, which
 * is what lets identity stop being derived from a Herdr pane id or a PPID walk
 * and start being declared and proved.
 *
 * `host` and `name` are the agent's address, and `host` names a `host` row in
 * the same organization rather than a free string: revoking a host must take
 * its agent clients with it. Several rows may name one agent, which is what
 * rotating a secret without an outage looks like.
 *
 * There is deliberately no `scopes` column. Nothing enforces a scope anywhere
 * in Transit, and a column named `scopes` is read as a permission boundary by
 * whoever arrives next however carefully its absence of meaning is documented.
 * It goes in when enforcement exists to give it one.
 */
export const agentClient = sqliteTable(
  "agent_client",
  {
    clientId: text("client_id").primaryKey(),
    orgId: text("org_id").notNull(),
    host: text("host").notNull(),
    name: text("name").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("agent_client_secret_hash_unique").on(table.secretHash),
    index("agent_client_org_revoked_idx").on(table.orgId, table.revokedAt),
  ],
);

export const enrollCode = sqliteTable(
  "enroll_code",
  {
    codeHash: text("code_hash").primaryKey(),
    orgId: text("org_id").notNull(),
    slug: text("slug").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("enroll_code_org_slug_idx").on(table.orgId, table.slug)],
);

export const agentSnapshot = sqliteTable(
  "agent_snapshot",
  {
    hostId: text("host_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    paneId: text("pane_id").notNull(),
    status: text("status").notNull(),
    namedBy: text("named_by", { enum: ["user", "auto"] }).notNull(),
    title: text("title").notNull(),
    cwd: text("cwd").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.hostId, table.name] }),
    index("agent_snapshot_host_status_idx").on(table.hostId, table.status),
    check("agent_snapshot_named_by_check", sql`${table.namedBy} in ('user', 'auto')`),
  ],
);

export const room = sqliteTable(
  "room",
  {
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    policy: text("policy", { enum: ["open", "invite"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.name] }),
    check("room_policy_check", sql`${table.policy} in ('open', 'invite')`),
  ],
);

// `org_id` is the ROOM OWNER's organization; `member_org_id` is the MEMBER's
// own organization; for a home member they are equal. The `(org_id, room,
// address)` key stays unique because foreign canonical addresses are
// organization-qualified.
export const roomMember = sqliteTable(
  "room_member",
  {
    orgId: text("org_id").notNull(),
    memberOrgId: text("member_org_id").notNull().default(""),
    room: text("room").notNull(),
    address: text("address").notNull(),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.room, table.address] }),
    index("room_member_address_idx").on(table.orgId, table.address),
  ],
);

export const message = sqliteTable(
  "message",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    recipientOrgId: text("recipient_org_id"),
    kind: text("kind", { enum: ["dm", "room"] }).notNull(),
    fromAddr: text("from_addr").notNull(),
    toAddr: text("to_addr").notNull(),
    roomSeq: integer("room_seq"),
    body: text("body").notNull(),
    replyTo: text("reply_to"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("message_org_created_idx").on(table.orgId, table.createdAt),
    index("message_org_to_created_idx").on(table.orgId, table.toAddr, table.createdAt),
    check("message_kind_check", sql`${table.kind} in ('dm', 'room')`),
    check(
      "message_room_seq_check",
      sql`(${table.kind} = 'dm' and ${table.roomSeq} is null) or (${table.kind} = 'room' and ${table.roomSeq} is not null)`,
    ),
  ],
);

export const messageDelivery = sqliteTable(
  "message_delivery",
  {
    messageId: text("message_id").notNull(),
    targetAddr: text("target_addr").notNull(),
    status: text("status", { enum: ["queued", "injected", "dead"] })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // How the delivery actually reached the agent: `adapter` for the harness's
    // own native client, `herdr` for a pane injection, `transcript` for a
    // redelivery settled from a session file. Deliberately not an enum: a
    // daemon older than this column reports nothing, and a newer one may
    // report a transport this Worker has not heard of. Neither is worth
    // rejecting a delivery ack over.
    via: text("via"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.targetAddr] }),
    index("message_delivery_target_status_idx").on(table.targetAddr, table.status),
    check(
      "message_delivery_status_check",
      sql`${table.status} in ('queued', 'injected', 'dead')`,
    ),
  ],
);

export const integration = sqliteTable(
  "integration",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    connector: text("connector").notNull(),
    name: text("name").notNull(),
    configEnc: text("config_enc").notNull(),
    targetAddr: text("target_addr").notNull(),
    status: text("status", { enum: ["active", "paused"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("integration_org_status_idx").on(table.orgId, table.status),
    check("integration_status_check", sql`${table.status} in ('active', 'paused')`),
  ],
);

export const integrationEvent = sqliteTable(
  "integration_event",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id").notNull(),
    eventKey: text("event_key").notNull(),
    conversationId: text("conversation_id").notNull(),
    user: text("user"),
    trigger: text("trigger"),
    content: text("content").notNull(),
    metaJson: text("meta_json", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("integration_event_key_unique").on(table.integrationId, table.eventKey),
    index("integration_event_received_idx").on(table.integrationId, table.receivedAt),
  ],
);

export const integrationDelivery = sqliteTable(
  "integration_delivery",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    targetAddr: text("target_addr").notNull(),
    status: text("status", {
      enum: ["pending", "dispatched", "read", "replied", "handled", "dead"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    // Times this delivery actually reached an agent, counted from the daemon's
    // ack. `attempts` counts dispatches, and a dispatch the host answers
    // "duplicate" injects nothing — so reading `attempts` as arrivals
    // overstates them, which is exactly how a 3-arrival delivery got reported
    // as 49.
    injections: integer("injections").notNull().default(0),
    // Envelopes the HostHub actually wrote to a daemon socket. The queue
    // retries an unacked entry, and none of those sends were recorded here at
    // all, so a delivery an agent saw four times read as one attempt.
    wireSends: integer("wire_sends").notNull().default(0),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    // The transport that carried this channel delivery to its agent, written
    // by the HostHub when the daemon acks. Same reasoning as
    // message_delivery.via: a delivery that reached an agent by being typed
    // into a pane and one that reached its adapter are indistinguishable
    // otherwise, and a channel delivery is the case an operator is least able
    // to observe directly.
    via: text("via"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("integration_delivery_event_idx").on(table.eventId),
    index("integration_delivery_target_status_idx").on(table.targetAddr, table.status),
    index("integration_delivery_status_created_idx").on(table.status, table.createdAt),
    check(
      "integration_delivery_status_check",
      sql`${table.status} in ('pending', 'dispatched', 'read', 'replied', 'handled', 'dead')`,
    ),
  ],
);

export const integrationReply = sqliteTable(
  "integration_reply",
  {
    deliveryId: text("delivery_id").primaryKey(),
    message: text("message").notNull(),
    replyMode: text("reply_mode", { enum: ["root", "thread"] }),
    postedAt: integer("posted_at", { mode: "timestamp_ms" }),
    postError: text("post_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    check(
      "integration_reply_mode_check",
      sql`${table.replyMode} is null or ${table.replyMode} in ('root', 'thread')`,
    ),
  ],
);

export const ingestSource = sqliteTable(
  "ingest_source",
  {
    orgId: text("org_id").notNull(),
    source: text("source").notNull(),
    secretEnc: text("secret_enc").notNull(),
    replyUrl: text("reply_url"),
    replyUrlPrefixes: text("reply_url_prefixes", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    instructions: text("instructions"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.source] })],
);

export const usageMonth = sqliteTable(
  "usage_month",
  {
    orgId: text("org_id").notNull(),
    period: text("period").notNull(),
    messages: integer("messages").notNull().default(0),
    graceStartedAt: integer("grace_started_at", { mode: "timestamp_ms" }),
    warningSentAt: integer("warning_sent_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.period] })],
);

export const organizationConnection = sqliteTable(
  "organization_connection",
  {
    id: text("id").primaryKey(),
    orgAId: text("org_a_id").notNull(),
    orgBId: text("org_b_id").notNull(),
    requestedByOrgId: text("requested_by_org_id").notNull(),
    status: text("status", { enum: ["pending", "active"] })
      .notNull()
      .default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("organization_connection_pair_unique").on(table.orgAId, table.orgBId),
    index("organization_connection_org_a_status_idx").on(table.orgAId, table.status),
    index("organization_connection_org_b_status_idx").on(table.orgBId, table.status),
    check(
      "organization_connection_pair_order_check",
      sql`${table.orgAId} < ${table.orgBId}`,
    ),
    check(
      "organization_connection_requester_check",
      sql`${table.requestedByOrgId} = ${table.orgAId} or ${table.requestedByOrgId} = ${table.orgBId}`,
    ),
    check(
      "organization_connection_status_check",
      sql`${table.status} in ('pending', 'active')`,
    ),
  ],
);
