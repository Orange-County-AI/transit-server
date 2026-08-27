import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { connectorCalls, onConnectorFetch } from "./connector-mock";

const ORG = "mattermost-poll-org";
const INTEGRATION_ID = "int_mmpoll000001";
const SERVER = "https://mm.example.test";

type Channel = {
  id: string;
  type: string;
  name?: string;
  total_msg_count: number;
};
type Member = { channel_id: string; msg_count: number; mention_count: number };

const state: {
  channels: Channel[];
  members: Member[];
  posts: Record<string, Record<string, unknown>>;
} = { channels: [], members: [], posts: {} };

function path(url: URL): string {
  return url.pathname;
}

function installMattermost(): void {
  onConnectorFetch(
    "GET",
    (url) => url.hostname === "mm.example.test" && path(url) === "/api/v4/users/me",
    () => Response.json({ id: "bot-1", username: "transit" }),
  );
  onConnectorFetch(
    "GET",
    (url) => path(url) === "/api/v4/users/me/channels",
    () => Response.json(state.channels),
  );
  onConnectorFetch(
    "GET",
    (url) => path(url) === "/api/v4/users/me/channel_members",
    () => Response.json(state.members),
  );
  onConnectorFetch(
    "GET",
    (url) => /^\/api\/v4\/channels\/[^/]+\/posts$/u.test(path(url)),
    () => Response.json({ order: Object.keys(state.posts), posts: state.posts }),
  );
  onConnectorFetch(
    "POST",
    (url) => path(url) === "/api/v4/users/ids",
    () => Response.json([{ id: "u-9", username: "dana" }]),
  );
  onConnectorFetch(
    "POST",
    (url) => /^\/api\/v4\/channels\/members\/[^/]+\/view$/u.test(path(url)),
    (call) => {
      // Mattermost clears the unread mark; the poller must then go quiet.
      const body: unknown = JSON.parse(call.body);
      const channelId =
        body && typeof body === "object" && "channel_id" in body
          ? String(body.channel_id)
          : "";
      const channel = state.channels.find((entry) => entry.id === channelId);
      const member = state.members.find((entry) => entry.channel_id === channelId);
      if (channel && member) {
        member.msg_count = channel.total_msg_count;
        member.mention_count = 0;
      }
      return Response.json({ status: "OK", last_viewed_at_times: {} });
    },
  );
  onConnectorFetch(
    "POST",
    (url) => path(url) === "/api/v4/posts",
    () => Response.json({ id: "reply-1" }, { status: 201 }),
  );
}

async function configuredMattermost() {
  const host = env.HOST_HUB.getByName(`org:${ORG}:host:alpha`);
  await runInDurableObject(host, async (_instance, store) => {
    await store.storage.put("roster:alice", {
      name: "alice",
      kind: "omp",
      pane_id: "wAA:p1",
      status: "idle",
      named_by: "user",
      title: "alice",
      cwd: "/tmp",
    });
  });
  const integration = env.INTEGRATION.getByName(
    `org:${ORG}:integration:${INTEGRATION_ID}`,
  );
  await integration.configure({
    org: ORG,
    id: INTEGRATION_ID,
    connector: "mattermost",
    name: "test-mattermost",
    targetAddr: "alice@alpha",
    config: { server_url: SERVER, bot_token: "token" },
  });
  return integration;
}

beforeEach(() => {
  state.channels = [];
  state.members = [];
  state.posts = {};
  installMattermost();
});

