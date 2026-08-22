import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hmacSign } from "../src/lib/transit/crypto";
import { signedIngestPayload } from "../src/lib/transit/ingest";
import { onConnectorFetch } from "./connector-mock";

const ORIGIN = "http://localhost";
const encoder = new TextEncoder();

type Credentials = {
  device_token: string;
  host_id: string;
  host: string;
  org: string;
};

type FrameReader = {
  next: () => Promise<Record<string, unknown>>;
  send: (frame: Record<string, unknown>) => void;
};

// One persistent listener feeding a FIFO buffer. Attaching one `once`
// listener per expected frame does not work for several frames on one
// socket: every pending listener observes the first message.
function readFrames(socket: WebSocket): FrameReader {
  const buffered: Record<string, unknown>[] = [];
  const waiting: ((frame: Record<string, unknown>) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve) resolve(frame);
    else buffered.push(frame);
  });
  return {
    next: () => {
      const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
      if (buffered.length > 0) resolve(buffered.shift()!);
      else waiting.push(resolve);
      return promise;
    },
    send: (frame) => socket.send(JSON.stringify(frame)),
  };
}

function closeSocket(socket: WebSocket): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  socket.addEventListener("close", () => resolve(), { once: true });
  socket.close();
  return promise;
}

async function operator(): Promise<{ cookie: string; org: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const signup = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      email: `bookkeeping-${suffix}@test.example`,
      password: "test1234!",
      name: "Bookkeeping Operator",
    }),
  });
  const cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const session = await signup.json<{ user: { id: string } }>();
  return { cookie, org: session.user.id };
}

async function enroll(cookie: string, host: string): Promise<Credentials> {
  const codeResponse = await SELF.fetch(`${ORIGIN}/api/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({ slug: host }),
  });
  const { code } = await codeResponse.json<{ code: string }>();
  const response = await SELF.fetch(`${ORIGIN}/api/daemon/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, daemon_ver: "bookkeeping-test" }),
  });
  return response.json<Credentials>();
}

async function connect(
  credentials: Credentials,
  agents: string[],
): Promise<FrameReader> {
  const response = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
    headers: {
      upgrade: "websocket",
      authorization: `Bearer ${credentials.device_token}`,
    },
  });
  const frames = readFrames(response.webSocket!);
  response.webSocket!.accept();
  frames.send({
    t: "hello",
    proto: 1,
    daemon_ver: "bookkeeping-test",
    host: credentials.host,
  });
  await frames.next();
  frames.send({
    t: "roster",
    agents: agents.map((agent, index) => ({
      name: agent,
      kind: "omp",
      pane_id: `${credentials.host}:p${index + 1}`,
      status: "idle",
      cwd: "/work",
      title: agent,
      named_by: "user",
    })),
  });
  frames.send({ t: "rpc", rid: "flush-hello", method: "list_rooms", params: {} });
  await frames.next();
  return frames;
}

async function rpc(
  frames: FrameReader,
  rid: string,
  method: string,
  params: Record<string, unknown>,
) {
  const result = frames.next();
  frames.send({ t: "rpc", rid, method, params });
  return result;
}

async function hubState(host: string, org: string) {
  const stub = env.HOST_HUB.getByName(`org:${org}:host:${host}`);
  return runInDurableObject(stub, async (_instance, state) => ({
    queue: await state.storage.list<Record<string, unknown>>({ prefix: "q:" }),
    markers: await state.storage.list<Record<string, unknown>>({ prefix: "d:" }),
  }));
}

