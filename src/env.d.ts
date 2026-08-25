// Secrets set via `wrangler secret put` aren't in wrangler.jsonc, so
// `wrangler types` can't see them — declare them here. Newer wrangler emits
// the bindings into a global `interface Env` *and* a separate `Cloudflare.Env`
// (both extending the generated base), so the secret must be merged into both:
// the auth() factory + Hono `Bindings` use the global `Env`.
//
// Both interfaces are open for declaration merging: a deployment that layers
// its own Worker over this one (see `createApp()` in `src/index.ts`) declares
// its extra secrets in its own `.d.ts` rather than here.
interface Env {
  BETTER_AUTH_SECRET: string;
  TRANSIT_MASTER_KEY: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  /** Where /dl redirects. Unset falls through to the published release. */
  TRANSIT_DOWNLOAD_BASE?: string;
}

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    TRANSIT_MASTER_KEY: string;
    BETTER_AUTH_TRUSTED_ORIGINS?: string;
    TRANSIT_DOWNLOAD_BASE?: string;
  }
}

/** The installer is shipped as a file and served verbatim; see /install. */
declare module "*.sh" {
  const content: string;
  export default content;
}
