import { SELF, env } from "cloudflare:test";
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

async function enrollHost(
  account: Account,
  slug: string,
): Promise<DaemonCredentials> {
  const codeResponse = await api("/api/hosts/enroll", {
    cookie: account.cookie,
    method: "POST",
    body: { slug },
  });
  expect(codeResponse.status, await codeResponse.clone().text()).toBe(200);
  const { code } = await codeResponse.json<{ code: string }>();
  const enrolled = await api("/api/daemon/enroll", {
    method: "POST",
    body: { code, daemon_ver: "cross-org-test" },
  });
  expect(enrolled.status, await enrolled.clone().text()).toBe(200);
  return enrolled.json<DaemonCredentials>();
}

async function flushSocket(socket: WebSocket, rid: string): Promise<Record<string, unknown>> {
  const result = nextFrame(socket);
  socket.send(JSON.stringify({ t: "rpc", rid, method: "list_agents", params: {} }));
  const frame = await result;
  expect(frame).toMatchObject({ t: "rpc_result", rid });
  return frame;
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
      daemon_ver: "cross-org-test",
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

async function send(
  socket: WebSocket,
  input: { id: string; from: string; to: string; body: string },
): Promise<Record<string, unknown>> {
  const response = nextFrame(socket);
  socket.send(
    JSON.stringify({
      t: "send",
      ...input,
      ts: "2026-08-22T10:00:00.000Z",
    }),
  );
  return response;
}

describe("cross-organization direct messages", () => {
  it("requires approval, qualifies identities, supports replies, and revokes queued routes", async () => {
    const aliceAccount = await signUp("cross-alice@test.example", "Alice Org");
    const bobAccount = await signUp("cross-bob@test.example", "Bob Org");
    const aliceCredentials = await enrollHost(aliceAccount, "alpha");
    const bobCredentials = await enrollHost(bobAccount, "beta");
    const alice = await connectDaemon(aliceCredentials, "alice");
    let bob = await connectDaemon(bobCredentials, "bob");
    const bobAddress = `${bobAccount.orgSlug}/bob@beta`;
    const aliceAddress = `${aliceAccount.orgSlug}/alice@alpha`;

    expect(
      await send(alice, {
        id: "tx_100000000001",
        from: "alice@alpha",
        to: bobAddress,
        body: "blocked before approval",
      }),
    ).toEqual({ t: "send_nak", id: "tx_100000000001", code: "no_route" });

    const requested = await api("/api/organization-connections", {
      cookie: aliceAccount.cookie,
      method: "POST",
      body: { organization_slug: bobAccount.orgSlug },
    });
    expect(requested.status, await requested.clone().text()).toBe(201);
    const requestBody = await requested.json<{ connection: { id: string } }>();

    const ownAccept = await api(
      `/api/organization-connections/${requestBody.connection.id}/accept`,
      { cookie: aliceAccount.cookie, method: "POST", body: {} },
    );
    expect(ownAccept.status).toBe(403);
    const incoming = await api("/api/organization-connections", {
      cookie: bobAccount.cookie,
    });
    expect(await incoming.json()).toMatchObject({
      connections: [
        {
          id: requestBody.connection.id,
          status: "pending",
          requested_by_me: false,
          can_accept: true,
          peer: { id: aliceAccount.orgId, slug: aliceAccount.orgSlug },
        },
      ],
    });

    const accepted = await api(
      `/api/organization-connections/${requestBody.connection.id}/accept`,
      { cookie: bobAccount.cookie, method: "POST", body: {} },
    );
    expect(accepted.status, await accepted.clone().text()).toBe(200);

    const rosterResult = nextFrame(alice);
    alice.send(
      JSON.stringify({
        t: "rpc",
        rid: "peer-roster",
        method: "list_agents",
        params: { organization: bobAccount.orgSlug },
      }),
    );
    expect(await rosterResult).toMatchObject({
      t: "rpc_result",
      rid: "peer-roster",
      result: [
        {
          name: "bob",
          host: "beta",
          organization: bobAccount.orgSlug,
          address: bobAddress,
        },
      ],
    });

    const deliveredToBob = nextFrame(bob);
    expect(
      await send(alice, {
        id: "tx_100000000002",
        from: "alice@alpha",
        to: bobAddress,
        body: "hello across organizations",
      }),
    ).toEqual({ t: "send_ack", id: "tx_100000000002" });
    const bobDelivery = await deliveredToBob;
    expect(bobDelivery).toMatchObject({
      t: "deliver",
      id: "tx_100000000002",
      agent: "bob",
    });
    expect(String(bobDelivery.envelope)).toContain(
      `<transit from="${aliceAddress}" id="tx_100000000002"`,
    );
    expect(String(bobDelivery.envelope)).toContain(
      `<reply tool="send_message" to="${aliceAddress}" reply_to="tx_100000000002"/>`,
    );
    bob.send(
      JSON.stringify({
        t: "deliver_ack",
        id: "tx_100000000002",
        agent: "bob",
      }),
    );
    await flushSocket(bob, "bob-after-ack");

    const deliveredToAlice = nextFrame(alice);
    expect(
      await send(bob, {
        id: "tx_100000000003",
        from: "bob@beta",
        to: aliceAddress,
        body: "reply across organizations",
      }),
    ).toEqual({ t: "send_ack", id: "tx_100000000003" });
    expect(await deliveredToAlice).toMatchObject({
      t: "deliver",
      id: "tx_100000000003",
      agent: "alice",
    });

    expect(
      await send(alice, {
        id: "tx_100000000004",
        from: aliceAddress,
        to: bobAddress,
        body: "qualified sender spoof",
      }),
    ).toEqual({ t: "send_nak", id: "tx_100000000004", code: "no_route" });

    await expect
      .poll(async () =>
        env.DB.prepare(
          "SELECT org_id, recipient_org_id, from_addr, to_addr FROM message WHERE id = ?",
        )
          .bind("tx_100000000002")
          .first(),
      )
      .toEqual({
        org_id: aliceAccount.orgId,
        recipient_org_id: bobAccount.orgId,
        from_addr: aliceAddress,
        to_addr: bobAddress,
      });
    const bobActivity = await api("/api/activity", {
      cookie: bobAccount.cookie,
    });
    const bobActivityBody = await bobActivity.json<{
      activity: Array<{ id: string }>;
    }>();
    expect(bobActivityBody.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tx_100000000003" }),
        expect.objectContaining({ id: "tx_100000000002" }),
      ]),
    );

    bob.close(1000, "test disconnect");
    const bobHub = env.HOST_HUB.getByName(
      `org:${bobAccount.orgId}:host:beta`,
    );
    await expect.poll(async () => (await bobHub.status()).connected).toBe(false);
    expect(
      await send(alice, {
        id: "tx_100000000005",
        from: "alice@alpha",
        to: bobAddress,
        body: "queued before revocation",
      }),
    ).toEqual({ t: "send_ack", id: "tx_100000000005" });

    const removed = await api(
      `/api/organization-connections/${requestBody.connection.id}`,
      { cookie: aliceAccount.cookie, method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(
      await send(alice, {
        id: "tx_100000000006",
        from: "alice@alpha",
        to: bobAddress,
        body: "blocked after revocation",
      }),
    ).toEqual({ t: "send_nak", id: "tx_100000000006", code: "no_route" });

    bob = await connectDaemon(bobCredentials, "bob");
    await expect
      .poll(async () =>
        env.DB.prepare(
          "SELECT status, last_error FROM message_delivery WHERE message_id = ?",
        )
          .bind("tx_100000000005")
          .first(),
      )
      .toEqual({
        status: "dead",
        last_error: "organization_connection_revoked",
      });

    alice.close(1000, "test complete");
    bob.close(1000, "test complete");
  });
});