describe("delivery bookkeeping", () => {
  it("delivers a room post to every same-host member and drains the queue once both ack", async () => {
    const { cookie, org } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials, ["jessica", "omp-sdm2"]);

    const created = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ name: "fleet", policy: "open" }),
    });
    expect(created.status).toBe(201);
    expect(
      await rpc(frames, "join-jessica", "join_room", { room: "fleet", address: "jessica@titan" }),
    ).toMatchObject({ t: "rpc_result", result: { joined: true } });
    expect(
      await rpc(frames, "join-omp", "join_room", { room: "fleet", address: "omp-sdm2@titan" }),
    ).toMatchObject({ t: "rpc_result", result: { joined: true } });

    const jessicaDelivery = frames.next();
    const ompDelivery = frames.next();
    const posted = await SELF.fetch(`${ORIGIN}/api/rooms/fleet/post`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ body: "same-host fan-out" }),
    });
    expect(posted.status).toBe(201);
    const message = await posted.json<{ message: { id: string; seq: number } }>();

    // The operator post resolves only after both per-member queueDelivery
    // calls settled, so the queue state is final here: both same-host members
    // must hold an entry (the queue keys carry the recipient agent).
    const queued = await hubState("titan", org);
    const queuedAgents = [...queued.queue.values()].map((item) => item.agent).sort();
    expect(queuedAgents, "both same-host members must be queued").toEqual([
      "jessica",
      "omp-sdm2",
    ]);

    const delivered = [await jessicaDelivery, await ompDelivery];
    expect(delivered.map((frame) => frame.agent).sort()).toEqual(["jessica", "omp-sdm2"]);
    for (const frame of delivered) {
      expect(frame).toMatchObject({ t: "deliver", id: message.message.id });
    }

    for (const frame of delivered) {
      frames.send({ t: "deliver_ack", id: frame.id, agent: frame.agent });
    }
    await rpc(frames, "flush-acks", "list_rooms", {});

    const settled = await hubState("titan", org);
    expect([...settled.queue.keys()]).toEqual([]);
    for (const agent of ["jessica", "omp-sdm2"]) {
      expect(settled.markers.get(`d:${message.message.id}:${agent}`)).toMatchObject({
        status: "injected",
      });
    }

    const room = env.ROOM.getByName(`org:${org}:room:fleet`);
    const detail = await room.detail();
    const acked = Object.fromEntries(
      detail.members.map((member) => [member.address, member.lastAckedSeq]),
    );
    expect(acked).toEqual({
      "jessica@titan": message.message.seq,
      "omp-sdm2@titan": message.message.seq,
    });
  });

  it("cancels a stuck agent delivery on every host queue holding it", async () => {
    const { cookie, org } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials, ["jessica", "omp-sdm2"]);

    expect(
      (
        await SELF.fetch(`${ORIGIN}/api/rooms`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, cookie },
          body: JSON.stringify({ name: "ops", policy: "open" }),
        })
      ).status,
    ).toBe(201);
    for (const agent of ["jessica", "omp-sdm2"]) {
      await rpc(frames, `join-${agent}`, "join_room", {
        room: "ops",
        address: `${agent}@titan`,
      });
    }

    const posted = await SELF.fetch(`${ORIGIN}/api/rooms/ops/post`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ body: "nobody will ack this" }),
    });
    expect(posted.status).toBe(201);
    const { message } = await posted.json<{ message: { id: string } }>();

    // Neither recipient acks, so both entries stay queued and would retry to
    // the attempt cap. This is the state an operator has to be able to clear.
    expect([...(await hubState("titan", org)).queue.values()].length).toBe(2);

    const cancelled = await SELF.fetch(`${ORIGIN}/api/messages/${message.id}/cancel`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ cancelled: 2, hosts: ["titan"] });

    const drained = await hubState("titan", org);
    expect([...drained.queue.keys()], "no entry may survive a cancel").toEqual([]);
    for (const agent of ["jessica", "omp-sdm2"]) {
      expect(drained.markers.get(`d:${message.id}:${agent}`)).toMatchObject({
        status: "injected",
      });
    }

    // A second cancel finds nothing left to settle rather than reporting success.
    const again = await SELF.fetch(`${ORIGIN}/api/messages/${message.id}/cancel`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie },
    });
    expect(again.status).toBe(404);
  });

  it("never re-dispatches a channel delivery after chat_reply settles it", async () => {
    const { cookie, org } = await operator();
    const credentials = await enroll(cookie, "alpha");
    const frames = await connect(credentials, ["alice"]);

    onConnectorFetch(
      "POST",
      (url) => url.hostname === "receiver.example",
      () => new Response(null, { status: 204 }),
    );
    const created = await SELF.fetch(`${ORIGIN}/api/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({
        source: "settle-once",
        target_addr: "alice@alpha",
        reply_url: "https://receiver.example/transit/replies",
        reply_url_prefixes: ["https://receiver.example/transit/"],
        instructions: "Settle every alert.",
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const source = await created.json<{ source: { integration_id: string }; secret: string }>();

    const ingestPayload = JSON.stringify({
      schema: "transit.ingest/1",
      event_key: "settle-event",
      conversation_id: "conversation-1",
      user: "Build system",
      trigger: "alert",
      content: "Build failed",
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = await hmacSign(
      source.secret,
      signedIngestPayload(timestamp, encoder.encode(ingestPayload)),
    );
    // The first dispatch happens while the ingest request is in flight, so the
    // reader must be drained only after the response resolves.
    const ingested = await SELF.fetch(`${ORIGIN}/ingest/settle-once`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Transit-Timestamp": timestamp,
        "Transit-Signature": `v1=${signature}`,
      },
      body: ingestPayload,
    });
    expect(ingested.status).toBe(202);
    const queued = await ingested.json<{ delivery_id: string }>();
    expect(queued.delivery_id).toMatch(/^dlv_/);

    const firstDelivery = await frames.next();
    expect(firstDelivery).toMatchObject({
      t: "deliver",
      id: queued.delivery_id,
      agent: "alice",
    });
    // Deliberately no deliver_ack yet: the agent is mid-turn, which is exactly
    // when chat_reply settles upstream while the host queue entry is pending.

    const reply = await rpc(frames, "reply-1", "chat_reply", {
      delivery_id: queued.delivery_id,
      conversation_id: "conversation-1",
      caller: "alice@alpha",
      message: "Handled",
    });
    expect(reply).toMatchObject({ t: "rpc_result", rid: "reply-1" });
    expect(reply.error).toBeUndefined();

    const settled = await hubState("alpha", org);
    expect(
      [...settled.queue.keys()],
      "chat_reply settlement must remove the pending host queue entry",
    ).toEqual([]);
    expect(settled.markers.get(`d:${queued.delivery_id}:alice`)).toMatchObject({
      status: "injected",
    });
  });
});
