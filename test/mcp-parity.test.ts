import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TRANSIT_TOOLS } from "../src/mcp/tools";

/**
 * Transit has two MCP servers and one tool surface.
 *
 * `src/mcp/tools.ts` is the hosted endpoint's; `daemon/mcp.go` is the stdio one
 * a local harness talks to. They exist separately because they pin the sender
 * differently — a credential on the request against the local session — and for
 * no other reason. An agent that moves from a Herdr box to a bare one, or from
 * a daemon to a raw HTTP client, must find the same tools with the same names.
 *
 * The drift this catches is not hypothetical. `read_inbox` lived on the hosted
 * endpoint alone for an entire release: an agent whose adapter was down had
 * messages queued for it in the Worker and no local tool that could ask for
 * them. It read as a Herdr dependency and was really a missing tool.
 *
 * Go cannot be imported and workerd cannot read a file, so `vitest.config.ts`
 * passes `daemon/mcp.go` in as a binding and this parses the names out of it.
 */

/** Every `"name": "..."` inside `mcpTools()`, in the order it declares them. */
function daemonToolNames(source: string): string[] {
  const start = source.indexOf("func mcpTools()");
  expect(start, "daemon/mcp.go no longer defines mcpTools()").toBeGreaterThan(-1);
  const end = source.indexOf("\nfunc ", start + 1);
  const body = source.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/"name": "([a-z_]+)"/g)].map((match) => match[1]!);
}

describe("the two MCP servers advertise one tool surface", () => {
  const daemon = daemonToolNames(env.DAEMON_MCP_SOURCE);
  const hosted = TRANSIT_TOOLS.map((tool) => tool.name);

  it("advertises the same tools in the same order", () => {
    expect(daemon).toEqual(hosted);
  });

  it("carries the tools that make Herdr optional", () => {
    // `read_inbox` is how an agent with nothing live to receive on gets its
    // messages; `read_room` is the same question for a room it missed. Neither
    // may be hosted-only again — that is the whole shape of the bug.
    for (const name of ["read_inbox", "read_room", "claim_name", "whoami"]) {
      expect(hosted, `hosted endpoint lost ${name}`).toContain(name);
      expect(daemon, `daemon lost ${name}`).toContain(name);
    }
  });

  it("never lets a model name the sender", () => {
    // Identity is pinned by the transport on both servers. A `from`, `caller`
    // or `address` property in a schema would hand it to the model instead.
    for (const tool of TRANSIT_TOOLS) {
      const properties = Object.keys(tool.inputSchema.properties);
      expect(properties, `${tool.name} exposes the sender`).not.toContain("from");
      expect(properties, `${tool.name} exposes the sender`).not.toContain("caller");
      expect(properties, `${tool.name} exposes the sender`).not.toContain("address");
    }
  });
});
