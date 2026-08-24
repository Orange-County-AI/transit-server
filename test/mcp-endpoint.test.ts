import { SELF } from "cloudflare:test";
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
  expect(await hello).toMatchObject({ t: "hello_ok", org: credentials.org });
  const rostered = nextFrame(socket);
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
    JSON.stringify({ t: "rpc", rid: "roster-flush", method: "list_agents", params: {} }),
  );
  expect(await rostered).toMatchObject({ t: "rpc_result", rid: "roster-flush" });
  return socket;
}

type JsonRpcReply = {
  jsonrpc: string;
  id: number | string | null;
  result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
};

/**
 * One MCP request, carrying nothing from any other. No session header is ever
 * sent — that is the property under test, not an omission.
 */
async function mcp(
  token: string | null,
  body: unknown,
  agent?: string,
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(agent ? { "x-transit-agent": agent } : {}),
    },
    body: JSON.stringify(body),
  });
}

function call(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("server-side MCP endpoint", () => {
  it("serves the tool surface and sends without a daemon, session, or handshake", async () => {
    const cookie = await signUp("mcp-endpoint@test.example");
    // `alpha` enrolls and never connects a daemon: it is the box with no Herdr
    // and no transit daemon that this endpoint exists for.
    const alpha = await enrollHost(cookie, "alpha");
    const beta = await enrollHost(cookie, "beta");
    const betaSocket = await connectDaemon(beta, "bob");

    // 1. tools/list, cold. No `initialize` has been sent on this connection or
    // any other, and no session id exists to send.
    const listed = await mcp(alpha.device_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("mcp-session-id")).toBeNull();
    const tools = (await listed.json<JsonRpcReply>()).result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "chat_reply",
      "claim_name",
      "create_room",
      "join_room",
      "leave_room",
      "list_agents",
      "list_rooms",
      "mark_handled",
      "read_message",
      "send_message",
      "whoami",
    ]);

    // 2. tools/call on a separate request, still with no session and still with
    // no `initialize` between the two. If anything were being remembered, this
    // is the call that would fail.
    const delivered = nextFrame(betaSocket);
    const sent = await mcp(
      alpha.device_token,
      call(2, "send_message", { to: "bob@beta", message: "hello from no daemon" }),
      "alice",
    );
    expect(sent.status).toBe(200);
    const sentBody = await sent.json<JsonRpcReply>();
    expect(sentBody.result?.isError).toBeUndefined();
    const text = sentBody.result?.content?.[0]?.text ?? "";
    expect(text).toMatch(/^Message tx_[0-9a-f]{12} to bob@beta: sent$/);

    // 3. The fake daemon actually receives it, rendered as a transit/1 envelope
    // from an agent that exists in no roster anywhere.
    const frame = await delivered;
    expect(frame).toMatchObject({ t: "deliver", agent: "bob" });
    expect(String(frame.envelope)).toContain('<transit from="alice@alpha"');
    expect(String(frame.envelope)).toContain("hello from no daemon");

    // 4. A third bare request reaches the shared tool layer, not a copy of it.
    const roster = await mcp(alpha.device_token, call(3, "list_agents"), "alice");
    const rosterText = (await roster.json<JsonRpcReply>()).result?.content?.[0]?.text;
    expect(JSON.parse(String(rosterText))).toMatchObject([
      { name: "bob", host: "beta" },
    ]);

    betaSocket.close(1000, "test complete");
  });

  it("refuses an unauthenticated call with a bearer challenge", async () => {
    const anonymous = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    // A 200 with a challenge header is what a connector silently ignores.
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toMatch(/^Bearer/);

    const wrong = await mcp("not-a-real-device-token", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(wrong.status).toBe(401);
  });

  it("reports identity, refuses notifications a body, and rejects unknown methods", async () => {
    const cookie = await signUp("mcp-identity@test.example");
    const alpha = await enrollHost(cookie, "solo");

    const who = await mcp(alpha.device_token, call(1, "whoami"), "scout");
    expect((await who.json<JsonRpcReply>()).result?.content?.[0]?.text).toBe(
      "scout@solo (connected: false)",
    );

    // A tool that acts as an agent must say how to name one rather than read as
    // a credential failure.
    const unnamed = await mcp(
      alpha.device_token,
      call(2, "send_message", { to: "bob@beta", message: "x" }),
    );
    const unnamedBody = await unnamed.json<JsonRpcReply>();
    expect(unnamedBody.result?.isError).toBe(true);
    expect(unnamedBody.result?.content?.[0]?.text).toContain("X-Transit-Agent");

    // Notifications get 202 and no body, never a JSON-RPC envelope.
    const notified = await mcp(alpha.device_token, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe("");

    const unknown = await mcp(alpha.device_token, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
    });
    expect((await unknown.json<JsonRpcReply>()).error?.code).toBe(-32601);

    // `initialize` is answered for older clients, and answering it stores
    // nothing: the version comes back from the request, not from a session.
    const initialized = await mcp(alpha.device_token, {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {} },
    });
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    expect(
      (await initialized.json<{ result: { protocolVersion: string } }>()).result
        .protocolVersion,
    ).toBe("2024-11-05");
  });
});
