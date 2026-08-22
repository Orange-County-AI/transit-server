import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256hex } from "../src/lib/transit/crypto";

const ORIGIN = "http://localhost";

async function operatorSession(email: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "test1234!", name: "Operator" }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function createCode(cookie: string, slug: string) {
  const response = await SELF.fetch(`${ORIGIN}/api/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({ slug }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<{ code: string; expires_at: string; command: string }>();
}

async function daemonEnroll(code: string) {
  return SELF.fetch(`${ORIGIN}/api/daemon/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, daemon_ver: "0.1.0-test" }),
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
  socket.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
  return promise;
}

function closeSocket(socket: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.addEventListener("close", () => resolve(), { once: true });
  socket.close(1000, "test complete");
  return promise;
}

describe("host enrollment", () => {
  it("issues one-time credentials and authenticates the daemon WebSocket", async () => {
    const cookie = await operatorSession("enroll@test.example");
    const enrollment = await createCode(cookie, "52labs");
    expect(enrollment.code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$/);
    expect(enrollment.command).toContain(`--code ${enrollment.code}`);

    const enrolled = await daemonEnroll(enrollment.code);
    expect(enrolled.status, await enrolled.clone().text()).toBe(200);
    const credentials = await enrolled.json<{
      device_token: string;
      host_id: string;
      host: string;
      org: string;
    }>();
    expect(credentials.device_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credentials.host_id).toMatch(/^hst_[0-9a-f]{12}$/);
    expect(credentials.host).toBe("52labs");

    const reused = await daemonEnroll(enrollment.code);
    expect(reused.status).toBe(401);
    expect(await reused.json()).toEqual({ error: "Unauthorized" });

    const upgrade = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${credentials.device_token}`,
      },
    });
    expect(upgrade.status).toBe(101);
    expect(upgrade.webSocket).not.toBeNull();
    const socket = upgrade.webSocket!;
    socket.accept();
    const hello = nextMessage(socket);
    socket.send(
      JSON.stringify({ t: "hello", proto: 1, daemon_ver: "0.1.0-test", host: "52labs" }),
    );
    expect(JSON.parse(await hello)).toEqual({
      t: "hello_ok",
      host_id: credentials.host_id,
      org: credentials.org,
    });
    await closeSocket(socket);

    const filteredAgents = await SELF.fetch(`${ORIGIN}/api/agents?host=52labs`, {
      headers: { origin: ORIGIN, cookie },
    });
    expect(filteredAgents.status).toBe(200);

    const revoked = await SELF.fetch(`${ORIGIN}/api/hosts/52labs`, {
      method: "DELETE",
      headers: { origin: ORIGIN, cookie },
    });
    expect(revoked.status).toBe(200);
  });

  it("returns the same 401 for wrong and expired codes", async () => {
    const wrong = await daemonEnroll("AAAA-BBBB");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "Unauthorized" });

    const cookie = await operatorSession("expired-enroll@test.example");
    const enrollment = await createCode(cookie, "expired");
    await env.DB.prepare("UPDATE enroll_code SET expires_at = ? WHERE code_hash = ?")
      .bind(Date.now() - 1, await sha256hex(enrollment.code))
      .run();
    const expired = await daemonEnroll(enrollment.code);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: "Unauthorized" });
  });

  it("closes a daemon that exceeds the 100-frame burst", async () => {
    const cookie = await operatorSession("frame-limit@test.example");
    const enrollment = await createCode(cookie, "flood");
    const enrolled = await daemonEnroll(enrollment.code);
    const credentials = await enrolled.json<{
      device_token: string;
      host_id: string;
      org: string;
    }>();
    const upgrade = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${credentials.device_token}`,
      },
    });
    const socket = upgrade.webSocket!;
    socket.accept();
    const hello = nextMessage(socket);
    socket.send(
      JSON.stringify({
        t: "hello",
        proto: 1,
        daemon_ver: "0.1.0-test",
        host: "flood",
      }),
    );
    await hello;
    const hub = env.HOST_HUB.getByName(
      `org:${credentials.org}:host:flood`,
    );
    await runInDurableObject(hub, async (_instance, state) => {
      const serverSocket = state.getWebSockets("daemon")[0];
      if (!serverSocket) throw new Error("daemon socket missing");
      const attachment = serverSocket.deserializeAttachment() as {
        frameRate: { tokens: number; updatedAt: number };
      };
      attachment.frameRate = { tokens: 0, updatedAt: Date.now() };
      serverSocket.serializeAttachment(attachment);
    });
    const { promise: closed, resolve } = Promise.withResolvers<CloseEvent>();
    socket.addEventListener("close", (event) => resolve(event), { once: true });
    socket.send(JSON.stringify({ t: "future" }));
    const event = await closed;
    expect(event.code).toBe(4008);
    expect(event.reason).toBe("rate_limited");
  });

  it("revocation closes the daemon socket with code 4001", async () => {
    const cookie = await operatorSession("revoke@test.example");
    const enrollment = await createCode(cookie, "revoked");
    const enrolled = await daemonEnroll(enrollment.code);
    const credentials = await enrolled.json<{ device_token: string; host_id: string; org: string }>();
    const upgrade = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${credentials.device_token}`,
      },
    });
    const socket = upgrade.webSocket!;
    socket.accept();
    const hello = nextMessage(socket);
    socket.send(
      JSON.stringify({ t: "hello", proto: 1, daemon_ver: "0.1.0-test", host: "revoked" }),
    );
    await hello;

    const { promise: closed, resolve: resolveClosed } =
      Promise.withResolvers<CloseEvent>();
    socket.addEventListener("close", (event) => resolveClosed(event), { once: true });
    const revoke = await SELF.fetch(`${ORIGIN}/api/hosts/revoked`, {
      method: "DELETE",
      headers: { origin: ORIGIN, cookie },
    });
    expect(revoke.status).toBe(200);
    expect((await closed).code).toBe(4001);

    const reconnect = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${credentials.device_token}`,
      },
    });
    expect(reconnect.status).toBe(401);
  });
});
