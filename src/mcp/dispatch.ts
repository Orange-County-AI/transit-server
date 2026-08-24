import type { HostIdentity, RpcOutcome } from "../do/host-hub";
import { txId } from "../lib/transit/ids";
import { type McpPrincipal, principalAddress } from "./principal";

/** A tool's answer, in the two shapes `tools/call` can render. */
export type ToolResult = { text: string; isError?: true };

class ToolError extends Error {}

function fail(message: string): never {
  throw new ToolError(message);
}

function required(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    fail(`${key} is required`);
  }
  return value;
}

function optional(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${key} must be a string`);
  return value || undefined;
}

function identityOf(principal: McpPrincipal): HostIdentity {
  return { hostId: principal.hostId, org: principal.org, slug: principal.host };
}

/**
 * The acting agent, for the tools that act as somebody rather than merely
 * read. A host-scoped credential does not name one on its own, so the failure
 * has to say how to supply it — an agent that reads "unauthorized" here will
 * conclude its token is wrong and stop.
 */
function actor(principal: McpPrincipal): string {
  const address = principalAddress(principal);
  if (!address) {
    fail(
      "this tool acts as an agent, and this credential does not name one; " +
        "send an X-Transit-Agent header with your agent name",
    );
  }
  return address;
}

function hub(env: Env, principal: McpPrincipal) {
  return env.HOST_HUB.getByName(`org:${principal.org}:host:${principal.host}`);
}

async function rpc(
  env: Env,
  principal: McpPrincipal,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const outcome: RpcOutcome = await hub(env, principal).callRpc(
    identityOf(principal),
    method,
    params,
  );
  if (!outcome.ok) throw new ToolError(outcome.error);
  return JSON.parse(outcome.json);
}

export async function callTool(
  env: Env,
  principal: McpPrincipal,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return { text: await runTool(env, principal, name, args) };
  } catch (error) {
    return {
      text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

async function runTool(
  env: Env,
  principal: McpPrincipal,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "send_message": {
      const to = required(args, "to");
      const from = actor(principal);
      const id = txId();
      const outcome = await hub(env, principal).submitSend(identityOf(principal), {
        t: "send",
        id,
        from,
        to,
        body: required(args, "message"),
        ...(optional(args, "reply_to") ? { reply_to: args.reply_to as string } : {}),
        ts: new Date().toISOString(),
      });
      // A daemon spools a nak and retries the transient ones itself. Over HTTP
      // there is no spool, so the code is the caller's to act on: retry
      // `rate_limited` and `plan_limit`, fix the address for the rest.
      if (outcome.status === "nak") fail(`send rejected: ${outcome.code}`);
      return `Message ${id} to ${to}: sent`;
    }
    case "read_message": {
      const id = required(args, "id");
      // A channel delivery's full body is settlement-scoped, so reading one
      // needs an actor for the same reason settling it does. A `tx_` message is
      // organization-scoped and needs none.
      const result = await rpc(env, principal, "read_message", {
        id,
        ...(id.startsWith("dlv_") ? { caller: actor(principal) } : {}),
      });
      if (typeof result !== "string") fail("read_message returned an invalid result");
      return result;
    }
    case "chat_reply":
      return JSON.stringify(
        await rpc(env, principal, "chat_reply", {
          delivery_id: required(args, "delivery_id"),
          conversation_id: required(args, "conversation_id"),
          message: required(args, "message"),
          caller: actor(principal),
          ...(optional(args, "reply_mode")
            ? { reply_mode: args.reply_mode as string }
            : {}),
        }),
      );
    case "mark_handled":
      return JSON.stringify(
        await rpc(env, principal, "mark_handled", {
          delivery_id: required(args, "delivery_id"),
          caller: actor(principal),
        }),
      );
    case "list_agents":
      return JSON.stringify(
        await rpc(env, principal, "list_agents", {
          ...(optional(args, "host") ? { host: args.host as string } : {}),
          ...(optional(args, "organization")
            ? { organization: args.organization as string }
            : {}),
        }),
        null,
        2,
      );
    case "list_rooms":
      return JSON.stringify(
        await rpc(env, principal, "list_rooms", {
          ...(optional(args, "organization")
            ? { organization: args.organization as string }
            : {}),
        }),
        null,
        2,
      );
    case "create_room": {
      const policy = optional(args, "policy");
      return JSON.stringify(
        await rpc(env, principal, "create_room", {
          room: required(args, "name"),
          address: actor(principal),
          ...(policy ? { policy } : {}),
        }),
      );
    }
    case "join_room":
    case "leave_room": {
      const room = required(args, "room");
      await rpc(env, principal, name, { room, address: actor(principal) });
      return `${name} ${room}`;
    }
    case "whoami": {
      const status = await hub(env, principal).status();
      const address = principalAddress(principal);
      return `${address ?? `(unnamed)@${principal.host}`} (connected: ${status.connected})`;
    }
    case "claim_name":
      // The stdio server renames a live pane through the local adapter. A
      // credential has no pane, and its name is whatever the credential says
      // it is, so there is nothing here to rename. Saying so beats a rename
      // that appears to work and binds nothing.
      return fail(
        "claim_name is a local-session operation; over MCP an agent's name comes " +
          "from its credential and is changed by reissuing that credential",
      );
    default:
      return fail(`unknown tool: ${name}`);
  }
}
