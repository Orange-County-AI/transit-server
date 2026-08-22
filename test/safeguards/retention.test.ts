import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sweep } from "../../src/lib/transit/retention";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("retention sweep", () => {
  it("is bounded and preserves current or unsettled records", async () => {
    const now = Date.now();
    const oldMessage = now - 8 * DAY_MS;
    const oldIntegration = now - 31 * DAY_MS;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO message
         (id, org_id, kind, from_addr, to_addr, room_seq, body, reply_to, created_at)
         VALUES ('tx_old00000001', 'org', 'dm', 'a@alpha', 'b@beta', NULL, 'old', NULL, ?)`,
      ).bind(oldMessage),
      env.DB.prepare(
        `INSERT INTO message
         (id, org_id, kind, from_addr, to_addr, room_seq, body, reply_to, created_at)
         VALUES ('tx_new00000001', 'org', 'dm', 'a@alpha', 'b@beta', NULL, 'new', NULL, ?)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO message_delivery
         (message_id, target_addr, status, attempts, last_error, updated_at)
         VALUES ('tx_old00000001', 'b@beta', 'injected', 1, NULL, ?)`,
      ).bind(oldMessage),
      env.DB.prepare(
        `INSERT INTO integration
         (id, org_id, connector, name, config_enc, target_addr, status, created_at)
         VALUES ('int_old0000001', 'org', 'telegram', 'test', 'sealed', 'a@alpha', 'active', ?)`,
      ).bind(oldIntegration),
      env.DB.prepare(
        `INSERT INTO integration_event
         (id, integration_id, event_key, conversation_id, user, trigger, content, meta_json, received_at)
         VALUES ('evt_oldhandled1', 'int_old0000001', 'handled', 'c1', NULL, NULL, 'old', '{}', ?)`,
      ).bind(oldIntegration),
      env.DB.prepare(
        `INSERT INTO integration_event
         (id, integration_id, event_key, conversation_id, user, trigger, content, meta_json, received_at)
         VALUES ('evt_oldpending1', 'int_old0000001', 'pending', 'c2', NULL, NULL, 'pending', '{}', ?)`,
      ).bind(oldIntegration),
      env.DB.prepare(
        `INSERT INTO integration_delivery
         (id, event_id, target_addr, status, attempts, read_at, settled_at, created_at)
         VALUES ('dlv_oldhandled1', 'evt_oldhandled1', 'a@alpha', 'handled', 1, NULL, ?, ?)`,
      ).bind(oldIntegration, oldIntegration),
      env.DB.prepare(
        `INSERT INTO integration_delivery
         (id, event_id, target_addr, status, attempts, read_at, settled_at, created_at)
         VALUES ('dlv_oldpending1', 'evt_oldpending1', 'a@alpha', 'pending', 0, NULL, NULL, ?)`,
      ).bind(oldIntegration),
      env.DB.prepare(
        `INSERT INTO integration_reply
         (delivery_id, message, reply_mode, posted_at, post_error, created_at)
         VALUES ('dlv_oldhandled1', 'done', NULL, ?, NULL, ?)`,
      ).bind(oldIntegration, oldIntegration),
      env.DB.prepare(
        `INSERT INTO enroll_code
         (code_hash, org_id, slug, expires_at, used_at)
         VALUES ('expired', 'org', 'alpha', ?, NULL)`,
      ).bind(now - 1),
      env.DB.prepare(
        `INSERT INTO enroll_code
         (code_hash, org_id, slug, expires_at, used_at)
         VALUES ('current', 'org', 'beta', ?, NULL)`,
      ).bind(now + DAY_MS),
    ]);

    const bounded = await sweep(env.DB, {
      now,
      batchSize: 1,
      maxBatches: 1,
    });
    expect(bounded).toEqual({ batches: 1, deleted: 1 });
    expect(
      await env.DB.prepare("SELECT id FROM message WHERE id = 'tx_old00000001'").first(),
    ).not.toBeNull();

    await sweep(env.DB, { now, batchSize: 1, maxBatches: 50 });
    expect(
      await env.DB.prepare("SELECT id FROM message WHERE id = 'tx_old00000001'").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM message WHERE id = 'tx_new00000001'").first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM integration_delivery WHERE id = 'dlv_oldhandled1'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM integration_delivery WHERE id = 'dlv_oldpending1'",
      ).first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM integration_event WHERE id = 'evt_oldhandled1'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT delivery_id FROM integration_reply WHERE delivery_id = 'dlv_oldhandled1'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT code_hash FROM enroll_code WHERE code_hash = 'expired'").first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT code_hash FROM enroll_code WHERE code_hash = 'current'").first(),
    ).not.toBeNull();
  });
});
