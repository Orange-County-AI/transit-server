/**
 * The two documents a Claude connector reads before it will ever send a
 * request, and the challenge that points at the first of them.
 *
 * These are authored here rather than taken from Better Auth's `mcp` plugin,
 * for reasons that are each a connector failure in their own right:
 *
 *  - Its protected-resource document sets `resource` to the ORIGIN. Claude
 *    compares that field literally against the URL the user typed, which
 *    includes `/mcp`. A mismatch is the single most common way a connector
 *    silently never connects: our server sees the first request, the
 *    authorization server sees no traffic at all.
 *  - Its authorization-server metadata names a `userinfo_endpoint` and a
 *    `jwks_uri` under `/mcp/…` that the plugin does not mount, and declares
 *    `id_token_signing_alg_values_supported: ["RS256"]` while actually signing
 *    the id_token with HS256 under a key generated fresh on every request — a
 *    key no JWKS could ever publish and nobody can verify against.
 *  - Both are mounted under Better Auth's `/api/auth` base path, and Claude
 *    probes the root.
 *
 * Everything advertised below is either served by the plugin at the path named
 * or not advertised at all. `test/mcp-discovery.test.ts` fetches each one and
 * fails if it 404s, so this file cannot drift from what Better Auth mounts
 * without the suite saying so.
 */

/** Where Better Auth's endpoints live, relative to the deployment origin. */
const AUTH_BASE = "/api/auth";

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

/**
 * The one origin every document and the challenge are built from.
 *
 * `BETTER_AUTH_URL` and not the request's own origin, because these three
 * strings are compared to each other and a caller cannot be trusted to produce
 * the same one twice. Behind the assets router, a request for `/.well-known/*`
 * reaches the Worker with its URL rewritten to the configured custom domain
 * while a request for `/mcp` keeps the address the caller dialled — so deriving
 * from the request handed Claude a challenge pointing at one origin and a
 * `resource` naming another. That disagreement is invisible in tests that speak
 * to the Worker on one origin, and fatal in production, where it presents as a
 * connector that silently never connects.
 *
 * `BETTER_AUTH_URL` is already the deployment's canonical public origin — it is
 * what auth callbacks and enrollment commands are written against — and it is
 * the URL a user types into the connector dialog. Falling back to the request
 * keeps a fresh self-hosted Worker working before the var is set, the same way
 * `/api/hosts/enroll` does.
 */
function canonicalOrigin(env: Env, request: Request): string {
  try {
    return new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    return new URL(request.url).origin;
  }
}

export function mcpResourceUrl(env: Env, request: Request): string {
  return `${canonicalOrigin(env, request)}/mcp`;
}

/** The `WWW-Authenticate` value a 401 from `/mcp` carries. RFC 9728 §5.1. */
export function bearerChallenge(env: Env, request: Request): string {
  const origin = canonicalOrigin(env, request);
  return `Bearer resource_metadata="${origin}${PROTECTED_RESOURCE_PATH}"`;
}

/** RFC 9728 protected-resource metadata. */
export function protectedResourceMetadata(
  env: Env,
  request: Request,
): Record<string, unknown> {
  const origin = canonicalOrigin(env, request);
  return {
    // Exactly the MCP endpoint URL, not the origin. See the note above.
    resource: `${origin}/mcp`,
    // Claude reads entry zero and does not fall back to later ones, so there is
    // exactly one and it is the issuer whose metadata is served below.
    authorization_servers: [origin],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/docs`,
  };
}

/** RFC 8414 authorization-server metadata. */
export function authorizationServerMetadata(
  env: Env,
  request: Request,
): Record<string, unknown> {
  const origin = canonicalOrigin(env, request);
  return {
    // Must equal the `authorization_servers` entry that led a client here, and
    // must be the origin this document is served from under RFC 8414 §3.
    issuer: origin,
    authorization_endpoint: `${origin}${AUTH_BASE}/mcp/authorize`,
    token_endpoint: `${origin}${AUTH_BASE}/mcp/token`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Required on every request and required to be advertised. Plain is not
    // offered: the plugin refuses it unless explicitly enabled, and it is not.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    subject_types_supported: ["public"],
    service_documentation: `${origin}/docs`,
    // Deliberately absent, and each absence is a fact rather than an oversight:
    //   userinfo_endpoint - the plugin mounts none.
    //   jwks_uri          - access tokens are opaque and looked up in the
    //                       database, and the id_token is signed with a
    //                       per-request throwaway key. There is no public key
    //                       to publish and nothing a client could verify.
    //   id_token_signing_alg_values_supported - would have to say HS256 with a
    //                       key the client never sees, which tells a client
    //                       nothing it can act on.
    //   registration_endpoint - dynamic client registration is gated behind an
    //                       authenticated organization admin, so it is not a
    //                       door a connector can walk through on its own. An
    //                       operator registers the client and enters its id and
    //                       secret into Claude as a custom connector. Better to
    //                       omit it than to advertise a URL that answers 401.
    //   client_id_metadata_document_supported - CIMD is not implemented.
  };
}
