import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

type Account = {
  cookie: string;
  orgId: string;
  orgSlug: string;
};

type DaemonCredentials = {
  device_token: string;
  host: string;
};

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
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

async function signUp(email: string, name: string): Promise<Account> {
  const response = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: "test1234!", name },
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

async function enrollHost(account: Account, slug: string): Promise<DaemonCredentials> {
  const codeResponse = await api("/api/hosts/enroll", {
    cookie: account.cookie,
    method: "POST",
    body: { slug },
  });
  expect(codeResponse.status, await codeResponse.clone().text()).toBe(200);
  const { code } = await codeResponse.json<{ code: string }>();
  const enrolled = await api("/api/daemon/enroll", {
    method: "POST",
    body: { code, daemon_ver: "cross-org-room-test" },
  });
  expect(enrolled.status, await enrolled.clone().text()).toBe(200);
  return enrolled.json<DaemonCredentials>();
}

async function connectDaemon(
  credentials: DaemonCredentials,
  agent: string,
): Promise<WebSocket> {
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
      daemon_ver: "cross-org-room-test",
      host: credentials.host,
    }),
  );
  expect(await hello).toMatchObject({ t: "hello_ok" });
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
  const flushed = nextFrame(socket);
  socket.send(JSON.stringify({ t: "rpc", rid: `flush-${agent}`, method: "list_agents", params: {} }));
  expect(await flushed).toMatchObject({ t: "rpc_result", rid: `flush-${agent}` });
  return socket;
}

describe("cross-organization room membership routes", () => {
  it("adds and removes qualified foreign members and exposes their connection state", async () => {
    const owner = await signUp("room-owner@test.example", "Room Owner");
    const peer = await signUp("room-peer@test.example", "Room Peer");
    const ownerSocket = await connectDaemon(await enrollHost(owner, "alpha"), "alice");
    const peerSocket = await connectDaemon(await enrollHost(peer, "beta"), "bob");
    const peerAddress = `${peer.orgSlug}/bob@beta`;

    const created = await api("/api/rooms", {
      cookie: owner.cookie,
      method: "POST",
      body: { name: "ops", policy: "invite" },
    });
    expect(created.status, await created.clone().text()).toBe(201);

    const refused = await api("/api/rooms/ops/members", {
      cookie: owner.cookie,
      method: "POST",
      body: { address: peerAddress },
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "organization_not_connected" });

    const requested = await api("/api/organization-connections", {
      cookie: owner.cookie,
      method: "POST",
      body: { organization_slug: peer.orgSlug },
    });
    expect(requested.status, await requested.clone().text()).toBe(201);
    const requestBody = await requested.json<{ connection: { id: string } }>();
    const accepted = await api(
      `/api/organization-connections/${requestBody.connection.id}/accept`,
      { cookie: peer.cookie, method: "POST", body: {} },
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);

    const peerAgents = await api(
      `/api/agents?organization=${encodeURIComponent(peer.orgSlug)}`,
      { cookie: owner.cookie },
    );
    expect(peerAgents.status).toBe(200);
    expect(await peerAgents.json()).toMatchObject({
      agents: [{ name: "bob", host: "beta", organization: peer.orgSlug, address: peerAddress }],
    });

    const homeAdded = await api("/api/rooms/ops/members", {
      cookie: owner.cookie,
      method: "POST",
      body: { address: "alice@alpha" },
    });
    expect(homeAdded.status, await homeAdded.clone().text()).toBe(200);

    const foreignAdded = await api("/api/rooms/ops/members", {
      cookie: owner.cookie,
      method: "POST",
      body: { address: peerAddress },
    });
    expect(foreignAdded.status, await foreignAdded.clone().text()).toBe(200);
    expect(await foreignAdded.json()).toEqual({ joined: true });

    const detail = await api("/api/rooms/ops", { cookie: owner.cookie });
    expect(detail.status).toBe(200);
    const body = await detail.json<{
      room: {
        members: Array<{
          address: string;
          organization?: string;
          connected?: boolean;
        }>;
      };
    }>();
    const home = body.room.members.find((member) => member.address === "alice@alpha");
    const foreign = body.room.members.find((member) => member.address === peerAddress);
    expect(home).toBeDefined();
    expect(home).not.toHaveProperty("organization");
    expect(home).not.toHaveProperty("connected");
    expect(foreign).toEqual({
      address: peerAddress,
      organization: peer.orgSlug,
      connected: true,
      joinedAt: expect.any(Number),
      lastAckedSeq: 0,
    });

    const removed = await api(
      `/api/rooms/ops/members/${encodeURIComponent(peerAddress)}`,
      { cookie: owner.cookie, method: "DELETE" },
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await removed.json()).toEqual({ left: true });

    const afterRemoval = await api("/api/rooms/ops", { cookie: owner.cookie });
    const afterBody = await afterRemoval.json<{
      room: { members: Array<{ address: string }> };
    }>();
    expect(afterBody.room.members).not.toContainEqual(
      expect.objectContaining({ address: peerAddress }),
    );

    ownerSocket.close(1000, "test complete");
    peerSocket.close(1000, "test complete");
  });
});
