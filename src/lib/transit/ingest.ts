import type { ConnectorEvent } from "transit-connector-kit";
import { allowedReplyURL } from "../../connectors/ingest";

export const MAX_INGEST_BYTES = 262_144;
export const INGEST_TIMESTAMP_SKEW_SECONDS = 300;
const textEncoder = new TextEncoder();

export type IngestBody = {
  schema?: unknown;
  event_key?: unknown;
  conversation_id?: unknown;
  user?: unknown;
  trigger?: unknown;
  content?: unknown;
  reply_url?: unknown;
  meta?: unknown;
};

function codePoints(value: string): number {
  return Array.from(value).length;
}

function requiredBoundedString(
  value: unknown,
  name: string,
  max: number,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${name} must be 1-${max} characters`);
  }
  return value;
}

export function validateIngestBody(
  raw: unknown,
  replyURLPrefixes: string[],
): ConnectorEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("body must be an object");
  }
  const body = raw as IngestBody;
  if (body.schema !== "transit.ingest/1") {
    throw new Error("schema must be transit.ingest/1");
  }
  const eventKey = requiredBoundedString(body.event_key, "event_key", 200);
  const conversationId = requiredBoundedString(
    body.conversation_id,
    "conversation_id",
    200,
  );
  if (typeof body.content !== "string") {
    throw new Error("content must be 1-65536 bytes");
  }
  const contentBytes = textEncoder.encode(body.content).byteLength;
  if (contentBytes < 1 || contentBytes > 65_536) {
    throw new Error("content must be 1-65536 bytes");
  }
  if (
    body.user !== undefined &&
    (typeof body.user !== "string" || codePoints(body.user) > 200)
  ) {
    throw new Error("user must be at most 200 code points");
  }
  if (
    body.trigger !== undefined &&
    (typeof body.trigger !== "string" || codePoints(body.trigger) > 32)
  ) {
    throw new Error("trigger must be at most 32 code points");
  }

  const meta: Record<string, string> = {};
  if (body.meta !== undefined) {
    if (!body.meta || typeof body.meta !== "object" || Array.isArray(body.meta)) {
      throw new Error("meta must be an object");
    }
    const entries = Object.entries(body.meta);
    if (entries.length > 32) throw new Error("meta has more than 32 entries");
    for (const [key, value] of entries) {
      if (key === "trigger") throw new Error("meta.trigger is reserved");
      if (key.length > 64) throw new Error("meta key exceeds 64 characters");
      if (typeof value !== "string" || value.length > 1_024) {
        throw new Error("meta values must be strings up to 1024 characters");
      }
      meta[key] = value;
    }
  }

  if (body.reply_url !== undefined) {
    if (
      typeof body.reply_url !== "string" ||
      body.reply_url.length > 2_048 ||
      !allowedReplyURL(body.reply_url, replyURLPrefixes)
    ) {
      throw new Error("reply_url is not permitted");
    }
    meta.reply_url = body.reply_url;
  }

  return {
    eventKey,
    conversationId,
    content: body.content,
    ...(typeof body.user === "string" ? { user: body.user } : {}),
    ...(typeof body.trigger === "string" ? { trigger: body.trigger } : {}),
    meta,
  };
}

export function parseReplyPrefixes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function signedIngestPayload(
  timestamp: string,
  body: Uint8Array,
): Uint8Array {
  const prefix = textEncoder.encode(`${timestamp}.`);
  const payload = new Uint8Array(prefix.byteLength + body.byteLength);
  payload.set(prefix);
  payload.set(body, prefix.byteLength);
  return payload;
}
