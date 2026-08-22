import {
  CONNECTOR_API,
  hmacSign,
  type Connector,
  type ConnectorCtx,
  type ConnectorEvent,
  type ReplyRequest,
} from "transit-connector-kit";

function prefixes(config: Record<string, string>): string[] {
  try {
    const parsed = JSON.parse(config.reply_url_prefixes || "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function allowedReplyURL(
  value: string | undefined,
  allowedPrefixes: string[],
): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    !allowedPrefixes.some((prefix) => value.startsWith(prefix))
  ) {
    return null;
  }
  return value;
}

function replyDestination(ctx: ConnectorCtx, event: ConnectorEvent): string | null {
  return allowedReplyURL(
    event.meta?.reply_url || ctx.config.reply_url,
    prefixes(ctx.config),
  );
}

async function postReply(ctx: ConnectorCtx, request: ReplyRequest): Promise<void> {
  const destination = replyDestination(ctx, request.event);
  if (!destination) {
    throw new Error(`${ctx.config.source} has no permitted reply destination`);
  }
  const body = JSON.stringify({
    schema: "transit.ingest/1",
    kind: "reply",
    source: ctx.config.source,
    conversation_id: request.conversationId,
    event_key: request.event.eventKey,
    delivery_id: request.deliveryId,
    agent: request.agent,
    message: request.message,
    ...(request.event.user ? { user: request.event.user } : {}),
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = await hmacSign(
    ctx.config.secret ?? "",
    `${timestamp}.${body}`,
  );
  const response = await ctx.fetch(destination, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Transit-Timestamp": timestamp,
      "Transit-Signature": `v1=${signature}`,
    },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`callback failed (${response.status})`);
  }
}

const ingest = {
  api: CONNECTOR_API,
  name: "ingest",
  mode: "webhook",
  configFields: [
    { key: "source", label: "Source", required: true },
    { key: "secret", label: "Signing secret", secret: true, required: true },
    { key: "reply_url", label: "Default reply URL" },
    { key: "reply_url_prefixes", label: "Reply URL prefixes", required: true },
    { key: "instructions", label: "Agent instructions" },
  ],
  canReply: (ctx: ConnectorCtx, event: ConnectorEvent) =>
    replyDestination(ctx, event) !== null,
  postReply,
} satisfies Connector;

export default ingest;
