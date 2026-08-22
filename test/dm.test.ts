import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

type DaemonCredentials = {
  device_token: string;
  host_id: string;
  host: string;
  org: string;
};

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } =
    Promise.withResolvers<Record<string, unknown>>();
  socket.addEventListener(
    "message",
    (event) => {
      try {
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    },
    { once: true },
  );
  socket.addEventListener("error", () => reject(new Error("WebSocket error")), {
    once: true,
  });
  return promise;
}

function closeSocket(socket: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.addEventListener("close", () => resolve(), { once: true });
  socket.close(1000, "test complete");
  return promise;
}

async function signUp(): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      email: "dm-operator@test.example",
      password: "test1234!",
      name: "Operator",
    }),
  });
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function enrollHost(cookie: string, slug: string): Promise<DaemonCredentials> {
  const codeResponse = await SELF.fetch(`${ORIGIN}/api/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({ slug }),
  });
  const { code } = await codeResponse.json<{ code: string }>();
  const enrolled = await SELF.fetch(`${ORIGIN}/api/daemon/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, daemon_ver: "0.1.0-test" }),
  });
  expect(enrolled.status, await enrolled.clone().text()).toBe(200);
  return enrolled.json<DaemonCredentials>();
}

async function connectDaemon(credentials: DaemonCredentials, agent: string) {
  const response = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
    headers: {
      upgrade: "websocket",
      authorization: `Bearer ${credentials.device_token}`,
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const hello = nextFrame(socket);
  socket.send(
    JSON.stringify({
      t: "hello",
      proto: 1,
      daemon_ver: "0.1.0-test",
      host: credentials.host,
    }),
  );
  expect(await hello).toMatchObject({
    t: "hello_ok",
    host_id: credentials.host_id,
    org: credentials.org,
  });
  socket.send(
    JSON.stringify({
      t: "roster",
      agents: [
        {
          name: agent,
          kind: "omp",
          pane_id: `${credentials.host}:p1`,
          status: "idle",
          cwd: `/work/${agent}`,
          title: agent,
          named_by: "user",
        },
      ],
    }),
  );
  await flushSocket(socket, `roster-${credentials.host}`);
  return socket;
}

async function flushSocket(socket: WebSocket, rid: string) {
  const result = nextFrame(socket);
  socket.send(JSON.stringify({ t: "rpc", rid, method: "list_agents", params: {} }));
  expect(await result).toMatchObject({ t: "rpc_result", rid });
}

async function sendAndRead(
  sender: WebSocket,
  frame: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = nextFrame(sender);
  sender.send(JSON.stringify(frame));
  return response;
}

describe("direct messages", () => {
  it("commits, delivers, acknowledges, deduplicates, and rejects invalid sends", async () => {
    const cookie = await signUp();
    const alphaCredentials = await enrollHost(cookie, "alpha");
    const betaCredentials = await enrollHost(cookie, "beta");
    const alpha = await connectDaemon(alphaCredentials, "alice");
    const beta = await connectDaemon(betaCredentials, "bob");

    const id = "tx_001122334455";
    const delivery = nextFrame(beta);
    const ack = sendAndRead(alpha, {
      t: "send",
      id,
      from: "alice@alpha",
      to: "bob@beta",
      body: "hello beta",
      ts: "2026-08-21T12:34:56.000Z",
    });
    expect(await ack).toEqual({ t: "send_ack", id });
    const delivered = await delivery;
    expect(delivered).toMatchObject({ t: "deliver", id, agent: "bob" });
    expect(String(delivered.envelope)).toContain(
      '<transit from="alice@alpha" id="tx_001122334455"',
    );
    beta.send(JSON.stringify({ t: "deliver_ack", id }));
    await flushSocket(beta, "after-ack");

    const duplicateAck = await sendAndRead(alpha, {
      t: "send",
      id,
      from: "alice@alpha",
      to: "bob@beta",
      body: "hello beta",
      ts: "2026-08-21T12:34:56.000Z",
    });
    expect(duplicateAck).toEqual({ t: "send_ack", id });
    const betaHosts = await SELF.fetch(`${ORIGIN}/api/hosts`, {
      headers: { origin: ORIGIN, cookie },
    });
    const hosts = await betaHosts.json<{ hosts: Array<{ slug: string; queue_depth: number }> }>();
    expect(hosts.hosts.find((host) => host.slug === "beta")?.queue_depth).toBe(0);

    expect(
      await sendAndRead(alpha, {
        t: "send",
        id: "tx_111122223333",
        from: "alice@alpha",
        to: "bob@beta",
        body: "x".repeat(64 * 1024 + 1),
        ts: new Date().toISOString(),
      }),
    ).toEqual({ t: "send_nak", id: "tx_111122223333", code: "body_too_large" });
    expect(
      await sendAndRead(alpha, {
        t: "send",
        id: "tx_222233334444",
        from: "alice@alpha",
        to: "operator@beta",
        body: "reserved",
        ts: new Date().toISOString(),
      }),
    ).toEqual({ t: "send_nak", id: "tx_222233334444", code: "reserved_name" });
    expect(
      await sendAndRead(alpha, {
        t: "send",
        id: "tx_333344445555",
        from: "alice@alpha",
        to: "missing@gamma",
        body: "missing",
        ts: new Date().toISOString(),
      }),
    ).toEqual({ t: "send_nak", id: "tx_333344445555", code: "no_route" });
    expect(
      await sendAndRead(alpha, {
        t: "send",
        id: "tx_444455556666",
        from: "alice@alpha",
        to: "#ops",
        body: "room before phase two",
        ts: new Date().toISOString(),
      }),
    ).toEqual({ t: "send_nak", id: "tx_444455556666", code: "not_member" });

    const alphaHub = env.HOST_HUB.getByName(
      `org:${alphaCredentials.org}:host:alpha`,
    );
    await runInDurableObject(alphaHub, async (_instance, state) => {
      await state.storage.put("rate:send:alice", {
        tokens: 0,
        updatedAt: Date.now(),
      });
    });
    expect(
      await sendAndRead(alpha, {
        t: "send",
        id: "tx_600000000000",
        from: "alice@alpha",
        to: "nobody@beta",
        body: "limited",
        ts: new Date().toISOString(),
      }),
    ).toEqual({
      t: "send_nak",
      id: "tx_600000000000",
      code: "rate_limited",
    });
    await Promise.all([closeSocket(alpha), closeSocket(beta)]);
  });

  it("moves a permanent delivery rejection to dead", async () => {
    const cookie = await signUp();
    const alphaCredentials = await enrollHost(cookie, "alpha");
    const betaCredentials = await enrollHost(cookie, "beta");
    const alpha = await connectDaemon(alphaCredentials, "alice");
    const beta = await connectDaemon(betaCredentials, "bob");
    const id = "tx_aabbccddeeff";
    const delivery = nextFrame(beta);
    const ack = sendAndRead(alpha, {
      t: "send",
      id,
      from: "alice@alpha",
      to: "bob@beta",
      body: "reject this",
      ts: new Date().toISOString(),
    });
    expect(await ack).toEqual({ t: "send_ack", id });
    await delivery;
    beta.send(
      JSON.stringify({
        t: "deliver_nak",
        id,
        code: "agent_refused",
        retryable: false,
      }),
    );
    await flushSocket(beta, "after-nak");
    await expect
      .poll(async () =>
        env.DB.prepare(
          "SELECT status, last_error FROM message_delivery WHERE message_id = ?",
        )
          .bind(id)
          .first<{ status: string; last_error: string }>(),
      )
      .toEqual({ status: "dead", last_error: "agent_refused" });
    await Promise.all([closeSocket(alpha), closeSocket(beta)]);
  });
});
