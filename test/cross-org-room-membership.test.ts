import { SELF, env, runInDurableObject } from "cloudflare:test";
import { Room } from "../src/do/room";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";
type Account = { cookie: string; orgId: string; orgSlug: string };
type Credentials = { device_token: string; host: string };

type FrameReader = {
  next: () => Promise<Record<string, unknown>>;
  requeue: (frame: Record<string, unknown>) => void;
  send: (frame: Record<string, unknown>) => void;
  socket: WebSocket;
};

// Buffered reader, as in test/cross-org-room-routing.test.ts and
// test/delivery-bookkeeping.test.ts: frames are captured in arrival order
// and awaited whenever the test gets to them, so a frame interleaved with
// the handshake (a queued delivery dispatched on hello) is never lost.
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
    requeue: (frame) => {
      const resolve = waiting.shift();
      if (resolve) resolve(frame);
      else buffered.unshift(frame);
    },
    send: (frame) => socket.send(JSON.stringify(frame)),
    socket,
  };
}

/** Awaits the flush reply without consuming anything else: on a reconnect a
 * queued delivery is dispatched between `hello_ok` and the reply, and that
 * frame belongs to the test body. Frames read past are restored in order. */
async function untilRpcResult(frames: FrameReader, rid: string, limit = 8): Promise<void> {
  const held: Record<string, unknown>[] = [];
  try {
    for (let index = 0; index < limit; index += 1) {
      const frame = await frames.next();
      if (frame.t === "rpc_result" && frame.rid === rid) return;
      held.push(frame);
    }
    throw new Error(`rpc_result ${rid} not received within ${limit} frames`);
  } finally {
    for (const frame of held.reverse()) frames.requeue(frame);
  }
}

/** Reads past at most `limit` non-delivery frames (handshake noise after a
 * reconnect) and returns the next `deliver` — bounded so a genuine fan-out
 * regression fails fast instead of hanging on an empty socket. */
async function nextDeliver(frames: FrameReader, limit = 8): Promise<Record<string, unknown>> {
  for (let index = 0; index < limit; index += 1) {
    const frame = await frames.next();
    if (frame.t === "deliver") return frame;
  }
  throw new Error(`no deliver frame within ${limit} frames`);
}

async function api(path: string, options: { cookie?: string; method?: string; body?: unknown } = {}) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: options.method,
    headers: {
      origin: ORIGIN,
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function signUp(email: string, name: string): Promise<Account> {
  const response = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: "test1234!", name },
  });
  const user = await response.json<{ user: { id: string } }>();
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const organizations = await api("/api/auth/organization/list", { cookie });
  const organization = (await organizations.json<Array<{ id: string; slug: string }>>())
    .find((row) => row.id === user.user.id)!;
  return { cookie, orgId: user.user.id, orgSlug: organization.slug };
}

async function enroll(account: Account, host: string): Promise<Credentials> {
  const codeResponse = await api("/api/hosts/enroll", {
    cookie: account.cookie,
    method: "POST",
    body: { slug: host },
  });
  const { code } = await codeResponse.json<{ code: string }>();
  const response = await api("/api/daemon/enroll", {
    method: "POST",
    body: { code, daemon_ver: "cross-org-room-test" },
  });
  return response.json<Credentials>();
}

