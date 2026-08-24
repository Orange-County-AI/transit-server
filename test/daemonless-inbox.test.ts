import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The asymmetry closing.
 *
 * Before this, an agent with no daemon could SEND and nothing could be
 * delivered to it, which is not communication. These tests are about the
 * receiving half: a daemon-backed agent reaching a daemonless one, and — the
 * feature that was outright impossible — two daemonless agents holding a
 * conversation with no Herdr and no daemon anywhere in it.
 */

const ORIGIN = "http://localhost";

type Enrolled = { device_token: string; host: string; org: string };

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

async function signUp(email: string): Promise<string> {
  const response = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "test1234!", name: "Operator" }),
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function enrollHost(cookie: string, slug: string): Promise<Enrolled> {
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
  expect(enrolled.status).toBe(200);
  return enrolled.json<Enrolled>();
}

/** An agent that exists only as a credential: no daemon, no roster, no pane. */
async function daemonlessAgent(
  cookie: string,
  host: string,
  name: string,
): Promise<string> {
  const created = await SELF.fetch(`${ORIGIN}/api/agent-clients`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({ host, name }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const client = await created.json<{ client_id: string; client_secret: string }>();
  const token = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: client.client_id,
      client_secret: client.client_secret,
    }).toString(),
  });
  expect(token.status).toBe(200);
  return (await token.json<{ access_token: string }>()).access_token;
}

async function tool(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError?: boolean }> {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json<{
    result: { content: { text: string }[]; isError?: boolean };
  }>();
  return { text: body.result.content[0]!.text, isError: body.result.isError };
}

async function connectDaemon(credentials: Enrolled, agent: string) {
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
  expect(await hello).toMatchObject({ t: "hello_ok" });
  const flushed = nextFrame(socket);
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
  socket.send(
    JSON.stringify({ t: "rpc", rid: "flush", method: "list_agents", params: {} }),
  );
  expect(await flushed).toMatchObject({ t: "rpc_result", rid: "flush" });
  return socket;
}

describe("a daemonless agent can be reached", () => {
  it("receives from a daemon-backed agent, and re-reads until it settles", async () => {
    const cookie = await signUp("inbox-mixed@test.example");
    const alpha = await enrollHost(cookie, "alpha");
    await enrollHost(cookie, "beta");
    const alphaSocket = await connectDaemon(alpha, "alice");
    // `scout@beta` has a credential and nothing else. No daemon ever connects
    // to beta in this test.
    const scout = await daemonlessAgent(cookie, "beta", "scout");

    const id = "tx_aabbccdd0011";
    const ack = nextFrame(alphaSocket);
    alphaSocket.send(
      JSON.stringify({
        t: "send",
        id,
        from: "alice@alpha",
        to: "scout@beta",
        body: "can you hear me",
        ts: "2026-08-24T12:00:00.000Z",
      }),
    );
    // This is the line that used to be `send_nak` with `no_route`.
    expect(await ack).toEqual({ t: "send_ack", id });

    const first = await tool(scout, "read_inbox");
    expect(first.isError).toBeUndefined();
    expect(first.text).toContain('<transit from="alice@alpha"');
    expect(first.text).toContain("can you hear me");

    // Reading does not settle: the same message comes back. That is the whole
    // reason it is safe for a reader to crash between fetching and acting.
    const again = await tool(scout, "read_inbox");
    expect(again.text).toBe(first.text);

    const settled = await tool(scout, "mark_handled", { delivery_id: id });
    expect(JSON.parse(settled.text)).toEqual({ settled: true });
    expect((await tool(scout, "read_inbox")).text).toBe("No messages waiting.");

    // Settling twice is not an error, it is a no-op — the same shape a
    // duplicate daemon ack has.
    expect(
      JSON.parse((await tool(scout, "mark_handled", { delivery_id: id })).text),
    ).toEqual({ settled: false });

    alphaSocket.close(1000, "done");
  });

  it("lets two daemonless agents hold a conversation", async () => {
    const cookie = await signUp("inbox-pair@test.example");
    await enrollHost(cookie, "alpha");
    await enrollHost(cookie, "beta");
    // Neither host ever opens a daemon socket. Before this phase these two
    // could each send into the void and neither could ever answer.
    const ada = await daemonlessAgent(cookie, "alpha", "ada");
    const bob = await daemonlessAgent(cookie, "beta", "bob");

    const asked = await tool(ada, "send_message", {
      to: "bob@beta",
      message: "what is the status",
    });
    expect(asked.isError, asked.text).toBeUndefined();
    const askId = /Message (tx_[0-9a-f]+)/.exec(asked.text)?.[1];
    expect(askId).toBeTruthy();

    const bobInbox = await tool(bob, "read_inbox");
    expect(bobInbox.text).toContain("what is the status");
    expect(bobInbox.text).toContain('from="ada@alpha"');

    const answered = await tool(bob, "send_message", {
      to: "ada@alpha",
      message: "green, all of it",
      reply_to: askId,
    });
    expect(answered.isError, answered.text).toBeUndefined();
    await tool(bob, "mark_handled", { delivery_id: askId! });

    const adaInbox = await tool(ada, "read_inbox");
    expect(adaInbox.text).toContain("green, all of it");
    expect(adaInbox.text).toContain('from="bob@beta"');
    expect(adaInbox.text).toContain(`reply_to="${askId}"`);

    // Each only ever sees its own mail.
    expect((await tool(bob, "read_inbox")).text).toBe("No messages waiting.");
  });

  it("still refuses an address nobody declared", async () => {
    const cookie = await signUp("inbox-unknown@test.example");
    const alpha = await enrollHost(cookie, "alpha");
    await enrollHost(cookie, "beta");
    const socket = await connectDaemon(alpha, "alice");

    // A name with no roster entry AND no agent_client row is still no_route.
    // Admission widened to declared identities, not to anything asked for.
    const nak = nextFrame(socket);
    socket.send(
      JSON.stringify({
        t: "send",
        id: "tx_ffee00112233",
        from: "alice@alpha",
        to: "ghost@beta",
        body: "into the void",
        ts: "2026-08-24T12:00:00.000Z",
      }),
    );
    expect(await nak).toEqual({
      t: "send_nak",
      id: "tx_ffee00112233",
      code: "no_route",
    });

    // And a revoked credential stops being an address.
    const created = await SELF.fetch(`${ORIGIN}/api/agent-clients`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie },
      body: JSON.stringify({ host: "beta", name: "briefly" }),
    });
    const { client_id } = await created.json<{ client_id: string }>();
    await SELF.fetch(`${ORIGIN}/api/agent-clients/${client_id}`, {
      method: "DELETE",
      headers: { origin: ORIGIN, cookie },
    });
    const afterRevoke = nextFrame(socket);
    socket.send(
      JSON.stringify({
        t: "send",
        id: "tx_ffee00112244",
        from: "alice@alpha",
        to: "briefly@beta",
        body: "too late",
        ts: "2026-08-24T12:00:00.000Z",
      }),
    );
    expect(await afterRevoke).toEqual({
      t: "send_nak",
      id: "tx_ffee00112244",
      code: "no_route",
    });

    socket.close(1000, "done");
  });
});
