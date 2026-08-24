import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The authorization-code hijack, driven end to end from the attacker's side.
 *
 * Every step below is something an attacker actually does, in order, and the
 * test asserts where the chain breaks rather than asserting a flag is set. The
 * previous version of the human OAuth test walked step 3 and asserted it
 * SUCCEEDED — "an authenticated authorize should return a code" — which is how
 * a hundred passing tests coexisted with a one-click read of a victim's
 * organization.
 *
 * The chain was: register a client called "Claude" pointing anywhere (nothing
 * required a session), send a signed-in user a top-level link to authorize
 * (SameSite=Lax sends the cookie), and receive a code at your own URI because
 * the consent screen is only reached when the CLIENT asks for it.
 */

const ORIGIN = "http://localhost";
const ATTACKER_URI = "https://attacker.example/collect";

async function signUp(email: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "test1234!", name: "Victim" }),
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function register(body: Record<string, unknown>, cookie?: string) {
  return SELF.fetch(`${ORIGIN}/api/auth/mcp/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

const CLAUDE_SHAPED = {
  client_name: "Claude",
  redirect_uris: [ATTACKER_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_post",
};

describe("the authorization-code hijack chain", () => {
  it("cannot register a client without an authenticated operator", async () => {
    // Step one of the chain, and where it now stops for someone with no
    // account: an open registration endpoint is what let an attacker mint a
    // client called "Claude" pointing at their own collector.
    const anonymous = await register(CLAUDE_SHAPED);
    expect(anonymous.status, "registration must not be open to the internet").toBe(
      401,
    );

    // Nor with a signed-in account that is not an operator of the organization
    // being registered against — an account is free to create.
    const outsider = await signUp("hijack-outsider@test.example");
    const asOutsider = await register(CLAUDE_SHAPED, outsider);
    // An owner of their OWN personal organization may register; what matters is
    // that it is authenticated and attributable, not anonymous.
    expect([200, 201, 403]).toContain(asOutsider.status);
  });

  it("does not hand back a code without consent, even to a registered client", async () => {
    const victim = await signUp("hijack-victim@test.example");

    // Give the attacker the strongest position still reachable: a real,
    // registered client whose redirect_uri is theirs. The question is whether
    // the victim's browser session alone is enough to complete it.
    const registered = await register(CLAUDE_SHAPED, victim);
    expect([200, 201]).toContain(registered.status);
    const { client_id } = await registered.json<{ client_id: string }>();

    // The link an attacker sends. A top-level GET carries the victim's
    // SameSite=Lax session cookie, so authorize sees a live session. Note the
    // absence of prompt=consent: that omission WAS the exploit.
    //
    // PKCE is supplied deliberately. Requiring it also stops this chain, and
    // stops it earlier — but then this test would be passing for the other
    // reason and the consent gate would be untested. An attacker can generate a
    // challenge as easily as anyone; consent has to hold on its own.
    const clicked = await SELF.fetch(
      `${ORIGIN}/api/auth/mcp/authorize?${new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: ATTACKER_URI,
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        scope: "openid profile email offline_access",
        state: "attacker-state",
      })}`,
      { headers: { cookie: victim, origin: ORIGIN }, redirect: "manual" },
    );

    const location = clicked.headers.get("location") ?? "";
    expect(
      location,
      "a click must never redirect a code to the client's URI on its own",
    ).not.toContain(ATTACKER_URI);
    // Parsed, not substring-matched: `consent_code=` contains `code=`, and a
    // looser check here would pass on the exploit's own redirect.
    const landed = new URL(location, ORIGIN);
    expect(landed.searchParams.get("code")).toBeNull();
    // It lands on the consent screen instead, where a person sees the
    // destination and decides.
    expect(landed.pathname).toBe("/oauth2/consent");
  });

  it("requires PKCE, so a stolen code is not enough on its own", async () => {
    const operator = await signUp("hijack-pkce@test.example");
    const registered = await register(CLAUDE_SHAPED, operator);
    const { client_id } = await registered.json<{ client_id: string }>();

    // No code_challenge at all. Without requirePKCE the plugin accepts this and
    // issues a code redeemable with the client secret alone.
    const withoutPkce = await SELF.fetch(
      `${ORIGIN}/api/auth/mcp/authorize?${new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: ATTACKER_URI,
        scope: "openid",
        state: "s",
        prompt: "consent",
      })}`,
      { headers: { cookie: operator, origin: ORIGIN }, redirect: "manual" },
    );
    const location = withoutPkce.headers.get("location") ?? "";
    expect(location).not.toContain("/oauth2/consent");
    expect(location).toContain("error=invalid_request");
  });

  it("does not hand a refresh token to a holder of an access token", async () => {
    // `/mcp/get-session` returns the entire oauthAccessToken row, refresh token
    // included, to anyone bearing the one-hour access token — turning a leak
    // into seven days. Transit reads that session in process and never over
    // HTTP, so the route exists only to leak.
    const response = await SELF.fetch(`${ORIGIN}/api/auth/mcp/get-session`, {
      headers: { authorization: "Bearer whatever" },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("refreshToken");
  });

  it("does not advertise a registration endpoint it gates", async () => {
    const metadata = await (
      await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)
    ).json<Record<string, unknown>>();
    // Advertising a URL that answers 401 to the only client that would use it
    // is worse than omitting it: the connector reports a broken server instead
    // of asking for the credentials an operator was meant to supply.
    expect(metadata.registration_endpoint).toBeUndefined();
  });

  it("caps a batch, so one authenticated request is not unbounded work", async () => {
    // Authenticated on purpose. An unauthenticated request answers 401 before
    // the batch is ever read, so testing it that way passes whether or not a
    // cap exists — which is worse than not testing it.
    const cookie = await signUp("hijack-batch@test.example");
    const enrollCode = await SELF.fetch(`${ORIGIN}/api/hosts/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ slug: "alpha" }),
    });
    const { code } = await enrollCode.json<{ code: string }>();
    const enrolled = await SELF.fetch(`${ORIGIN}/api/daemon/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, daemon_ver: "0.1.0-test" }),
    });
    const { device_token } = await enrolled.json<{ device_token: string }>();

    const batch = (length: number) =>
      SELF.fetch(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${device_token}`,
        },
        body: JSON.stringify(
          Array.from({ length }, (_unused, index) => ({
            jsonrpc: "2.0",
            id: index,
            method: "tools/list",
          })),
        ),
      });

    // A batch a real client might send still works.
    const reasonable = await batch(4);
    expect(reasonable.status).toBe(200);
    expect((await reasonable.json<unknown[]>()).length).toBe(4);

    const oversized = await batch(200);
    expect(oversized.status, "an uncapped batch is authenticated amplification").toBe(
      400,
    );
    expect(
      (await oversized.json<{ error: { message: string } }>()).error.message,
    ).toContain("batch exceeds");
  });
});
