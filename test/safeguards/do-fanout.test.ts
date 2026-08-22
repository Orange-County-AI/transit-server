import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ALARM_BUDGET_PER_HOUR,
  alarmBudgetStatus,
  budgetedAlarm,
} from "../../src/lib/transit/alarm-budget";

const HOUR_MS = 60 * 60 * 1_000;

describe("Durable Object fan-out safeguards", () => {
  it("refuses alarms past 120 per hour and schedules one boundary wake", async () => {
    const stub = env.HOST_HUB.getByName(`budget-${crypto.randomUUID()}`);
    const now = Date.now();
    const expectedResume = (Math.floor(now / HOUR_MS) + 1) * HOUR_MS;

    const result = await runInDurableObject(stub, async (_instance, state) => {
      const scheduled: boolean[] = [];
      for (let index = 0; index < ALARM_BUDGET_PER_HOUR + 2; index += 1) {
        scheduled.push(await budgetedAlarm(state.storage, now + 60_000));
      }
      return {
        scheduled,
        alarm: await state.storage.getAlarm(),
        status: await alarmBudgetStatus(state.storage),
      };
    });

    expect(result.scheduled.slice(0, ALARM_BUDGET_PER_HOUR).every(Boolean)).toBe(true);
    expect(result.scheduled.slice(ALARM_BUDGET_PER_HOUR)).toEqual([false, false]);
    expect(result.alarm).toBe(expectedResume);
    expect(result.status).toEqual({ hourStart: expectedResume - HOUR_MS, resumeAt: expectedResume });
  });

  it("moves a delivery at the 40-attempt cap to dead without another alarm", async () => {
    const stub = env.HOST_HUB.getByName(`attempts-${crypto.randomUUID()}`);
    const messageId = "tx_deadbeefcafe";
    const queueKey = "q:agent:0000000000000001";
    const item = {
      messageId,
      org: "org-test",
      agent: "agent",
      targetAddr: "agent@alpha",
      envelope: "<transit />",
      attempts: 40,
      enqueuedAt: Date.now(),
    };

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(queueKey, item);
      await state.storage.put(`d:${messageId}:${item.agent}`, {
        status: "queued",
        updatedAt: Date.now(),
        queueKey,
      });
      await state.storage.setAlarm(Date.now() + 1_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const state = await runInDurableObject(stub, async (_instance, durableState) => ({
      marker: await durableState.storage.get<{ status: string; item?: { attempts: number } }>(
        `d:${messageId}:${item.agent}`,
      ),
      queued: await durableState.storage.get(queueKey),
      alarm: await durableState.storage.getAlarm(),
    }));
    expect(state.marker?.status).toBe("dead");
    expect(state.marker?.item?.attempts).toBe(40);
    expect(state.queued).toBeUndefined();
    expect(state.alarm).toBeNull();

    const archived = await env.DB.prepare(
      "SELECT status, attempts FROM message_delivery WHERE message_id = ? AND target_addr = ?",
    )
      .bind(messageId, item.targetAddr)
      .first<{ status: string; attempts: number }>();
    expect(archived).toEqual({ status: "dead", attempts: 40 });
  });

  it("fans Room posts directly into HostHub queues without Room re-entry", async () => {
    const org = `org-${crypto.randomUUID()}`;
    const alpha = env.HOST_HUB.getByName(`org:${org}:host:alpha`);
    const beta = env.HOST_HUB.getByName(`org:${org}:host:beta`);
    await runInDurableObject(alpha, async (_instance, state) => {
      await state.storage.put("roster:alice", {
        name: "alice",
        kind: "omp",
        pane_id: "alpha:p1",
        status: "idle",
        cwd: "/work",
        title: "alice",
        named_by: "user",
      });
    });
    await runInDurableObject(beta, async (_instance, state) => {
      await state.storage.put("roster:bob", {
        name: "bob",
        kind: "omp",
        pane_id: "beta:p1",
        status: "idle",
        cwd: "/work",
        title: "bob",
        named_by: "user",
      });
    });

    const room = env.ROOM.getByName(`org:${org}:room:ops`);
    await room.configure({
      org,
      name: "ops",
      policy: "open",
      createdAt: Date.now(),
    });
    await room.join("alice@alpha", "operator");
    await room.join("bob@beta", "operator");
    const posted = await room.post("operator@transit", "fan-out once");
    expect(posted.seq).toBe(1);

    const [alphaQueues, betaQueues] = await Promise.all([
      runInDurableObject(alpha, async (_instance, state) =>
        state.storage.list({ prefix: "q:" }),
      ),
      runInDurableObject(beta, async (_instance, state) =>
        state.storage.list({ prefix: "q:" }),
      ),
    ]);
    expect(alphaQueues.size).toBe(1);
    expect(betaQueues.size).toBe(1);
    expect((await room.detail()).sequence).toBe(1);
  });

  it("applies the same alarm budget inside each Integration DO", async () => {
    const integration = env.INTEGRATION.getByName(
      `integration-budget-${crypto.randomUUID()}`,
    );
    const results = await runInDurableObject(
      integration,
      async (_instance, state) => {
        const scheduled: boolean[] = [];
        for (let index = 0; index < ALARM_BUDGET_PER_HOUR + 1; index += 1) {
          scheduled.push(await budgetedAlarm(state.storage, Date.now() + 1_000));
        }
        return {
          last: scheduled.at(-1),
          status: await alarmBudgetStatus(state.storage),
        };
      },
    );
    expect(results.last).toBe(false);
    expect(results.status).not.toBeNull();
  });
});
