import { sha256hex } from "../lib/transit/crypto";
import { mintAgentToken } from "./agent-token";

/**
 * `POST /oauth/token`, `grant_type=client_credentials` only.
 *
 * This exists beside Better Auth rather than inside it because neither its
 * `oidcProvider` nor its `mcp` plugin will do this grant: both advertise only
 * `authorization_code` and `refresh_token` and throw `unsupported_grant_type`
 * on anything else, and both structurally require a user row behind a token.
 * There is no service-principal shape to extend. Checked in the installed
 * 1.6.22 source, not in the docs.
 *
 * Nothing here serves a human. A person reaches Transit through the
 * authorization-code flow, which is the only one Claude will perform; this is
 * for an agent proving it is itself.
 */

type ClientCredentials = { clientId: string; secret: string };

function tokenError(
  error: string,
  description: string,
  status = 400,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      // RFC 6749 §5.1: a token response must never be cached, and neither must
      // the failure that says why one was refused.
      "cache-control": "no-store",
      pragma: "no-cache",
      ...headers,
    },
  });
}

/** RFC 6749 §2.3.1 form-encodes both halves of a Basic credential. */
function basicCredentials(headers: Headers): ClientCredentials | null {
  const authorization = headers.get("authorization");
  const match = /^Basic[ ]+(.+)$/i.exec(authorization?.trim() ?? "");
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      secret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

function scopeSet(scopes: string): Set<string> {
  return new Set(scopes.split(" ").filter(Boolean));
}

export async function handleTokenRequest(env: Env, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return tokenError("invalid_request", "the token endpoint takes POST", 405, {
      allow: "POST",
    });
  }

  let form: URLSearchParams;
  try {
    // Deliberately not `request.formData()`: the token endpoint takes
    // `application/x-www-form-urlencoded` and nothing else, and reading a
    // multipart body here would accept a request no OAuth client sends.
    // Decoded from bytes rather than `.text()`, which warns on this very
    // content type.
    form = new URLSearchParams(
      new TextDecoder().decode(await request.arrayBuffer()),
    );
  } catch {
    return tokenError("invalid_request", "body must be form-urlencoded");
  }

  if (form.get("grant_type") !== "client_credentials") {
    return tokenError(
      "unsupported_grant_type",
      "this endpoint issues agent tokens for grant_type=client_credentials",
    );
  }

  const basic = basicCredentials(request.headers);
  const credentials: ClientCredentials | null = basic ?? {
    clientId: form.get("client_id") ?? "",
    secret: form.get("client_secret") ?? "",
  };
  if (!credentials.clientId || !credentials.secret) {
    return tokenError(
      "invalid_client",
      "client_id and client_secret are required",
      401,
      basic ? { "www-authenticate": 'Basic realm="transit"' } : {},
    );
  }

  // Matched on the hash, not fetched and compared, so the query never returns a
  // row for a wrong secret — the same discipline `host.token_hash` uses. The
  // host join is what makes revoking a host revoke its agent clients.
  const row = await env.DB.prepare(
    `SELECT c.client_id, c.org_id, c.host, c.name, c.scopes
     FROM agent_client c
     JOIN host h ON h.org_id = c.org_id AND h.slug = c.host
     WHERE c.client_id = ? AND c.secret_hash = ?
       AND c.revoked_at IS NULL AND h.revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(credentials.clientId, await sha256hex(credentials.secret))
    .first<{
      client_id: string;
      org_id: string;
      host: string;
      name: string;
      scopes: string;
    }>();
  if (!row) {
    return tokenError("invalid_client", "client authentication failed", 401);
  }

  // A request may narrow what its row was granted; it may never widen it.
  // Nothing enforces scope on the tool surface yet — see `agent_client`.
  let scope = row.scopes;
  const requested = form.get("scope");
  if (requested !== null) {
    const granted = scopeSet(row.scopes);
    const asked = [...scopeSet(requested)];
    if (asked.some((entry) => !granted.has(entry))) {
      return tokenError("invalid_scope", "requested scope exceeds this client's grant");
    }
    scope = asked.join(" ");
  }

  const minted = await mintAgentToken(env, {
    clientId: row.client_id,
    org: row.org_id,
    host: row.host,
    name: row.name,
    scope,
  });

  await env.DB.prepare("UPDATE agent_client SET last_used_at = ? WHERE client_id = ?")
    .bind(Date.now(), row.client_id)
    .run();

  return new Response(
    JSON.stringify({
      access_token: minted.token,
      token_type: "Bearer",
      expires_in: minted.expiresIn,
      ...(scope ? { scope } : {}),
    }),
    {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}
