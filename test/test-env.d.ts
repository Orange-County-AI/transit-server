// Bindings injected by vitest.config.ts at test time. Augments the global
// Cloudflare.Env so `env.TEST_MIGRATIONS` / `env.WRANGLER_CONFIG_SOURCE`
// from `cloudflare:test` are typed in test files.
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      WRANGLER_CONFIG_SOURCE: string;
    }
  }
}

export {};
