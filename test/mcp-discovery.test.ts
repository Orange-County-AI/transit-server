import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The connector handshake, walked the way Claude walks it.
 *
 * Each step below feeds the next from the document the previous one returned,
 * rather than from a literal this file could be edited to agree with. That is
 * the point: the failure this guards against is a document that is internally
 * plausible and does not match the URL the user typed, which produces no error
 * anywhere — our server sees the first request and the authorization server
 * sees no traffic at all.
 */

const ORIGIN = "http://localhost";

describe("Claude connector discovery", () => {
  it("walks 401 -> protected resource -> authorization server -> registration", async () => {
    // 1. An unauthenticated request. A 200 carrying a challenge header is
    // ignored by Claude, so the status is as load-bearing as the header.
    const unauthenticated = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthenticated.status).toBe(401);

    const challenge = unauthenticated.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    expect(resourceMetadataUrl, challenge).toBeDefined();

    // 2. Follow the URL the challenge gave, not one this test knows.
    const prmResponse = await SELF.fetch(resourceMetadataUrl!);
    expect(prmResponse.status).toBe(200);
    const prm = await prmResponse.json<{
      resource: string;
      authorization_servers: string[];
    }>();

    // The literal comparison Claude makes. `${ORIGIN}/mcp` is the URL a user
    // types into the connector dialog.
    expect(prm.resource).toBe(`${ORIGIN}/mcp`);

    // And the three strings must agree with EACH OTHER, not merely each look
    // right. Deriving them from `request.url` passed the assertion above and
    // still shipped a challenge naming one origin and a `resource` naming
    // another, because behind the assets router the two requests arrive with
    // different URLs. Claude compares them and stops, silently.
    expect(new URL(prm.resource).origin).toBe(new URL(resourceMetadataUrl!).origin);

    // 3. Entry zero only — Claude does not fall back to later entries.
    expect(prm.authorization_servers.length).toBeGreaterThan(0);
    const issuer = prm.authorization_servers[0]!;
    expect(issuer).toBe(new URL(prm.resource).origin);

    const asResponse = await SELF.fetch(
      `${issuer}/.well-known/oauth-authorization-server`,
    );
    expect(asResponse.status).toBe(200);
    const as = await asResponse.json<{
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint?: string;
      code_challenge_methods_supported: string[];
      grant_types_supported: string[];
    }>();

    // RFC 8414 §3: the issuer in the document must be the one that led here.
    expect(as.issuer).toBe(issuer);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.grant_types_supported).toContain("authorization_code");

    // 4. Registration is NOT part of the connector's automatic path: it is
    // gated behind an organization operator, so the metadata does not offer it
    // and Claude is given a pre-registered client id and secret instead. See
    // test/oauth-hijack.test.ts for why open registration is not on the table.
    expect(as.registration_endpoint).toBeUndefined();
    const operator = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: "discovery-operator@test.example",
        password: "test1234!",
        name: "Operator",
      }),
    });
    const cookie = operator.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const registered = await SELF.fetch(`${ORIGIN}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    // RFC 7591 §3.2.1 says 201; Better Auth returns it.
    expect([200, 201]).toContain(registered.status);
    const client = await registered.json<{ client_id: string }>();
    expect(client.client_id).toBeTruthy();

    // 5. The authorize endpoint exists and takes the request rather than
    // 404ing. An unauthenticated browser is sent to sign in, which is a
    // redirect, not an error.
    const authorize = await SELF.fetch(
      `${as.authorization_endpoint}?${new URLSearchParams({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        scope: "openid profile email offline_access",
        state: "xyz",
      })}`,
      { redirect: "manual" },
    );
    expect(authorize.status).not.toBe(404);
    expect([302, 303, 307].includes(authorize.status), `${authorize.status}`).toBe(true);
    expect(authorize.headers.get("location") ?? "").toContain("/login");
  });

  it("names the deployment's canonical origin, not the caller's", async () => {
    // The bug this pins: deriving the documents from `request.url`. Behind the
    // assets router a `/.well-known/*` request reaches the Worker with its URL
    // rewritten to the configured route while `/mcp` keeps the dialled address,
    // so the challenge and the document named different origins and the
    // connector stopped without an error anywhere. Reached here on a host that
    // is not the canonical one, everything must still say the canonical one.
    const canonical = "http://localhost";
    const prm = await (
      await SELF.fetch("http://preview.example/.well-known/oauth-protected-resource")
    ).json<{ resource: string; authorization_servers: string[] }>();
    expect(prm.resource).toBe(`${canonical}/mcp`);
    expect(prm.authorization_servers[0]).toBe(canonical);

    const as = await (
      await SELF.fetch("http://preview.example/.well-known/oauth-authorization-server")
    ).json<{ issuer: string; token_endpoint: string }>();
    expect(as.issuer).toBe(canonical);
    expect(as.token_endpoint.startsWith(canonical)).toBe(true);

    const challenged = await SELF.fetch("http://preview.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toContain(canonical);
  });

  it("advertises nothing it does not serve", async () => {
    // The Better Auth mcp plugin's own metadata names a `/mcp/userinfo` and a
    // `/mcp/jwks` it never mounts. Transit's must not, and the way to know is
    // to fetch every URL it names.
    const as = await (
      await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)
    ).json<Record<string, unknown>>();

    for (const key of [
      "userinfo_endpoint",
      "jwks_uri",
      "id_token_signing_alg_values_supported",
    ]) {
      expect(as[key], `${key} must be absent, not pointing at nothing`).toBeUndefined();
    }

    const advertised = Object.entries(as)
      .filter(([key, value]) => key.endsWith("_endpoint") && typeof value === "string")
      .map(([, value]) => value as string);
    expect(advertised.length).toBeGreaterThan(1);
    for (const url of advertised) {
      // A GET on a POST-only endpoint answers 404 in Better Auth's router the
      // same way a missing route does, so probe with the method each takes and
      // assert only that the route exists at all.
      const probe = await SELF.fetch(url, {
        method: url.endsWith("/authorize") ? "GET" : "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        ...(url.endsWith("/authorize") ? {} : { body: "{}" }),
        redirect: "manual",
      });
      expect(probe.status, `${url} is advertised but answers 404`).not.toBe(404);
    }

    const prm = await (
      await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource`)
    ).json<Record<string, unknown>>();
    expect(prm.jwks_uri, "no key is publishable, so none may be named").toBeUndefined();
  });
});
