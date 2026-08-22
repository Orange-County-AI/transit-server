import {
  SELF,
  env,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Integration } from "../src/do/integration";
import { hmacSign, hmacVerify } from "../src/lib/transit/crypto";
import { signedIngestPayload } from "../src/lib/transit/ingest";
import {
  connectorCalls,
  onConnectorFetch,
} from "./connector-mock";

const ORIGIN = "http://localhost";
const encoder = new TextEncoder();

type SourceCredentials = {
  cookie: string;
  org: string;
  integrationId: string;
  secret: string;
  source: string;
};

async function createSource(options: {
  source: string;
  replyURL?: string;
  prefixes?: string[];
}): Promise<SourceCredentials> {
  const signup = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      email: `${options.source}@test.example`,
      password: "test1234!",
      name: "Source Operator",
    }),
  });
  const cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const session = await signup.json<{ user: { id: string } }>();
  const hostID = `hst_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
  const host = env.HOST_HUB.getByName(`org:${session.user.id}:host:alpha`);
  await runInDurableObject(host, async (_instance, state) => {
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

  const response = await SELF.fetch(`${ORIGIN}/api/sources`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({
      source: options.source,
      target_addr: "alice@alpha",
      reply_url: options.replyURL ?? "",
      reply_url_prefixes: options.prefixes ?? [],
      instructions: "Settle every alert.",
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const created = await response.json<{
    source: { integration_id: string };
    secret: string;
  }>();
  return {
    cookie,
    org: session.user.id,
    integrationId: created.source.integration_id,
    secret: created.secret,
    source: options.source,
  };
}

function ingestBody(overrides: Record<string, unknown> = {}) {
  return {
    schema: "transit.ingest/1",
    event_key: "event-1",
    conversation_id: "conversation-1",
    user: "Build system",
    trigger: "alert",
    content: "Build failed",
    meta: { severity: "high" },
    ...overrides,
  };
}

async function signedPost(
  credentials: SourceCredentials,
  body: string,
  options: { signedBody?: string; timestamp?: string; secret?: string } = {},
) {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1_000));
  const signedBody = options.signedBody ?? body;
  const signature = await hmacSign(
    options.secret ?? credentials.secret,
    signedIngestPayload(timestamp, encoder.encode(signedBody)),
  );
  return SELF.fetch(`${ORIGIN}/ingest/${credentials.source}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Transit-Timestamp": timestamp,
      "Transit-Signature": `v1=${signature}`,
    },
    body,
  });
}

