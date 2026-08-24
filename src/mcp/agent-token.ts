import { hmacSign } from "../lib/transit/crypto";
import { type JwtClaims, signJwt, verifyJwt } from "../lib/transit/jwt";

/**
 * Access tokens for the `client_credentials` grant, where the subject IS an
 * agent.
 *
 * Better Auth cannot issue these. Its `oidcProvider` and `mcp` plugins reject
 * `client_credentials` outright, and their tokens structurally require a user
 * row to hang off — verified in the installed 1.6.22 source, not inferred from
 * docs. There is no service-principal shape to extend, so this is a small
 * endpoint beside Better Auth rather than a configuration of it.
 *
 * The claims are a HINT, not the authority. Everything that decides what a
 * caller may do — organization, host, agent name — is read back from the
 * `agent_client` row keyed by `client_id`, so a claim cannot widen what the
 * row grants and a revoked row stops working immediately rather than at the
 * next expiry.
 */

export const AGENT_TOKEN_TTL_SECONDS = 3600;
const AUDIENCE = "transit-mcp";
const SUBJECT_PREFIX = "agent:";

/**
 * Domain-separated from every other use of `BETTER_AUTH_SECRET`. Reusing that
 * secret directly would let a signature minted for one purpose verify as
 * another; the label is what stops that, and it costs a deployment no new
 * configuration.
 */
async function signingSecret(env: Env): Promise<string> {
  return hmacSign(env.BETTER_AUTH_SECRET, "transit-agent-token/1");
}

export type AgentTokenGrant = {
  clientId: string;
  org: string;
  host: string;
  name: string;
  scope: string;
};

export async function mintAgentToken(
  env: Env,
  grant: AgentTokenGrant,
  now = Date.now(),
): Promise<{ token: string; expiresIn: number }> {
  const issuedAt = Math.floor(now / 1000);
  const claims: JwtClaims = {
    iss: env.BETTER_AUTH_URL,
    aud: AUDIENCE,
    sub: `${SUBJECT_PREFIX}${grant.clientId}`,
    org: grant.org,
    host: grant.host,
    name: grant.name,
    ...(grant.scope ? { scope: grant.scope } : {}),
    iat: issuedAt,
    exp: issuedAt + AGENT_TOKEN_TTL_SECONDS,
  };
  return {
    token: await signJwt(claims, await signingSecret(env)),
    expiresIn: AGENT_TOKEN_TTL_SECONDS,
  };
}

/**
 * The client id this token was minted for, or null if it was not minted here,
 * has expired, or is not an agent token. Deliberately returns nothing else:
 * every other fact about the caller comes from the database row.
 */
export async function agentTokenSubject(
  env: Env,
  token: string,
  now = Date.now(),
): Promise<string | null> {
  const claims = await verifyJwt(token, await signingSecret(env), { now });
  if (!claims || claims.aud !== AUDIENCE) return null;
  if (typeof claims.sub !== "string" || !claims.sub.startsWith(SUBJECT_PREFIX)) {
    return null;
  }
  return claims.sub.slice(SUBJECT_PREFIX.length) || null;
}
