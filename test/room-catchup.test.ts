import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Reading a room back.
 *
 * A room's transcript was reachable through `GET /api/rooms/:name`, which is
 * gated on a browser session — so only a signed-in person could catch up on
 * one. An agent that missed a fan-out, because its adapter was down or its box
 * has no Herdr to type into a pane, could not see what it had missed. Push was
 * the only way into a room and push is the half that needs a live session.
 *
 * `read_room` is the pull half. Membership is the authorization: it answers to
 * a member and to nobody else, and it settles nothing.
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

async function enrollHost(cookie: string, slug: string): Promise<void> {
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

type RoomDetail = {
  name: string;
  members: { address: string }[];
  messages: { seq: number; from: string; body: string }[];
};

describe("an agent can read a room it belongs to", () => {
  it("returns the transcript to a member with no daemon anywhere", async () => {
    const cookie = await signUp("room-catchup@test.example");
    await enrollHost(cookie, "alpha");
    await enrollHost(cookie, "beta");
    const ada = await daemonlessAgent(cookie, "alpha", "ada");
    const bob = await daemonlessAgent(cookie, "beta", "bob");

    expect((await tool(ada, "create_room", { name: "standup" })).isError).toBeUndefined();
    expect((await tool(bob, "join_room", { room: "standup" })).isError).toBeUndefined();
    expect(
      (await tool(ada, "send_message", { to: "#standup", message: "first line" }))
        .isError,
    ).toBeUndefined();
    expect(
      (await tool(bob, "send_message", { to: "#standup", message: "second line" }))
        .isError,
    ).toBeUndefined();

    const read = await tool(bob, "read_room", { room: "standup" });
    expect(read.isError, read.text).toBeUndefined();
    const detail = JSON.parse(read.text) as RoomDetail;
    expect(detail.name).toBe("standup");
    expect(detail.members.map((member) => member.address).sort()).toEqual([
      "ada@alpha",
      "bob@beta",
    ]);
    expect(detail.messages.map((message) => message.body)).toEqual([
      "first line",
      "second line",
    ]);
    // Ordered by sequence, so a reader can resume from the last one it saw.
    expect(detail.messages[0]!.seq).toBeLessThan(detail.messages[1]!.seq);

    // Reading changes nothing: the same transcript comes back.
    const again = await tool(bob, "read_room", { room: "standup" });
    expect(JSON.parse(again.text)).toEqual(detail);
  });

  it("refuses a non-member and an agent that left", async () => {
    const cookie = await signUp("room-outsider@test.example");
    await enrollHost(cookie, "alpha");
    await enrollHost(cookie, "beta");
    const ada = await daemonlessAgent(cookie, "alpha", "ada");
    const nosy = await daemonlessAgent(cookie, "beta", "nosy");

    await tool(ada, "create_room", { name: "private-standup" });
    await tool(ada, "send_message", { to: "#private-standup", message: "internal" });

    const denied = await tool(nosy, "read_room", { room: "private-standup" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("not a member of this room");
    expect(denied.text).not.toContain("internal");

    // Membership is checked per read, so leaving closes the transcript again.
    await tool(nosy, "join_room", { room: "private-standup" });
    expect((await tool(nosy, "read_room", { room: "private-standup" })).isError)
      .toBeUndefined();
    await tool(nosy, "leave_room", { room: "private-standup" });
    const afterLeaving = await tool(nosy, "read_room", { room: "private-standup" });
    expect(afterLeaving.isError).toBe(true);
    expect(afterLeaving.text).toContain("not a member of this room");
  });

  it("caps how much it hands back", async () => {
    const cookie = await signUp("room-limit@test.example");
    await enrollHost(cookie, "alpha");
    const ada = await daemonlessAgent(cookie, "alpha", "ada");
    await tool(ada, "create_room", { name: "chatty" });
    for (const line of ["one", "two", "three"]) {
      await tool(ada, "send_message", { to: "#chatty", message: line });
    }

    const limited = await tool(ada, "read_room", { room: "chatty", limit: "2" });
    expect(limited.isError, limited.text).toBeUndefined();
    const detail = JSON.parse(limited.text) as RoomDetail;
    // The newest ones: catching up means the tail, not the head.
    expect(detail.messages.map((message) => message.body)).toEqual(["two", "three"]);
  });
});
