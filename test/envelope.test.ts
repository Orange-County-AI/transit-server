import { describe, expect, it } from "vitest";
import vectors from "../spec/envelope-vectors.json";
import {
  type EnvelopeMessage,
  type FullEnvelopeMessage,
  renderEnvelope,
  renderFull,
} from "../src/lib/transit/envelope";

describe("transit/1 envelope", () => {
  for (const vector of vectors.envelopes) {
    it(vector.name, () => {
      expect(renderEnvelope(vector.input as EnvelopeMessage)).toBe(vector.expected);
    });
  }

  for (const vector of vectors.full) {
    it(vector.name, () => {
      expect(renderFull(vector.input as FullEnvelopeMessage)).toBe(vector.expected);
    });
  }

  it("clips direct-message injection to 4,000 runes", () => {
    const rendered = renderEnvelope({
      from: "alice@alpha",
      id: "tx_56789abcdef0",
      ts: "2026-08-21T12:35:01.000Z",
      kind: "dm",
      body: `${"🙂".repeat(4_000)}x`,
    });
    expect(rendered).toContain('truncated="1" schema="transit/1"');
    expect(rendered).toContain(`\n${"🙂".repeat(4_000)}\n`);
    expect(rendered).not.toContain(`${"🙂".repeat(4_000)}x`);
  });

  it("limits a channel preview to 100 runes", () => {
    const rendered = renderEnvelope({
      from: "telegram",
      id: "dlv_6789abcdef01",
      ts: "2026-08-21T12:35:02.000Z",
      kind: "channel",
      body: "🙂".repeat(101),
      conversationId: "chat-2",
      connector: "telegram",
    });
    expect(rendered).toContain(`\n${"🙂".repeat(100)}\n`);
    expect(rendered).not.toContain("🙂".repeat(101));
  });
});