describe("Mattermost polling integration", () => {
  it("holds no socket and arms an alarm on configure", async () => {
    state.channels = [{ id: "c1", type: "D", total_msg_count: 0 }];
    state.members = [{ channel_id: "c1", msg_count: 0, mention_count: 0 }];
    const integration = await configuredMattermost();

    const detail = await integration.detail();
    expect(detail.mode).toBe("poll");

    const alarm = await runInDurableObject(integration, async (_instance, store) =>
      store.storage.getAlarm(),
    );
    expect(alarm).toBeGreaterThan(Date.now());
    // A poller opens no upstream socket; `start` only resolves identity.
    expect(
      connectorCalls.filter((call) => call.url.includes("/websocket")),
    ).toHaveLength(0);
  });

  it("delivers an unread direct message to the target agent on the next alarm", async () => {
    // A newly discovered DM channel gets a two-minute lookback so its first
    // message is not dropped. Older backlog is still skipped.
    const oldPostAt = Date.now() - 10 * 60_000;
    state.channels = [{ id: "c1", type: "D", total_msg_count: 4 }];
    state.members = [{ channel_id: "c1", msg_count: 0, mention_count: 0 }];
    state.posts = {
      old: {
        id: "old",
        channel_id: "c1",
        user_id: "u-9",
        message: "old backlog",
        create_at: oldPostAt,
        update_at: oldPostAt,
      },
    };
    const integration = await configuredMattermost();

    await runDurableObjectAlarm(integration);
    expect(
      await runInDurableObject(integration, async (_instance, store) =>
        [...(await store.storage.list({ prefix: "delivery:" }))].length,
      ),
    ).toBe(0);
    expect(connectorCalls.some((call) => call.url.includes("/posts"))).toBe(true);

    const cursor = await runInDurableObject(integration, async (_instance, store) =>
      store.storage.get<number>("cx:cursor:c1"),
    );
    expect(cursor).toEqual(expect.any(Number));
    const postedAt = (cursor ?? Date.now()) + 1_000;
    state.channels = [{ id: "c1", type: "D", total_msg_count: 5 }];
    state.members = [{ channel_id: "c1", msg_count: 0, mention_count: 1 }];
    state.posts = {
      p1: {
        id: "p1",
        channel_id: "c1",
        user_id: "u-9",
        message: "deploy is green",
        create_at: postedAt,
        update_at: postedAt,
      },
    };

    await runDurableObjectAlarm(integration);

    const deliveries = await runInDurableObject(
      integration,
      async (_instance, store) =>
        [...(await store.storage.list<{ status: string }>({ prefix: "delivery:" }))],
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.[1].status).toBe("dispatched");

    const queued = await runInDurableObject(
      env.HOST_HUB.getByName(`org:${ORG}:host:alpha`),
      async (_instance, store) => store.storage.list({ prefix: "q:" }),
    );
    expect(queued.size).toBe(1);

    // Fresh activity puts the poller in burst cadence: the next alarm is due
    // within a second, not at the idle interval.
    const state_ = await runInDurableObject(integration, async (_instance, store) =>
      store.storage.get<{ lastActivityAt: number }>("poll:state"),
    );
    expect(state_?.lastActivityAt).toBeGreaterThan(0);
    const alarm = await runInDurableObject(integration, async (_instance, store) =>
      store.storage.getAlarm(),
    );
    expect(alarm).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("records a rate-limit backoff instead of hammering the server", async () => {
    state.channels = [{ id: "c1", type: "D", total_msg_count: 0 }];
    state.members = [{ channel_id: "c1", msg_count: 0, mention_count: 0 }];
    const integration = await configuredMattermost();

    onConnectorFetch(
      "GET",
      (url) => path(url) === "/api/v4/users/me/channels",
      () =>
        new Response("limit exceeded", {
          status: 429,
          headers: { "retry-after": "9" },
        }),
    );

    await runDurableObjectAlarm(integration);

    const poll = await runInDurableObject(integration, async (_instance, store) =>
      store.storage.get<{ backoffUntil: number; failures: number }>("poll:state"),
    );
    expect(poll?.failures).toBe(0);
    expect(poll?.backoffUntil).toBeGreaterThan(Date.now() + 8_000);
    const alarm = await runInDurableObject(integration, async (_instance, store) =>
      store.storage.getAlarm(),
    );
    expect(alarm).toBeGreaterThan(Date.now() + 8_000);
  });
});
