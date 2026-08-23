import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hmacSign } from "../src/lib/transit/crypto";
import { signedIngestPayload } from "../src/lib/transit/ingest";

const ORIGIN = "http://localhost";

type Credentials = { device_token: string; host: string; org: string };

type FrameReader = {
  next: () => Promise<Record<string, unknown>>;
  send: (frame: Record<string, unknown>) => void;
};

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

async function operator(): Promise<{ cookie: string; org: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const signup = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      email: `via-${suffix}@test.example`,
      password: "correct horse battery staple",
      name: `via-${suffix}`,
    }),
  });
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  const session = await SELF.fetch(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } });
  const body = await session.json<{ user: { id: string } }>();
  return { cookie, org: body.user.id };
}
async function enroll(cookie: string, host: string): Promise<Credentials> {
  const codeResponse = await SELF.fetch(`${ORIGIN}/api/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({ slug: host }),
  });
  expect(codeResponse.status).toBe(200);
  const { code } = await codeResponse.json<{ code: string }>();
  const claimed = await SELF.fetch(`${ORIGIN}/api/daemon/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, daemon_ver: "transport-test" }),
  });
  expect(claimed.status).toBe(200);
  return await claimed.json<Credentials>();
}

async function connect(credentials: Credentials, agents: string[]): Promise<FrameReader> {
  const response = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${credentials.device_token}` },
  });
  const frames = readFrames(response.webSocket!);
  response.webSocket!.accept();
  frames.send({ t: "hello", proto: 1, daemon_ver: "transport-test", host: credentials.host });
  await frames.next();
  frames.send({
    t: "roster",
    agents: agents.map((name, index) => ({
      name,
      kind: "omp",
      pane_id: `${credentials.host}:p${index + 1}`,
      status: "idle",
      cwd: "/work",
      title: name,
      named_by: "user",
    })),
  });
  // A round trip forces the roster through before the first message is sent.
  frames.send({ t: "rpc", rid: "flush-hello", method: "list_rooms", params: {} });
  await frames.next();
  return frames;
}

// Sends over the daemon socket and returns the `deliver` frame for it. The
// send_ack and the delivery arrive in either order on one socket, so this
// reads until the delivery appears rather than assuming a position.
async function sendAndAwaitDelivery(
  frames: FrameReader,
  id: string,
  from: string,
  to: string,
): Promise<Record<string, unknown>> {
  frames.send({
    t: "send",
    id,
    from,
    to,
    body: `probe for ${to}`,
    ts: new Date().toISOString(),
  });
  for (let read = 0; read < 8; read += 1) {
    const frame = await frames.next();
    if (frame.t === "deliver" && frame.id === id) return frame;
  }
  throw new Error(`no deliver frame for ${id}`);
}

function deliveryRow(id: string, target: string) {
  return env.DB.prepare(
    `SELECT status, via FROM message_delivery WHERE message_id = ? AND target_addr = ?`,
  )
    .bind(id, target)
    .first<{ status: string; via: string | null }>();
}

// Creates a signed ingest source and posts one event to it, returning the
// delivery id the integration queued for the agent.
async function ingestOne(
  cookie: string,
  source: string,
  target: string,
  key: string,
): Promise<string> {
  const created = await SELF.fetch(`${ORIGIN}/api/sources`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({
      source,
      target_addr: target,
      reply_url_prefixes: ["https://receiver.example/transit/"],
      instructions: "Report every alert.",
    }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const { secret } = await created.json<{ secret: string }>();

  const payload = JSON.stringify({
    schema: "transit.ingest/1",
    event_key: key,
    conversation_id: `conversation-${key}`,
    user: "Build system",
    content: "Build failed",
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await hmacSign(
    secret,
    signedIngestPayload(timestamp, new TextEncoder().encode(payload)),
  );
  const ingested = await SELF.fetch(`${ORIGIN}/ingest/${source}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Transit-Timestamp": timestamp,
      "Transit-Signature": `v1=${signature}`,
    },
    body: payload,
  });
  expect(ingested.status).toBe(202);
  const { delivery_id: deliveryId } = await ingested.json<{ delivery_id: string }>();
  return deliveryId;
}

