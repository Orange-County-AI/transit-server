import net from "node:net";
import path from "node:path";

const MAX_FRAME_BYTES = 1024 * 1024;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_PERSISTENCE_POLL_MS = 50;
const DEFAULT_PERSISTENCE_TIMEOUT_MS = 30_000;

export function agentSocketPath(env = process.env) {
	return path.join(env.TRANSIT_DATA_DIR || path.join(env.HOME || "", ".local", "share", "transit"), "agent.sock");
}

export function agentName(env = process.env) {
	for (const key of ["TRANSIT_AGENT_NAME", "WORKSPACE_AGENT_NAME"]) {
		const value = (env[key] ?? "").trim();
		if (value) return value;
	}
	return "";
}

export function deliveryInMessages(messages, id) {
	if (!Array.isArray(messages)) return false;
	return messages.some(message =>
		Array.isArray(message?.parts) &&
		message.parts.some(part => part?.type === "text" && typeof part.text === "string" && part.text.includes(id)),
	);
}

function responseData(result, operation) {
	if (result?.error !== undefined) {
		const message = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
		throw new Error(`${operation}: ${message}`);
	}
	return result?.data ?? result;
}

function errorCode(error, fallback) {
	if (error && typeof error === "object" && typeof error.code === "string") return error.code;
	return fallback;
}

