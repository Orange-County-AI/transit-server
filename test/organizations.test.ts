import { SELF, env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

const ORIGIN = "http://localhost";

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function api(
  path: string,
  options: { cookie?: string; method?: string; body?: unknown } = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: options.method,
    headers: {
      origin: ORIGIN,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function signUp(email: string, name: string): Promise<{ cookie: string; userId: string }> {
  const response = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: "test1234!", name },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json<{ user: { id: string } }>();
  return { cookie: cookiesFrom(response), userId: body.user.id };
}

describe("organization boundary", () => {
  test("sign-up creates and activates a personal organization", async () => {
    const { cookie, userId } = await signUp("org-personal@test.example", "Personal Owner");

    const sessionResponse = await api("/api/auth/get-session", { cookie });
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json<{
      session: { activeOrganizationId: string | null };
    }>();
    expect(session.session.activeOrganizationId).toBe(userId);

    const organizationsResponse = await api("/api/auth/organization/list", { cookie });
    expect(organizationsResponse.status).toBe(200);
    const organizations = await organizationsResponse.json<Array<{ id: string; name: string }>>();
    expect(organizations).toEqual([
      expect.objectContaining({ id: userId, name: "Personal Owner's organization" }),
    ]);
  });

  test("switching organizations changes every resource query boundary", async () => {
    const { cookie, userId } = await signUp("org-switch@test.example", "Switch Owner");

    const createResponse = await api("/api/auth/organization/create", {
      cookie,
      method: "POST",
      body: { name: "Mattermost Operations", slug: "mattermost-operations" },
    });
    expect(createResponse.status, await createResponse.clone().text()).toBe(200);
    const created = await createResponse.json<{ id: string }>();
    expect(created.id).not.toBe(userId);

    const createRoom = await api("/api/rooms", {
      cookie,
      method: "POST",
      body: { name: "ops", policy: "invite" },
    });
    expect(createRoom.status, await createRoom.clone().text()).toBe(201);

    const secondRooms = await api("/api/rooms", { cookie });
    expect(await secondRooms.json()).toMatchObject({ rooms: [expect.objectContaining({ name: "ops" })] });

    const activatePersonal = await api("/api/auth/organization/set-active", {
      cookie,
      method: "POST",
      body: { organizationId: userId },
    });
    expect(activatePersonal.status, await activatePersonal.clone().text()).toBe(200);

    const personalRooms = await api("/api/rooms", { cookie });
    expect(personalRooms.status).toBe(200);
    expect(await personalRooms.json()).toMatchObject({ rooms: [] });

    const activateSecond = await api("/api/auth/organization/set-active", {
      cookie,
      method: "POST",
      body: { organizationId: created.id },
    });
    expect(activateSecond.status).toBe(200);
    const restoredRooms = await api("/api/rooms", { cookie });
    expect(await restoredRooms.json()).toMatchObject({
      rooms: [expect.objectContaining({ name: "ops" })],
    });
  });

  test("an active organization id without membership grants no access", async () => {
    const alice = await signUp("org-alice@test.example", "Alice");
    const bob = await signUp("org-bob@test.example", "Bob");

    const switchResponse = await api("/api/auth/organization/set-active", {
      cookie: alice.cookie,
      method: "POST",
      body: { organizationId: bob.userId },
    });
    expect(switchResponse.status).toBe(403);

    await env.DB.prepare(
      "UPDATE session SET active_organization_id = ? WHERE user_id = ?",
    )
      .bind(bob.userId, alice.userId)
      .run();

    const hosts = await api("/api/hosts", { cookie: alice.cookie });
    expect(hosts.status).toBe(401);
    expect(await hosts.json()).toEqual({ error: "Unauthorized" });
  });
});