// The Integration DO that owns a delivery, reached the same way the HostHub
// reaches it: by the integration id recorded against the event.
async function integrationFor(deliveryId: string) {
  const row = await env.DB.prepare(
    `SELECT e.integration_id AS id, i.org_id AS org
     FROM integration_delivery d
     JOIN integration_event e ON e.id = d.event_id
     JOIN integration i ON i.id = e.integration_id
     WHERE d.id = ?`,
  )
    .bind(deliveryId)
    .first<{ id: string; org: string }>();
  return env.INTEGRATION.getByName(`org:${row!.org}:integration:${row!.id}`);
}

type StoredDelivery = {
  attempts: number;
  nextAttemptAt?: number;
  injectedVia?: string;
};

async function storedDelivery(deliveryId: string): Promise<StoredDelivery> {
  const stub = await integrationFor(deliveryId);
  const record = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoredDelivery>(`delivery:${deliveryId}`),
  );
  return record!;
}

// Read from D1 rather than DO storage: the point of the counters is what an
// operator can see. A missing row reports zeroes so a poll retries with a
// readable diff instead of throwing on null.
async function deliveryCounts(
  deliveryId: string,
): Promise<{ attempts: number; injections: number }> {
  const row = await env.DB.prepare(
    "SELECT attempts, injections FROM integration_delivery WHERE id = ?",
  )
    .bind(deliveryId)
    .first<{ attempts: number; injections: number }>();
  return row ?? { attempts: 0, injections: 0 };
}

describe("delivery transport reporting", () => {
  // Both delivery paths acked identically, so the ledger could say a message
  // was injected but never which transport carried it. Answering that per
  // message is the only way to tell a fleet on native adapters from one
  // quietly typing into panes.
  it("records the transport a daemon reports on its ack", async () => {
    const { cookie } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials, ["sender", "native-agent", "pane-agent"]);

    const nativeId = "tx_via0000000a1";
    await sendAndAwaitDelivery(frames, nativeId, "sender@titan", "native-agent@titan");
    frames.send({ t: "deliver_ack", id: nativeId, agent: "native-agent", via: "adapter" });

    const paneId = "tx_via0000000b2";
    await sendAndAwaitDelivery(frames, paneId, "sender@titan", "pane-agent@titan");
    frames.send({ t: "deliver_ack", id: paneId, agent: "pane-agent", via: "herdr" });

    // The ledger write runs under waitUntil, so poll the row rather than
    // guessing a duration: the awaited condition is the thing under test.
    await expect
      .poll(() => deliveryRow(nativeId, "native-agent@titan"))
      .toEqual({ status: "injected", via: "adapter" });
    await expect
      .poll(() => deliveryRow(paneId, "pane-agent@titan"))
      .toEqual({ status: "injected", via: "herdr" });

    const response = await SELF.fetch(`${ORIGIN}/api/deliveries`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const { deliveries } = await response.json<{ deliveries: Record<string, unknown>[] }>();
    const byId = new Map(deliveries.map((row) => [row.id, row]));
    expect(byId.get(nativeId)).toMatchObject({ via: "adapter" });
    expect(byId.get(paneId)).toMatchObject({ via: "herdr" });
  });

  // A daemon older than the field omits it. The delivery must still settle —
  // an unreported transport is missing information, not a bad frame.
  it("settles an ack from a daemon that reports no transport", async () => {
    const { cookie } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials, ["sender", "legacy-agent"]);

    const id = "tx_via0000000c3";
    await sendAndAwaitDelivery(frames, id, "sender@titan", "legacy-agent@titan");
    frames.send({ t: "deliver_ack", id, agent: "legacy-agent" });

    await expect
      .poll(() => deliveryRow(id, "legacy-agent@titan"))
      .toEqual({ status: "injected", via: null });
  });

  // A channel delivery is ledgered by the Integration DO, which never sees the
  // wire ack, so its transport used to be recorded nowhere central at all —
  // and an external integration is the case an operator is least able to
  // observe directly.
  it("records the transport of a channel delivery", async () => {
    const { cookie } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials, ["alice"]);

    const created = await SELF.fetch(`${ORIGIN}/api/sources`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({
        source: "transport-source",
        target_addr: "alice@titan",
        reply_url_prefixes: ["https://receiver.example/transit/"],
        instructions: "Report every alert.",
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const source = await created.json<{ secret: string }>();

    const payload = JSON.stringify({
      schema: "transit.ingest/1",
      event_key: "transport-event",
      conversation_id: "conversation-1",
      user: "Build system",
      content: "Build failed",
    });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = await hmacSign(
      source.secret,
      signedIngestPayload(timestamp, new TextEncoder().encode(payload)),
    );
    const ingested = await SELF.fetch(`${ORIGIN}/ingest/transport-source`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Transit-Timestamp": timestamp,
        "Transit-Signature": `v1=${signature}`,
      },
      body: payload,
    });
    expect(ingested.status).toBe(202);
    const { delivery_id: deliveryId } = await ingested.json<{ delivery_id: string }>();

    expect(await frames.next()).toMatchObject({ t: "deliver", id: deliveryId });
    frames.send({ t: "deliver_ack", id: deliveryId, agent: "alice", via: "adapter" });

    await expect
      .poll(() =>
        env.DB.prepare("SELECT via FROM integration_delivery WHERE id = ?")
          .bind(deliveryId)
          .first<{ via: string | null }>(),
      )
      .toEqual({ via: "adapter" });

    const response = await SELF.fetch(`${ORIGIN}/api/deliveries`, { headers: { cookie } });
    const { deliveries } = await response.json<{ deliveries: Record<string, unknown>[] }>();
    expect(deliveries.find((row) => row.id === deliveryId)).toMatchObject({ via: "adapter" });
  });
});

