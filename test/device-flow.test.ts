import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

async function operator(): Promise<{ cookie: string; org: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const signup = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      email: `device-${suffix}@test.example`,
      password: "correct-horse-battery-staple",
      name: "Device Operator",
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

type Authorized = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

async function authorize(hostname = "titan"): Promise<Authorized> {
  const response = await SELF.fetch(`${ORIGIN}/api/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname, daemon_ver: "0.4.1" }),
  });
  expect(response.status).toBe(200);
  return response.json<Authorized>();
}

function poll(deviceCode: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
}

/** The daemon is told to wait between polls; skip the wait in tests. */
async function allowNextPoll(deviceCode: string): Promise<void> {
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(deviceCode)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await env.DB.prepare(
    "UPDATE device_authorization SET polled_at = NULL WHERE device_code_hash = ?",
  )
    .bind(hash)
    .run();
}

function approve(
  cookie: string,
  userCode: string,
  slug?: string,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: ORIGIN },
    body: JSON.stringify(slug ? { user_code: userCode, slug } : { user_code: userCode }),
  });
}

describe("device authorization", () => {
  it("enrolls a host end to end without a pre-issued code", async () => {
    const { cookie, org } = await operator();
    const started = await authorize("titan");

    expect(started.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
    expect(started.verification_uri).toBe(`${ORIGIN}/activate`);
    expect(started.verification_uri_complete).toContain(started.user_code);
    expect(started.interval).toBeGreaterThan(0);

    // Nothing to hand over until a person says so.
    const pending = await poll(started.device_code);
    expect(pending.status).toBe(400);
    expect(await pending.json()).toEqual({ error: "authorization_pending" });

    // The browser can see what it is being asked to approve, and only that.
    const preview = await SELF.fetch(
      `${ORIGIN}/api/device/pending/${started.user_code}`,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({
      hostname: "titan",
      daemon_ver: "0.4.1",
      approved: false,
    });

    expect((await approve(cookie, started.user_code)).status).toBe(200);

    await allowNextPoll(started.device_code);
    const issued = await poll(started.device_code);
    expect(issued.status).toBe(200);
    const enrolled = await issued.json<{
      device_token: string;
      host: string;
      org: string;
    }>();
    expect(enrolled.host).toBe("titan");
    expect(enrolled.org).toBe(org);
    expect(enrolled.device_token.length).toBeGreaterThan(20);

    // The token has to actually work, or "enrolled" means nothing.
    const authed = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
      headers: {
        authorization: `Bearer ${enrolled.device_token}`,
        upgrade: "websocket",
      },
    });
    expect(authed.status).toBe(101);
  });

  it("spends a device code exactly once", async () => {
    const { cookie } = await operator();
    const started = await authorize("blackbird");
    await approve(cookie, started.user_code);

    await allowNextPoll(started.device_code);
    expect((await poll(started.device_code)).status).toBe(200);

    await allowNextPoll(started.device_code);
    const replay = await poll(started.device_code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
  });

  it("tells an impatient daemon to slow down", async () => {
    const started = await authorize("minime");
    expect((await poll(started.device_code)).status).toBe(400);
    // Immediately again, without clearing polled_at.
    const hasty = await poll(started.device_code);
    expect(hasty.status).toBe(429);
    expect(await hasty.json()).toEqual({ error: "slow_down" });
  });

  it("refuses an expired flow", async () => {
    const started = await authorize("gigachad");
    await env.DB.prepare(
      "UPDATE device_authorization SET expires_at = ? WHERE user_code = ?",
    )
      .bind(Date.now() - 1_000, started.user_code)
      .run();

    const expired = await poll(started.device_code);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ error: "expired_token" });

    // And it is no longer approvable.
    const { cookie } = await operator();
    expect((await approve(cookie, started.user_code)).status).toBe(404);
  });

  it("rejects an unknown device code", async () => {
    const response = await poll("not-a-real-device-code");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
  });

  it("requires a session to approve", async () => {
    const started = await authorize("titan");
    const response = await SELF.fetch(`${ORIGIN}/api/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ user_code: started.user_code }),
    });
    expect(response.status).toBe(401);
  });

  it("will not approve the same flow twice", async () => {
    const { cookie } = await operator();
    const started = await authorize("titan");
    expect((await approve(cookie, started.user_code)).status).toBe(200);
    const second = await approve(cookie, started.user_code);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "already_approved" });
  });

  it("lets the browser rename the host away from the reported hostname", async () => {
    const { cookie } = await operator();
    const started = await authorize("ip-10-0-0-4");
    const approved = await approve(cookie, started.user_code, "prod-runner");
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ approved: true, host: "prod-runner" });

    await allowNextPoll(started.device_code);
    const issued = await poll(started.device_code);
    const enrolled = await issued.json<{ host: string }>();
    expect(enrolled.host).toBe("prod-runner");
  });

  it("rejects a slug that is not a valid host name", async () => {
    const { cookie } = await operator();
    const started = await authorize("titan");
    const response = await approve(cookie, started.user_code, "Not A Host!");
    expect(response.status).toBe(400);
  });

  it("scopes the enrolled host to the approving operator's organization", async () => {
    const mine = await operator();
    const theirs = await operator();
    const started = await authorize("shared-name");
    expect((await approve(theirs.cookie, started.user_code)).status).toBe(200);

    await allowNextPoll(started.device_code);
    const enrolled = await (await poll(started.device_code)).json<{ org: string }>();
    expect(enrolled.org).toBe(theirs.org);
    expect(enrolled.org).not.toBe(mine.org);
  });

  it("rejects a malformed authorize request", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/device/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "titan" }),
    });
    expect(response.status).toBe(400);
  });

  it("does not leak an organization through the pending preview", async () => {
    const { cookie } = await operator();
    const started = await authorize("titan");
    await approve(cookie, started.user_code);
    const preview = await SELF.fetch(
      `${ORIGIN}/api/device/pending/${started.user_code}`,
    );
    const body = await preview.json<Record<string, unknown>>();
    expect(body).toEqual({ hostname: "titan", daemon_ver: "0.4.1", approved: true });
    expect(Object.keys(body)).not.toContain("org_id");
  });
});

describe("installation hosting", () => {
  it("serves an installer that points back at this origin", async () => {
    const response = await SELF.fetch(`${ORIGIN}/install`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/x-shellscript");

    const script = await response.text();
    expect(script).toContain("#!/bin/sh");
    // The whole point: no third-party host in the documented path.
    expect(script).not.toContain("github.com");
    expect(script).toContain("/dl/$os/$arch");
  });

  it("redirects each supported platform to a release asset", async () => {
    for (const platform of [
      "linux/amd64",
      "linux/arm64",
      "darwin/amd64",
      "darwin/arm64",
    ]) {
      const response = await SELF.fetch(`${ORIGIN}/dl/${platform}`, {
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain(`transit_${platform.replace("/", "_")}`);
    }
  });

  it("refuses a platform nothing is built for", async () => {
    const response = await SELF.fetch(`${ORIGIN}/dl/windows/amd64`, {
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });
});
