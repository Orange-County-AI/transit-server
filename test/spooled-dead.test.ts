import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

type Credentials = { device_token: string; host: string; org: string };

function readFrames(socket: WebSocket) {
  const buffered: Record<string, unknown>[] = [];
  const waiting: ((frame: Record<string, unknown>) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    const next = waiting.shift();
    if (next) next(frame);
    else buffered.push(frame);
  });
  return {
    next: () =>
      new Promise<Record<string, unknown>>((resolve) => {
        const frame = buffered.shift();
        if (frame) resolve(frame);
        else waiting.push(resolve);
      }),
    send: (frame: Record<string, unknown>) => socket.send(JSON.stringify(frame)),
    closed: () =>
      new Promise<number>((resolve) =>
        socket.addEventListener("close", (event) => resolve(event.code)),
      ),
  };
}

async function operator(): Promise<{ cookie: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const signup = await SELF.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      email: `dead-${suffix}@test.example`,
      password: "correct-horse-battery-staple",
      name: "Dead Letter Operator",
    }),
  });
  expect(signup.status).toBe(200);
  return { cookie: signup.headers.get("set-cookie")!.split(";")[0]! };
}

async function enroll(cookie: string, host: string): Promise<Credentials> {
  const code = await SELF.fetch(`${ORIGIN}/api/hosts/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify({ slug: host }),
  });
  const claimed = await SELF.fetch(`${ORIGIN}/api/daemon/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ code: (await code.json<{ code: string }>()).code, daemon_ver: "dead-test" }),
  });
  return await claimed.json<Credentials>();
}

async function connect(credentials: Credentials) {
  const response = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${credentials.device_token}` },
  });
  response.webSocket!.accept();
  const frames = readFrames(response.webSocket!);
  frames.send({ t: "hello", proto: 1, daemon_ver: "dead-test", host: credentials.host });
  // Wait for the handshake before returning. Every caller's first act is to
  // send a roster frame, and returning early raced it against the hub's hello
  // bookkeeping: the roster was dropped and `spooled_dead` stayed null past the
  // poll window, roughly one run in three under full-suite load. The real
  // daemon does not have this bug — client.go waits for hello_ok before
  // sendRoster — so the race was in this helper, not in the product.
  expect(await frames.next()).toMatchObject({ t: "hello_ok" });
  return frames;
}

function hostRow(cookie: string, slug: string) {
  return SELF.fetch(`${ORIGIN}/api/hosts`, { headers: { cookie } })
    .then((response) => response.json<{ hosts: Record<string, unknown>[] }>())
    .then(({ hosts }) => hosts.find((host) => host.slug === slug));
}

describe("spooled dead letters", () => {
  // A send that dies in a sender's outbox has no row anywhere central, so the
  // only way to see it was to run transit status on every box. The roster
  // carries the count so one number reaches the operator.
  it("reports a daemon's local dead count per host", async () => {
    const { cookie } = await operator();
    const credentials = await enroll(cookie, "titan");
    const frames = await connect(credentials);

    // Before any report: null, not zero. An old daemon must not read as clean.
    await expect.poll(() => hostRow(cookie, "titan")).toMatchObject({ spooled_dead: null });

    frames.send({ t: "roster", agents: [], dead: 3 });
    await expect.poll(() => hostRow(cookie, "titan")).toMatchObject({ spooled_dead: 3 });

    // And a box that drains its spool has to be able to say so.
    frames.send({ t: "roster", agents: [], dead: 0 });
    await expect.poll(() => hostRow(cookie, "titan")).toMatchObject({ spooled_dead: 0 });
  });

  // A report is not an instruction. An unusable value degrades to "not
  // reported"; costing a host its whole connection over a diagnostic field is
  // how one bad roster value took out a fleet before.
  //
  // The barrier matters. Polling for "still null" passes instantly, before the
  // bad frame has even been read, so that version passed with validation
  // removed entirely. Land a good value first, prove the bad frame was applied
  // by watching the roster it carries change, and only then check the count
  // did not move.
  it("keeps the host connected when the count is unusable", async () => {
    const { cookie } = await operator();
    const credentials = await enroll(cookie, "beta");
    const frames = await connect(credentials);
    const agent = (name: string) => ({
      name,
      kind: "omp",
      pane_id: `pane-${name}`,
      status: "idle",
      cwd: "/w",
      title: "t",
      named_by: "user",
    });

    frames.send({ t: "roster", agents: [agent("alice")], dead: 2 });
    await expect.poll(() => hostRow(cookie, "beta")).toMatchObject({ spooled_dead: 2 });

    frames.send({ t: "roster", agents: [agent("alice"), agent("bob")], dead: "lots" });
    // Two agents is the proof this frame was applied, not skipped and not fatal.
    await expect.poll(() => hostRow(cookie, "beta")).toMatchObject({ agent_count: 2 });

    const row = await hostRow(cookie, "beta");
    expect(row).toMatchObject({ connected: true, spooled_dead: 2 });
  });
});
