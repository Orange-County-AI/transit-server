import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hmacSign } from "../src/lib/transit/crypto";

const ORIGIN = "http://localhost";

async function operatorAndTarget(email: string) {
  const signup = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "test1234!", name: "Operator" }),
  });
  const cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const session = await signup.json<{ user: { id: string } }>();

  const hostID = "hst_aaaaaaaaaaaa";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO host
       (id, org_id, slug, token_hash, token_issued_at, daemon_ver, last_seen_at, revoked_at)
       VALUES (?, ?, 'alpha', ?, ?, 'test', ?, NULL)`,
    ).bind(hostID, session.user.id, `hash-${crypto.randomUUID()}`, Date.now(), Date.now()),
    env.DB.prepare(
      `INSERT INTO agent_snapshot
       (host_id, name, kind, pane_id, status, named_by, title, cwd, updated_at)
       VALUES (?, 'alice', 'omp', 'alpha:p1', 'idle', 'user', 'Alice', '/work', ?)`,
    ).bind(hostID, Date.now()),
  ]);
  const hub = env.HOST_HUB.getByName(`org:${session.user.id}:host:alpha`);
  await runInDurableObject(hub, async (_instance, state) => {
    await state.storage.put("roster:alice", {
      name: "alice",
      kind: "omp",
      pane_id: "alpha:p1",
      status: "idle",
      cwd: "/work",
      title: "Alice",
      named_by: "user",
    });
  });
  return { cookie, org: session.user.id };
}

async function createIntegration(
  cookie: string,
  connector: string,
  config: Record<string, string>,
) {
  const response = await SELF.fetch(`${ORIGIN}/api/integrations`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({
      connector,
      name: `${connector}-test`,
      target_addr: "alice@alpha",
      config,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = await response.json<{
    integration: { meta: { id: string } };
  }>();
  return body.integration.meta.id;
}

describe("connector webhooks", () => {
  it("verifies Telegram secret and allowlists, then deduplicates before 2xx", async () => {
    const { cookie, org } = await operatorAndTarget("telegram-hook@test.example");
    const id = await createIntegration(cookie, "telegram", {
      bot_token: "123:test",
      webhook_secret: "telegram-secret",
      allowed_user_ids: "42",
    });
    const update = {
      update_id: 700,
      message: {
        message_id: 12,
        from: { id: 42, first_name: "Ada" },
        chat: { id: 99, type: "private" },
        text: "hello",
      },
    };
    const wrong = await SELF.fetch(`${ORIGIN}/hooks/telegram/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong",
      },
      body: JSON.stringify(update),
    });
    expect(wrong.status).toBe(403);

    const send = () =>
      SELF.fetch(`${ORIGIN}/hooks/telegram/${id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "telegram-secret",
        },
        body: JSON.stringify(update),
      });
    const first = await send();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "queued" });
    const replay = await send();
    expect(await replay.json()).toEqual({ status: "duplicate" });

    const integration = env.INTEGRATION.getByName(`org:${org}:integration:${id}`);
    const committed = await runInDurableObject(
      integration,
      async (_instance, state) =>
        state.storage.get<{ eventId: string; deliveryId: string }>(
          "event_key:update:700",
        ),
    );
    expect(committed?.eventId).toMatch(/^evt_[0-9a-f]{12}$/);
    expect(committed?.deliveryId).toMatch(/^dlv_[0-9a-f]{12}$/);
  });

  it("verifies Kaneo HMAC over the exact raw body and commits before 2xx", async () => {
    const { cookie, org } = await operatorAndTarget("kaneo-hook@test.example");
    const id = await createIntegration(cookie, "kaneo", {
      api_base: "https://kaneo.example",
      bot_key: "bot-key",
      webhook_secret: "kaneo-secret",
      workspace_id: "ws-1",
    });
    const raw = JSON.stringify({
      event: "task.status_changed",
      project: { name: "Transit", workspaceId: "ws-1" },
      task: { id: "task-1", title: "Ship", statusName: "Done" },
      actor: { name: "Ada" },
    });
    const signature = await hmacSign("kaneo-secret", raw);
    const response = await SELF.fetch(`${ORIGIN}/hooks/kaneo/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kaneo-signature": signature,
      },
      body: raw,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "queued" });

    const integration = env.INTEGRATION.getByName(`org:${org}:integration:${id}`);
    const events = await runInDurableObject(integration, async (_instance, state) =>
      state.storage.list({ prefix: "event:" }),
    );
    expect(events.size).toBe(1);

    const tampered = await SELF.fetch(`${ORIGIN}/hooks/kaneo/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kaneo-signature": signature,
      },
      body: `${raw} `,
    });
    expect(tampered.status).toBe(403);
  });
});