describe("channel redelivery", () => {
  // Nothing ever marks a channel delivery dead, so an unsettled one used to be
  // re-injected forever. A native adapter's ack is the receipt that ends it:
  // the envelope is durably queued in the session, and sending it again only
  // invites a second reply to one message.
  it("stops redelivering once an adapter has taken the envelope", async () => {
    const { cookie } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials, ["alice"]);

    const deliveryId = await ingestOne(cookie, "held-source", "alice@titan", "held-event");
    expect(await frames.next()).toMatchObject({ t: "deliver", id: deliveryId });
    frames.send({ t: "deliver_ack", id: deliveryId, agent: "alice", via: "adapter" });

    await expect
      .poll(() => storedDelivery(deliveryId))
      .toMatchObject({ injectedVia: "adapter", nextAttemptAt: undefined, attempts: 1 });

    // Firing the alarm is the real redelivery trigger; a suspended delivery
    // must survive it untouched.
    const stub = await integrationFor(deliveryId);
    await runDurableObjectAlarm(stub);
    expect(await storedDelivery(deliveryId)).toMatchObject({ attempts: 1 });

    // Absence needs a barrier: a later message proves the socket was live and
    // carried no redelivery in between.
    const barrier = "tx_held00000001";
    await sendAndAwaitDelivery(frames, barrier, "alice@titan", "alice@titan");
  });

  // The safety net has to stay for the transport that needs it: text typed
  // into a pane can be cleared, closed, or never read, so a herdr delivery
  // keeps its schedule and comes back.
  it("keeps redelivering an envelope typed into a pane", async () => {
    const { cookie } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials, ["bob"]);

    const deliveryId = await ingestOne(cookie, "pane-source", "bob@titan", "pane-event");
    expect(await frames.next()).toMatchObject({ t: "deliver", id: deliveryId });
    frames.send({ t: "deliver_ack", id: deliveryId, agent: "bob", via: "herdr" });

    await expect
      .poll(() => storedDelivery(deliveryId))
      .toMatchObject({ injectedVia: "herdr" });
    expect((await storedDelivery(deliveryId)).nextAttemptAt).toBeTypeOf("number");

    // Bring the scheduled attempt forward instead of waiting five minutes for
    // it; the schedule is what is under test, not the clock.
    const stub = await integrationFor(deliveryId);
    await runInDurableObject(stub, async (_instance, state) => {
      const record = await state.storage.get<StoredDelivery>(`delivery:${deliveryId}`);
      await state.storage.put(`delivery:${deliveryId}`, {
        ...record,
        nextAttemptAt: Date.now() - 1,
      });
    });
    await runDurableObjectAlarm(stub);

    expect(await frames.next()).toMatchObject({ t: "deliver", id: deliveryId });
    expect(await storedDelivery(deliveryId)).toMatchObject({ attempts: 2 });
  });

  // Reading re-armed the schedule, so the message an agent had just opened
  // came back at it — the "read/unsettled, do not reply twice" case seen in a
  // live pane. A read is not a reason to re-inject what is already in hand.
  it("does not re-arm a held envelope when the agent reads it", async () => {
    const { cookie } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials, ["carol"]);

    const deliveryId = await ingestOne(cookie, "read-source", "carol@titan", "read-event");
    expect(await frames.next()).toMatchObject({ t: "deliver", id: deliveryId });
    frames.send({ t: "deliver_ack", id: deliveryId, agent: "carol", via: "adapter" });
    await expect
      .poll(() => storedDelivery(deliveryId))
      .toMatchObject({ injectedVia: "adapter", nextAttemptAt: undefined });

    frames.send({
      t: "rpc",
      rid: "read-1",
      method: "read_message",
      params: { id: deliveryId, caller: "carol@titan" },
    });
    for (let read = 0; read < 8; read += 1) {
      const frame = await frames.next();
      if (frame.t === "rpc_result" && frame.rid === "read-1") break;
    }

    const record = await storedDelivery(deliveryId);
    expect(record).toMatchObject({ nextAttemptAt: undefined, attempts: 1 });
  });

  // `attempts` counts dispatches. A dispatch the host answers "duplicate"
  // injects nothing and still counts one, which is how a delivery that reached
  // an agent three times got reported as 49. Arrivals are counted from acks,
  // so the two must be able to disagree.
  it("counts arrivals from acks, not dispatch attempts", async () => {
    const { cookie } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials, ["dave"]);

    const deliveryId = await ingestOne(cookie, "count-source", "dave@titan", "count-event");
    expect(await frames.next()).toMatchObject({ t: "deliver", id: deliveryId });

    // Never acked: the host keeps the entry queued, so every later dispatch is
    // deduplicated. Attempts climb, arrivals stay at zero.
    const stub = await integrationFor(deliveryId);
    for (let round = 0; round < 3; round += 1) {
      await runInDurableObject(stub, async (_instance, state) => {
        const record = await state.storage.get<StoredDelivery>(`delivery:${deliveryId}`);
        await state.storage.put(`delivery:${deliveryId}`, {
          ...record,
          nextAttemptAt: Date.now() - 1,
        });
      });
      await runDurableObjectAlarm(stub);
    }

    const beforeAck = await deliveryCounts(deliveryId);
    expect(beforeAck.attempts).toBeGreaterThan(1);
    expect(beforeAck.injections).toBe(0);

    frames.send({ t: "deliver_ack", id: deliveryId, agent: "dave", via: "adapter" });
    await expect.poll(() => deliveryCounts(deliveryId)).toMatchObject({ injections: 1 });

    // And the operator surface reports the two separately.
    const response = await SELF.fetch(`${ORIGIN}/api/deliveries`, { headers: { cookie } });
    const { deliveries } = await response.json<{ deliveries: Record<string, unknown>[] }>();
    const row = deliveries.find((entry) => entry.id === deliveryId)!;
    expect(row.arrivals).toBe(1);
    expect(Number(row.attempts)).toBeGreaterThan(1);
  });
});