describe("transit.ingest/1", () => {
  it("accepts exact signed bytes, deduplicates, and exposes unsigned health", async () => {
    const credentials = await createSource({ source: "ci-alerts" });
    const body = JSON.stringify(ingestBody());
    const first = await signedPost(credentials, body);
    expect(first.status).toBe(202);
    const queued = await first.json<{
      status: string;
      event_id: string;
      delivery_id: string;
    }>();
    expect(queued).toMatchObject({ status: "queued" });
    expect(queued.event_id).toMatch(/^evt_[0-9a-f]{12}$/);
    expect(queued.delivery_id).toMatch(/^dlv_[0-9a-f]{12}$/);

    const replay = await signedPost(credentials, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: "duplicate",
      event_id: queued.event_id,
      delivery_id: queued.delivery_id,
    });
    const health = await SELF.fetch(`${ORIGIN}/ingest/ci-alerts/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, schema: "transit.ingest/1" });
    expect((await SELF.fetch(`${ORIGIN}/ingest/missing/health`)).status).toBe(404);
  });

  it("rejects wrong signatures, skew, reserialized bytes, size, and invalid fields", async () => {
    const credentials = await createSource({
      source: "validation",
      prefixes: ["https://receiver.example/transit/"],
    });
    const body = JSON.stringify(ingestBody());
    expect((await signedPost(credentials, body, { secret: "wrong" })).status).toBe(401);
    expect(
      (
        await signedPost(credentials, body, {
          timestamp: String(Math.floor(Date.now() / 1_000) - 301),
        })
      ).status,
    ).toBe(401);
    const pretty = JSON.stringify(ingestBody(), null, 2);
    expect(
      (await signedPost(credentials, pretty, { signedBody: body })).status,
    ).toBe(401);

    const tooLarge = "x".repeat(262_145);
    const large = await SELF.fetch(`${ORIGIN}/ingest/validation`, {
      method: "POST",
      body: tooLarge,
    });
    expect(large.status).toBe(413);

    for (const invalid of [
      ingestBody({ schema: "wrong" }),
      ingestBody({ meta: { severity: 5 } }),
      ingestBody({ meta: { trigger: "reserved" } }),
      ingestBody({ reply_url: "https://evil.example/reply" }),
    ]) {
      expect(
        (await signedPost(credentials, JSON.stringify(invalid))).status,
      ).toBe(400);
    }
    expect((await SELF.fetch(`${ORIGIN}/ingest/unknown`, { method: "POST" })).status).toBe(404);
  });

  it("posts a signed callback and returns the prior result for duplicate chat_reply", async () => {
    const credentials = await createSource({
      source: "callback",
      replyURL: "https://receiver.example/transit/replies",
      prefixes: ["https://receiver.example/transit/"],
    });
    onConnectorFetch(
      "POST",
      (url) => url.hostname === "receiver.example",
      () => new Response(null, { status: 204 }),
    );
    const ingested = await signedPost(
      credentials,
      JSON.stringify(ingestBody({ event_key: "callback-event" })),
    );
    const queued = await ingested.json<{ delivery_id: string }>();
    const integration = env.INTEGRATION.getByName(
      `org:${credentials.org}:integration:${credentials.integrationId}`,
    );
    const reply = await integration.chatReply({
      deliveryId: queued.delivery_id,
      conversationId: "conversation-1",
      caller: "alice@alpha",
      message: "Acknowledged",
    });
    expect(reply).toMatchObject({ status: "handled", duplicate: false });
    const callback = connectorCalls.find((call) =>
      call.url.startsWith("https://receiver.example/"),
    );
    expect(callback).toBeDefined();
    const timestamp = callback?.headers["transit-timestamp"] ?? "";
    const signature = callback?.headers["transit-signature"] ?? "";
    expect(
      await hmacVerify(
        credentials.secret,
        `${timestamp}.${callback?.body ?? ""}`,
        signature.replace(/^v1=/u, ""),
      ),
    ).toBe(true);
    expect(JSON.parse(callback?.body ?? "{}")).toMatchObject({
      schema: "transit.ingest/1",
      kind: "reply",
      source: "callback",
      delivery_id: queued.delivery_id,
      agent: "alice@alpha",
      message: "Acknowledged",
    });
    expect(
      await integration.chatReply({
        deliveryId: queued.delivery_id,
        conversationId: "conversation-1",
        caller: "alice@alpha",
        message: "Do not post twice",
      }),
    ).toMatchObject({ duplicate: true, message: "Acknowledged" });
  });

  it("rechecks prefixes at post time and refuses one-way replies before persistence", async () => {
    const credentials = await createSource({
      source: "revoked-prefix",
      replyURL: "https://receiver.example/transit/replies",
      prefixes: ["https://receiver.example/transit/"],
    });
    const removeFailure = onConnectorFetch(
      "POST",
      (url) => url.hostname === "receiver.example",
      () => new Response("temporary", { status: 500 }),
    );
    const ingested = await signedPost(
      credentials,
      JSON.stringify(ingestBody({ event_key: "prefix-event" })),
    );
    const queued = await ingested.json<{ delivery_id: string }>();
    const integration = env.INTEGRATION.getByName(
      `org:${credentials.org}:integration:${credentials.integrationId}`,
    );
    expect(
      await integration.chatReply({
        deliveryId: queued.delivery_id,
        conversationId: "conversation-1",
        caller: "alice@alpha",
        message: "Queued callback",
      }),
    ).toMatchObject({ status: "post_pending" });
    removeFailure();
    await SELF.fetch(`${ORIGIN}/api/sources/revoked-prefix`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: credentials.cookie,
      },
      body: JSON.stringify({ reply_url: "", reply_url_prefixes: [] }),
    });
    await runInDurableObject(integration, async (instance, state) => {
      const reply = await state.storage.get<{ nextAttemptAt?: number }>(
        `reply:${queued.delivery_id}`,
      );
      if (!reply) throw new Error("reply missing");
      reply.nextAttemptAt = Date.now() - 1;
      await state.storage.put(`reply:${queued.delivery_id}`, reply);
      await (instance as Integration).alarm();
    });
    expect(connectorCalls.filter((call) => call.url.includes("receiver.example"))).toHaveLength(1);

    const oneWay = await createSource({ source: "one-way" });
    const oneWayIngest = await signedPost(
      oneWay,
      JSON.stringify(ingestBody({ event_key: "one-way-event" })),
    );
    const oneWayQueued = await oneWayIngest.json<{ delivery_id: string }>();
    const oneWayStub = env.INTEGRATION.getByName(
      `org:${oneWay.org}:integration:${oneWay.integrationId}`,
    );
    await runInDurableObject(oneWayStub, async (instance, state) => {
      const engine = instance as Integration;
      await expect(
        engine.chatReply({
          deliveryId: oneWayQueued.delivery_id,
          conversationId: "conversation-1",
          caller: "alice@alpha",
          message: "Cannot post",
        }),
      ).rejects.toThrow("one-way; use mark_handled");
      expect(await state.storage.get(`reply:${oneWayQueued.delivery_id}`)).toBeUndefined();
    });
  });

  it("limits a source to a burst of 20 requests", async () => {
    const credentials = await createSource({ source: "rate-limit" });
    const responses = await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        signedPost(
          credentials,
          JSON.stringify(
            ingestBody({
              event_key: `burst-${index}`,
              conversation_id: `burst-${index}`,
            }),
          ),
        ),
      ),
    );
    expect(responses.filter((response) => response.status === 202)).toHaveLength(20);
    const limited = responses.find((response) => response.status === 429);
    expect(limited).toBeDefined();
    expect(await limited?.json()).toEqual({ error: "rate_limited" });
  });
});
