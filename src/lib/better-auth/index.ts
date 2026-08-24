import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { mcp, organization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import * as appSchema from "../../db/app-schema";
import { betterAuthOptions } from "./options";

import { sendPasswordResetEmail } from "../email/reset-password";

/**
 * Supplies deployment-specific Better Auth plugins — the seam the hosted
 * service uses to add its subscription plugin without that plugin existing in
 * this repository. Evaluated per request because a plugin may need `env`.
 */
export type AuthPluginFactory = (env: Env) => BetterAuthPlugin[];

const NO_PLUGINS: BetterAuthPlugin[] = [];

/** Default {@link AuthPluginFactory}: this distribution adds no plugins. */
export const noAuthPlugins: AuthPluginFactory = () => NO_PLUGINS;

/**
 * Better Auth's CSRF check rejects any request whose Origin doesn't match
 * `baseURL` or an entry in `trustedOrigins` ("Invalid origin"). Two common
 * Cloudflare scenarios trip this:
 *
 *  1. No custom domain: `BETTER_AUTH_URL=https://<worker>.<sub>.workers.dev`,
 *     and Workers Builds previews live at
 *     `<version>-<worker>.<sub>.workers.dev` — siblings under the same
 *     account subdomain. Auto-derive `https://*.<sub>.workers.dev` so
 *     previews "just work" with zero config.
 *  2. Custom domain: `BETTER_AUTH_URL=https://app.example.com` but previews
 *     are still on workers.dev. Auto-derivation can't help because the
 *     workers.dev subdomain isn't in `BETTER_AUTH_URL`. Set
 *     `BETTER_AUTH_TRUSTED_ORIGINS` (CSV) in wrangler.jsonc vars, e.g.
 *     `"https://*.<sub>.workers.dev"`.
 *
 * Local dev: when you hit the Worker via a hostname that doesn't match
 * `.dev.vars`'s `BETTER_AUTH_URL` (a `/etc/hosts` entry, a reverse proxy,
 * or an alternate port), add the actual origin to
 * `BETTER_AUTH_TRUSTED_ORIGINS` in `.dev.vars` instead of changing
 * `BETTER_AUTH_URL` — keeps cookies set on the canonical origin.
 *
 * Better Auth also reads `BETTER_AUTH_TRUSTED_ORIGINS` from `process.env`,
 * but Worker `vars` aren't exposed there — they only reach us via `env`,
 * which is why we plumb it explicitly.
 */
export function deriveTrustedOrigins(env: Env): string[] {
  const origins = new Set<string>();
  // Local dev on the default ports and on *any explicit port just works.
  // `wrangler dev`, the Vite dev server (which auto-bumps its port when one is
  // busy), and multiple front-ends pointed at one Worker all send a localhost
  // Origin. Better Auth's trusted-origin matcher treats `*` as a wildcard for
  // any non-`/` chars, so the wildcard patterns cover explicit ports while the
  // bare entries cover browsers or proxies that normalize the default port
  // away. This is not a CSRF vector: browsers set `Origin` truthfully and a
  // cross-site attacker's page always carries its own (non-localhost) origin.
  origins.add("http://localhost");
  origins.add("http://127.0.0.1");
  origins.add("http://localhost:*");
  origins.add("http://127.0.0.1:*");

  try {
    const url = new URL(env.BETTER_AUTH_URL);
    if (url.hostname.endsWith(".workers.dev")) {
      const parts = url.hostname.split(".");
      // ["<worker>", "<sub>", "workers", "dev"] → "*.<sub>.workers.dev"
      if (parts.length >= 4) {
        origins.add(`${url.protocol}//*.${parts.slice(1).join(".")}`);
      }
    }
  } catch {
    // Malformed BETTER_AUTH_URL — skip auto-derivation.
  }

  const extra = env.BETTER_AUTH_TRUSTED_ORIGINS;
  if (extra) {
    for (const o of extra.split(",")) {
      const trimmed = o.trim();
      if (trimmed) origins.add(trimmed);
    }
  }

  return [...origins];
}

/**
 * The authorization-code half of `/mcp`, for a HUMAN.
 *
 * Claude's connector performs exactly one flow — authorization code with S256
 * PKCE — and will not do client credentials at all, so this plugin and the
 * agent-token endpoint beside it are not two doors into one room. This one is
 * for a person; that one is for an agent.
 *
 * Registration is Dynamic Client Registration rather than CIMD, because CIMD
 * needs a `client_id_metadata_document_supported` flag this version does not
 * emit. DCR is deprecated in the 2026-07-28 spec and works; at one operator's
 * scale the client-sprawl warning that motivated deprecating it does not apply.
 *
 * The discovery documents this plugin serves are NOT the ones Transit
 * advertises. Its `resource` defaults to the origin rather than the MCP URL,
 * which is the single most common reason a Claude connector silently never
 * connects, and its metadata names a `/mcp/userinfo` and a `/mcp/jwks` it does
 * not mount. Transit serves its own; see `src/mcp/discovery.ts`.
 */
function mcpPlugin() {
  return mcp({
    // Where an unauthenticated browser lands mid-authorization. The SPA's own
    // sign-in page, which returns to the authorize request afterwards.
    loginPage: "/login",
    // Under `oidcConfig`, not beside `loginPage`: the plugin spreads
    // `oidcConfig` into the options its authorize handler reads, and a
    // `consentPage` set anywhere else is silently ignored.
    oidcConfig: {
      loginPage: "/login",
      consentPage: "/oauth2/consent",
      // Off by default, and its absence is half of an authorization-code
      // interception: a confidential client registered by an attacker can skip
      // the challenge entirely and exchange a stolen code with only its own
      // secret. Claude always sends S256, and the discovery document already
      // advertises it as the only method, so requiring it costs nothing and
      // makes the advertisement true.
      requirePKCE: true,
    },
  });
}

export const auth = (env: Env, extraPlugins: BetterAuthPlugin[] = []) => {
  const fullSchema = { ...schema, ...appSchema };
  const db = drizzle(env.DB, { schema: fullSchema });

  const organizationPlugin = organization({
    teams: { enabled: false },
    disableOrganizationDeletion: true,
  });
  // Both stay statically typed: the organization plugin because callers read
  // its inferred session fields, and the mcp plugin because `getMcpSession` is
  // how `/mcp` reads a person's access token. Deployment-supplied plugins are
  // appended opaquely.
  const mcpAuthPlugin = mcpPlugin();
  const plugins: [
    typeof organizationPlugin,
    typeof mcpAuthPlugin,
    ...BetterAuthPlugin[],
  ] = [organizationPlugin, mcpAuthPlugin, ...extraPlugins];

  return betterAuth({
    ...betterAuthOptions,
    plugins,
    // `sendResetPassword` is the seam that enables the forgot-password flow:
    // Better Auth refuses /request-password-reset unless this is set. It needs
    // `env` (for the EMAIL binding), so it's wired here in the env-scoped
    // factory rather than in the static `betterAuthOptions`. Uses the existing
    // `verification` table — no schema change.
    emailAndPassword: {
      ...betterAuthOptions.emailAndPassword,
      enabled: true,
      sendResetPassword: async ({ user, url }) => {
        await sendPasswordResetEmail(env, {
          to: user.email,
          url,
          name: user.name,
        });
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const createdAt = user.createdAt.getTime();
            const slug = `personal-${user.id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
            await env.DB.batch([
              env.DB.prepare(
                `INSERT INTO organization
                 (id, name, slug, logo, created_at, metadata, stripe_customer_id)
                 VALUES (?, ?, ?, NULL, ?, NULL, NULL)`,
              ).bind(user.id, `${user.name}'s organization`, slug, createdAt),
              env.DB.prepare(
                `INSERT INTO member (id, organization_id, user_id, role, created_at)
                 VALUES (?, ?, ?, 'owner', ?)`,
              ).bind(crypto.randomUUID(), user.id, user.id, createdAt),
            ]);
          },
        },
      },
      session: {
        create: {
          before: async (session) => ({
            data: {
              ...session,
              activeOrganizationId: session.userId,
            },
          }),
        },
      },
    },
    database: drizzleAdapter(db, { provider: "sqlite", schema: fullSchema }),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: deriveTrustedOrigins(env),
  });
};
