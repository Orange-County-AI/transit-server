import { formatAgentAddress, formatRoomAddress } from "../lib/transit/addr";
import { resolveConnectedOrganization } from "../lib/transit/organizations";
import { ServiceError } from "./errors";

/**
 * Who and what exists in a fleet, answered once.
 *
 * `list_agents` and `list_rooms` are the two questions Transit answers through
 * both an HTTP route and an MCP tool, and each pair used to carry its own copy
 * of the SQL, its own ordering and its own rule for qualifying a foreign
 * organization's addresses. They had already drifted: the roster query ordered
 * by agent name over HTTP and by host-then-name over the wire. Nothing depended
 * on the difference, which is exactly why it survived — the next one might not
 * be so lucky.
 *
 * Deliberately takes a `D1Database` and not a request or an `Env`. A Durable
 * Object and a Hono handler have nothing else in common, and a service that
 * needed either would only be callable from one of them.
 */

export type AgentListing = {
  name: string;
  kind: string;
  pane_id: string;
  status: string;
  named_by: "user" | "auto";
  title: string;
  cwd: string;
  host: string;
  updated_at: number;
  /** Present only for a connected organization's roster. */
  organization?: string;
  address?: string;
};

export type RoomListing = {
  name: string;
  policy: string;
  created_at: number;
  members: number;
  /** Present only when the caller asked for the activity window. */
  messages_24h?: number;
  organization?: string;
  address?: string;
};

/**
 * Which organization's directory to read, and how its addresses are written.
 * A slug names a *connected* organization: the caller's own is the default and
 * has no slug, and its addresses stay bare.
 */
type Scope = { org: string; slug: string | null };

async function scopeFor(
  db: D1Database,
  org: string,
  organization: string | null | undefined,
): Promise<Scope> {
  if (!organization) return { org, slug: null };
  const connected = await resolveConnectedOrganization(db, org, organization);
  if (!connected) {
    throw new ServiceError(
      "organization_not_connected",
      "organization is not connected",
    );
  }
  return { org: connected.targetOrgId, slug: connected.targetSlug };
}

const AGENT_COLUMNS = `a.name, a.kind, a.pane_id, a.status, a.named_by, a.title,
                       a.cwd, a.updated_at, h.slug AS host`;

export async function listAgents(
  db: D1Database,
  input: { org: string; host?: string | null; organization?: string | null },
): Promise<AgentListing[]> {
  const scope = await scopeFor(db, input.org, input.organization);
  const statement = input.host
    ? db
        .prepare(
          `SELECT ${AGENT_COLUMNS}
           FROM agent_snapshot a JOIN host h ON h.id = a.host_id
           WHERE h.org_id = ? AND h.slug = ? AND h.revoked_at IS NULL
           ORDER BY h.slug, a.name`,
        )
        .bind(scope.org, input.host)
    : db
        .prepare(
          `SELECT ${AGENT_COLUMNS}
           FROM agent_snapshot a JOIN host h ON h.id = a.host_id
           WHERE h.org_id = ? AND h.revoked_at IS NULL
           ORDER BY h.slug, a.name`,
        )
        .bind(scope.org);
  const agents = (await statement.all<AgentListing>()).results;
  if (!scope.slug) return agents;
  const slug = scope.slug;
  return agents.map((agent) => ({
    ...agent,
    organization: slug,
    address: formatAgentAddress(agent.name, agent.host, slug),
  }));
}

export async function listRooms(
  db: D1Database,
  input: {
    org: string;
    organization?: string | null;
    /**
     * When set, each room also carries the messages posted to it inside this
     * window. The dashboard shows it; a tool listing does not ask for it, and
     * adding the join unconditionally would put a column in a tool result that
     * nothing reads.
     */
    activityWindowMs?: number;
  },
): Promise<RoomListing[]> {
  const scope = await scopeFor(db, input.org, input.organization);
  // `room_member.org_id` is the room OWNER's organization, not the member's.
  const statement =
    input.activityWindowMs === undefined
      ? db
          .prepare(
            `SELECT r.name, r.policy, r.created_at,
                    COUNT(DISTINCT rm.address) AS members
             FROM room r
             LEFT JOIN room_member rm ON rm.org_id = r.org_id AND rm.room = r.name
             WHERE r.org_id = ?
             GROUP BY r.org_id, r.name
             ORDER BY r.name`,
          )
          .bind(scope.org)
      : db
          .prepare(
            `SELECT r.name, r.policy, r.created_at,
                    COUNT(DISTINCT rm.address) AS members,
                    COUNT(DISTINCT CASE WHEN msg.created_at >= ? THEN msg.id END)
                      AS messages_24h
             FROM room r
             LEFT JOIN room_member rm ON rm.org_id = r.org_id AND rm.room = r.name
             LEFT JOIN message msg
               ON msg.org_id = r.org_id AND msg.to_addr = '#' || r.name
              AND msg.kind = 'room'
             WHERE r.org_id = ?
             GROUP BY r.org_id, r.name
             ORDER BY r.name`,
          )
          .bind(Date.now() - input.activityWindowMs, scope.org);
  const rooms = (await statement.all<RoomListing>()).results;
  if (!scope.slug) return rooms;
  const slug = scope.slug;
  return rooms.map((room) => ({
    ...room,
    organization: slug,
    address: `${slug}/${formatRoomAddress(room.name)}`,
  }));
}

/** Whether a live agent by this name exists on this host, in this org. */
export async function agentExists(
  db: D1Database,
  input: { org: string; host: string; name: string },
): Promise<boolean> {
  return Boolean(
    await db
      .prepare(
        `SELECT 1 AS present
         FROM agent_snapshot a JOIN host h ON h.id = a.host_id
         WHERE h.org_id = ? AND h.slug = ? AND a.name = ? AND h.revoked_at IS NULL
         LIMIT 1`,
      )
      .bind(input.org, input.host, input.name)
      .first(),
  );
}

/**
 * The integration a channel delivery belongs to, scoped by organization so a
 * delivery id from another tenant reads as absent rather than as forbidden.
 */
export async function integrationForDelivery(
  db: D1Database,
  input: { org: string; deliveryId: string },
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT e.integration_id
       FROM integration_delivery d
       JOIN integration_event e ON e.id = d.event_id
       JOIN integration i ON i.id = e.integration_id
       WHERE d.id = ? AND i.org_id = ? LIMIT 1`,
    )
    .bind(input.deliveryId, input.org)
    .first<{ integration_id: string }>();
  return row?.integration_id ?? null;
}
