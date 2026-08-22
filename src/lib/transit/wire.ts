export const MAX_WIRE_FRAME_BYTES = 1024 * 1024;
export const TRANSIT_WIRE_PROTO = 1;

export type RosterAgent = {
  name: string;
  kind: string;
  pane_id: string;
  status: string;
  cwd: string;
  title: string;
  named_by: "user" | "auto";
};

export type SendNakCode =
  | "no_route"
  | "not_member"
  | "body_too_large"
  | "reserved_name"
  | "rate_limited"
  | "plan_limit";

export type DaemonFrame =
  | { t: "hello"; proto: 1; daemon_ver: string; host: string }
  | { t: "roster"; agents: RosterAgent[] }
  | { t: "send"; id: string; from: string; to: string; body: string; reply_to?: string; ts: string }
  // `agent` echoes the recipient of the `deliver` frame being settled so the
  // Worker can keep delivery bookkeeping per recipient. An older daemon omits
  // it; the Worker then falls back to the oldest queued entry for the id.
  | { t: "deliver_ack"; id: string; agent?: string }
  | { t: "deliver_nak"; id: string; code: string; retryable: boolean; agent?: string }
  | { t: "rpc"; rid: string; method: string; params: Record<string, unknown> }
  | { t: "pong" };

export type WorkerFrame =
  | { t: "hello_ok"; host_id: string; org: string }
  | { t: "hello_err"; code: string }
  | { t: "deliver"; id: string; agent: string; envelope: string }
  | { t: "send_ack"; id: string }
  | { t: "send_nak"; id: string; code: SendNakCode }
  | { t: "rpc_result"; rid: string; result?: unknown; error?: unknown }
  | { t: "ping" };

export class WireError extends Error {
  constructor(
    message: string,
    readonly code: "frame_too_large" | "invalid_json" | "invalid_frame",
  ) {
    super(message);
    this.name = "WireError";
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(frame: JsonObject, key: string): string {
  const value = frame[key];
  if (typeof value !== "string") {
    throw new WireError(`${key} must be a string`, "invalid_frame");
  }
  return value;
}

function booleanField(frame: JsonObject, key: string): boolean {
  const value = frame[key];
  if (typeof value !== "boolean") {
    throw new WireError(`${key} must be a boolean`, "invalid_frame");
  }
  return value;
}

function optionalStringField(frame: JsonObject, key: string): string | undefined {
  const value = frame[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WireError(`${key} must be a string`, "invalid_frame");
  }
  return value;
}

function parseJsonFrame(raw: string): JsonObject {
  if (new TextEncoder().encode(raw).byteLength > MAX_WIRE_FRAME_BYTES) {
    throw new WireError("wire frame exceeds 1 MiB", "frame_too_large");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WireError("wire frame is not valid JSON", "invalid_json");
  }
  if (!isObject(value) || typeof value.t !== "string") {
    throw new WireError("wire frame must be an object with string t", "invalid_frame");
  }
  return value;
}

function rosterAgent(value: unknown): RosterAgent {
  if (!isObject(value)) {
    throw new WireError("roster agent must be an object", "invalid_frame");
  }
  const namedBy = stringField(value, "named_by");
  if (namedBy !== "user" && namedBy !== "auto") {
    throw new WireError("named_by must be user or auto", "invalid_frame");
  }
  return {
    name: stringField(value, "name"),
    kind: stringField(value, "kind"),
    pane_id: stringField(value, "pane_id"),
    status: stringField(value, "status"),
    cwd: stringField(value, "cwd"),
    title: stringField(value, "title"),
    named_by: namedBy,
  };
}

function sendNakCode(value: string): SendNakCode {
  switch (value) {
    case "no_route":
    case "not_member":
    case "body_too_large":
    case "reserved_name":
    case "rate_limited":
    case "plan_limit":
      return value;
    default:
      throw new WireError("unknown send_nak code", "invalid_frame");
  }
}

export function decodeDaemonFrame(raw: string): DaemonFrame | null {
  const frame = parseJsonFrame(raw);
  switch (frame.t) {
    case "hello": {
      if (frame.proto !== TRANSIT_WIRE_PROTO) {
        throw new WireError("unsupported wire protocol", "invalid_frame");
      }
      return {
        t: "hello",
        proto: TRANSIT_WIRE_PROTO,
        daemon_ver: stringField(frame, "daemon_ver"),
        host: stringField(frame, "host"),
      };
    }
    case "roster": {
      // A host with no agents is a normal state, and Go's `omitempty` drops the
      // empty array rather than sending `[]`, so an absent `agents` is a roster
      // of none - not a malformed frame. Rejecting it closed the whole host
      // connection with 4002 the moment its last agent exited, which stranded a
      // workspace whose only session had not been restarted yet.
      if (frame.agents === undefined || frame.agents === null) {
        return { t: "roster", agents: [] };
      }
      if (!Array.isArray(frame.agents)) {
        throw new WireError("agents must be an array", "invalid_frame");
      }
      return { t: "roster", agents: frame.agents.map(rosterAgent) };
    }
    case "send": {
      const replyTo = optionalStringField(frame, "reply_to");
      return {
        t: "send",
        id: stringField(frame, "id"),
        from: stringField(frame, "from"),
        to: stringField(frame, "to"),
        body: stringField(frame, "body"),
        ...(replyTo === undefined ? {} : { reply_to: replyTo }),
        ts: stringField(frame, "ts"),
      };
    }
    case "deliver_ack": {
      const agent = optionalStringField(frame, "agent");
      return {
        t: "deliver_ack",
        id: stringField(frame, "id"),
        ...(agent === undefined ? {} : { agent }),
      };
    }
    case "deliver_nak": {
      const agent = optionalStringField(frame, "agent");
      return {
        t: "deliver_nak",
        id: stringField(frame, "id"),
        code: stringField(frame, "code"),
        retryable: booleanField(frame, "retryable"),
        ...(agent === undefined ? {} : { agent }),
      };
    }
    case "rpc": {
      if (!isObject(frame.params)) {
        throw new WireError("rpc params must be an object", "invalid_frame");
      }
      return {
        t: "rpc",
        rid: stringField(frame, "rid"),
        method: stringField(frame, "method"),
        params: frame.params,
      };
    }
    case "pong":
      return { t: "pong" };
    default:
      return null;
  }
}

export function decodeWorkerFrame(raw: string): WorkerFrame | null {
  const frame = parseJsonFrame(raw);
  switch (frame.t) {
    case "hello_ok":
      return {
        t: "hello_ok",
        host_id: stringField(frame, "host_id"),
        org: stringField(frame, "org"),
      };
    case "hello_err":
      return { t: "hello_err", code: stringField(frame, "code") };
    case "deliver":
      return {
        t: "deliver",
        id: stringField(frame, "id"),
        agent: stringField(frame, "agent"),
        envelope: stringField(frame, "envelope"),
      };
    case "send_ack":
      return { t: "send_ack", id: stringField(frame, "id") };
    case "send_nak":
      return {
        t: "send_nak",
        id: stringField(frame, "id"),
        code: sendNakCode(stringField(frame, "code")),
      };
    case "rpc_result": {
      const result: WorkerFrame = { t: "rpc_result", rid: stringField(frame, "rid") };
      if ("result" in frame) result.result = frame.result;
      if ("error" in frame) result.error = frame.error;
      return result;
    }
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
}
