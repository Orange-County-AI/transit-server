import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

async function operator(): Promise<{ cookie: string; org: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const signup = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      email: `activity-${suffix}@test.example`,
      password: "correct-horse-battery-staple",
      name: "Activity Operator",
    }),
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const session = await SELF.fetch(`${ORIGIN}/api/auth/get-session`, {
    headers: { cookie },
  });
  const body = await session.json<{ user: { id: string } }>();
  return { cookie, org: body.user.id };
}

// Seeds one message with a derived per-message status, `index` slots newer.
async function seed(
  org: string,
  index: number,
  status: "injected" | "dead" | "queued",
): Promise<void> {
  const id = `tx_seed${String(index).padStart(9, "0")}`;
  await env.DB.prepare(
    `INSERT INTO message (id, org_id, kind, from_addr, to_addr, body, created_at)
     VALUES (?, ?, 'dm', 'alice@titan', 'bob@titan', ?, ?)`,
  )
    .bind(id, org, `seed ${index}`, Date.now() - (500 - index) * 1_000)
    .run();
  await env.DB.prepare(
    `INSERT INTO message_delivery (message_id, target_addr, status, attempts, updated_at)
     VALUES (?, 'bob@titan', ?, 1, ?)`,
  )
    .bind(id, status, Date.now())
    .run();
}

describe("activity window", () => {
  // The overview tiles used to be filtered client-side from the activity feed,
  // which returns the newest 100 rows. A dead letter older than those was
  // invisible, so "0 dead" could not fail. The counts have to come from the
  // whole 24-hour window, and the feed has to admit when it is clipped.
  it("counts a dead letter that falls outside the feed window", async () => {
    const { cookie, org } = await operator();

    // The oldest row: with 120 messages seeded it can never be in the newest
    // 100, which is exactly the row the old tile could not see.
    await seed(org, 0, "dead");
    for (let index = 1; index < 120; index += 1) {
      await seed(org, index, "injected");
    }

    const response = await SELF.fetch(`${ORIGIN}/api/activity`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json<{
      activity: { id: string }[];
      truncated: boolean;
      window: { deliveries_24h: number; dead_24h: number; queued_24h: number };
    }>();

    expect(body.activity).toHaveLength(100);
    expect(body.truncated).toBe(true);
    // The proof: the dead row is absent from the feed and present in the count.
    expect(body.activity.some((line) => line.id === "tx_seed000000000")).toBe(false);
    expect(body.window.dead_24h).toBe(1);
    expect(body.window.deliveries_24h).toBe(120);
  });

  it("reports an unclipped feed as complete", async () => {
    const { cookie, org } = await operator();
    await seed(org, 1, "injected");
    await seed(org, 2, "queued");

    const response = await SELF.fetch(`${ORIGIN}/api/activity`, { headers: { cookie } });
    const body = await response.json<{
      activity: unknown[];
      truncated: boolean;
      window: { deliveries_24h: number; dead_24h: number; queued_24h: number };
    }>();
    expect(body.truncated).toBe(false);
    expect(body.activity).toHaveLength(2);
    expect(body.window).toMatchObject({
      deliveries_24h: 2,
      dead_24h: 0,
      queued_24h: 1,
    });
  });
});
