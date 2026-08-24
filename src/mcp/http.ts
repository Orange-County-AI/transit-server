import { callTool } from "./dispatch";
import {
  type McpPrincipal,
  type McpSessionReader,
  resolvePrincipal,
} from "./principal";
import { MCP_INSTRUCTIONS, TRANSIT_TOOLS } from "./tools";

/**
 * Streamable HTTP MCP, stateless.
 *
 * Nothing about a caller survives a request. There is no `Mcp-Session-Id`, no
 * stored `initialize` result, and no SSE stream to hold open: every tool
 * Transit exposes is single-shot, and identity arrives on each request in the
 * `Authorization` header rather than being established by a handshake. That is
 * what lets this run in a Worker with no session store behind it, and it is
 * also the direction the 2026-07-28 spec took — which retires the handshake and
 * the session header outright.
 *
 * `initialize` is still answered, because clients older than that revision open
 * with one, but answering it writes nothing down.
 */

/** Revisions this server will speak. All of them work statelessly here. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2026-07-28",
];

/**
 * Answer to a client that asked for a revision we do not know. The spec has the
 * server name one it supports rather than echo an unknown string back.
 */
const PREFERRED_PROTOCOL_VERSION = "2025-06-18";

/** The Worker carries no build stamp, so this is the tool surface's revision. */
const SERVER_VERSION = "1";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export type McpEndpointOptions = {
  /**
   * The `WWW-Authenticate` challenge for an unauthenticated request. Claude's
   * connector discovery starts from this header on a 401 and ignores it on any
   * other status, so the 401 is load-bearing, not cosmetic.
   */
  challenge: (request: Request) => string;
  /**
   * Reads a Better Auth `mcp` access token. Supplied by the caller because it
   * needs the Better Auth instance, which is built from deployment-supplied
   * plugins this module deliberately knows nothing about.
   */
  mcpSession?: McpSessionReader;
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

function argumentsOf(params: unknown): Record<string, unknown> {
  const value = (params as { arguments?: unknown } | undefined)?.arguments;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function negotiateVersion(params: unknown): string {
  const requested = (params as { protocolVersion?: unknown } | undefined)
    ?.protocolVersion;
  return typeof requested === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PREFERRED_PROTOCOL_VERSION;
}

async function handleRequest(
  env: Env,
  principal: McpPrincipal,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  // A JSON-RPC notification has no id and gets no reply, ever — including for
  // errors. `notifications/initialized` is the one every client sends.
  const id = request.id === undefined ? null : request.id;
  const isNotification = request.id === undefined;

  switch (request.method) {
    case "initialize":
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateVersion(request.params),
          capabilities: { tools: {} },
          serverInfo: { name: "transit", version: SERVER_VERSION },
          instructions: MCP_INSTRUCTIONS,
        },
      };
    case "ping":
      return isNotification ? null : { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return isNotification
        ? null
        : { jsonrpc: "2.0", id, result: { tools: TRANSIT_TOOLS } };
    case "tools/call": {
      if (isNotification) return null;
      const name = (request.params as { name?: unknown } | undefined)?.name;
      if (typeof name !== "string") {
        return errorResponse(id, INVALID_PARAMS, "tool name is required");
      }
      const outcome = await callTool(env, principal, name, argumentsOf(request.params));
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: outcome.text }],
          ...(outcome.isError ? { isError: true } : {}),
        },
      };
    }
    default:
      if (isNotification) return null;
      return errorResponse(id, METHOD_NOT_FOUND, `method not found: ${request.method}`);
  }
}

export async function handleMcp(
  env: Env,
  request: Request,
  options: McpEndpointOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    // This server offers no server-initiated stream, and the spec has such a
    // server refuse GET rather than open an empty one.
    return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  }

  // Authenticate before reading the body: an unauthenticated request must
  // answer 401 whatever it was going to ask for.
  const resolution = await resolvePrincipal(env, request.headers, options.mcpSession);
  if (!resolution.ok) {
    if (resolution.reason === "invalid_agent") {
      return json({ error: "invalid_agent", message: resolution.message }, 400);
    }
    return json({ error: "unauthorized" }, 401, {
      "www-authenticate": options.challenge(request),
    });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(errorResponse(null, PARSE_ERROR, "parse error"), 400);
  }

  const batch = Array.isArray(payload);
  const entries: unknown[] = Array.isArray(payload) ? payload : [payload];
  if (batch && entries.length === 0) {
    return json(errorResponse(null, INVALID_REQUEST, "empty batch"), 400);
  }

  const responses: JsonRpcResponse[] = [];
  for (const entry of entries) {
    if (!isRequest(entry)) {
      responses.push(errorResponse(null, INVALID_REQUEST, "invalid request"));
      continue;
    }
    try {
      const response = await handleRequest(env, resolution.principal, entry);
      if (response) responses.push(response);
    } catch (error) {
      if (entry.id !== undefined) {
        responses.push(
          errorResponse(
            entry.id,
            INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  }

  // Every entry was a notification. The spec has that answered with 202 and no
  // body, not with an empty JSON-RPC envelope.
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(batch ? responses : responses[0]);
}
