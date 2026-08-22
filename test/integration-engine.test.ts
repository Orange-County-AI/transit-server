import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Integration } from "../src/do/integration";
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
    expect(full).toContain("need answer\n[settle: chat_reply or mark_handled]\nReply visibly.");
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
    expect(connectorCalls.at(-1)?.body).toContain("recorded answer");
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
