const MAX_BODY_RUNES = 4_000;
const MAX_PREVIEW_RUNES = 100;
const MAX_USER_RUNES = 64;
const EMPTY_PREVIEW = "(no text — attachments or an empty body)";
const CHANNEL_HINT = '<reply read="read_message" settle="chat_reply|mark_handled"/>';
const FULL_SETTLE_HINT = '<settle tool="chat_reply|mark_handled"/>';
const FULL_SETTLED_HINT = '<settle state="done"/>';
const REDELIVERY_READ = "do not reply twice; chat_reply or mark_handled";
const REDELIVERY_UNREAD = "already replied? mark_handled; otherwise read_message";

export type DirectEnvelope = {
  from: string;
  id: string;
  ts: string;
  kind: "dm";
  body: string;
  replyTo?: string;
  replyTarget?: string;
};

export type RoomEnvelope = {
  from: string;
  id: string;
  ts: string;
  kind: "room";
  room: string;
  seq: number;
  body: string;
  replyTo?: string;
  replyTarget?: string;
};

export type ChannelEnvelope = {
  from: string;
  id: string;
  ts: string;
  kind: "channel";
  body: string;
  conversationId: string;
  connector: string;
  user?: string;
  trigger?: string;
  redelivery?: number;
  read?: boolean;
};

export type EnvelopeMessage = DirectEnvelope | RoomEnvelope | ChannelEnvelope;

export type FullEnvelopeMessage = {
  id: string;
  conversationId: string;
  user?: string;
  connector: string;
  status: string;
  firstRead: boolean;
  settled: boolean;
  body: string;
  instructions?: string;
};

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clipRunes(value: string, limit: number): { value: string; clipped: boolean } {
  const runes = Array.from(value);
  if (runes.length <= limit) return { value, clipped: false };
  return { value: runes.slice(0, limit).join(""), clipped: true };
}

// Bodies are peer or user data and are the one field an attacker controls, so
// Transit's own vocabulary is disarmed by escaping the leading `<`. Deliberately
// narrow: `<div>`, generics and JSX survive, and an envelope quoted in a message
// still reads as `&lt;transit`. Without this a body can render a well-formed
// `<reply/>` or `<settle/>` line indistinguishable from the real hint.
const ENVELOPE_VOCABULARY = /<(\/?)(transit(?:_full)?|reply|redelivery|settle)\b/giu;

function neutralizeBody(value: string): string {
  return value.replace(ENVELOPE_VOCABULARY, "&lt;$1$2");
}

function channelPreview(value: string): string {
  const flattened = value.replace(/<[^>]*>/gu, " ").trim().replace(/\s+/gu, " ");
  if (!flattened) return EMPTY_PREVIEW;
  return clipRunes(flattened, MAX_PREVIEW_RUNES).value;
}

function renderAttributes(attributes: [string, string][]): string {
  return attributes
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
    .join(" ");
}

function openingTag(attributes: [string, string][]): string {
  return `<transit ${renderAttributes(attributes)}>`;
}

function selfClosing(name: string, attributes: [string, string][]): string {
  return `<${name} ${renderAttributes(attributes)}/>`;
}

export function renderEnvelope(message: EnvelopeMessage): string {
  const attributes: [string, string][] = [
    ["from", message.from],
    ["id", message.id],
    ["ts", message.ts],
    ["kind", message.kind],
  ];

  if (message.kind === "room") {
    attributes.push(["room", message.room], ["seq", String(message.seq)]);
  }
  if (message.kind !== "channel" && message.replyTo) {
    attributes.push(["reply_to", message.replyTo]);
  }

  let body: string;
  let hint: string;
  let statusNote: string | undefined;

  if (message.kind === "channel") {
    const redelivery = Math.max(0, message.redelivery ?? 0);
    attributes.push(
      ["conversation_id", message.conversationId],
      ["connector", message.connector],
      ["user", clipRunes(message.user || "unknown", MAX_USER_RUNES).value],
      ["redelivery", String(redelivery)],
    );
    if (message.trigger) attributes.push(["trigger", message.trigger]);
    body = channelPreview(message.body);
    hint = CHANNEL_HINT;
    if (redelivery > 0) {
      statusNote = message.read
        ? `<redelivery state="read">${REDELIVERY_READ}</redelivery>`
        : `<redelivery state="unread">${REDELIVERY_UNREAD}</redelivery>`;
    }
  } else {
    const clipped = clipRunes(neutralizeBody(message.body), MAX_BODY_RUNES);
    body = clipped.value;
    hint = selfClosing("reply", [
      ["tool", "send_message"],
      ["to", message.replyTarget ?? message.from],
      ["reply_to", message.id],
    ]);
    if (clipped.clipped) attributes.push(["truncated", "1"]);
  }

  attributes.push(["schema", "transit/1"]);
  return [openingTag(attributes), body, hint, statusNote, "</transit>"]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function renderFull(message: FullEnvelopeMessage): string {
  const attributes: [string, string][] = [
    ["id", message.id],
    ["conversation_id", message.conversationId],
    ["user", message.user || "unknown"],
    ["connector", message.connector],
    ["status", message.status],
    ["read", message.firstRead ? "first" : "again"],
    ["schema", "transit/1"],
  ];
  const footer = message.settled ? FULL_SETTLED_HINT : FULL_SETTLE_HINT;
  const lines = [
    `<transit_full ${renderAttributes(attributes)}>`,
    neutralizeBody(message.body),
    footer,
  ];
  if (message.instructions) lines.push(message.instructions);
  lines.push("</transit_full>");
  return lines.join("\n");
}