async function connect(credentials: Credentials, agent: string): Promise<FrameReader> {
  const response = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${credentials.device_token}` },
  });
  const frames = readFrames(response.webSocket!);
  frames.socket.accept();
  frames.send({ t: "hello", proto: 1, daemon_ver: "cross-org-room-test", host: credentials.host });
  await frames.next();
  frames.send({
    t: "roster",
    agents: [{ name: agent, kind: "omp", pane_id: `${credentials.host}:p1`, status: "idle", cwd: "/work", title: agent, named_by: "user" }],
  });
  const flushed = untilRpcResult(frames, `flush-${agent}`);
  frames.send({ t: "rpc", rid: `flush-${agent}`, method: "list_agents", params: {} });
  await flushed;
  return frames;
}

describe("cross-organization Room membership", () => {
  it("authorizes foreign members, routes their deliveries, and fails closed after revocation", async () => {
    const home = await signUp("room-home@test.example", "Room Home");
    const foreign = await signUp("room-foreign@test.example", "Room Foreign");
    const alice = await connect(await enroll(home, "alpha"), "alice");
    const bob = await connect(await enroll(home, "bravo"), "bob");
    const charlieCredentials = await enroll(foreign, "beta");
    let charlie = await connect(charlieCredentials, "charlie");
    const room = env.ROOM.getByName(`org:${home.orgId}:room:ops`);
    await room.configure({ org: home.orgId, name: "ops", policy: "open", createdAt: Date.now() });
    await room.join("alice@alpha", "creator");
    await room.join("bob@bravo", "operator");

    const request = await api("/api/organization-connections", {
      cookie: home.cookie,
      method: "POST",
      body: { organization_slug: foreign.orgSlug },
    });
    const { connection } = await request.json<{ connection: { id: string } }>();
    const foreignAddress = `${foreign.orgSlug}/charlie@beta`;
    const foreignMember = { org: foreign.orgId, orgSlug: foreign.orgSlug, connectionId: connection.id };
    expect(await room.join(foreignAddress, "operator", foreignMember)).toEqual({
      joined: false,
      error: "not_connected",
    });
    expect(await room.join(foreignAddress, "operator", { ...foreignMember, org: "absent" })).toEqual({
      joined: false,
      error: "not_connected",
    });

    expect((await api(`/api/organization-connections/${connection.id}/accept`, {
      cookie: foreign.cookie,
      method: "POST",
      body: {},
    })).status).toBe(200);
    expect(await room.join(foreignAddress, "operator", foreignMember)).toEqual({ joined: true });

    const cap = env.ROOM.getByName(`org:${home.orgId}:room:cap`);
    await cap.configure({ org: home.orgId, name: "cap", policy: "open", createdAt: Date.now() });
    for (let index = 0; index < 63; index += 1) {
      expect(await cap.join(`u${index}@host`, "operator")).toEqual({ joined: true });
    }
    expect(await cap.join(`${foreign.orgSlug}/u63@host`, "operator", foreignMember)).toEqual({ joined: true });
    expect(await cap.join("overflow@host", "operator")).toEqual({ joined: false, error: "room_full" });

    charlie.socket.close(1000, "inspect foreign hub");
    const foreignHub = env.HOST_HUB.getByName(`org:${foreign.orgId}:host:beta`);
    const roomHub = env.HOST_HUB.getByName(`org:${home.orgId}:host:beta`);
    await expect.poll(async () => !(await foreignHub.status()).connected).toBe(true);
    const homeDelivery = bob.next();
    await room.post("alice@alpha", "cross-org room message", undefined, "tx_200000000001");
    const deliveredHome = await homeDelivery;
    expect(String(deliveredHome.envelope)).toContain('from="alice@alpha"');
    expect(String(deliveredHome.envelope)).toContain('room="ops"');
    expect(String(deliveredHome.envelope)).toContain('[reply: send_message to="alice@alpha"');
    await expect.poll(async () => (await foreignHub.status()).queueDepth).toBe(1);
    expect((await roomHub.status()).queueDepth).toBe(0);

    charlie = await connect(charlieCredentials, "charlie");
    const deliveredForeign = await nextDeliver(charlie);
    expect(String(deliveredForeign.envelope)).toContain(`from="${home.orgSlug}/alice@alpha"`);
    expect(String(deliveredForeign.envelope)).toContain(`room="${home.orgSlug}/ops"`);
    expect(String(deliveredForeign.envelope)).toContain(
      `[reply: send_message to="${home.orgSlug}/#ops"`,
    );

    expect((await api(`/api/organization-connections/${connection.id}`, {
      cookie: home.cookie,
      method: "DELETE",
    })).status).toBe(200);
    const afterRevocation = bob.next();
    await room.post("alice@alpha", "home remains live", undefined, "tx_200000000002");
    expect(await afterRevocation).toMatchObject({ t: "deliver", agent: "bob" });
    await expect.poll(async () =>
      env.DB.prepare("SELECT status, last_error FROM message_delivery WHERE message_id = ? AND target_addr = ?")
        .bind("tx_200000000002", foreignAddress)
        .first(),
    ).toEqual({ status: "dead", last_error: "organization_connection_revoked" });
    // Inside the DO: a rejected RPC stub call leaves an unhandled-rejection
    // trace in this harness (integration-engine.test.ts uses the local
    // instance for expected throws; so do we).
    const revokedSender = await runInDurableObject(room, async (instance) => {
      try {
        await (instance as Room).post(foreignAddress, "revoked sender");
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(revokedSender).toBe("not_member");

    alice.socket.close(1000, "test complete");
    bob.socket.close(1000, "test complete");
    charlie.socket.close(1000, "test complete");
  });

  it("restores a foreign member's live connection after revocation and reconnect", async () => {
    const home = await signUp("room-reconnect-home@test.example", "Reconnect Home");
    const foreign = await signUp("room-reconnect-foreign@test.example", "Reconnect Foreign");
    const alice = await connect(await enroll(home, "reconnect-alpha"), "alice");
    const charlieCredentials = await enroll(foreign, "reconnect-beta");
    let charlie = await connect(charlieCredentials, "charlie");
    const room = env.ROOM.getByName(`org:${home.orgId}:room:reconnect`);
    await room.configure({
      org: home.orgId,
      name: "reconnect",
      policy: "open",
      createdAt: Date.now(),
    });
    await room.join("alice@reconnect-alpha", "creator");

    const requested = await api("/api/organization-connections", {
      cookie: home.cookie,
      method: "POST",
      body: { organization_slug: foreign.orgSlug },
    });
    const { connection } = await requested.json<{ connection: { id: string } }>();
    expect((await api(`/api/organization-connections/${connection.id}/accept`, {
      cookie: foreign.cookie,
      method: "POST",
      body: {},
    })).status).toBe(200);

    const foreignAddress = `${foreign.orgSlug}/charlie@reconnect-beta`;
    expect(await room.join(foreignAddress, "operator", {
      org: foreign.orgId,
      orgSlug: foreign.orgSlug,
      connectionId: connection.id,
    })).toEqual({ joined: true });
    const storedMember = await runInDurableObject(room, async (_instance, state) =>
      state.storage.get<{ connectionId?: string }>(`member:${foreignAddress}`),
    );
    expect(storedMember).toMatchObject({ connectionId: connection.id });

    charlie.socket.close(1000, "queue initial foreign delivery");
    const foreignHub = env.HOST_HUB.getByName(
      `org:${foreign.orgId}:host:reconnect-beta`,
    );
    await expect.poll(async () => !(await foreignHub.status()).connected).toBe(true);

    await room.post(
      "alice@reconnect-alpha",
      "initial delivery before reconnect",
      undefined,
      "tx_200000000101",
    );
    await expect.poll(async () => (await foreignHub.status()).queueDepth).toBe(1);
    const initiallyQueued = await runInDurableObject(foreignHub, async (_instance, state) =>
      state.storage.list<{ connectionId?: string; messageId: string }>({ prefix: "q:" }),
    );
    expect([...initiallyQueued.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "tx_200000000101",
          connectionId: connection.id,
        }),
      ]),
    );

    charlie = await connect(charlieCredentials, "charlie");
    const initialDelivery = await nextDeliver(charlie);
    expect(initialDelivery).toMatchObject({
      t: "deliver",
      id: "tx_200000000101",
      agent: "charlie",
    });
    charlie.send({ t: "deliver_ack", id: "tx_200000000101", agent: "charlie" });
    await expect.poll(async () => (await foreignHub.status()).queueDepth).toBe(0);

    expect((await api(`/api/organization-connections/${connection.id}`, {
      cookie: home.cookie,
      method: "DELETE",
    })).status).toBe(200);
    expect(
      (await room.detail()).members.find((member) => member.address === foreignAddress),
    ).toMatchObject({ connected: false });

    await room.post(
      "alice@reconnect-alpha",
      "foreign delivery while revoked",
      undefined,
      "tx_200000000102",
    );
    await expect.poll(async () =>
      env.DB.prepare("SELECT status, last_error FROM message_delivery WHERE message_id = ? AND target_addr = ?")
        .bind("tx_200000000102", foreignAddress)
        .first(),
    ).toEqual({ status: "dead", last_error: "organization_connection_revoked" });

    const reconnectedRequest = await api("/api/organization-connections", {
      cookie: home.cookie,
      method: "POST",
      body: { organization_slug: foreign.orgSlug },
    });
    const { connection: reconnected } = await reconnectedRequest.json<{ connection: { id: string } }>();
    expect(reconnected.id).not.toBe(connection.id);
    expect((await api(`/api/organization-connections/${reconnected.id}/accept`, {
      cookie: foreign.cookie,
      method: "POST",
      body: {},
    })).status).toBe(200);
    expect(
      (await room.detail()).members.find((member) => member.address === foreignAddress),
    ).toMatchObject({ connected: true });

    const restoredDelivery = nextDeliver(charlie);
    await room.post(
      "alice@reconnect-alpha",
      "foreign delivery after reconnect",
      undefined,
      "tx_200000000103",
    );
    const reconnectedQueue = await runInDurableObject(foreignHub, async (_instance, state) =>
      state.storage.list<{ connectionId?: string; messageId: string }>({ prefix: "q:" }),
    );
    expect([...reconnectedQueue.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId: "tx_200000000103",
          connectionId: reconnected.id,
        }),
      ]),
    );
    expect(await restoredDelivery).toMatchObject({
      t: "deliver",
      id: "tx_200000000103",
      agent: "charlie",
    });
    charlie.send({ t: "deliver_ack", id: "tx_200000000103", agent: "charlie" });

    alice.socket.close(1000, "test complete");
    charlie.socket.close(1000, "test complete");
  });
});
