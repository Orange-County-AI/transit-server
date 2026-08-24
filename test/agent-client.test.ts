import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintAgentToken } from "../src/mcp/agent-token";

/**
 * Agent client credentials: the token's subject IS the agent.
 *
 * The two tests that matter here are the negative ones. A credential minted for
 * one agent must not be able to act as another, and a credential minted in one
 * organization must not be able to reach into another — including when a
 * validly signed token claims otherwise.
 */

const ORIGIN = "http://localhost";

type Enrolled = { device_token: string; host: string; org: string };
type Minted = { client_id: string; client_secret: string; address: string };

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

async function enrollHost(cookie: string, slug: string): Promise<Enrolled> {
  const codeResponse = await SELF.fetch(`${ORIGIN}/api/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({ slug }),
  });
  const { code } = await codeResponse.json<{ code: string }>();
  const enrolled = await SELF.fetch(`${ORIGIN}/api/daemon/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, daemon_ver: "0.1.0-test" }),
  });
  expect(enrolled.status).toBe(200);
  return enrolled.json<Enrolled>();
}

async function createClient(
  cookie: string,
  host: string,
  name: string,
): Promise<Minted> {
  const response = await SELF.fetch(`${ORIGIN}/api/agent-clients`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({ host, name }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json<Minted>();
}

async function tokenRequest(body: Record<string, string>): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

async function accessToken(client: Minted): Promise<string> {
  const response = await tokenRequest({
    grant_type: "client_credentials",
    client_id: client.client_id,
    client_secret: client.client_secret,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json<{ access_token: string; token_type: string }>();
  expect(body.token_type).toBe("Bearer");
  return body.access_token;
}

async function whoami(token: string, actingHeader?: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(actingHeader ? { "x-transit-agent": actingHeader } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json<{ result: { content: { text: string }[] } }>();
  return body.result.content[0]!.text;
}

describe("agent client credentials", () => {
  it("issues a token whose subject decides the acting agent", async () => {
    const cookie = await signUp("agent-client-basic@test.example");
    await enrollHost(cookie, "alpha");
    const client = await createClient(cookie, "alpha", "scout");
    expect(client.address).toBe("scout@alpha");

    const token = await accessToken(client);
    expect(await whoami(token)).toBe("scout@alpha (connected: false)");

    // The same token works over HTTP Basic, which is what most OAuth clients
    // reach for first.
    const viaBasic = await SELF.fetch(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`,
      },
      body: "grant_type=client_credentials",
    });
    expect(viaBasic.status).toBe(200);
    expect(viaBasic.headers.get("cache-control")).toBe("no-store");

    // Revoking the client kills its live token immediately, not at expiry.
    const revoked = await SELF.fetch(
      `${ORIGIN}/api/agent-clients/${client.client_id}`,
      { method: "DELETE", headers: { origin: ORIGIN, cookie } },
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("ignores X-Transit-Agent entirely on an agent-client token", async () => {
    const cookie = await signUp("agent-client-header@test.example");
    await enrollHost(cookie, "alpha");
    const alice = await createClient(cookie, "alpha", "alice");
    // `bob` is a real, separately-credentialled agent on the same host and in
    // the same organization — the closest thing to a legitimate target there
    // is, which is what makes this the escalation worth blocking.
    await createClient(cookie, "alpha", "bob");

    const token = await accessToken(alice);
    // Alice's token, Bob's name in the header. It must act as Alice.
    expect(await whoami(token, "bob")).toBe("alice@alpha (connected: false)");

    // And the header does not leak into what a send is attributed to either.
    const sent = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-transit-agent": "bob",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { to: "nobody@alpha", message: "attribution check" },
        },
      }),
    });
    const body = await sent.json<{ result: { content: { text: string }[] } }>();
    // The send fails (no such recipient), but the attribution is the point:
    // the message never existed as bob's.
    const rows = await env.DB.prepare(
      "SELECT from_addr FROM message WHERE org_id IS NOT NULL",
    ).all<{ from_addr: string }>();
    expect(rows.results.some((row) => row.from_addr.startsWith("bob@"))).toBe(false);
    expect(body.result.content[0]!.text).toContain("Error:");
  });

  it("takes organization from the client row, not from a signed claim", async () => {
    const ownerCookie = await signUp("agent-client-org-a@test.example");
    const intruderCookie = await signUp("agent-client-org-b@test.example");
    const alpha = await enrollHost(ownerCookie, "alpha");
    const beta = await enrollHost(intruderCookie, "alpha");
    expect(alpha.org).not.toBe(beta.org);

    // Org B has a room; org A must not see it, whatever its token claims.
    const room = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: intruderCookie,
      },
      body: JSON.stringify({ name: "secret", policy: "open" }),
    });
    expect(room.status).toBe(201);

    const client = await createClient(ownerCookie, "alpha", "scout");

    // A token signed by this server's own key, with this client's real
    // subject, but claiming org B and a different agent name. Forging the
    // signature is impossible; forging the CLAIMS is not, which is exactly why
    // nothing downstream may read them.
    const forged = await mintAgentToken(env as unknown as Env, {
      clientId: client.client_id,
      org: beta.org,
      host: "alpha",
      name: "impostor",
      scope: "",
    });

    const listed = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${forged.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_rooms", arguments: {} },
      }),
    });
    const body = await listed.json<{ result: { content: { text: string }[] } }>();
    expect(JSON.parse(body.result.content[0]!.text)).toEqual([]);
    expect(await whoami(forged.token)).toBe("scout@alpha (connected: false)");
  });

  it("refuses a bad secret, a wrong grant, and an over-wide scope", async () => {
    const cookie = await signUp("agent-client-errors@test.example");
    await enrollHost(cookie, "alpha");
    const client = await createClient(cookie, "alpha", "scout");

    const wrongSecret = await tokenRequest({
      grant_type: "client_credentials",
      client_id: client.client_id,
      client_secret: "not-the-secret",
    });
    expect(wrongSecret.status).toBe(401);
    expect(await wrongSecret.json<{ error: string }>()).toMatchObject({
      error: "invalid_client",
    });

    const wrongGrant = await tokenRequest({
      grant_type: "authorization_code",
      client_id: client.client_id,
      client_secret: client.client_secret,
      code: "whatever",
    });
    expect(wrongGrant.status).toBe(400);
    expect(await wrongGrant.json<{ error: string }>()).toMatchObject({
      error: "unsupported_grant_type",
    });

    // The row grants no scope, so nothing may be asked for.
    const overWide = await tokenRequest({
      grant_type: "client_credentials",
      client_id: client.client_id,
      client_secret: client.client_secret,
      scope: "rooms:write",
    });
    expect(overWide.status).toBe(400);
    expect(await overWide.json<{ error: string }>()).toMatchObject({
      error: "invalid_scope",
    });

    // A token whose claims were edited after signing. The signature is the only
    // thing standing between "this client says so" and "anyone says so".
    const token = await accessToken(client);
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const claims = JSON.parse(
      atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
    ) as Record<string, unknown>;
    claims.name = "impostor";
    const tampered = `${header}.${btoa(JSON.stringify(claims))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "")}.${signature}`;
    const rejected = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tampered}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(rejected.status).toBe(401);
  });

  it("keeps the device token working unchanged beside it", async () => {
    const cookie = await signUp("agent-client-coexist@test.example");
    const alpha = await enrollHost(cookie, "alpha");
    await createClient(cookie, "alpha", "scout");

    // Six production hosts depend on this path; an agent credential must not
    // deprecate it.
    expect(await whoami(alpha.device_token, "legacy")).toBe(
      "legacy@alpha (connected: false)",
    );
  });
});
