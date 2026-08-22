import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "http://localhost";

describe("public agent skill", () => {
  it("serves the canonical root SKILL.md without authentication", async () => {
    const response = await SELF.fetch(`${ORIGIN}/SKILL.md`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300",
    );

    const markdown = await response.text();
    expect(markdown).toContain("name: transit");
    expect(markdown).toContain("**Claude Code:**");
    expect(markdown).toContain("**OMP:**");
    expect(markdown).toContain("**Other harnesses:**");
    expect(markdown).toContain("**Pi:**");
    expect(markdown).toContain("**OpenCode:**");
    expect(markdown).toContain("Native registration wins over Herdr");
    expect(markdown).toContain("organization-slug/name@host");
    expect(markdown).toContain('list_agents(organization="<slug>")');
  });
});
