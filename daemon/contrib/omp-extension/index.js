import net from "node:net";
import path from "node:path";

export const RECEIPT_ENTRY_TYPE = "transit-delivery-receipt";

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
	#inFlight = new Map();
	#status = "idle";

	constructor({ pi, ctx, harness = "omp", socketPath = agentSocketPath(), env = process.env }) {
		if (harness !== "omp" && harness !== "pi") {
			throw new Error(`unsupported Transit extension harness: ${harness}`);
		}
		this.#pi = pi;
		this.#ctx = ctx;
		this.#env = env;
		this.#harness = harness;
		this.#socketPath = socketPath;
		this.#sessionId = ctx.sessionManager.getSessionId();
		this.#receipts = receiptIdsFromBranch(ctx.sessionManager.getBranch());
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
		try {
			// OMP 17.4.2 supports steer on sendUserMessage. Unlike sendMessage,
			// it does not support triggerTurn or nextTurn; an idle user message
			// starts a turn and an active turn queues this as a steer.
			await this.#pi.sendUserMessage(envelope, { deliverAs: "steer" });
		} catch (error) {
			this.#queueControl({
				t: "deliver_nak",
				id,
				code: errorCode(error, "send_user_message_failed"),
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
