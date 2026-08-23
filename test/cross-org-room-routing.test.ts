import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

type Account = {
  cookie: string;
  orgId: string;
  orgSlug: string;
};

type DaemonCredentials = {
  device_token: string;
  host_id: string;
  host: string;
  org: string;
};

type FrameReader = {
  next: () => Promise<Record<string, unknown>>;
  send: (frame: Record<string, unknown>) => void;
  socket: WebSocket;
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
    socket,
  };
}

async function api(
  path: string,
  options: { cookie?: string; method?: string; body?: unknown } = {},
): Promise<Response> {
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

async function signUp(name: string): Promise<Account> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const response = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: {
      email: `cross-room-${suffix}@test.example`,
      password: "test1234!",
      name,
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const user = await response.json<{ user: { id: string } }>();
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const organizations = await api("/api/auth/organization/list", { cookie });
  const rows = await organizations.json<Array<{ id: string; slug: string }>>();
  const personal = rows.find((organization) => organization.id === user.user.id);
  expect(personal).toBeDefined();
  return { cookie, orgId: user.user.id, orgSlug: personal!.slug };
}

async function enroll(account: Account, host: string): Promise<DaemonCredentials> {
  const codeResponse = await api("/api/hosts/enroll", {
    cookie: account.cookie,
    method: "POST",
    body: { slug: host },
  });
  expect(codeResponse.status, await codeResponse.clone().text()).toBe(200);
  const { code } = await codeResponse.json<{ code: string }>();
  const response = await api("/api/daemon/enroll", {
    method: "POST",
    body: { code, daemon_ver: "cross-org-room-test" },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<DaemonCredentials>();
}

async function connect(
  credentials: DaemonCredentials,
  agent: string,
): Promise<FrameReader> {
  const response = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
    headers: {
      upgrade: "websocket",
      authorization: `Bearer ${credentials.device_token}`,
    },
  });
  expect(response.status).toBe(101);
  const frames = readFrames(response.webSocket!);
  frames.socket.accept();
  frames.send({
    t: "hello",
    proto: 1,
    daemon_ver: "cross-org-room-test",
    host: credentials.host,
  });
  expect(await frames.next()).toMatchObject({ t: "hello_ok", host_id: credentials.host_id });
  frames.send({
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
  });
  await rpc(frames, `flush-${credentials.host}`, "list_rooms", {});
  return frames;
}

async function rpc(
  frames: FrameReader,
  rid: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = frames.next();
  frames.send({ t: "rpc", rid, method, params });
  return result;
}

async function connectOrganizations(source: Account, target: Account): Promise<string> {
  const requested = await api("/api/organization-connections", {
    cookie: source.cookie,
    method: "POST",
    body: { organization_slug: target.orgSlug },
  });
  expect(requested.status, await requested.clone().text()).toBe(201);
  const { connection } = await requested.json<{ connection: { id: string } }>();
  const accepted = await api(`/api/organization-connections/${connection.id}/accept`, {
    cookie: target.cookie,
    method: "POST",
    body: {},
  });
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  return connection.id;
}

async function createRoom(frames: FrameReader, room: string, address: string) {
  return rpc(frames, `create-${room}-${address}`, "create_room", { room, address });
}

describe("cross-organization rooms", () => {
  it("routes qualified room joins, sends, creation, and listings to the connected organization", async () => {
    const aliceAccount = await signUp("Alice Org");
    const bobAccount = await signUp("Bob Org");
    const aliceCredentials = await enroll(aliceAccount, "alpha");
    const bobCredentials = await enroll(bobAccount, "beta");
    const alice = await connect(aliceCredentials, "alice");
    const bob = await connect(bobCredentials, "bob");

    expect(await createRoom(bob, "ops", "bob@beta")).toMatchObject({
      t: "rpc_result",
      result: { room: { name: "ops" }, joined: true },
    });
    expect(await createRoom(alice, "ops", "alice@alpha")).toMatchObject({
      t: "rpc_result",
      result: { room: { name: "ops" }, joined: true },
    });

    expect(
      await rpc(alice, "unconnected-join", "join_room", {
        room: `${bobAccount.orgSlug}/#ops`,
        address: "alice@alpha",
      }),
    ).toMatchObject({
      t: "rpc_result",
      error: { code: "rpc_error", message: "organization is not connected" },
    });

    await connectOrganizations(aliceAccount, bobAccount);

    expect(
      await rpc(alice, "connected-join", "join_room", {
        room: `${bobAccount.orgSlug}/#ops`,
        address: "alice@alpha",
      }),
    ).toMatchObject({ t: "rpc_result", result: { joined: true } });
    expect(
      await rpc(alice, "qualified-create", "create_room", {
        room: `${bobAccount.orgSlug}/#forbidden`,
        address: "alice@alpha",
      }),
    ).toMatchObject({
      t: "rpc_result",
      error: { code: "rpc_error", message: "cannot create a room in another organization" },
    });
    expect(
      await rpc(alice, "peer-rooms", "list_rooms", { organization: bobAccount.orgSlug }),
    ).toMatchObject({
      t: "rpc_result",
      result: expect.arrayContaining([
        expect.objectContaining({
          name: "ops",
          organization: bobAccount.orgSlug,
          address: `${bobAccount.orgSlug}/#ops`,
        }),
      ]),
    });

    const acknowledgement = alice.next();
    alice.send({
      t: "send",
      id: "tx_100000000101",
      from: "alice@alpha",
      to: `${bobAccount.orgSlug}/#ops`,
      body: "cross-organization room post",
      ts: "2026-08-23T10:00:00.000Z",
    });
    expect(await acknowledgement).toEqual({ t: "send_ack", id: "tx_100000000101" });

    const peerDetail = await env.ROOM.getByName(`org:${bobAccount.orgId}:room:ops`).detail();
    const localDetail = await env.ROOM.getByName(`org:${aliceAccount.orgId}:room:ops`).detail();
    expect(peerDetail.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tx_100000000101", body: "cross-organization room post" }),
      ]),
    );
    expect(localDetail.messages).toEqual([]);

    alice.socket.close(1000, "test complete");
    bob.socket.close(1000, "test complete");
  });

  it("kills a queued foreign room delivery after its connection is revoked", async () => {
    const aliceAccount = await signUp("Alice Revocation Org");
    const bobAccount = await signUp("Bob Revocation Org");
    const aliceCredentials = await enroll(aliceAccount, "alpha");
    const bobCredentials = await enroll(bobAccount, "beta");
    let alice = await connect(aliceCredentials, "alice");
    const bob = await connect(bobCredentials, "bob");

    expect(await createRoom(bob, "ops", "bob@beta")).toMatchObject({
      t: "rpc_result",
      result: { joined: true },
    });
    const connectionId = await connectOrganizations(aliceAccount, bobAccount);
    expect(
      await rpc(alice, "join-peer-ops", "join_room", {
        room: `${bobAccount.orgSlug}/#ops`,
        address: "alice@alpha",
      }),
    ).toMatchObject({ t: "rpc_result", result: { joined: true } });

    alice.socket.close(1000, "test disconnect");
    const aliceHub = env.HOST_HUB.getByName(`org:${aliceAccount.orgId}:host:alpha`);
    await expect.poll(async () => (await aliceHub.status()).connected).toBe(false);

    const posted = await api("/api/rooms/ops/post", {
      cookie: bobAccount.cookie,
      method: "POST",
      body: { body: "queued for a foreign member" },
    });
    expect(posted.status, await posted.clone().text()).toBe(201);
    const { message } = await posted.json<{ message: { id: string } }>();

    const queued = await runInDurableObject(aliceHub, async (_instance, state) =>
      state.storage.list<{ connectionId?: string; roomName?: string }>({ prefix: "q:" }),
    );
    expect([...queued.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId, roomName: "ops" }),
      ]),
    );

    const removed = await api(`/api/organization-connections/${connectionId}`, {
      cookie: aliceAccount.cookie,
      method: "DELETE",
    });
    expect(removed.status, await removed.clone().text()).toBe(200);

    alice = await connect(aliceCredentials, "alice");
    await expect
      .poll(async () =>
        env.DB.prepare(
          "SELECT status, last_error FROM message_delivery WHERE message_id = ? AND target_addr = ?",
        )
          .bind(message.id, `${aliceAccount.orgSlug}/alice@alpha`)
          .first(),
      )
      .toEqual({
        status: "dead",
        last_error: "organization_connection_revoked",
      });

    alice.socket.close(1000, "test complete");
    bob.socket.close(1000, "test complete");
  });
});
