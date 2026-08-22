import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";

import { TransitOpenCodeClient } from "./index.js";

const clients = [];
const servers = [];

function waitFor(predicate, description) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 1_000;
		const check = () => {
			const value = predicate();
			if (value) return resolve(value);
			if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${description}`));
			setTimeout(check, 5);
		};
		check();
	});
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.stop();
	for (const server of servers.splice(0)) await server.close();
});

async function createAgentSocket() {
	const directory = await mkdtemp(path.join(tmpdir(), "transit-opencode-plugin-"));
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

function fakeApi({ messages = [], promptAsync } = {}) {
	const prompts = [];
	return {
		prompts,
		messages,
		client: {
			session: {
				messages: async () => ({ data: messages }),
				promptAsync: async input => {
					prompts.push(input);
					return promptAsync ? promptAsync(input) : {};
				},
			},
		},
	};
}

async function connectClient(api) {
	const agent = await createAgentSocket();
	const client = new TransitOpenCodeClient({
		api,
		sessionId: "ses_opencode_123",
		cwd: "/workspace/project",
		socketPath: agent.socketPath,
		persistencePollMs: 5,
		persistenceTimeoutMs: 100,
	});
	clients.push(client);
	client.start();
	const register = await waitFor(() => agent.frames.find(frame => frame.t === "register"), "register frame");
	agent.send({
		t: "registered",
		agent: "opencode-test",
		address: "opencode-test@titan",
		generation: 1,
		capability: "0123456789abcdef0123456789abcdef",
	});
	return { agent, client, register };
}

test("registers the selected OpenCode session", async () => {
	const { register } = await connectClient(fakeApi());
	expect(register).toEqual({
		t: "register",
		proto: 1,
		harness: "opencode",
		session_id: "ses_opencode_123",
		pid: process.pid,
		cwd: "/workspace/project",
		title: "Transit agent messages",
		status: "idle",
	});
});

test("acks only after the delivery appears in OpenCode message history", async () => {
	const api = fakeApi();
	const { agent } = await connectClient(api);
	agent.send({ t: "deliver", id: "tx_opencode_1", envelope: "<transit id=\"tx_opencode_1\"/>" });
	await waitFor(() => api.prompts.length === 1, "OpenCode prompt");
	expect(api.prompts[0]).toEqual({
		sessionID: "ses_opencode_123",
		parts: [{ type: "text", text: "<transit id=\"tx_opencode_1\"/>" }],
	});
	expect(agent.frames.find(frame => frame.t === "deliver_ack")).toBeUndefined();
	api.messages.push({ info: { id: "msg_1" }, parts: [{ type: "text", text: "<transit id=\"tx_opencode_1\"/>" }] });
	const ack = await waitFor(() => agent.frames.find(frame => frame.t === "deliver_ack"), "delivery acknowledgement");
	expect(ack).toEqual({
		t: "deliver_ack",
		id: "tx_opencode_1",
		persisted: true,
		capability: "0123456789abcdef0123456789abcdef",
	});
});

test("re-acks a delivery already persisted in OpenCode without reinjecting it", async () => {
	const api = fakeApi({
		messages: [{ info: { id: "msg_existing" }, parts: [{ type: "text", text: "delivery tx_opencode_existing" }] }],
	});
	const { agent } = await connectClient(api);
	agent.send({ t: "deliver", id: "tx_opencode_existing", envelope: "duplicate" });
	const ack = await waitFor(() => agent.frames.find(frame => frame.t === "deliver_ack"), "duplicate acknowledgement");
	expect(ack.id).toBe("tx_opencode_existing");
	expect(api.prompts).toEqual([]);
});

test("returns a retryable NAK when OpenCode rejects prompt injection", async () => {
	const api = fakeApi({ promptAsync: async () => ({ error: { name: "SessionNotFound" } }) });
	const { agent } = await connectClient(api);
	agent.send({ t: "deliver", id: "tx_opencode_failed", envelope: "failure" });
	const nak = await waitFor(() => agent.frames.find(frame => frame.t === "deliver_nak"), "delivery NAK");
	expect(nak).toEqual({
		t: "deliver_nak",
		id: "tx_opencode_failed",
		code: "opencode_injection_failed",
		retryable: true,
		capability: "0123456789abcdef0123456789abcdef",
	});
});
