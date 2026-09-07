import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN, callTool, signedInPerson } from "./human-oauth-flow";

/**
 * A person in a room with their agents.
 *
 * Transit used to hold that a signed-in person had an organization and no
 * address, so every tool that acts AS somebody refused. That was a decision
 * about a public namespace rather than a limit of the design — the daemonless
 * path already routes an address with nothing live behind it. `claim_name`
 * makes the decision explicitly, and this is the shape it has to have: one
 * call, from the same MCP surface, and the rest of the surface starts working.
 *
 * The client that made it matter cannot poll on its own. Claude in voice mode
 * has no daemon, no session to push into and no way to hold a socket open, so
 * everything here is pull: send, then `read_inbox` for what came back. That is
 * the half of Transit that never needed a session, used by the one participant
 * that never has one.
 *
 * The agents are deliberately daemonless too, because that is the sharpest
 * version of the test: nothing in this file has a live session anywhere, and
 * the conversation still happens.
 */

async function enrollHost(cookie: string, slug: string): Promise<void> {
  const codeResponse = await SELF.fetch(`${ORIGIN}/api/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({ slug }),
  });
  expect(codeResponse.status, await codeResponse.clone().text()).toBe(200);
  const { code } = await codeResponse.json<{ code: string }>();
  const enrolled = await SELF.fetch(`${ORIGIN}/api/daemon/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, daemon_ver: "0.1.0-test" }),
  });
  expect(enrolled.status, await enrolled.clone().text()).toBe(200);
}

/** An agent that exists only as a credential: no daemon, no roster, no pane. */
async function agentToken(
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
  expect(token.status, await token.clone().text()).toBe(200);
  return (await token.json<{ access_token: string }>()).access_token;
}

