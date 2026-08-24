import { AddressError, formatAgentAddress, validateName } from "../lib/transit/addr";
import { sha256hex } from "../lib/transit/crypto";
import { looksLikeJwt } from "../lib/transit/jwt";
import { agentTokenSubject } from "./agent-token";

/**
 * Who is calling `/mcp`. One shape, however the bearer was proved: the tool
 * layer must not be able to tell one credential from another, or a check
 * written for one will silently not apply to the other.
 */
export type McpPrincipal = {
  org: string;
  /**
   * Host slug, or null for a principal that is not on a host at all — today
   * that means a signed-in person. Durable Object names are
   * `org:<org>:host:<host>`, so a null host is a principal that cannot reach a
   * HostHub and therefore cannot act as an agent.
   */
  host: string | null;
  hostId: string | null;
  /**
   * The acting agent's name, or null when nothing named one.
   *
   * For a device token this is the caller's assertion, via the
   * `X-Transit-Agent` header — which is exactly the authority that token
   * already carries, since its holder can publish any roster it likes over the
   * daemon socket. For an agent client it comes from the `agent_client` row and
   * cannot be overridden; see {@link resolvePrincipal}.
   */
  name: string | null;
  credential: "device_token" | "agent_client" | "user_session";
  /** Present only for an agent client. */
  clientId?: string;
  /**
   * The scopes a person's OAuth grant carries, verbatim from Better Auth.
   * Recorded, never consulted: nothing in Transit enforces a scope, and an
   * agent credential deliberately carries none at all.
   */
  scope?: string;
  /** Present only for a signed-in person. */
  userId?: string;
};

/**
 * Reads a Better Auth `mcp` access token, which is opaque and looked up in the
 * database rather than verified. Supplied by the caller because it needs the
 * Better Auth instance, and that is assembled from deployment-supplied plugins
 * the `src/mcp/` modules deliberately know nothing about.
 */
export type McpSessionReader = (
  headers: Headers,
) => Promise<{ userId: string; scopes?: string | null } | null>;

export type PrincipalResolution =
  | { ok: true; principal: McpPrincipal }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "invalid_agent"; message: string };

/** Header naming the agent a host-scoped credential is acting as. */
export const ACTING_AGENT_HEADER = "x-transit-agent";

const UNAUTHORIZED = { ok: false, reason: "unauthorized" } as const;

export function bearerToken(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization) return null;
  // RFC 6750 §2.1 makes the scheme case-insensitive, and clients do vary.
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

export async function resolvePrincipal(
  env: Env,
  headers: Headers,
  mcpSession?: McpSessionReader,
): Promise<PrincipalResolution> {
  const token = bearerToken(headers);
  if (!token) return UNAUTHORIZED;
  // A device token is base64url of 32 random bytes and never contains a dot, so
  // the shape picks the path without either verifier seeing the other's input.
  // A malformed agent token does NOT fall through to the device-token lookup.
  if (looksLikeJwt(token)) return resolveAgentClient(env, token);

  const device = await resolveDeviceToken(env, token, headers);
  if (device.ok || device.reason === "invalid_agent") return device;
  // A Better Auth access token is also dot-free, so it can only be told from a
  // device token by asking. Tried second, and only on a miss, so the common
  // case stays one query.
  return mcpSession ? resolveUserSession(env, headers, mcpSession) : UNAUTHORIZED;
}

/**
 * A signed-in person, reached through the authorization-code flow Claude
 * performs. They have an organization and no address: `host` and `name` are
 * null, so every tool that acts AS an agent refuses with a message saying so,
 * and the ones that only observe work.
 */
