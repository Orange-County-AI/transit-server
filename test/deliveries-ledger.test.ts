import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

async function operator(): Promise<{ cookie: string; org: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const signup = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      email: `ledger-${suffix}@test.example`,
      password: "test1234!",
      name: "Ledger Operator",
    }),
  });
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await signup.json<{ user: { id: string } }>();
  return { cookie, org: session.user.id };
}

async function seedMessages(org: string, count: number): Promise<void> {
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    const id = `tx_ledger${String(index).padStart(6, "0")}`;
    await env.DB.prepare(
      `INSERT INTO message (id, org_id, kind, from_addr, to_addr, body, created_at)
       VALUES (?, ?, 'dm', 'alice@alpha', 'bob@beta', ?, ?)`,
    )
      .bind(id, org, `ledger row ${index}`, now + index)
      .run();
    await env.DB.prepare(
      `INSERT INTO message_delivery (message_id, target_addr, status, attempts, updated_at)
       VALUES (?, 'bob@beta', 'injected', 1, ?)`,
    )
      .bind(id, now + index)
      .run();
  }
}

async function ledger(cookie: string, query: string) {
  const response = await SELF.fetch(`${ORIGIN}/api/deliveries${query}`, {
    headers: { origin: ORIGIN, cookie },
  });
  return {
    status: response.status,
    body: await response.json<{
      deliveries?: unknown[];
      limit?: number;
      truncated?: boolean;
      error?: string;
    }>(),
  };
}

describe("delivery ledger paging", () => {
  // A ledger that truncates silently reads as a complete ledger. That is how a
  // fleet sweep came back reassuring while a redelivery loop was running: the
  // caller asked for 500 rows, the handler ignored the parameter, returned its
  // hardcoded 200, and said nothing about the rest.
  it("honours a limit, reports it, and admits truncation", async () => {
    const { cookie, org } = await operator();
    await seedMessages(org, 12);

    const capped = await ledger(cookie, "?f=all&limit=5");
    expect(capped.status).toBe(200);
    expect(capped.body.deliveries).toHaveLength(5);
    expect(capped.body.limit).toBe(5);
    expect(capped.body.truncated, "5 of 12 rows is a truncated answer").toBe(true);

    const whole = await ledger(cookie, "?f=all&limit=50");
    expect(whole.body.deliveries).toHaveLength(12);
    expect(whole.body.truncated, "50 covers 12 rows, so nothing was dropped").toBe(false);

    const defaulted = await ledger(cookie, "?f=all");
    expect(defaulted.body.limit, "the historical cap stays the default").toBe(200);
    expect(defaulted.body.truncated).toBe(false);
  });

  // Clamping an out-of-range limit would answer a question the caller did not
  // ask, which is the same defect the truncation flag exists to prevent.
  it("refuses a limit it cannot honour", async () => {
    const { cookie } = await operator();
    for (const query of ["?limit=0", "?limit=-5", "?limit=1001", "?limit=abc", "?limit=1.5"]) {
      const response = await ledger(cookie, query);
      expect(response.status, `${query} must be refused`).toBe(400);
      expect(response.body.error).toBe("invalid_limit");
    }
  });
});
