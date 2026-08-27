import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";

import { DELIVERY_MESSAGE_TYPE, IDENTITY_ENTRY_TYPE, RECEIPT_ENTRY_TYPE, TransitClient } from "./index.js";

const clients = [];
const servers = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.stop();
	for (const server of servers.splice(0)) await server.close();
});

async function waitFor(predicate, description) {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		const result = predicate();
		if (result) return result;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function createAgentSocket() {
	const directory = await mkdtemp(path.join(tmpdir(), "transit-omp-extension-"));
	const socketPath = path.join(directory, "agent.sock");
	const frames = [];
	let peer;
	let buffer = "";

	const server = net.createServer(socket => {
		peer = socket;
		socket.on("data", chunk => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line) frames.push(JSON.parse(line));
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	const fixture = {
		socketPath,
		frames,
		send(frame) {
			if (!peer) throw new Error("client has not connected");
			peer.write(`${JSON.stringify(frame)}\n`);
		},
		async close() {
			peer?.destroy();
			await new Promise(resolve => server.close(resolve));
			await rm(directory, { recursive: true, force: true });
		},
	};
	servers.push(fixture);
	return fixture;
}

function createContext(branch = [], withOmpTimers = true) {
	const context = {
		cwd: "/workspace/project",
		sessionManager: {
			getSessionId: () => "omp-session-123",
			getBranch: () => branch,
		},
	};
	if (withOmpTimers) {
		context.setTimeout = setTimeout;
		context.clearTimer = timer => {
			clearTimeout(timer);
			clearInterval(timer);
		};
	}
	return context;
}

async function connectClient({ pi, branch, harness = "omp", withOmpTimers = true, env = {} } = {}) {
	const agent = await createAgentSocket();
	const client = new TransitClient({
		pi:
			pi ?? {
				sendMessage: () => {},
				appendEntry: () => {},
			},
		ctx: createContext(branch, withOmpTimers),
		harness,
		socketPath: agent.socketPath,
		env,
	});
	clients.push(client);
	client.start();
	const register = await waitFor(() => agent.frames.find(frame => frame.t === "register"), "register frame");
	return { agent, client, register };
}

async function register(agent) {
	agent.send({
		t: "registered",
		agent: "omp-test",
		address: "omp-test@titan",
		generation: 1,
		capability: "0123456789abcdef0123456789abcdef",
	});
}

test("registers the OMP session with the transit-agent/1 shape", async () => {
	const { agent, register: frame } = await connectClient();

	expect(frame).toEqual({
		t: "register",
		proto: 1,
		harness: "omp",
		session_id: "omp-session-123",
		pid: process.pid,
		cwd: "/workspace/project",
		status: "idle",
	});
	await register(agent);
});

test("includes the running Herdr pane only when HERDR_PANE_ID is set", async () => {
	const withPane = await connectClient({ env: { HERDR_PANE_ID: "titan:pane-1" } });
	expect(withPane.register.pane_id).toBe("titan:pane-1");
	await register(withPane.agent);

	const withoutPane = await connectClient({ env: { HERDR_PANE_ID: "  " } });
	expect(withoutPane.register).not.toHaveProperty("pane_id");
	await register(withoutPane.agent);
});

test("registers a standalone Pi session without OMP timer helpers", async () => {
	const { agent, register: frame } = await connectClient({ harness: "pi", withOmpTimers: false });

	expect(frame.harness).toBe("pi");
	expect(frame.session_id).toBe("omp-session-123");
	await register(agent);
});

test("acks only after the receipt write resolves", async () => {
	const sent = [];
	let resolveReceipt;
	const receiptWrite = new Promise(resolve => {
		resolveReceipt = resolve;
	});
	const { agent } = await connectClient({
		pi: {
			sendMessage: async (...args) => {
				sent.push(args);
			},
			appendEntry: () => receiptWrite,
		},
	});
	await register(agent);

	agent.send({ t: "deliver", id: "tx-delivery-1", envelope: "<transit id=\"tx-delivery-1\"/>" });
	await waitFor(() => sent.length === 1, "injection call");
	expect(sent).toEqual([[
		{ customType: DELIVERY_MESSAGE_TYPE, content: "<transit id=\"tx-delivery-1\"/>", display: true, details: { id: "tx-delivery-1" } },
		{ deliverAs: "nextTurn", triggerTurn: true },
	]]);
	expect(agent.frames.find(frame => frame.t === "deliver_ack")).toBeUndefined();

	resolveReceipt();
	const ack = await waitFor(() => agent.frames.find(frame => frame.t === "deliver_ack"), "delivery acknowledgement");
	expect(ack).toEqual({
		t: "deliver_ack",
		id: "tx-delivery-1",
		persisted: true,
		capability: "0123456789abcdef0123456789abcdef",
	});
});

test("returns a retryable NAK when persisting a receipt fails", async () => {
	const sent = [];
	const { agent } = await connectClient({
		pi: {
			sendMessage: async (...args) => {
				sent.push(args);
			},
			appendEntry: () => {
				throw new Error("disk full");
			},
		},
	});
	await register(agent);

	agent.send({ t: "deliver", id: "tx-delivery-2", envelope: "receipt failure" });
	const nak = await waitFor(() => agent.frames.find(frame => frame.t === "deliver_nak"), "delivery NAK");
	expect(sent).toEqual([[
		{ customType: DELIVERY_MESSAGE_TYPE, content: "receipt failure", display: true, details: { id: "tx-delivery-2" } },
		{ deliverAs: "nextTurn", triggerTurn: true },
	]]);
	expect(nak).toEqual({
		t: "deliver_nak",
		id: "tx-delivery-2",
		code: "receipt_write_failed",
		retryable: true,
		capability: "0123456789abcdef0123456789abcdef",
	});
});

test("re-acks a receipt found on the resumed session branch without injecting it", async () => {
	const sent = [];
	const { agent } = await connectClient({
		branch: [{ type: "custom", customType: RECEIPT_ENTRY_TYPE, data: { id: "tx-received" } }],
		pi: {
			sendMessage: async (...args) => {
				sent.push(args);
			},
			appendEntry: () => {
				throw new Error("should not write another receipt");
			},
		},
	});
	await register(agent);

	agent.send({ t: "deliver", id: "tx-received", envelope: "already delivered" });
	const ack = await waitFor(() => agent.frames.find(frame => frame.t === "deliver_ack"), "resumed acknowledgement");
	expect(sent).toEqual([]);
	expect(ack.id).toBe("tx-received");
});

test("stores the identity token the daemon issues on the session branch", async () => {
	const entries = [];
	const { agent } = await connectClient({
		pi: {
			sendMessage: () => {},
			appendEntry: (type, data) => {
				entries.push([type, data]);
			},
		},
	});
	agent.send({
		t: "registered",
		agent: "omp-test",
		address: "omp-test@titan",
		generation: 1,
		capability: "0123456789abcdef0123456789abcdef",
		agent_token: "fedcba9876543210fedcba9876543210",
	});

	await waitFor(() => entries.length === 1, "identity entry write");
	expect(entries).toEqual([[IDENTITY_ENTRY_TYPE, { token: "fedcba9876543210fedcba9876543210" }]]);
});

// The branch survives a `--resume`, the session id does not. Re-presenting the
// token is what keeps a resumed agent at the same address.
test("re-presents the identity token found on the resumed session branch", async () => {
	const { register: frame } = await connectClient({
		branch: [
			{ type: "custom", customType: IDENTITY_ENTRY_TYPE, data: { token: "aaaabbbbccccddddeeeeffff00001111" } },
			{ type: "custom", customType: IDENTITY_ENTRY_TYPE, data: { token: "1111000feeeeddddccccbbbbaaaa2222" } },
		],
	});

	expect(frame.agent_token).toBe("1111000feeeeddddccccbbbbaaaa2222");
});

// A harness the extension has never heard of is the daemon's business, not
// this constructor's: refusing here put the allowlist back one layer up.
test("registers a harness the extension does not know", async () => {
	const { agent, register: frame } = await connectClient({ harness: "acme-cli", withOmpTimers: false });

	expect(frame.harness).toBe("acme-cli");
	await register(agent);
});

// The regression this whole change exists for. `deliverAs: "steer"` put the
// envelope in OMP's editable pending-message UI — the buffer a person types
// into — and an arriving delivery discarded whatever draft was there. Any mode
// but "nextTurn" is that bug, and any call to sendUserMessage is that bug
// reached by another route, so both are asserted.
test("keeps a delivery out of the editable composer and still wakes an idle agent", async () => {
	const calls = [];
	const { agent } = await connectClient({
		pi: {
			sendMessage: (message, options) => calls.push(["sendMessage", message, options]),
			sendUserMessage: (content, options) => calls.push(["sendUserMessage", content, options]),
			appendEntry: () => {},
		},
	});
	await register(agent);

	agent.send({ t: "deliver", id: "tx-quiet-1", envelope: "<transit id=\"tx-quiet-1\"/>" });
	await waitFor(() => calls.length === 1, "an injection call");
	await waitFor(() => agent.frames.find(frame => frame.t === "deliver_ack"), "delivery acknowledgement");

	const [api, message, options] = calls[0];
	expect(api).toBe("sendMessage");
	expect(options.deliverAs).toBe("nextTurn");
	// Quiet must not become never delivered: an idle session only starts a turn
	// on a hidden message when triggerTurn is set.
	expect(options.triggerTurn).toBe(true);
	// Attribution stays OMP's "agent" default. Attributing to "user" makes the
	// message user-restorable, which puts the envelope back in the composer on
	// a queue clear or a dequeue — the clobber, one keystroke later.
	expect(message.attribution).toBeUndefined();
	expect(calls).toHaveLength(1);
});

// A build without the hidden delivery mode must fail visibly rather than
// silently fall back to the composer. Not retryable: retrying cannot make an
// older OMP grow the API, and the dead entry names the real problem.
test("naks without retry when the harness cannot deliver out of the composer", async () => {
	const { agent } = await connectClient({
		pi: {
			sendUserMessage: () => {},
			appendEntry: () => {
				throw new Error("no receipt should be written for an undeliverable message");
			},
		},
	});
	await register(agent);

	agent.send({ t: "deliver", id: "tx-quiet-2", envelope: "<transit id=\"tx-quiet-2\"/>" });
	const nak = await waitFor(() => agent.frames.find(frame => frame.t === "deliver_nak"), "delivery NAK");
	expect(nak).toEqual({
		t: "deliver_nak",
		id: "tx-quiet-2",
		code: "send_message_unsupported",
		retryable: false,
		capability: "0123456789abcdef0123456789abcdef",
	});
});
