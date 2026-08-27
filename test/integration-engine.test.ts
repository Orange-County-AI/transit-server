import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Integration } from "../src/do/integration";
import { readAttachmentCapability } from "../src/lib/transit/attachment";
import {
  connectorCalls,
  onConnectorFetch,
} from "./connector-mock";

const ORG = "integration-test-org";
const INTEGRATION_ID = "int_001122334455";

async function configuredIntegration() {
  const host = env.HOST_HUB.getByName(`org:${ORG}:host:alpha`);
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
  const integration = env.INTEGRATION.getByName(
    `org:${ORG}:integration:${INTEGRATION_ID}`,
  );
  await integration.configure({
    org: ORG,
    id: INTEGRATION_ID,
    connector: "telegram",
    name: "test-telegram",
    targetAddr: "alice@alpha",
    config: {
      bot_token: "123:test",
      webhook_secret: "webhook-secret",
      allowed_user_ids: "42",
      instructions: "Reply visibly.",
    },
  });
  return integration;
}

beforeEach(() => {
  onConnectorFetch(
    "POST",
    (url) => url.hostname === "api.telegram.org",
    () => Response.json({ ok: true, result: { message_id: 1 } }),
  );
});

describe("Integration engine", () => {
  it("deduplicates ingest and dispatches one durable delivery", async () => {
    const integration = await configuredIntegration();
    const event = {
      eventKey: "update:1",
      conversationId: "chat-1",
      user: "Ada",
      trigger: "message",
      content: "hello",
      meta: { chat_id: "42" },
    };
    const first = await integration.ingestEvent(event);
    const duplicate = await integration.ingestEvent(event);
    expect(first.status).toBe("queued");
    expect(first.deliveryId).toMatch(/^dlv_[0-9a-f]{12}$/);
    expect(duplicate).toEqual({
      status: "duplicate",
      eventId: first.eventId,
      deliveryId: first.deliveryId,
    });

    const host = env.HOST_HUB.getByName(`org:${ORG}:host:alpha`);
    const queued = await runInDurableObject(host, async (_instance, state) =>
      state.storage.list({ prefix: "q:" }),
    );
    expect(queued.size).toBe(1);
    const delivery = await runInDurableObject(
      integration,
      async (_instance, state) =>
        state.storage.get<{ attempts: number; status: string }>(
          `delivery:${first.deliveryId}`,
        ),
    );
    expect(delivery).toMatchObject({ attempts: 1, status: "dispatched" });
  });

  it("returns short-lived attachment capabilities without exposing connector credentials", async () => {
    const integration = await configuredIntegration();
    const ingested = await integration.ingestEvent({
      eventKey: "update:attachment",
      conversationId: "chat-attachment",
      user: "Ada",
      content: "review the file",
      meta: { chat_id: "42" },
      attachments: [
        {
          id: "upstream-file-1",
          name: "brief.pdf",
          contentType: "application/pdf",
          size: 3,
        },
      ],
    });
    const result = await integration.readMessageV2(
      ingested.deliveryId,
      "alice@alpha",
    );
    expect(result.text).toContain("review the file");
    expect(result.attachments).toHaveLength(1);
    const url = new URL(result.attachments[0]!.url);
    expect(url.origin).toBe(new URL(env.BETTER_AUTH_URL).origin);
    expect(url.pathname).toBe("/api/attachments");
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();
    const claims = await readAttachmentCapability(
      token!,
      env.TRANSIT_MASTER_KEY,
    );
    expect(claims).toMatchObject({
      org: ORG,
      integrationId: INTEGRATION_ID,
      eventId: ingested.eventId,
      deliveryId: ingested.deliveryId,
      index: 0,
    });
    expect(result.attachments[0]).not.toHaveProperty("id");
  });

  it("streams a capability-authorized attachment through its connector", async () => {
    onConnectorFetch(
      "GET",
      (url) => url.hostname === "mm.example" && url.pathname === "/api/v4/users/me",
      () => Response.json({ id: "bot-1", username: "transit" }),
    );
    onConnectorFetch(
      "GET",
      (url) =>
        url.hostname === "mm.example" &&
        url.pathname === "/api/v4/files/file-1",
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            "content-type": "application/pdf",
            "content-length": "3",
          },
        }),
    );
    const integrationID = "int_attachmentmm";
    const integration = env.INTEGRATION.getByName(
      `org:${ORG}:integration:${integrationID}`,
    );
    const host = env.HOST_HUB.getByName(`org:${ORG}:host:alpha`);
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
    await integration.configure({
      org: ORG,
      id: integrationID,
      connector: "mattermost",
      name: "attachment-mattermost",
      targetAddr: "alice@alpha",
      config: {
        server_url: "https://mm.example",
        bot_token: "secret-token",
      },
    });
    const ingested = await integration.ingestEvent({
      eventKey: "mattermost:file-1",
      conversationId: "channel:root",
      content: "review this",
      meta: { channel_id: "channel", post_id: "post" },
      attachments: [
        {
          id: "file-1",
          name: "brief.pdf",
          contentType: "application/pdf",
          size: 3,
        },
      ],
    });
    const read = await integration.readMessageV2(
      ingested.deliveryId,
      "alice@alpha",
    );
    const capability = new URL(read.attachments[0]!.url).searchParams.get(
      "token",
    );
    const response = await SELF.fetch(
      `https://transit.test/api/attachments?token=${encodeURIComponent(
        capability!,
      )}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("heartbeats only while the connector and named target are healthy", async () => {
    const integrationID = "int_health001122";
    const host = env.HOST_HUB.getByName(`org:${ORG}:host:alpha`);
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
    const integration = env.INTEGRATION.getByName(
      `org:${ORG}:integration:${integrationID}`,
    );
    await integration.configure({
      org: ORG,
      id: integrationID,
      connector: "telegram",
      name: "test-telegram-health",
      targetAddr: "alice@alpha",
      config: {
        bot_token: "123:test",
        webhook_secret: "webhook-secret",
        allowed_user_ids: "42",
        health_ping_url: "https://monicron.example/heartbeat/token",
      },
    });
    await runInDurableObject(integration, async (_instance, state) => {
      await state.storage.put("connectorStatus", {
        state: "webhook",
        updatedAt: Date.now(),
      });
      await state.storage.delete("health:last_ping");
    });
    onConnectorFetch(
      "POST",
      (url) => url.hostname === "monicron.example",
      () => new Response(null, { status: 204 }),
    );
    await runInDurableObject(integration, async (instance) => {
      await (instance as Integration).alarm();
    });
    expect(
      connectorCalls.filter((call) =>
        call.url.startsWith("https://monicron.example/heartbeat/"),
      ),
    ).toHaveLength(1);

    await runInDurableObject(host, async (_instance, state) => {
      await state.storage.delete("roster:alice");
    });
    await runInDurableObject(integration, async (_instance, state) => {
      await state.storage.delete("health:last_ping");
    });
    await runInDurableObject(integration, async (instance) => {
      await (instance as Integration).alarm();
    });
    expect(
      connectorCalls.filter((call) =>
        call.url.startsWith("https://monicron.example/heartbeat/"),
      ),
    ).toHaveLength(1);
    await integration.pause(true);
  });

  it("marks read, records a reply before posting, and retries the same reply", async () => {
    const integration = await configuredIntegration();
    const ingested = await integration.ingestEvent({
      eventKey: "update:2",
      conversationId: "chat-2",
      user: "Ada",
      content: "need answer",
      meta: { chat_id: "42" },
    });
    const beforeRead = Date.now();
    const full = await integration.readMessage(ingested.deliveryId, "alice@alpha");
    expect(full).toContain('read="first" schema="transit/1"');
    expect(full).toContain(
      'need answer\n<settle tool="chat_reply|mark_handled"/>\nReply visibly.',
    );
    const readDelivery = await runInDurableObject(
      integration,
      async (_instance, state) =>
        state.storage.get<{ nextAttemptAt: number; status: string }>(
          `delivery:${ingested.deliveryId}`,
        ),
    );
    expect(readDelivery?.status).toBe("read");
    expect(readDelivery?.nextAttemptAt).toBeGreaterThanOrEqual(
      beforeRead + 20 * 60_000 - 1_000,
    );

    const removeSuccess = onConnectorFetch(
      "POST",
      (url) => url.hostname === "api.telegram.org",
      () => Response.json({ ok: false, description: "temporary" }, { status: 500 }),
    );
    const firstReply = await integration.chatReply({
      deliveryId: ingested.deliveryId,
      conversationId: "chat-2",
      caller: "alice@alpha",
      message: "recorded answer",
    });
    expect(firstReply).toMatchObject({
      status: "post_pending",
      duplicate: false,
      message: "recorded answer",
      postError: "temporary",
    });
    const recorded = await runInDurableObject(
      integration,
      async (_instance, state) =>
        state.storage.get<{ message: string; postedAt?: number }>(
          `reply:${ingested.deliveryId}`,
        ),
    );
    expect(recorded).toEqual(
      expect.objectContaining({ message: "recorded answer" }),
    );
    expect(recorded?.postedAt).toBeUndefined();

    const duplicateReply = await integration.chatReply({
      deliveryId: ingested.deliveryId,
      conversationId: "chat-2",
      caller: "alice@alpha",
      message: "different answer",
    });
    expect(duplicateReply).toMatchObject({
      status: "post_pending",
      duplicate: true,
      message: "recorded answer",
    });
    removeSuccess();
    await runInDurableObject(integration, async (_instance, state) => {
      const reply = await state.storage.get<{
        nextAttemptAt?: number;
      }>(`reply:${ingested.deliveryId}`);
      if (!reply) throw new Error("reply missing");
      reply.nextAttemptAt = Date.now() - 1;
      await state.storage.put(`reply:${ingested.deliveryId}`, reply);
    });
    expect(await runDurableObjectAlarm(integration)).toBe(true);
    const settled = await runInDurableObject(
      integration,
      async (_instance, state) =>
        state.storage.get<{ status: string; settledAt?: number }>(
          `delivery:${ingested.deliveryId}`,
        ),
    );
    expect(settled?.status).toBe("handled");
    expect(settled?.settledAt).toBeTypeOf("number");
    expect(
      connectorCalls.findLast((call) =>
        call.url.startsWith("https://api.telegram.org/"),
      )?.body,
    ).toContain("recorded answer");
  });

  it("enforces ownership and pause", async () => {
    const integration = await configuredIntegration();
    const ingested = await integration.ingestEvent({
      eventKey: "update:3",
      conversationId: "chat-3",
      content: "owned",
      meta: { chat_id: "42" },
    });
    await runInDurableObject(integration, async (instance) => {
      const engine = instance as Integration;
      await expect(
        engine.markHandled(ingested.deliveryId, "mallory@beta"),
      ).rejects.toThrow("delivery owner mismatch");
      expect(
        await engine.markHandled(ingested.deliveryId, "alice@alpha"),
      ).toEqual({ duplicate: false });
      await engine.pause(true);
      await expect(
        engine.ingestEvent({
          eventKey: "update:4",
          conversationId: "chat-4",
          content: "paused",
        }),
      ).rejects.toThrow("integration_paused");
    });
  });
});
