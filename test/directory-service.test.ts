import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * `list_agents` and `list_rooms` answer the same question through an HTTP route
 * and an MCP tool. They used to be two queries, and they had already drifted in
 * ordering. This is the test that fails if they drift again: it reads both
 * surfaces and compares the fields they share, rather than checking each one
 * against a literal it can be updated to match on its own.
 */

const ORIGIN = "http://localhost";

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

async function enrollHost(cookie: string, slug: string): Promise<string> {
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
  return (await enrolled.json<{ device_token: string }>()).device_token;
}

async function tool(token: string, name: string): Promise<unknown> {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json<{
    result: { content: { text: string }[]; isError?: boolean };
  }>();
  expect(body.result.isError, body.result.content[0]?.text).toBeUndefined();
  return JSON.parse(body.result.content[0]!.text);
}

describe("the directory service answers both transports the same way", () => {
  it("agrees on rooms, and adds the activity window only where it was asked for", async () => {
    const cookie = await signUp("directory-rooms@test.example");
    const token = await enrollHost(cookie, "alpha");
    for (const [name, policy] of [
      ["zulu", "invite"],
      ["ops", "open"],
    ] as const) {
      const created = await SELF.fetch(`${ORIGIN}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify({ name, policy }),
      });
      expect(created.status).toBe(201);
    }

    const restResponse = await SELF.fetch(`${ORIGIN}/api/rooms`, {
      headers: { origin: ORIGIN, cookie },
    });
    const rest = (await restResponse.json<{ rooms: Record<string, unknown>[] }>()).rooms;
    const viaTool = (await tool(token, "list_rooms")) as Record<string, unknown>[];

    // Same rooms, same order, same shared fields — asserted against each other.
    expect(viaTool.map((room) => room.name)).toEqual(rest.map((room) => room.name));
    expect(viaTool.map(({ name, policy, members }) => ({ name, policy, members }))).toEqual(
      rest.map(({ name, policy, members }) => ({ name, policy, members })),
    );
    // Created in reverse alphabetical order, returned in forward: the ordering
    // is the service's, not the insert's.
    expect(rest.map((room) => room.name)).toEqual(["ops", "zulu"]);

    // The dashboard asked for the 24-hour window; a tool listing did not, and
    // must not silently grow a column nothing reads.
    expect(rest.every((room) => room.messages_24h === 0)).toBe(true);
    expect(viaTool.every((room) => !("messages_24h" in room))).toBe(true);
  });

  it("agrees on agents, ordered by host then name", async () => {
    const cookie = await signUp("directory-agents@test.example");
    const token = await enrollHost(cookie, "alpha");
    // No daemon is connected, so the roster is empty on both surfaces — which
    // is itself the agreement being checked.
    const restResponse = await SELF.fetch(`${ORIGIN}/api/agents`, {
      headers: { origin: ORIGIN, cookie },
    });
    const rest = (await restResponse.json<{ agents: unknown[] }>()).agents;
    expect(await tool(token, "list_agents")).toEqual(rest);
  });
});
