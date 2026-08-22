/**
 * Fan-out tripwire.
 *
 * Why this test exists: a worker that calls itself in a loop (or a queue
 * consumer that re-publishes to its own queue, or a DO alarm that schedules
 * another alarm, ...) is invisible to Cloudflare's public-facing kill-switch
 * — nuking DNS, routes, custom domains, and workers.dev does nothing for
 * internal subrequests. See:
 *
 *   https://pizzaconsole.com/blog/posts/programming/cf-overage
 *
 * So protection has to live inside the worker. This template intentionally
 * does NOT prescribe a single safeguard pattern (hop-count headers, message
 * envelopes, alarm rate-limits, ...) — different fan-out shapes need
 * different mitigations. Instead this test fails the build the moment any
 * fan-out surface is added to wrangler.jsonc without an explicit reviewed-it
 * acknowledgment in REVIEWED below.
 *
 * When this test fails after you add a binding:
 *   1. Decide what stops a runaway loop for that surface (a hop-count
 *      header, a depth field on the queue message, a per-DO alarm budget,
 *      shared-secret + counter on the service binding, etc.).
 *   2. Add a REVIEWED entry below — the value is a one-line note pointing
 *      at the chosen safeguard and the test that exercises it.
 *   3. Add a behavioral test under test/safeguards/ that drives the
 *      surface end-to-end and asserts it terminates.
 *
 * When you remove a binding, delete the corresponding REVIEWED entry.
 */
import { env } from "cloudflare:test";
import { parse } from "jsonc-parser";
import { describe, expect, test } from "vitest";

type Surface =
  | "queues.producers"
  | "queues.consumers"
  | "services"
  | "durable_objects"
  | "triggers.crons"
  | "workflows"
  | "tail_consumers";

type WranglerConfig = {
  queues?: { producers?: unknown[]; consumers?: unknown[] };
  services?: unknown[];
  durable_objects?: { bindings?: unknown[] };
  triggers?: { crons?: unknown[] };
  workflows?: unknown[];
  tail_consumers?: unknown[];
};

// Add an entry per surface as you wire it in. The value is a one-line note
// describing what stops a runaway loop and pointing at the test that proves
// it. Keep the comment style — `// "queues.producers": "..."` — uncomment
// the line when you add the binding.
const REVIEWED: Partial<Record<Surface, string>> = {
  // "queues.producers": "Envelope { hop, payload }; consumer drops past 5 + DLQ — see queue.test.ts",
  // "queues.consumers": "Same envelope; consumer's own re-publishes increment hop — see queue.test.ts",
  // "services":         "Shared secret + hop header on the binding caller — see services.test.ts",
  "durable_objects": "Per-DO alarm budget (120/h) plus delivery cap 40 and 24h TTL; Room queues only into HostHubs — see test/safeguards/do-fanout.test.ts",
  "triggers.crons": "Scheduled handler calls bounded sweep(DB) directly; never fetches the Worker — see test/safeguards/retention.test.ts",
  // "workflows":        "Step.do guards against re-invocation; max retries=3 — see workflow.test.ts",
  // "tail_consumers":   "Tail consumer is read-only; no fan-out to producers — see tail.test.ts",
};

const SURFACES: ReadonlyArray<readonly [Surface, (c: WranglerConfig) => boolean]> = [
  ["queues.producers", (c) => Boolean(c.queues?.producers?.length)],
  ["queues.consumers", (c) => Boolean(c.queues?.consumers?.length)],
  ["services", (c) => Boolean(c.services?.length)],
  ["durable_objects", (c) => Boolean(c.durable_objects?.bindings?.length)],
  ["triggers.crons", (c) => Boolean(c.triggers?.crons?.length)],
  ["workflows", (c) => Boolean(c.workflows?.length)],
  ["tail_consumers", (c) => Boolean(c.tail_consumers?.length)],
];

const config = parse(env.WRANGLER_CONFIG_SOURCE) as WranglerConfig;

describe("safeguards: every fan-out surface has been reviewed for runaway-loop risk", () => {
  for (const [name, isPresent] of SURFACES) {
    test(`${name}: present in wrangler.jsonc → REVIEWED entry exists`, () => {
      if (!isPresent(config)) return; // surface not in use, nothing to gate

      expect(
        REVIEWED[name],
        [
          `wrangler.jsonc declares "${name}" but REVIEWED in ${"test/safeguards/no-runaway-fanout.test.ts"} has no entry for it.`,
          ``,
          `Add a one-line note in REVIEWED above explaining what stops a runaway loop for this surface,`,
          `then add a behavioral test under test/safeguards/ that exercises the surface and asserts it terminates.`,
          ``,
          `Why: internal subrequests bypass DNS/route-level kill-switches —`,
          `https://pizzaconsole.com/blog/posts/programming/cf-overage`,
        ].join("\n"),
      ).toBeTruthy();
    });
  }
});
