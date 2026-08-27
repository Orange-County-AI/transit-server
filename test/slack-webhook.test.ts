import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hmacSign } from "../src/lib/transit/crypto";
import { connectorCalls, onConnectorFetch } from "./connector-mock";

const ORIGIN = "http://localhost";
const SIGNING_SECRET = "slack-signing-secret";
const BOT = "U0BOT";

type DeliveryRecord = { id: string; status: string; settledAt?: number };

async function operatorAndTarget(email: string) {
  const signup = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "test1234!", name: "Operator" }),
  });
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await signup.json<{ user: { id: string } }>();

  const hostID = "hst_bbbbbbbbbbbb";
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

async function createSlackIntegration(cookie: string) {
  const response = await SELF.fetch(`${ORIGIN}/api/integrations`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({
      connector: "slack",
      name: "slack-test",
      target_addr: "alice@alpha",
      config: {
        bot_token: "xoxb-test",
        signing_secret: SIGNING_SECRET,
        bot_user_id: BOT,
      },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = await response.json<{ integration: { meta: { id: string } } }>();
  return body.integration.meta.id;
}

/** Send a request signed the way Slack signs one. */
async function hook(id: string, payload: unknown, secret = SIGNING_SECRET) {
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = `v0=${await hmacSign(secret, `v0:${timestamp}:${raw}`)}`;
  return SELF.fetch(`${ORIGIN}/hooks/slack/${id}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body: raw,
  });
}

function mention(overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    api_app_id: "A0APP",
    team_id: "T0TEAM",
    event_id: "Ev0001",
    authorizations: [{ user_id: BOT, is_bot: true }],
    event: {
      type: "message",
      channel: "C0CHAN",
      channel_type: "channel",
      user: "U0HUMAN",
      text: `<@${BOT}> what is the status`,
      ts: "1700000000.000100",
      ...overrides,
    },
  };
}

const posted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  posted.length = 0;
  onConnectorFetch(
    "GET",
    (url) => url.hostname === "slack.com" && url.pathname === "/api/users.info",
    () =>
      Response.json({
        ok: true,
        user: { name: "ada", profile: { display_name: "Ada L" } },
      }),
  );
  onConnectorFetch(
    "POST",
    (url) => url.hostname === "slack.com" && url.pathname === "/api/chat.postMessage",
    (call) => {
      posted.push(JSON.parse(call.body) as Record<string, unknown>);
      return Response.json({ ok: true, ts: "1700000010.000100" });
    },
  );
});

describe("Slack connector end to end", () => {
  it("configures without a network call and holds no socket", async () => {
    const { cookie, org } = await operatorAndTarget("slack-config@test.example");
    const id = await createSlackIntegration(cookie);

    // `start` is deliberately offline: the bot user id arrives with the events.
    expect(connectorCalls.filter((call) => call.url.includes("slack.com"))).toHaveLength(0);

    const integration = env.INTEGRATION.getByName(`org:${org}:integration:${id}`);
    const detail = await integration.detail();
    expect(detail.mode).toBe("webhook");
  });

  it("answers the signed url_verification challenge and rejects a forged one", async () => {
    const { cookie } = await operatorAndTarget("slack-challenge@test.example");
    const id = await createSlackIntegration(cookie);
    const challenge = { type: "url_verification", challenge: "c-abc-123" };

    const forged = await hook(id, challenge, "not-the-secret");
    expect(forged.status).toBe(403);

    const accepted = await hook(id, challenge);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ challenge: "c-abc-123" });
  });

  it("rejects a body altered after signing", async () => {
    const { cookie } = await operatorAndTarget("slack-tamper@test.example");
    const id = await createSlackIntegration(cookie);
    const raw = JSON.stringify(mention());
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = `v0=${await hmacSign(SIGNING_SECRET, `v0:${timestamp}:${raw}`)}`;
    const response = await SELF.fetch(`${ORIGIN}/hooks/slack/${id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
      body: `${raw} `,
    });
    expect(response.status).toBe(403);
  });

  it("commits the event before 2xx and dedupes a Slack retry", async () => {
    const { cookie, org } = await operatorAndTarget("slack-ingest@test.example");
    const id = await createSlackIntegration(cookie);

    const first = await hook(id, mention());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "queued" });

    // Slack retries a delivery it thinks failed, under a fresh event id.
    const retry = await hook(id, { ...mention(), event_id: "Ev0002" });
    expect(await retry.json()).toEqual({ status: "duplicate" });

    const integration = env.INTEGRATION.getByName(`org:${org}:integration:${id}`);
    const committed = await runInDurableObject(integration, async (_instance, state) =>
      state.storage.get<{ eventId: string; deliveryId: string }>(
        "event_key:C0CHAN:1700000000.000100",
      ),
    );
    expect(committed?.eventId).toMatch(/^evt_[0-9a-f]{12}$/u);
    expect(committed?.deliveryId).toMatch(/^dlv_[0-9a-f]{12}$/u);
  });

  it("posts a settled reply into the thread the message came from", async () => {
    const { cookie, org } = await operatorAndTarget("slack-reply@test.example");
    const id = await createSlackIntegration(cookie);
    await hook(id, mention());

    const integration = env.INTEGRATION.getByName(`org:${org}:integration:${id}`);
    const committed = await runInDurableObject(integration, async (_instance, state) =>
      state.storage.get<{ deliveryId: string }>("event_key:C0CHAN:1700000000.000100"),
    );
    const deliveryId = committed!.deliveryId;

    const result = await integration.chatReply({
      deliveryId,
      conversationId: "C0CHAN:1700000000.000100",
      caller: "alice@alpha",
      message: "shipped, and a < b",
    });
    expect(result.status).toBe("handled");

    expect(posted).toEqual([
      {
        channel: "C0CHAN",
        // Slack's three reserved characters are re-escaped on the way out.
        text: "shipped, and a &lt; b",
        thread_ts: "1700000000.000100",
      },
    ]);

    const delivery = await runInDurableObject(integration, async (_instance, state) =>
      state.storage.get<DeliveryRecord>(`delivery:${deliveryId}`),
    );
    expect(delivery?.status).toBe("handled");
    expect(delivery?.settledAt).toBeGreaterThan(0);
  });

  it("honours reply_mode root by posting to the channel instead of the thread", async () => {
    const { cookie, org } = await operatorAndTarget("slack-root@test.example");
    const id = await createSlackIntegration(cookie);
    await hook(id, mention());

    const integration = env.INTEGRATION.getByName(`org:${org}:integration:${id}`);
    const committed = await runInDurableObject(integration, async (_instance, state) =>
      state.storage.get<{ deliveryId: string }>("event_key:C0CHAN:1700000000.000100"),
    );
    await integration.chatReply({
      deliveryId: committed!.deliveryId,
      conversationId: "C0CHAN:1700000000.000100",
      caller: "alice@alpha",
      message: "shipped",
      replyMode: "root",
    });
    expect(posted[0]?.thread_ts).toBeUndefined();
  });

  it("never re-ingests the bot's own message", async () => {
    const { cookie, org } = await operatorAndTarget("slack-loop@test.example");
    const id = await createSlackIntegration(cookie);

    const echo = await hook(id, mention({ user: BOT, text: "shipped" }));
    expect(await echo.json()).toEqual({ status: "ignored" });
    const asBot = await hook(
      id,
      mention({ ts: "1700000002.000100", bot_id: "B0BOT", subtype: "bot_message" }),
    );
    expect(await asBot.json()).toEqual({ status: "ignored" });

    const integration = env.INTEGRATION.getByName(`org:${org}:integration:${id}`);
    const events = await runInDurableObject(integration, async (_instance, state) =>
      state.storage.list({ prefix: "event:" }),
    );
    expect(events.size).toBe(0);
  });

  it("stays hibernated between events: no alarm is armed by an ingest", async () => {
    const { cookie, org } = await operatorAndTarget("slack-alarm@test.example");
    const id = await createSlackIntegration(cookie);
    const integration = env.INTEGRATION.getByName(`org:${org}:integration:${id}`);

    // A webhook connector must not put itself on a clock; the only alarm a
    // Slack integration ever arms is the redelivery one for a queued envelope.
    const armedAtConfigure = await runInDurableObject(
      integration,
      async (_instance, state) => state.storage.getAlarm(),
    );
    expect(armedAtConfigure).toBeNull();

    await hook(id, mention());
    const afterIngest = await runInDurableObject(integration, async (_instance, state) =>
      state.storage.getAlarm(),
    );
    // Redelivery, not polling: it is minutes out, not the 5s poll cadence.
    expect(afterIngest).toBeGreaterThan(Date.now() + 60_000);
  });
});
