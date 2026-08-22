import { describe, expect, test } from "vitest";
import { deriveTrustedOrigins } from "../../src/lib/better-auth";

// `wrangler types` infers `BETTER_AUTH_URL` as the literal "http://localhost:8787"
// from the prod vars block, which is too narrow for unit tests that swap in
// arbitrary URLs. Define a relaxed shape and cast at the call site.
type TestEnv = {
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
};

const envWith = (overrides: Partial<TestEnv>): Env =>
  ({ BETTER_AUTH_SECRET: "x", ...overrides }) as unknown as Env;

// Every result starts with the always-on localhost dev origins, with and without
// an explicit port.
const LOCAL = [
  "http://localhost",
  "http://127.0.0.1",
  "http://localhost:*",
  "http://127.0.0.1:*",
];

describe("deriveTrustedOrigins", () => {
  test("localhost dev origins are always trusted", () => {
    const origins = deriveTrustedOrigins(envWith({ BETTER_AUTH_URL: "https://app.example.com" }));
    expect(origins).toEqual(LOCAL);
  });

  test("workers.dev URL auto-derives the wildcard sibling origin", () => {
    const origins = deriveTrustedOrigins(
      envWith({ BETTER_AUTH_URL: "https://my-worker.acct.workers.dev" }),
    );
    expect(origins).toEqual([...LOCAL, "https://*.acct.workers.dev"]);
  });

  test("custom domain adds nothing beyond the localhost dev origins", () => {
    const origins = deriveTrustedOrigins(envWith({ BETTER_AUTH_URL: "https://app.example.com" }));
    expect(origins).toEqual([...LOCAL]);
  });

  test("BETTER_AUTH_TRUSTED_ORIGINS CSV is merged in", () => {
    const origins = deriveTrustedOrigins(
      envWith({
        BETTER_AUTH_URL: "https://app.example.com",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://staging.example.com, https://*.preview.workers.dev",
      }),
    );
    expect(origins).toEqual([
      ...LOCAL,
      "https://staging.example.com",
      "https://*.preview.workers.dev",
    ]);
  });

  test("workers.dev URL + CSV combine without duplication", () => {
    const origins = deriveTrustedOrigins(
      envWith({
        BETTER_AUTH_URL: "https://my-worker.acct.workers.dev",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://*.acct.workers.dev,https://other.example.com",
      }),
    );
    expect(origins).toEqual([
      ...LOCAL,
      "https://*.acct.workers.dev",
      "https://other.example.com",
    ]);
  });

  test("malformed BETTER_AUTH_URL falls back to CSV-only without throwing", () => {
    const origins = deriveTrustedOrigins(
      envWith({
        BETTER_AUTH_URL: "not a url",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://app.example.com",
      }),
    );
    expect(origins).toEqual([...LOCAL, "https://app.example.com"]);
  });

  test("empty/whitespace CSV entries are skipped", () => {
    const origins = deriveTrustedOrigins(
      envWith({
        BETTER_AUTH_URL: "https://app.example.com",
        BETTER_AUTH_TRUSTED_ORIGINS: " , https://a.example.com , ,  ",
      }),
    );
    expect(origins).toEqual([...LOCAL, "https://a.example.com"]);
  });
});
