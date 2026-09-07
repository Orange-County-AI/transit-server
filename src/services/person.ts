import { validateName } from "../lib/transit/addr";
import { hostId } from "../lib/transit/ids";
import { ServiceError } from "./errors";

/**
 * A signed-in person's own Transit address.
 *
 * Transit used to hold that a person was not a participant: they had an
 * organization and no address, so every tool that acts AS somebody refused. The
 * reason was never that it could not work — it was that inventing a name in a
 * public namespace is a decision, not an inference. This module is that
 * decision made explicitly: the person picks the name, with `claim_name`, and
 * nothing is created until they do.
 *
 * What makes it work at all is that the daemonless path already exists. An
 * `agent_client` row makes an address routable with no session behind it, a
 * delivery with no sink waits in the recipient's HostHub, and `read_inbox`
 * reads it back. A person is that same shape with a different reason for having
 * no daemon: there is no box, rather than a box that is asleep.
 */

/**
 * The host every person in an organization lives on.
 *
 * A person is not on a machine, so the slug names what they are instead of
 * where they run: `stephan@people` reads as a person on sight, next to
 * `claude@titan`. One per organization, so the namespace it creates is exactly
 * as wide as the organization's own.
 */
export const PERSON_HOST_SLUG = "people";

/**
 * The `token_hash` a person host carries.
 *
 * `host.token_hash` is NOT NULL and unique because a host is normally something
 * a daemon enrolls into. Nothing may ever enroll into this one, so rather than
 * store the hash of a token nobody holds — which is only unreachable by
 * improbability — it stores a string that is not 64 hex characters and
 * therefore cannot be the SHA-256 of anything a caller could present. The
 * device-token lookup hashes what it is given and compares; no input hashes to
 * this.
 */
function personHostTokenHash(org: string): string {
  return `person-host:${org}`;
}

export type PersonAddress = {
  org: string;
  userId: string;
  host: string;
  hostId: string;
  name: string;
};

/**
 * The person host row, created on demand.
 *
 * Lazily rather than at organization creation: an organization whose people
 * never claim an address should not carry a host that shows up in listings and
 * in the dashboard as something an operator might try to enroll.
 */
async function ensurePersonHost(db: D1Database, org: string): Promise<string> {
  const existing = await db
    .prepare("SELECT id, revoked_at FROM host WHERE org_id = ? AND slug = ? LIMIT 1")
    .bind(org, PERSON_HOST_SLUG)
    .first<{ id: string; revoked_at: number | null }>();
  if (existing && existing.revoked_at === null) return existing.id;

  const id = existing?.id ?? hostId();
  await db
    .prepare(
      `INSERT INTO host
       (id, org_id, slug, token_hash, token_issued_at, daemon_ver, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, 'person', NULL, NULL)
       ON CONFLICT(org_id, slug) DO UPDATE SET revoked_at = NULL`,
    )
    .bind(id, org, PERSON_HOST_SLUG, personHostTokenHash(org), Date.now())
    .run();
  return id;
}

/** The address this person holds in this organization, or null if unclaimed. */
export async function resolvePersonAddress(
  db: D1Database,
  input: { org: string; userId: string },
): Promise<PersonAddress | null> {
  const row = await db
    .prepare(
      `SELECT p.name, p.host, h.id AS host_id
       FROM person_address p
       JOIN host h ON h.org_id = p.org_id AND h.slug = p.host
       WHERE p.org_id = ? AND p.user_id = ? AND h.revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(input.org, input.userId)
    .first<{ name: string; host: string; host_id: string }>();
  if (!row) return null;
  return {
    org: input.org,
    userId: input.userId,
    host: row.host,
    hostId: row.host_id,
    name: row.name,
  };
}

/**
 * Claim, or rename to, a name on the person host.
 *
 * One row per person per organization, so a second call is a rename rather than
 * a second identity — a person with two addresses is two participants as far as
 * every room membership and delivery queue is concerned, and nothing would ever
 * merge them back.
 *
 * The name must be free of every OTHER claim on that host: another person's,
 * and any agent client declared there. A roster entry cannot collide, because
 * no daemon can enroll this host.
 */
export async function claimPersonAddress(
  db: D1Database,
  input: { org: string; userId: string; name: string },
): Promise<PersonAddress> {
  try {
    validateName(input.name);
  } catch (error) {
    throw new ServiceError(
      "invalid_name",
      error instanceof Error ? error.message : "invalid name",
    );
  }

  const id = await ensurePersonHost(db, input.org);

  const takenByPerson = await db
    .prepare(
      `SELECT 1 AS present FROM person_address
       WHERE org_id = ? AND host = ? AND name = ? AND user_id <> ? LIMIT 1`,
    )
    .bind(input.org, PERSON_HOST_SLUG, input.name, input.userId)
    .first();
  const takenByAgent = await db
    .prepare(
      `SELECT 1 AS present FROM agent_client
       WHERE org_id = ? AND host = ? AND name = ? AND revoked_at IS NULL LIMIT 1`,
    )
    .bind(input.org, PERSON_HOST_SLUG, input.name)
    .first();
  if (takenByPerson || takenByAgent) {
    throw new ServiceError(
      "name_taken",
      `${input.name}@${PERSON_HOST_SLUG} is already claimed`,
    );
  }

  await db
    .prepare(
      `INSERT INTO person_address (org_id, user_id, host, name, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, user_id) DO UPDATE SET name = excluded.name`,
    )
    .bind(input.org, input.userId, PERSON_HOST_SLUG, input.name, Date.now())
    .run();

  return {
    org: input.org,
    userId: input.userId,
    host: PERSON_HOST_SLUG,
    hostId: id,
    name: input.name,
  };
}

/** Every claimed person address in an organization, for the fleet directory. */
export async function listPeople(
  db: D1Database,
  input: { org: string; host?: string | null },
): Promise<{ name: string; host: string; created_at: number }[]> {
  if (input.host && input.host !== PERSON_HOST_SLUG) return [];
  return (
    await db
      .prepare(
        `SELECT p.name, p.host, p.created_at
         FROM person_address p
         JOIN host h ON h.org_id = p.org_id AND h.slug = p.host
         WHERE p.org_id = ? AND h.revoked_at IS NULL
         ORDER BY p.name`,
      )
      .bind(input.org)
      .all<{ name: string; host: string; created_at: number }>()
  ).results;
}