async function resolveUserSession(
  env: Env,
  headers: Headers,
  mcpSession: McpSessionReader,
): Promise<PrincipalResolution> {
  const session = await mcpSession(headers);
  if (!session) return UNAUTHORIZED;
  // Scoped exactly as a browser session is: the membership row is what makes an
  // organization theirs, not a claim in a token.
  //
  // The dashboard follows `session.activeOrganizationId`, which this cannot:
  // that choice lives on a browser session and an access token outlives it. So
  // the personal organization is preferred - `id` equals the user id, and it is
  // what a new session defaults to - with the oldest membership as the
  // fallback. The consequence, which nothing here can fix without recording the
  // choice at authorize time: a multi-org member who switches organizations in
  // the UI keeps acting in their personal one over MCP. The membership row
  // still bounds it, so this is surprising rather than permissive.
  const membership = await env.DB.prepare(
    `SELECT organization_id FROM member
     WHERE user_id = ?
     ORDER BY CASE WHEN organization_id = ? THEN 0 ELSE 1 END, created_at
     LIMIT 1`,
  )
    .bind(session.userId, session.userId)
    .first<{ organization_id: string }>();
  if (!membership) return UNAUTHORIZED;
  return {
    ok: true,
    principal: {
      org: membership.organization_id,
      host: null,
      hostId: null,
      name: null,
      credential: "user_session",
      userId: session.userId,
      ...(session.scopes ? { scope: session.scopes } : {}),
    },
  };
}

/**
 * An agent client's token. Its subject IS the agent, so `X-Transit-Agent` is
 * ignored here — not merged, not preferred.
 *
 * This is the one place the header would be an escalation rather than the
 * equivalence it is for a device token: honouring it would let a credential
 * minted for one agent act as another, in the same organization, with no
 * further proof. The header is host-scoped authority standing in for an
 * identity that was never proved; a token IS the proof, and nothing may
 * override it.
 */
async function resolveAgentClient(
  env: Env,
  token: string,
): Promise<PrincipalResolution> {
  const clientId = await agentTokenSubject(env, token);
  if (!clientId) return UNAUTHORIZED;

  // Everything below comes from the row, never from a claim: a claim cannot
  // widen what the row grants, and a revoked row stops working now rather than
  // at the token's expiry. The host join is why revoking a host revokes its
  // agent clients too.
  const row = await env.DB.prepare(
    `SELECT c.org_id, c.host, c.name, h.id AS host_id
     FROM agent_client c
     JOIN host h ON h.org_id = c.org_id AND h.slug = c.host
     WHERE c.client_id = ? AND c.revoked_at IS NULL AND h.revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(clientId)
    .first<{ org_id: string; host: string; name: string; host_id: string }>();
  if (!row) return UNAUTHORIZED;

  return {
    ok: true,
    principal: {
      org: row.org_id,
      host: row.host,
      hostId: row.host_id,
      name: row.name,
      credential: "agent_client",
      clientId,
    },
  };
}

async function resolveDeviceToken(
  env: Env,
  token: string,
  headers: Headers,
): Promise<PrincipalResolution> {
  const row = await env.DB.prepare(
    `SELECT id, org_id, slug FROM host
     WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
  )
    .bind(await sha256hex(token))
    .first<{ id: string; org_id: string; slug: string }>();
  if (!row) return UNAUTHORIZED;

  const declared = headers.get(ACTING_AGENT_HEADER)?.trim();
  if (declared) {
    try {
      validateName(declared);
    } catch (error) {
      return {
        ok: false,
        reason: "invalid_agent",
        message:
          error instanceof AddressError
            ? `${ACTING_AGENT_HEADER}: ${error.message}`
            : `${ACTING_AGENT_HEADER} is not a valid agent name`,
      };
    }
  }

  return {
    ok: true,
    principal: {
      org: row.org_id,
      host: row.slug,
      hostId: row.id,
      name: declared || null,
      credential: "device_token",
    },
  };
}

/** `name@host` for a principal that named an agent. */
export function principalAddress(principal: McpPrincipal): string | null {
  return principal.name && principal.host
    ? formatAgentAddress(principal.name, principal.host)
    : null;
}
