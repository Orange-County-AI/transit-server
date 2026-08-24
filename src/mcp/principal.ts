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
  /** Host slug. Durable Object names are `org:<org>:host:<host>`. */
  host: string;
  hostId: string;
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
  credential: "device_token" | "agent_client";
  /** Present only for an agent client. Reserved: nothing enforces scope yet. */
  clientId?: string;
  scope?: string;
};

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
): Promise<PrincipalResolution> {
  const token = bearerToken(headers);
  if (!token) return UNAUTHORIZED;
  // A device token is base64url of 32 random bytes and never contains a dot, so
  // the shape picks the path without either verifier seeing the other's input.
  // A malformed agent token does NOT fall through to the device-token lookup.
  return looksLikeJwt(token)
    ? resolveAgentClient(env, token)
    : resolveDeviceToken(env, token, headers);
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
    `SELECT c.org_id, c.host, c.name, c.scopes, h.id AS host_id
     FROM agent_client c
     JOIN host h ON h.org_id = c.org_id AND h.slug = c.host
     WHERE c.client_id = ? AND c.revoked_at IS NULL AND h.revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(clientId)
    .first<{
      org_id: string;
      host: string;
      name: string;
      scopes: string;
      host_id: string;
    }>();
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
      scope: row.scopes,
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
  return principal.name ? formatAgentAddress(principal.name, principal.host) : null;
}
