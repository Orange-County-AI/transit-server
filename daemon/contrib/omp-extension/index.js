import net from "node:net";
import path from "node:path";

export const RECEIPT_ENTRY_TYPE = "transit-delivery-receipt";
// The daemon issues an identity credential and this session stores it in its
// own branch, which is precisely the thing OMP carries across a `--resume`.
// A resumed session arrives with a new session id and the same branch, so
// re-presenting the token is what keeps the agent's address from changing
// under it. No lineage file, no key to guess, no way for two sessions to
// collide on one.
export const IDENTITY_ENTRY_TYPE = "transit-agent-identity";
// The custom-message type an arriving envelope is injected as. Naming it means
// a transcript and a session branch both say where the entry came from, and a
// renderer can be registered for it later without changing the wire.
export const DELIVERY_MESSAGE_TYPE = "transit-delivery";

const MAX_FRAME_BYTES = 1024 * 1024;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export function agentSocketPath(env = process.env) {
	return path.join(env.TRANSIT_DATA_DIR || path.join(env.HOME || "", ".local", "share", "transit"), "agent.sock");
}

export function receiptIdsFromBranch(branch) {
	const receipts = new Set();
	for (const entry of branch) {
		if (entry?.type !== "custom" || entry.customType !== RECEIPT_ENTRY_TYPE) continue;
		if (typeof entry.data?.id === "string" && entry.data.id.length > 0) {
			receipts.add(entry.data.id);
		}
	}
	return receipts;
}

// The most recent token the daemon issued this lineage. Later entries win: a
// branch that outlived a daemon rebuild carries both.
export function identityTokenFromBranch(branch) {
	let token = "";
	for (const entry of branch) {
		if (entry?.type !== "custom" || entry.customType !== IDENTITY_ENTRY_TYPE) continue;
		if (typeof entry.data?.token === "string" && entry.data.token.length > 0) {
			token = entry.data.token;
		}
	}
	return token;
}

// The address this workspace already publishes, if the launcher set one.
// Empty means "let the daemon choose an auto-name".
export function agentName(env = process.env) {
	for (const key of ["TRANSIT_AGENT_NAME", "WORKSPACE_AGENT_NAME"]) {
		const value = (env[key] ?? "").trim();
		if (value) return value;
	}
	return "";
}

export function agentPaneID(env = process.env) {
	return (env.HERDR_PANE_ID ?? "").trim();
}

function errorCode(error, fallback) {
	if (error && typeof error === "object" && typeof error.code === "string") return error.code;
	return fallback;
}

/**
 * Persistent client for transit-agent/1. It deliberately has no OMP imports so
 * its socket and receipt behavior can be tested outside an OMP process.
 */
export class TransitClient {
	#pi;
	#harness;
	#ctx;
	#env;
	#socketPath;
	#sessionId;
	#socket;
	#stopped = false;
	#connected = false;
	#capability;
	#setTimeout;
	#clearTimer;
	#frameBuffer = "";
	#reconnectTimer;
	#reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
	#outbound = [];
	#receipts;
	#token;
	#inFlight = new Map();
	#status = "idle";

	constructor({ pi, ctx, harness = "omp", socketPath = agentSocketPath(), env = process.env }) {
		this.#pi = pi;
		this.#ctx = ctx;
		this.#env = env;
		this.#harness = harness;
		this.#socketPath = socketPath;
		this.#sessionId = ctx.sessionManager.getSessionId();
		this.#receipts = receiptIdsFromBranch(ctx.sessionManager.getBranch());
		this.#token = identityTokenFromBranch(ctx.sessionManager.getBranch());
		this.#setTimeout = typeof ctx.setTimeout === "function" ? ctx.setTimeout.bind(ctx) : setTimeout;
		this.#clearTimer = typeof ctx.clearTimer === "function" ? ctx.clearTimer.bind(ctx) : clearTimeout;
	}