describe("a signed-in person as a Transit participant", () => {
  it("claims a name, then talks to an agent and reads the reply", async () => {
    const { cookie, token } = await signedInPerson("person-room@test.example");
    await enrollHost(cookie, "titan");
    const scout = await agentToken(cookie, "titan", "scout");

    // Nothing works before the claim, and the refusal names the fix rather
    // than reading as a broken credential.
    const before = await callTool(token, "read_inbox");
    expect(before.isError).toBe(true);
    expect(before.text).toContain("claim_name");

    const claimed = await callTool(token, "claim_name", { name: "stephan" });
    expect(claimed.isError, claimed.text).toBeUndefined();
    expect(claimed.text).toBe("stephan@people");

    // The address is real on the very next request: the principal is rebuilt
    // per request from the row, so there is no session to refresh.
    const who = await callTool(token, "whoami");
    expect(who.isError).toBeUndefined();
    expect(who.text).toContain("stephan@people");

    const sent = await callTool(token, "send_message", {
      to: "scout@titan",
      message: "what is the deploy status?",
    });
    expect(sent.isError, sent.text).toBeUndefined();

    // The agent finds it waiting, and it is from the person's address.
    const agentInbox = await callTool(scout, "read_inbox");
    expect(agentInbox.isError, agentInbox.text).toBeUndefined();
    expect(agentInbox.text).toContain("what is the deploy status?");
    expect(agentInbox.text).toContain("stephan@people");

    // And can answer it. This is the leg that never worked: a reply addressed
    // to a human had nowhere to land.
    const replied = await callTool(scout, "send_message", {
      to: "stephan@people",
      message: "green, deployed at 14:02",
    });
    expect(replied.isError, replied.text).toBeUndefined();

    // The person reads it back by pulling, because a voice conversation has
    // nothing to push into.
    const inbox = await callTool(token, "read_inbox");
    expect(inbox.isError, inbox.text).toBeUndefined();
    expect(inbox.text).toContain("green, deployed at 14:02");
    expect(inbox.text).toContain("scout@titan");
  });

  it("puts the person in a room with agents and fans out both ways", async () => {
    const { cookie, token } = await signedInPerson("person-fleet@test.example");
    await enrollHost(cookie, "titan");
    const scout = await agentToken(cookie, "titan", "scout");
    const runner = await agentToken(cookie, "titan", "runner");

    expect((await callTool(token, "claim_name", { name: "stephan" })).text).toBe(
      "stephan@people",
    );

    const room = await callTool(token, "create_room", { name: "standup" });
    expect(room.isError, room.text).toBeUndefined();
    for (const agent of [scout, runner]) {
      const joined = await callTool(agent, "join_room", { room: "standup" });
      expect(joined.isError, joined.text).toBeUndefined();
    }

    const posted = await callTool(token, "send_message", {
      to: "#standup",
      message: "status please",
    });
    expect(posted.isError, posted.text).toBeUndefined();

    for (const [name, agent] of [
      ["scout", scout],
      ["runner", runner],
    ] as const) {
      const inbox = await callTool(agent, "read_inbox");
      expect(inbox.text, `${name} missed the room post`).toContain("status please");
      expect(inbox.text).toContain("stephan@people");
    }

    const answered = await callTool(scout, "send_message", {
      to: "#standup",
      message: "scout is idle",
    });
    expect(answered.isError, answered.text).toBeUndefined();

    // The person's own fan-out copy lands in their queue, and the transcript
    // answers the same question without settling anything.
    const inbox = await callTool(token, "read_inbox");
    expect(inbox.text).toContain("scout is idle");

    const transcript = await callTool(token, "read_room", { room: "standup" });
    expect(transcript.isError, transcript.text).toBeUndefined();
    const parsed = JSON.parse(transcript.text) as {
      members: { address: string }[];
      messages: { body: string }[];
    };
    expect(parsed.members.map((member) => member.address)).toContain("stephan@people");
    expect(parsed.messages.map((message) => message.body)).toContain("status please");
  });

  it("shows the person in the fleet directory so agents can find them", async () => {
    const { cookie, token } = await signedInPerson("person-listed@test.example");
    await enrollHost(cookie, "titan");
    const scout = await agentToken(cookie, "titan", "scout");
    await callTool(token, "claim_name", { name: "stephan" });

    // The agent's own view is the one that matters: a fleet member asking who
    // it can talk to must see the human.
    const listed = await callTool(scout, "list_agents");
    expect(listed.isError, listed.text).toBeUndefined();
    expect(JSON.parse(listed.text)).toContainEqual(
      expect.objectContaining({ name: "stephan", host: "people", kind: "person" }),
    );
  });

  it("renames rather than growing a second identity", async () => {
    const { token } = await signedInPerson("person-rename@test.example");
    expect((await callTool(token, "claim_name", { name: "stephan" })).text).toBe(
      "stephan@people",
    );
    expect((await callTool(token, "claim_name", { name: "steve" })).text).toBe(
      "steve@people",
    );
    expect((await callTool(token, "whoami")).text).toContain("steve@people");

    // The old address is gone, not merely unused: a person with two addresses
    // is two participants to every room and queue in the system.
    const listed = JSON.parse((await callTool(token, "list_agents")).text) as {
      name: string;
    }[];
    expect(listed.map((entry) => entry.name)).toEqual(["steve"]);
  });

  it("keeps the namespace per-organization", async () => {
    const first = await signedInPerson("person-ns-a@test.example");
    const second = await signedInPerson("person-ns-b@test.example");
    for (const person of [first, second]) {
      const claimed = await callTool(person.token, "claim_name", { name: "stephan" });
      expect(claimed.isError, claimed.text).toBeUndefined();
      expect(claimed.text).toBe("stephan@people");
    }
  });

  it("refuses a name an agent already holds on the person host", async () => {
    const { cookie, token } = await signedInPerson("person-clash@test.example");
    await enrollHost(cookie, "people");
    await agentToken(cookie, "people", "stephan");

    const clash = await callTool(token, "claim_name", { name: "stephan" });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain("already claimed");
  });

  it("never lets a header stand in for a claim", async () => {
    const { token } = await signedInPerson("person-header@test.example");
    // A person's session carries no authority over a name, so the header a
    // device token may legitimately send must do nothing at all here.
    const spoofed = await callTool(
      token,
      "send_message",
      { to: "scout@titan", message: "hello" },
      { "x-transit-agent": "someone-else" },
    );
    expect(spoofed.isError).toBe(true);
    expect(spoofed.text).toContain("claim_name");
  });

  it("rejects a name that is not a valid Transit name", async () => {
    const { token } = await signedInPerson("person-badname@test.example");
    for (const name of ["Stephan", "9lives", "transit", "operator", "a".repeat(40)]) {
      const answer = await callTool(token, "claim_name", { name });
      expect(answer.isError, `${name} was accepted`).toBe(true);
    }
    expect((await callTool(token, "whoami")).text).toContain("no Transit address yet");
  });
});
