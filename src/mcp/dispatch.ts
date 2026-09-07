import type { HostIdentity, RpcOutcome } from "../do/host-hub";
import { txId } from "../lib/transit/ids";
import { listAgents, listRooms } from "../services/directory";
import { ServiceError } from "../services/errors";
import { claimPersonAddress } from "../services/person";
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

/**
 * The host a principal acts on. A signed-in person who has not claimed an
 * address has none, so every tool that reaches a HostHub stops here rather than
 * inventing one. Giving a human an agent-shaped address is a real decision
 * about a public namespace, so the person makes it with `claim_name`; nothing
 * here infers it.
 */
function identityOf(principal: McpPrincipal): HostIdentity {
  if (!principal.host || !principal.hostId) {
    fail(unclaimed(principal, "this tool acts from a host"));
  }
  return { hostId: principal.hostId, org: principal.org, slug: principal.host };
}

/**
 * How a caller with no address is told so, in the terms that caller can act on.
 *
 * Two different things can be missing and they need different answers, because
 * each has a different fix and a caller told the wrong one stops. A signed-in
 * person has no address until they claim one, and the sentence must name the
 * tool that does it — this is the ordinary first call for a person reaching
 * Transit through Claude, not an error state. Anything else is a credential
 * genuinely not bound to a host, and no argument will change that.
 */
function unclaimed(principal: McpPrincipal, lead: string): string {
  if (principal.credential === "user_session") {
    return (
      `${lead}, and you have not claimed a Transit address yet; ` +
      "call claim_name with the name you want to be known by, " +
      "then this tool works"
    );
  }
  return `${lead}, and this credential is not bound to a host`;
}

/**
 * The acting agent, for the tools that act as somebody rather than merely read.
 *
 * Two different things can be missing and they need different answers. A
 * credential bound to no host at all cannot be fixed by a header — the address
 * does not exist yet, and for a person the fix is `claim_name`. A host-scoped
 * credential that simply did not say who it is can fix it, and must be told
 * how: an agent that reads "unauthorized" here will conclude its token is wrong
 * and stop.
 */
function actor(principal: McpPrincipal): string {
  if (!principal.host) {
    fail(unclaimed(principal, "this tool acts as an agent"));
  }
  const address = principalAddress(principal);
  if (!address) {
    fail(
      "this tool acts as an agent, and this credential does not name one; " +
        "send an X-Transit-Agent header with your agent name",
    );
  }
  return address;
}

/**
 * An optional count. Every schema property here is `type: "string"`, so a model
 * sends `"50"` about as often as `50`; anything that is not a number at all is
 * dropped rather than passed on as `NaN`, which would reach a storage list as a
 * limit and mean nothing.
 */
function count(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A waiting queue, rendered. The envelopes go out verbatim — exactly the bytes
 * a daemon would have injected into the session — so an agent reads the same
 * thing whether the message was pushed to it or pulled by it.
 */
export function renderInbox(waiting: { envelope: string }[]): string {
  if (waiting.length === 0) return "No messages waiting.";
  return waiting.map((message) => message.envelope).join("\n\n");
}

function hub(env: Env, principal: McpPrincipal) {
  // Through `identityOf` rather than reading `principal.host` directly: a null
  // host interpolated into a Durable Object name addresses an object literally
  // called `null`, which exists, answers, and is wrong.
  const identity = identityOf(principal);
  return env.HOST_HUB.getByName(`org:${identity.org}:host:${identity.slug}`);
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
    // A ServiceError's message is the sentence a tool result carries; see
    // `services/errors.ts`.
    const message =
      error instanceof ServiceError || error instanceof Error
        ? error.message
        : String(error);
    return { text: `Error: ${message}`, isError: true };
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
    case "mark_handled": {
      // The `tx_`/`dlv_` split lives in `invokeRpc` now, with the rest of the
      // tool surface, so settling means the same thing over this endpoint and
      // over the daemon wire.
      return JSON.stringify(
        await rpc(env, principal, "mark_handled", {
          delivery_id: required(args, "delivery_id"),
          caller: actor(principal),
        }),
      );
    }
    case "read_inbox": {
      const waiting = (await rpc(env, principal, "read_inbox", {
        caller: actor(principal),
      })) as { envelope: string }[];
      return renderInbox(waiting);
    }
    case "read_room": {
      return JSON.stringify(
        await rpc(env, principal, "read_room", {
          room: required(args, "room"),
          caller: actor(principal),
          ...(count(args.limit) === undefined ? {} : { limit: count(args.limit) }),
        }),
        null,
        2,
      );
    }
    // These two only observe, so they read the directory service directly
    // rather than through a HostHub. That is not an optimisation: a signed-in
    // person has an organization and no host, and routing an org-scoped
    // question through a host-scoped object would put them behind a door they
    // have no key for. The daemon wire still reaches the same service through
    // `invokeRpc`; `test/directory-service.test.ts` is what holds them equal.
    case "list_agents":
      return JSON.stringify(
        await listAgents(env.DB, {
          org: principal.org,
          host: optional(args, "host") ?? null,
          organization: optional(args, "organization") ?? null,
        }),
        null,
        2,
      );
    case "list_rooms":
      return JSON.stringify(
        await listRooms(env.DB, {
          org: principal.org,
          organization: optional(args, "organization") ?? null,
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
      // A signed-in person who has not claimed a name holds an organization and
      // no address. Saying that plainly beats both an error, which reads as a
      // broken credential, and a fabricated address, which would make the
      // namespace decision by accident.
      if (!principal.host) {
        return `signed-in person (organization ${principal.org}); no Transit address yet — call claim_name with the name you want to be known by`;
      }
      const status = await hub(env, principal).status();
      const address = principalAddress(principal);
      return `${address ?? `(unnamed)@${principal.host}`} (connected: ${status.connected})`;
    }
    case "claim_name": {
      // For a person this is the real thing, and the only tool that works
      // before they have an address: it mints the `person_address` row the
      // principal is built from, so every other tool starts working on the
      // next request. Calling it again renames, because the row is keyed on
      // the person rather than on the name.
      if (principal.credential === "user_session") {
        if (!principal.userId) fail("this credential has no signed-in person");
        const claimed = await claimPersonAddress(env.DB, {
          org: principal.org,
          userId: principal.userId,
          name: required(args, "name"),
        });
        return `${claimed.name}@${claimed.host}`;
      }
      // The stdio server renames a live pane through the local adapter. An
      // agent credential has no pane, and its name is whatever the credential
      // says it is, so there is nothing here to rename. Saying so beats a
      // rename that appears to work and binds nothing.
      return fail(
        "claim_name is a local-session operation; over MCP an agent's name comes " +
          "from its credential and is changed by reissuing that credential",
      );
    }
    default:
      return fail(`unknown tool: ${name}`);
  }
}
