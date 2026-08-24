import { AddressError, formatAgentAddress, validateName } from "../lib/transit/addr";
import { sha256hex } from "../lib/transit/crypto";

/**
 * Who is calling `/mcp`. One shape, however the bearer was proved: the tool
 * layer must not be able to tell a device token from anything added later, or
 * a permission check written for one will silently not apply to the other.
 */
export type McpPrincipal = {
  org: string;
  /** Host slug. Durable Object names are `org:<org>:host:<host>`. */
  host: string;
  hostId: string;
  /**
   * The acting agent's name, or null when the caller did not name one. A
   * device token proves a host, not an agent, so the name is the caller's
   * assertion — which is exactly the authority that token already carries,
   * since its holder can publish any roster it likes over the daemon socket.
   */
  name: string | null;
  credential: "device_token";
};

export type PrincipalResolution =
  | { ok: true; principal: McpPrincipal }
  | { ok: false; reason: "unauthorized" }
  | { ok: false; reason: "invalid_agent"; message: string };

/** Header naming the agent a host-scoped credential is acting as. */
export const ACTING_AGENT_HEADER = "x-transit-agent";

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
): Promise<PrincipalResolution> {
  const token = bearerToken(headers);
  if (!token) return { ok: false, reason: "unauthorized" };

  const row = await env.DB.prepare(
    `SELECT id, org_id, slug FROM host
     WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
  )
    .bind(await sha256hex(token))
    .first<{ id: string; org_id: string; slug: string }>();
  if (!row) return { ok: false, reason: "unauthorized" };

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
  return principal.name ? formatAgentAddress(principal.name, principal.host) : null;
}