	start() {
		if (this.#stopped || this.#socket || this.#reconnectTimer) return;
		this.#connect();
	}

	stop() {
		this.#stopped = true;
		if (this.#reconnectTimer) {
			this.#clearTimer(this.#reconnectTimer);
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
			const name = agentName(this.#env);
			const paneID = agentPaneID(this.#env);
			this.#write({
				t: "register",
				proto: 1,
				harness: this.#harness,
				session_id: this.#sessionId,
				pid: process.pid,
				cwd: this.#ctx.cwd,
				status: this.#status,
				// Claim the address this workspace already publishes. Without it
				// the daemon mints a fresh auto-name and this session registers
				// alongside its own Herdr entry instead of superseding it.
				...(name ? { name } : {}),
				...(paneID ? { pane_id: paneID } : {}),
				// Without a declared name this is the only thing that keeps the
				// address stable across a resume, which mints a new session id.
				...(this.#token ? { agent_token: this.#token } : {}),
			});
		});
		socket.on("data", chunk => this.#onData(chunk));
		// A failed connect emits error before close; keeping an error listener makes
		// the bounded close/reconnect path responsible for recovery.
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
		const delay = this.#reconnectDelay;
		this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
		this.#reconnectTimer = this.#setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#connect();
		}, delay);
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
			if (line.length === 0 || line.length > MAX_FRAME_BYTES) continue;
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
			if (typeof frame.agent_token === "string" && frame.agent_token.length > 0) {
				void this.#rememberToken(frame.agent_token);
			}
			if (typeof frame.capability === "string" && frame.capability.length > 0) {
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
		// Unknown frames are intentionally ignored for protocol forward compatibility.
	}

	// A token is written to the branch once. Failing to persist it costs this
	// lineage its stable address on the next resume, and nothing else, so it
	// must never take the registration down with it.
	async #rememberToken(token) {
		if (this.#token === token) return;
		this.#token = token;
		try {
			await this.#pi.appendEntry(IDENTITY_ENTRY_TYPE, { token });
		} catch {
			// Left in memory: this connection keeps the identity, the next one
			// falls back to the session id.
		}
	}

	async #deliver(id, envelope) {
		if (this.#receipts.has(id)) {
			this.#queueControl({ t: "deliver_ack", id, persisted: true });
			return;
		}

		const existing = this.#inFlight.get(id);
		if (existing) {
			await existing;
			return;
		}

		const delivery = this.#injectAndReceipt(id, envelope);
		this.#inFlight.set(id, delivery);
		try {
			await delivery;
		} finally {
			this.#inFlight.delete(id);
		}
	}

	async #injectAndReceipt(id, envelope) {
		// Refusing is the point. `sendUserMessage` is the API that ate a
		// person's draft, so a build without `sendMessage` must fail loudly
		// rather than quietly fall back to the thing being fixed. Not
		// retryable: retrying cannot make an older OMP grow the API, and a
		// dead entry with this code names the real problem.
		if (typeof this.#pi.sendMessage !== "function") {
			this.#queueControl({ t: "deliver_nak", id, code: "send_message_unsupported", retryable: false });
			return;
		}

		try {
			// `sendUserMessage(..., { deliverAs: "steer" })` put the envelope
			// in the EDITABLE pending-message UI — the same buffer the person
			// is typing into — and an arriving delivery discarded whatever
			// draft was there. `deliverAs: "nextTurn"` is the only mode OMP
			// documents as keeping a message "hidden from the editable
			// pending-message UI" (`sendMessage` in the installed
			// extensibility/extensions/types.d.ts), and only `sendMessage`
			// accepts it: `sendUserMessage` takes "steer"|"followUp" and
			// nothing else, so it can never be quiet.
			//
			// `triggerTurn` is what keeps quiet from becoming never delivered.
			// Without it a hidden message is appended and waits for whatever
			// starts the next turn, which on an idle agent is a human typing —
			// so a fleet agent nobody is watching would never act on its mail.
			// With it, an idle session starts a turn on the delivery, and a
			// streaming one consumes it when the current turn unwinds.
			//
			// Attribution stays OMP's default of "agent" on purpose. A custom
			// message attributed to "user" is user-restorable, so clearing or
			// dequeuing the queue would put this envelope back into the
			// composer — reintroducing exactly the clobber being fixed.
			// `display: true` keeps the delivery visible in the transcript,
			// which is where it was visible before.
			await this.#pi.sendMessage(
				{ customType: DELIVERY_MESSAGE_TYPE, content: envelope, display: true, details: { id } },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
		} catch (error) {
			this.#queueControl({
				t: "deliver_nak",
				id,
				code: errorCode(error, "send_message_failed"),
				retryable: true,
			});
			return;
		}

		try {
			// appendEntry is synchronous in OMP 17.4.2. Awaiting also makes this
			// ordering explicit and supports test doubles that model async disk I/O.
			await this.#pi.appendEntry(RECEIPT_ENTRY_TYPE, { id });
			this.#receipts.add(id);
			this.#queueControl({ t: "deliver_ack", id, persisted: true });
		} catch (error) {
			this.#queueControl({
				t: "deliver_nak",
				id,
				code: errorCode(error, "receipt_write_failed"),
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

export function transitExtension(harness) {
	return function transitNativeExtension(pi) {
		let client;

		pi.on("session_start", (_event, ctx) => {
			client?.stop();
			client = new TransitClient({ pi, ctx, harness });
			client.start();
		});
		pi.on("turn_start", () => client?.setStatus("busy"));
		pi.on("turn_end", () => client?.setStatus("idle"));
		pi.on("session_shutdown", () => {
			client?.stop();
			client = undefined;
		});
	};
}

export const transitOmpExtension = transitExtension("omp");

export default transitOmpExtension;
