import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

type DocumentSection = "start" | "guide" | "advanced" | "reference";

type PublicDocument = {
  slug: string;
  title: string;
  description: string;
  section: DocumentSection;
  markdown: string;
};

const ALLOWED_SECTIONS: readonly DocumentSection[] = ["start", "guide", "advanced", "reference"];

const EXPECTED_DOCUMENTS = [
  { slug: "getting-started", title: "Getting started" },
  { slug: "accounts", title: "Accounts" },
  { slug: "hosts", title: "Hosts and the daemon" },
  { slug: "agents", title: "Agents" },
  { slug: "direct-messages", title: "Direct messages" },
  { slug: "rooms", title: "Rooms" },
  { slug: "integrations", title: "Integrations" },
  { slug: "deliveries", title: "Deliveries" },
  { slug: "harnesses", title: "Native harness adapters and Herdr" },
  { slug: "agent-skill", title: "Agent skill" },
  { slug: "troubleshooting", title: "Troubleshooting" },
  { slug: "self-hosting", title: "Self-hosting Transit" },
  { slug: "architecture", title: "Transit architecture" },
  { slug: "protocols", title: "Transit protocols" },
  { slug: "security", title: "Transit security model" },
  { slug: "ui", title: "Transit UI design" },
] as const;

describe("public documentation corpus", () => {
  it("serves the canonical frontmatter-free Markdown files from docs", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/docs`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");

    const body = await response.json<{ documents: PublicDocument[] }>();
    expect(body.documents.map((document) => document.slug)).toEqual(
      EXPECTED_DOCUMENTS.map((document) => document.slug),
    );

    for (const [index, expected] of EXPECTED_DOCUMENTS.entries()) {
      const document = body.documents[index]!;
      expect(document.title).toBe(expected.title);
      expect(document.title.trim()).not.toBe("");
      expect(document.description.trim()).not.toBe("");
      expect(ALLOWED_SECTIONS).toContain(document.section);
      expect(document.markdown).toContain(`# ${expected.title}`);
      expect(document.markdown).not.toMatch(/^---/);
    }
  });
});
