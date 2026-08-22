import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

type Credentials = {
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
  return promise;
}

function closeSocket(socket: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.addEventListener("close", () => resolve(), { once: true });
  socket.close(1000, "test complete");
  return promise;
}

async function operator(): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      email: "rooms@test.example",
      password: "test1234!",
      name: "Rooms Operator",
    }),
  });
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function api(
  path: string,
  cookie: string,
  init: { method?: string; body?: unknown } = {},
) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: init.method,
    headers: {
      origin: ORIGIN,
      cookie,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function enroll(cookie: string, host: string): Promise<Credentials> {
  const codeResponse = await api("/api/hosts/enroll", cookie, {
    method: "POST",
    body: { slug: host },
  });
  const { code } = await codeResponse.json<{ code: string }>();
  const response = await SELF.fetch(`${ORIGIN}/api/daemon/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, daemon_ver: "room-test" }),
  });
  return response.json<Credentials>();
}

async function connect(credentials: Credentials, agent: string) {
  const response = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
    headers: {
      upgrade: "websocket",
      authorization: `Bearer ${credentials.device_token}`,
    },
  });
  const socket = response.webSocket!;
  socket.accept();
  let frame = nextFrame(socket);
  socket.send(
    JSON.stringify({
      t: "hello",
      proto: 1,
      daemon_ver: "room-test",
      host: credentials.host,
    }),
  );
  await frame;
  socket.send(
    JSON.stringify({
      t: "roster",
      agents: [
        {
          name: agent,
          kind: "omp",
          pane_id: `${credentials.host}:p1`,
          status: "idle",
          cwd: "/work",
          title: agent,
          named_by: "user",
        },
      ],
    }),
  );
  frame = nextFrame(socket);
  socket.send(JSON.stringify({ t: "rpc", rid: `flush-${agent}`, method: "list_rooms", params: {} }));
  await frame;
  return socket;
}

async function rpc(
  socket: WebSocket,
  rid: string,
  method: string,
  params: Record<string, unknown>,
) {
  const result = nextFrame(socket);
  socket.send(JSON.stringify({ t: "rpc", rid, method, params }));
  return result;
}

describe("rooms", () => {
  it("fans out with monotonic sequence, explicit membership, and operator posting", async () => {
    const cookie = await operator();
    const alphaCredentials = await enroll(cookie, "alpha");
    const betaCredentials = await enroll(cookie, "beta");
    const alpha = await connect(alphaCredentials, "alice");
    const beta = await connect(betaCredentials, "bob");

    expect(
      await rpc(alpha, "create-ops", "create_room", {
        room: "ops",
        address: "alice@alpha",
      }),
    ).toMatchObject({
      t: "rpc_result",
      rid: "create-ops",
      result: {
        room: { name: "ops", policy: "open" },
        joined: true,
      },
    });
    expect(
      await rpc(alpha, "create-duplicate", "create_room", {
        room: "ops",
        address: "alice@alpha",
      }),
    ).toMatchObject({
      t: "rpc_result",
      rid: "create-duplicate",
      error: { code: "rpc_error", message: "room_exists" },
    });
    expect(
      await rpc(beta, "create-spoofed", "create_room", {
        room: "spoofed",
        address: "alice@alpha",
      }),
    ).toMatchObject({ t: "rpc_result", rid: "create-spoofed", error: { code: "rpc_error" } });
    expect(await rpc(beta, "join-b", "join_room", { room: "ops", address: "bob@beta" })).toMatchObject({
      t: "rpc_result",
      rid: "join-b",
      result: { joined: true },
    });

    const betaDelivery = nextFrame(beta);
    const sendAck = nextFrame(alpha);
    alpha.send(
      JSON.stringify({
        t: "send",
        id: "tx_010203040506",
        from: "alice@alpha",
        to: "#ops",
        body: "first room post",
        ts: "2026-08-21T12:00:00.000Z",
      }),
    );
    expect(await sendAck).toEqual({ t: "send_ack", id: "tx_010203040506" });
    const firstDelivery = await betaDelivery;
    expect(firstDelivery).toMatchObject({
      t: "deliver",
      id: "tx_010203040506",
      agent: "bob",
    });
    expect(String(firstDelivery.envelope)).toContain('kind="room" room="ops" seq="1"');

    const firstDeliveries = await env.DB.prepare(
      "SELECT target_addr FROM message_delivery WHERE message_id = ?",
    )
      .bind("tx_010203040506")
      .all<{ target_addr: string }>();
    expect(firstDeliveries.results).toEqual([{ target_addr: "bob@beta" }]);
    beta.send(JSON.stringify({ t: "deliver_ack", id: "tx_010203040506" }));
    await rpc(beta, "flush-ack", "list_rooms", {});

    const alphaOperatorDelivery = nextFrame(alpha);
    const betaOperatorDelivery = nextFrame(beta);
    const operatorPost = await api("/api/rooms/ops/post", cookie, {
      method: "POST",
      body: { body: "operator directive" },
    });
    expect(operatorPost.status).toBe(201);
    const operatorMessage = await operatorPost.json<{ message: { id: string; seq: number } }>();
    expect(operatorMessage.message.seq).toBe(2);
    expect(await alphaOperatorDelivery).toMatchObject({
      t: "deliver",
      id: operatorMessage.message.id,
      agent: "alice",
    });
    expect(await betaOperatorDelivery).toMatchObject({
      t: "deliver",
      id: operatorMessage.message.id,
      agent: "bob",
    });

    const detail = await api("/api/rooms/ops", cookie);
    const detailBody = await detail.json<{
      room: { sequence: number; messages: Array<{ seq: number; from: string }> };
    }>();
    expect(detailBody.room.sequence).toBe(2);
    expect(detailBody.room.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(detailBody.room.messages[1]?.from).toBe("operator@transit");

    expect(
      await rpc(alpha, "create-private", "create_room", {
        room: "private",
        policy: "invite",
        address: "alice@alpha",
      }),
    ).toMatchObject({
      t: "rpc_result",
      rid: "create-private",
      result: {
        room: { name: "private", policy: "invite" },
        joined: true,
      },
    });
    const refused = await rpc(beta, "join-private", "join_room", {
      room: "private",
      address: "bob@beta",
    });
    expect(refused).toMatchObject({ t: "rpc_result", rid: "join-private" });
    expect(refused.error).toBeDefined();
    const operatorAdd = await api("/api/rooms/private/members", cookie, {
      method: "POST",
      body: { address: "bob@beta" },
    });
    expect(operatorAdd.status).toBe(200);
    expect(await operatorAdd.json()).toEqual({ joined: true });

    await Promise.all([closeSocket(alpha), closeSocket(beta)]);
  });
});