function delay(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export class TransitOpenCodeClient {
	#api;
	#sessionId;
	#cwd;
	#title;
	#socketPath;
	#persistencePollMs;
	#persistenceTimeoutMs;
	#socket;
	#stopped = false;
	#connected = false;
	#capability;
	#frameBuffer = "";
	#reconnectTimer;
	#reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
	#outbound = [];
	#inFlight = new Map();
	#status = "idle";

	constructor({
		api,
		sessionId,
		cwd,
		title = "Transit agent messages",
		status = "idle",
		socketPath = agentSocketPath(),
		persistencePollMs = DEFAULT_PERSISTENCE_POLL_MS,
		persistenceTimeoutMs = DEFAULT_PERSISTENCE_TIMEOUT_MS,
	}) {
		if (!sessionId) throw new Error("OpenCode session id is required");
		this.#api = api;
		this.#sessionId = sessionId;
		this.#cwd = cwd;
		this.#title = title;
		this.#status = status;
		this.#socketPath = socketPath;
		this.#persistencePollMs = persistencePollMs;
		this.#persistenceTimeoutMs = persistenceTimeoutMs;
	}

	start() {
		if (this.#stopped || this.#socket || this.#reconnectTimer) return;
		this.#connect();
	}

	stop() {
		this.#stopped = true;
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = undefined;
		}
		if (this.#socket) {
			this.#socket.destroy();
			this.#socket = undefined;
		}
		this.#connected = false;
		this.#capability = undefined;
	}

	setStatus(status) {
		if (this.#status === status) return;
		this.#status = status;
		this.#queueControl({ t: "status", status });
	}

	#connect() {
		if (this.#stopped || this.#socket) return;
		const socket = net.createConnection({ path: this.#socketPath });
		this.#socket = socket;
		socket.on("connect", () => {
			if (this.#socket !== socket || this.#stopped) return;
			this.#connected = true;
			this.#reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
			this.#write({
				t: "register",
				proto: 1,
				harness: "opencode",
				session_id: this.#sessionId,
				// No `agent_token`: OpenCode's session id is its own durable
				// handle - reopening a session is how you get back to it - so
				// the daemon's session anchor already recovers this identity.
				// A stored token would have to be keyed by something that
				// outlives the process, and the only such key here is that same
				// session id, so it could not recover anything the id does not.
				pid: process.pid,
				cwd: this.#cwd,
				title: this.#title,
				status: this.#status,
				...(agentName() ? { name: agentName() } : {}),
			});
		});
		socket.on("data", chunk => this.#onData(chunk));
		socket.on("error", () => {});
		socket.on("close", () => {
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			this.#connected = false;
			this.#capability = undefined;
			this.#frameBuffer = "";
			if (!this.#stopped) this.#scheduleReconnect();
		});
	}

	#scheduleReconnect() {
		if (this.#stopped || this.#reconnectTimer) return;
		const milliseconds = this.#reconnectDelay;
		this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#connect();
		}, milliseconds);
	}

	#onData(chunk) {
		this.#frameBuffer += chunk.toString("utf8");
		if (this.#frameBuffer.length > MAX_FRAME_BYTES && !this.#frameBuffer.includes("\n")) {
			this.#socket?.destroy();
			return;
		}
		for (;;) {
			const newline = this.#frameBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#frameBuffer.slice(0, newline);
			this.#frameBuffer = this.#frameBuffer.slice(newline + 1);
			if (!line || line.length > MAX_FRAME_BYTES) continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			this.#handleFrame(frame);
		}
	}

	#handleFrame(frame) {
		if (!frame || typeof frame !== "object") return;
		if (frame.t === "registered") {
			if (typeof frame.capability === "string" && frame.capability) {
				this.#capability = frame.capability;
				this.#flushOutbound();
			}
			return;
		}
		if (frame.t === "ping") {
			this.#queueControl({ t: "pong" });
			return;
		}
		if (frame.t === "deliver" && typeof frame.id === "string" && typeof frame.envelope === "string") {
			void this.#deliver(frame.id, frame.envelope);
		}
	}

	async #deliver(id, envelope) {
		const existing = this.#inFlight.get(id);
		if (existing) {
			await existing;
			return;
		}
		const delivery = this.#injectAndConfirm(id, envelope);
		this.#inFlight.set(id, delivery);
		try {
			await delivery;
		} finally {
			this.#inFlight.delete(id);
		}
	}

	async #messagesContain(id) {
		const result = await this.#api.client.session.messages({ sessionID: this.#sessionId });
		return deliveryInMessages(responseData(result, "list OpenCode session messages"), id);
	}

	async #waitUntilPersisted(id) {
		const deadline = Date.now() + this.#persistenceTimeoutMs;
		for (;;) {
			if (await this.#messagesContain(id)) return;
			if (Date.now() >= deadline) {
				const error = new Error(`OpenCode did not persist delivery ${id} before timeout`);
				error.code = "opencode_persistence_timeout";
				throw error;
			}
			await delay(this.#persistencePollMs);
		}
	}

	async #injectAndConfirm(id, envelope) {
		try {
			if (await this.#messagesContain(id)) {
				this.#queueControl({ t: "deliver_ack", id, persisted: true });
				return;
			}
			const result = await this.#api.client.session.promptAsync({
				sessionID: this.#sessionId,
				parts: [{ type: "text", text: envelope }],
			});
			responseData(result, "inject OpenCode session message");
			await this.#waitUntilPersisted(id);
			this.#queueControl({ t: "deliver_ack", id, persisted: true });
		} catch (error) {
			this.#queueControl({
				t: "deliver_nak",
				id,
				code: errorCode(error, "opencode_injection_failed"),
				retryable: true,
			});
		}
	}

	#queueControl(frame) {
		this.#outbound.push(frame);
		this.#flushOutbound();
	}

	#flushOutbound() {
		if (!this.#capability) return;
		while (this.#outbound.length > 0) {
			const frame = { ...this.#outbound[0], capability: this.#capability };
			if (!this.#write(frame)) return;
			this.#outbound.shift();
		}
	}

	#write(frame) {
		if (!this.#connected || !this.#socket || this.#socket.destroyed || !this.#socket.writable) return false;
		try {
			this.#socket.write(`${JSON.stringify(frame)}\n`);
			return true;
		} catch {
			return false;
		}
	}
}

function adapterStatus(status) {
	const kind = typeof status === "string" ? status : status?.type;
	return kind === "idle" ? "idle" : "busy";
}

export async function transitOpenCodePlugin(api) {
	let selectedSessionId;
	let client;

	const syncSelectedSession = () => {
		const route = api.route.current;
		const sessionId = route?.name === "session" ? route.params?.sessionID : undefined;
		const session = typeof sessionId === "string" && sessionId ? api.state.session.get(sessionId) : undefined;
		if (!session || session.parentID) {
			selectedSessionId = undefined;
			client?.stop();
			client = undefined;
			return;
		}
		const status = adapterStatus(api.state.session.status(sessionId));
		if (sessionId !== selectedSessionId) {
			client?.stop();
			selectedSessionId = sessionId;
			client = new TransitOpenCodeClient({
				api,
				sessionId,
				cwd: api.state.path.directory,
				title: session.title || "Transit agent messages",
				status,
			});
			client.start();
			return;
		}
		client?.setStatus(status);
	};

	syncSelectedSession();
	const routePoll = setInterval(syncSelectedSession, 100);
	api.lifecycle.onDispose(() => {
		clearInterval(routePoll);
		client?.stop();
		client = undefined;
	});
}

export default {
	id: "transit-opencode",
	tui: transitOpenCodePlugin,
};
