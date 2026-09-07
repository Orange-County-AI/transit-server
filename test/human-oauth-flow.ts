import { SELF } from "cloudflare:test";
import { expect } from "vitest";

/**
 * The authorization-code flow a person goes through, as a callable step.
 *
 * Two suites need a working person's access token: the one that proves the
 * flow itself is correct, and the one that proves what a person can then DO.
 * A second copy of the dance would drift from the first, and the half that
 * drifted would be whichever suite nobody was reading — so there is one.
 */

export const ORIGIN = "http://localhost";
export const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export async function signUp(email: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "test1234!", name: "Operator" }),
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

export async function registerClient(cookie: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect([200, 201]).toContain(response.status);
  return (await response.json<{ client_id: string }>()).client_id;
}

export function authorizeUrl(
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {},
): string {
  return `${ORIGIN}/api/auth/mcp/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "openid profile email offline_access",
    state: "opaque-state",
    ...extra,
  })}`;
}

export async function exchange(
  clientId: string,
  code: string,
  verifier: string,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
}

export type ToolAnswer = { text: string; isError?: boolean };

/** One `tools/call` against `/mcp` with a person's bearer. */
export async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<ToolAnswer> {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json<{
    result: { content: { text: string }[]; isError?: boolean };
  }>();
  return { text: body.result.content[0]!.text, isError: body.result.isError };
}

/**
 * Sign up, register a client, consent, and come back holding a working `/mcp`
 * access token plus the browser cookie that minted it.
 */
export async function signedInPerson(
  email: string,
): Promise<{ cookie: string; token: string }> {
  const cookie = await signUp(email);
  const clientId = await registerClient(cookie);
  const { verifier, challenge } = await pkce();

  const authorized = await SELF.fetch(authorizeUrl(clientId, challenge), {
    headers: { cookie, origin: ORIGIN },
    redirect: "manual",
  });
  const consentRedirect = new URL(authorized.headers.get("location") ?? "", ORIGIN);
  const approved = await SELF.fetch(`${ORIGIN}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({
      accept: true,
      consent_code: consentRedirect.searchParams.get("consent_code"),
    }),
  });
  expect(approved.status, await approved.clone().text()).toBe(200);
  const code = new URL(
    (await approved.json<{ redirectURI: string }>()).redirectURI,
  ).searchParams.get("code");

  const tokenResponse = await exchange(clientId, code!, verifier);
  expect(tokenResponse.status, await tokenResponse.clone().text()).toBe(200);
  const { access_token } = await tokenResponse.json<{ access_token: string }>();
  return { cookie, token: access_token };
}
