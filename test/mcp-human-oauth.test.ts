import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The whole authorization-code flow a person goes through, ending in an access
 * token used against `/mcp`.
 *
 * Discovery being correct proves Claude will start; only this proves it will
 * finish. The consent leg is exercised too, because that redirect is the one
 * step that leaves the API and lands in the SPA.
 */

const ORIGIN = "http://localhost";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function signUp(email: string): Promise<string> {
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

async function registerClient(cookie: string): Promise<string> {
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

function authorizeUrl(
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

async function exchange(
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

async function callTool(token: string, name: string): Promise<{ text: string; isError?: boolean }> {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json<{
    result: { content: { text: string }[]; isError?: boolean };
  }>();
  return { text: body.result.content[0]!.text, isError: body.result.isError };
}

describe("human OAuth against /mcp", () => {
  it("carries a signed-in person from authorize to a working access token", async () => {
    const cookie = await signUp("mcp-human@test.example");
    const clientId = await registerClient(cookie);
    const { verifier, challenge } = await pkce();

    // The room proves the token is scoped to this person's organization rather
    // than to nothing at all.
    const room = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ name: "ops", policy: "open" }),
    });
    expect(room.status).toBe(201);

    // NO `prompt=consent`, which is what an attacker's client omits. Better
    // Auth mints the code and redirects before it looks at the consent page, so
    // without the server forcing the prompt this returns a working code to
    // whatever redirect_uri the client registered. It must not.
    const authorized = await SELF.fetch(authorizeUrl(clientId, challenge), {
      headers: { cookie, origin: ORIGIN },
      redirect: "manual",
    });
    const location = authorized.headers.get("location") ?? "";
    expect(
      location,
      "an authorize with no prior consent must not hand back a code",
    ).not.toContain(REDIRECT_URI);
    const consentRedirect = new URL(location, ORIGIN);
    expect(consentRedirect.pathname).toBe("/oauth2/consent");

    // Approving is what produces the code.
    const approved = await SELF.fetch(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({
        accept: true,
        consent_code: consentRedirect.searchParams.get("consent_code"),
      }),
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const callback = new URL(
      (await approved.json<{ redirectURI: string }>()).redirectURI,
    );
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await exchange(clientId, code!, verifier);
    expect(tokenResponse.status, await tokenResponse.clone().text()).toBe(200);
    const token = await tokenResponse.json<{
      access_token: string;
      token_type: string;
      refresh_token?: string;
    }>();
    expect(token.token_type).toBe("Bearer");

    // The whole point: this bearer, which came out of the flow Claude performs,
    // authenticates the MCP endpoint.
    const rooms = await callTool(token.access_token, "list_rooms");
    expect(rooms.isError).toBeUndefined();
    expect(JSON.parse(rooms.text)).toMatchObject([{ name: "ops" }]);

    // A person is not yet a Transit participant. `whoami` says so plainly
    // rather than erroring, which would read as a broken credential.
    const who = await callTool(token.access_token, "whoami");
    expect(who.isError).toBeUndefined();
    expect(who.text).toContain("not yet a Transit participant");

    // A tool that acts as an agent must refuse, and say why.
    const send = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token.access_token}`,
        // Even with a header naming one: a person has no host, so there is no
        // address for this to complete.
        "x-transit-agent": "stephan",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { to: "someone@alpha", message: "hello" },
        },
      }),
    });
    const sendBody = await send.json<{
      result: { content: { text: string }[]; isError?: boolean };
    }>();
    expect(sendBody.result.isError).toBe(true);
    expect(sendBody.result.content[0]!.text).toContain("not bound to a host");

    // A second authorize now skips the screen, because this user HAS granted
    // these scopes to this client. Forcing consent every time would be a
    // different bug.
    const repeat = await SELF.fetch(authorizeUrl(clientId, challenge, { state: "b" }), {
      headers: { cookie, origin: ORIGIN },
      redirect: "manual",
    });
    const repeatLocation = repeat.headers.get("location") ?? "";
    expect(repeatLocation, "a prior grant should not re-prompt").toContain(
      REDIRECT_URI,
    );
    const secondCode = new URL(repeatLocation).searchParams.get("code");

    // A wrong PKCE verifier must not produce a token.
    const wrongVerifier = await exchange(clientId, secondCode!, "not-the-verifier");
    expect(wrongVerifier.status).not.toBe(200);
  });

  it("sends the browser to the SPA's consent route when consent is prompted", async () => {
    const cookie = await signUp("mcp-human-consent@test.example");
    const clientId = await registerClient(cookie);
    const { verifier, challenge } = await pkce();

    const prompted = await SELF.fetch(
      authorizeUrl(clientId, challenge, { prompt: "consent" }),
      { headers: { cookie, origin: ORIGIN }, redirect: "manual" },
    );
    const consentLocation = new URL(
      prompted.headers.get("location") ?? "",
      ORIGIN,
    );
    expect(consentLocation.pathname).toBe("/oauth2/consent");
    const consentCode = consentLocation.searchParams.get("consent_code");
    expect(consentCode).toBeTruthy();
    expect(consentLocation.searchParams.get("client_id")).toBe(clientId);
    expect(consentLocation.searchParams.get("scope")).toContain("openid");

    // What the consent page posts when the person approves.
    const approved = await SELF.fetch(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ accept: true, consent_code: consentCode }),
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const { redirectURI } = await approved.json<{ redirectURI: string }>();
    const code = new URL(redirectURI).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await exchange(clientId, code!, verifier);
    expect(tokenResponse.status, await tokenResponse.clone().text()).toBe(200);
    const { access_token } = await tokenResponse.json<{ access_token: string }>();
    expect((await callTool(access_token, "list_agents")).isError).toBeUndefined();
  });

  it("refuses consent without breaking the flow", async () => {
    const cookie = await signUp("mcp-human-deny@test.example");
    const clientId = await registerClient(cookie);
    const { challenge } = await pkce();

    const prompted = await SELF.fetch(
      authorizeUrl(clientId, challenge, { prompt: "consent" }),
      { headers: { cookie, origin: ORIGIN }, redirect: "manual" },
    );
    const consentCode = new URL(
      prompted.headers.get("location") ?? "",
      ORIGIN,
    ).searchParams.get("consent_code");

    const denied = await SELF.fetch(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ accept: false, consent_code: consentCode }),
    });
    expect(denied.status).toBe(200);
    const { redirectURI } = await denied.json<{ redirectURI: string }>();
    expect(redirectURI).toContain("error=access_denied");
  });
});
