/**
 * End-to-end auth flow against the Hono worker via SELF.fetch().
 *
 * Pins the four gotchas from CLAUDE.md "Auth-specific gotchas":
 *   1. Origin header must match BETTER_AUTH_URL (or a trusted origin) for CSRF.
 *   2. /api/auth/sign-out crashes on empty body — must send "{}".
 *   3. Hono mount basePath matches Better Auth's basePath ("/api/auth").
 *   4. /api/me returns { authenticated: true, user } with cookie, 401 without.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

const ORIGIN = "http://localhost";

const cookiesFrom = (res: Response): string =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const post = (path: string, body: unknown, cookie?: string): Promise<Response> =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (path: string, cookie?: string): Promise<Response> =>
  SELF.fetch(`${ORIGIN}${path}`, {
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
  });

const creds = { email: "alice@test.example", password: "test1234!", name: "Alice" } as const;

describe("auth flow", () => {
  test("/api/me without a session returns 401", async () => {
    const res = await get("/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  test("sign-up issues a session cookie and /api/me identifies the user", async () => {
    const signUp = await post("/api/auth/sign-up/email", creds);
    expect(signUp.status, `sign-up failed: ${await signUp.clone().text()}`).toBe(200);

    const cookie = cookiesFrom(signUp);
    expect(cookie).toBeTruthy();

    const me = await get("/api/me", cookie);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { authenticated: boolean; user: { email: string } };
    expect(body.authenticated).toBe(true);
    expect(body.user.email).toBe(creds.email);
  });

  test("sign-in with valid credentials returns a session", async () => {
    const signUp = await post("/api/auth/sign-up/email", creds);
    expect(signUp.status).toBe(200);

    const signIn = await post("/api/auth/sign-in/email", {
      email: creds.email,
      password: creds.password,
    });
    expect(signIn.status, `sign-in failed: ${await signIn.clone().text()}`).toBe(200);
    const cookie = cookiesFrom(signIn);
    expect(cookie).toBeTruthy();

    const me = await get("/api/me", cookie);
    expect(me.status).toBe(200);
  });

  test("sign-out invalidates the session cookie", async () => {
    const signUp = await post("/api/auth/sign-up/email", creds);
    expect(signUp.status).toBe(200);
    const cookie = cookiesFrom(signUp);

    // Body must be "{}" — Better Auth parses request body as JSON and 500s
    // on an empty stream. The SPA's auth-client.ts sends the same shape.
    const signOut = await post("/api/auth/sign-out", {}, cookie);
    expect(signOut.status, `sign-out failed: ${await signOut.clone().text()}`).toBe(200);

    const me = await get("/api/me", cookie);
    expect(me.status).toBe(401);
  });
});
