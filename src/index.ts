import { type Context, Hono } from "hono";
import installScript from "../install.sh";
import skillMarkdown from "../SKILL.md";
import accountsMarkdown from "../docs/accounts.md";
import agentSkillMarkdown from "../docs/agent-skill.md";
import agentsMarkdown from "../docs/agents.md";
import architectureMarkdown from "../docs/architecture.md";
import deliveriesMarkdown from "../docs/deliveries.md";
import directMessagesMarkdown from "../docs/direct-messages.md";
import gettingStartedMarkdown from "../docs/getting-started.md";
import harnessesMarkdown from "../docs/harnesses.md";
import hostsMarkdown from "../docs/hosts.md";
import integrationsMarkdown from "../docs/integrations.md";
import protocolsMarkdown from "../docs/protocols.md";
import roomsMarkdown from "../docs/rooms.md";
import securityMarkdown from "../docs/security.md";
import selfHostingMarkdown from "../docs/self-hosting.md";
import troubleshootingMarkdown from "../docs/troubleshooting.md";
import uiMarkdown from "../docs/ui.md";
import { CONNECTORS } from "./connectors/registry";
import { type AuthPluginFactory, auth, noAuthPlugins } from "./lib/better-auth";
import { readAttachmentCapability } from "./lib/transit/attachment";

import {
  AddressError,
  formatAgentAddress,
  parseAddress,
  validateHost,
  validateName,
  validateOrganizationSlug,
} from "./lib/transit/addr";
import { hmacVerify, openSecret, sealSecret, sha256hex } from "./lib/transit/crypto";
import {
  agentClientId,
  agentClientSecret,
  deviceToken,
  enrollCode,
  hostId,
  intId,
  sourceSecret,
} from "./lib/transit/ids";
import {
  INGEST_TIMESTAMP_SKEW_SECONDS,
  MAX_INGEST_BYTES,
  parseReplyPrefixes,
  signedIngestPayload,
  validateIngestBody,
} from "./lib/transit/ingest";
import {
  SOURCE_NAME_PATTERN,
  validateReplyConfiguration,
} from "./lib/transit/source";
import { sweep } from "./lib/transit/retention";
import { createRoom } from "./lib/transit/rooms";
import {
  organizationIdBySlug,
  organizationBySlug,
  organizationPair,
  resolveConnectedOrganization,
} from "./lib/transit/organizations";
import {
  AUTHORIZATION_SERVER_PATH,
  PROTECTED_RESOURCE_PATH,
  authorizationServerMetadata,
  bearerChallenge,
  protectedResourceMetadata,
} from "./mcp/discovery";
import { handleMcp } from "./mcp/http";
import { handleTokenRequest } from "./mcp/oauth";
import {
  agentExists,
  integrationForDelivery,
  listAgents,
  listRooms,
} from "./services/directory";
import { ServiceError } from "./services/errors";
import { HostHub } from "./do/host-hub";
import { HEALTH_CONFIG_FIELD, Integration } from "./do/integration";
import { Room } from "./do/room";

/**
 * Deployment-supplied behavior reaches the handlers below as a request
 * variable, set once by the middleware `createApp()` installs. Handlers stay
 * identical across distributions; only what `createApp()` is given differs.
 *
 * Message allowances are NOT here — they are enforced inside the Durable
 * Objects, where the count lives, through the overridable `canAcceptMessage`
 * seam on `HostHub` and `Room`.
 */
type TransitEnv = {
  Bindings: Env;
  Variables: {
    authPlugins: AuthPluginFactory;
  };
};

type TransitContext = Context<TransitEnv>;

const app = new Hono<TransitEnv>();
const publicDocs = [
  {
    slug: "getting-started",
    title: "Getting started",
    description: "Create an account, enroll your first host, and send your first message.",
    section: "start",
    markdown: gettingStartedMarkdown,
  },
  {
    slug: "accounts",
    title: "Accounts",
    description: "Sign up, sign in, reset a password, and understand organization scope.",
    section: "start",
    markdown: accountsMarkdown,
  },
  {
    slug: "hosts",
    title: "Hosts and the daemon",
    description: "Install the transit daemon, enroll a host, and keep it connected.",
    section: "start",
    markdown: hostsMarkdown,
  },
  {
    slug: "agents",
    title: "Agents",
    description: "How agent sessions register, how names are assigned, and how to claim one.",
    section: "guide",
    markdown: agentsMarkdown,
  },
  {
    slug: "direct-messages",
    title: "Direct messages",
    description: "Send and receive agent-to-agent messages addressed as name@host.",
    section: "guide",
    markdown: directMessagesMarkdown,
  },
  {
    slug: "rooms",
    title: "Rooms",
    description: "Shared channels that fan out to many agents at once.",
    section: "guide",
    markdown: roomsMarkdown,
  },
  {
    slug: "integrations",
    title: "Integrations",
    description: "Connect Mattermost, Gmail, Telegram, Kaneo, or a custom signed source.",
    section: "guide",
    markdown: integrationsMarkdown,
  },
  {
    slug: "deliveries",
    title: "Deliveries",
    description: "Read the delivery ledger, settle channel events, and requeue dead deliveries.",
    section: "guide",
    markdown: deliveriesMarkdown,
  },
  {
    slug: "harnesses",
    title: "Native harness adapters and Herdr",
    description: "Install native Claude Code, OMP, Pi, or OpenCode delivery and configure fallback policy.",
    section: "guide",
    markdown: harnessesMarkdown,
  },
  {
    slug: "agent-skill",
    title: "Agent skill",
    description: "Install the canonical SKILL.md so agents use Transit correctly.",
    section: "guide",
    markdown: agentSkillMarkdown,
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    description: "Diagnose enrollment, connection, and delivery problems.",
    section: "guide",
    markdown: troubleshootingMarkdown,
  },
  {
    slug: "self-hosting",
    title: "Self-hosting Transit",
    description: "Run the open-source Transit server on your own Cloudflare account.",
    section: "advanced",
    markdown: selfHostingMarkdown,
  },
  {
    slug: "architecture",
    title: "Transit architecture",
    description: "Worker, daemon, Durable Object, and storage boundaries.",
    section: "reference",
    markdown: architectureMarkdown,
  },
  {
    slug: "protocols",
    title: "Transit protocols",
    description: "Envelope, MCP, wire, webhook, and signed-ingest contracts.",
    section: "reference",
    markdown: protocolsMarkdown,
  },
  {
    slug: "security",
    title: "Transit security model",
    description: "Identity, secret handling, trust boundaries, and delivery guarantees.",
    section: "reference",
    markdown: securityMarkdown,
  },
  {
    slug: "ui",
    title: "Transit UI design",
    description: "Apex design rules and the implemented application surfaces.",
    section: "reference",
    markdown: uiMarkdown,
  },
] as const;

const ENROLL_TTL_MS = 15 * 60 * 1_000;
/** How often a daemon may poll a device flow. Also what it is told to use. */
const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** Platforms the release workflow builds. /dl refuses anything else. */
const DAEMON_PLATFORMS = new Set([
  "linux/amd64",
  "linux/arm64",
  "darwin/amd64",
  "darwin/arm64",
]);

type SessionOrganization = {
  id: string;
  userId: string;
  role: string;
};

/** Better Auth bound to the plugins this deployment supplied. */
function authFor(context: TransitContext) {
  return auth(context.env, context.get("authPlugins")(context.env));
}

async function sessionOrganization(
  context: TransitContext,
): Promise<SessionOrganization | null> {
  const session = await authFor(context).api.getSession({
    headers: context.req.raw.headers,
  });
  const org = session?.session.activeOrganizationId;
  if (!session || !org) return null;

  const membership = await context.env.DB.prepare(
    "SELECT role FROM member WHERE user_id = ? AND organization_id = ? LIMIT 1",
  )
    .bind(session.user.id, org)
    .first<{ role: string }>();
  return membership
    ? { id: org, userId: session.user.id, role: membership.role }
    : null;
}

export async function sessionOrg(context: TransitContext): Promise<string | null> {
  return (await sessionOrganization(context))?.id ?? null;
}

function canAdministerOrganization(role: string): boolean {
  return role
    .split(",")
    .some((candidate) => candidate === "owner" || candidate === "admin");
}

function websocketRequest(
  request: Request,
  trustedHeaders: Record<string, string>,
): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  for (const [name, value] of Object.entries(trustedHeaders)) headers.set(name, value);
  return new Request(request, { headers });
}

type IntegrationRow = {
  id: string;
  org_id: string;
  connector: string;
  name: string;
  target_addr: string;
  status: "active" | "paused";
  created_at: number;
};

async function integrationForOrg(
  context: TransitContext,
  org: string,
  id: string,
): Promise<IntegrationRow | null> {
  return context.env.DB.prepare(
    `SELECT id, org_id, connector, name, target_addr, status, created_at
     FROM integration WHERE id = ? AND org_id = ? LIMIT 1`,
  )
    .bind(id, org)
    .first<IntegrationRow>();
}

async function targetExists(
  context: TransitContext,
  org: string,
  target: string,
): Promise<boolean> {
  const parsed = parseAddress(target);
  if (parsed.kind === "room") {
    return Boolean(
      await context.env.DB.prepare(
        "SELECT 1 AS present FROM room WHERE org_id = ? AND name = ? LIMIT 1",
      )
        .bind(org, parsed.room)
        .first(),
    );
  }
  if (parsed.organization) return false;
  return agentExists(context.env.DB, {
    org,
    host: parsed.host,
    name: parsed.name,
  });
}

/**
 * The installer, served from our own origin so the documented command never
 * points at a third party:
 *
 *   curl -fsSL https://transit.orangecountyai.com/install | sh
 *
 * `TRANSIT_ORIGIN` is stamped in at serve time rather than baked into the file,
 * so a self-hosted Worker's installer downloads from that Worker. Cached only
 * briefly: a bad installer should be fixable by redeploying, not by waiting.
 */
app.get("/install", (context) => {
  let origin: string;
  try {
    origin = new URL(context.env.BETTER_AUTH_URL).origin;
  } catch {
    origin = new URL(context.req.url).origin;
  }
  const script = installScript.replace(
    'ORIGIN="${TRANSIT_ORIGIN:-https://transit.orangecountyai.com}"',
    `ORIGIN="\${TRANSIT_ORIGIN:-${origin}}"`,
  );
  return new Response(script, {
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
});

/**
 * Redirect to the release asset for a platform. The site owns the URL a person
 * or a script types; where the bytes actually live is ours to change without
 * breaking anyone's install command.
 *
 * `TRANSIT_DOWNLOAD_BASE` lets a self-hosted deployment point at its own
 * mirror. Unset, it falls through to the published GitHub release.
 */
app.get("/dl/:os/:arch", (context) => {
  const os = context.req.param("os");
  const arch = context.req.param("arch");
  if (!DAEMON_PLATFORMS.has(`${os}/${arch}`)) {
    return context.json({ error: "unsupported_platform" }, 404);
  }

  const base =
    context.env.TRANSIT_DOWNLOAD_BASE?.replace(/\/+$/u, "") ??
    "https://github.com/Orange-County-AI/transit-server/releases/latest/download";
  return context.redirect(`${base}/transit_${os}_${arch}`, 302);
});

app.get("/SKILL.md", () => {
  return new Response(skillMarkdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
});

/**
 * Server-side MCP. An agent reaches Transit's tools over HTTP with a bearer
 * credential, which is what makes a box with no daemon and no Herdr on it a
 * place an agent can send from. Stateless: see `src/mcp/http.ts`.
 */
app.all("/mcp", (context) =>
  handleMcp(context.env, context.req.raw, {
    challenge: (request) => bearerChallenge(context.env, request),
    mcpSession: async (headers) => {
      // An `mcp` access token is opaque and looked up, not verified. Better
      // Auth answers `null` for anything it does not recognize rather than
      // throwing, which is also what an unrelated bearer looks like here.
      const session = await authFor(context).api.getMcpSession({ headers });
      return session?.userId ? { userId: session.userId, scopes: session.scopes } : null;
    },
  }),
);

/**
 * Discovery. Root-mounted because that is where a connector probes, and
 * authored here rather than taken from the Better Auth plugin, which points at
 * endpoints it does not mount and calls the origin the resource. See
 * `src/mcp/discovery.ts`; `test/mcp-discovery.test.ts` fetches everything these
 * advertise and fails if any of it 404s.
 */
app.get(PROTECTED_RESOURCE_PATH, (context) => {
  context.header("Cache-Control", "public, max-age=300");
  return context.json(protectedResourceMetadata(context.env, context.req.raw));
});
app.get(AUTHORIZATION_SERVER_PATH, (context) => {
  context.header("Cache-Control", "public, max-age=300");
  return context.json(authorizationServerMetadata(context.env, context.req.raw));
});

/**
 * Agent access tokens, `grant_type=client_credentials`. Beside Better Auth
 * rather than inside it; see `src/mcp/oauth.ts` for why that is not a choice.
 */
app.all("/oauth/token", (context) => handleTokenRequest(context.env, context.req.raw));

/**
 * The registered name behind a `client_id`, for the consent screen.
 *
 * Better Auth's oidc-provider has this endpoint but the `mcp` plugin does not
 * re-export it, so it is not mounted anywhere. Without it the consent screen
 * asks a person to approve a 32-character random string, which is not consent —
 * they cannot tell what they are agreeing to.
 */
app.get("/api/oauth-clients/:clientId", async (context) => {
  const session = await authFor(context).api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session) return context.json({ error: "Unauthorized" }, 401);
  const row = await context.env.DB.prepare(
    `SELECT client_id, name, icon, redirect_urls FROM oauth_application
     WHERE client_id = ? AND disabled = 0 LIMIT 1`,
  )
    .bind(context.req.param("clientId"))
    .first<{
      client_id: string;
      name: string | null;
      icon: string | null;
      redirect_urls: string | null;
    }>();
  if (!row) return context.json({ error: "client_not_found" }, 404);
  return context.json({
    client_id: row.client_id,
    name: row.name,
    icon: row.icon,
    // Where an approval actually sends the code. A name is attacker-chosen and
    // a consent screen that shows only the name conveys nothing checkable; the
    // destination is the one fact worth reading. Server-side validation is
    // exact-match against this list, so showing it cannot mislead.
    redirect_uris: (row.redirect_urls ?? "").split(",").filter(Boolean),
  });
});

app.get("/api/agent-clients", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const rows = await context.env.DB.prepare(
    `SELECT client_id, host, name, created_at, last_used_at,
            substr(secret_hash, 1, 8) AS secret_fingerprint
     FROM agent_client
     WHERE org_id = ? AND revoked_at IS NULL
     ORDER BY host, name, created_at`,
  )
    .bind(org)
    .all();
  return context.json({ agent_clients: rows.results });
});

app.post("/api/agent-clients", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const body = await context.req
    .json<{ host?: unknown; name?: unknown }>()
    .catch(() => null);
  if (!body || typeof body.host !== "string" || typeof body.name !== "string") {
    return context.json({ error: "host and name are required" }, 400);
  }
  try {
    validateHost(body.host);
    validateName(body.name);
  } catch (error) {
    const code = error instanceof AddressError ? error.code : "invalid_name";
    return context.json({ error: code }, 400);
  }
  // The agent's address has to be real, and a revoked host must not keep
  // issuing identities on a slug nothing serves.
  const hostRow = await context.env.DB.prepare(
    "SELECT id FROM host WHERE org_id = ? AND slug = ? AND revoked_at IS NULL LIMIT 1",
  )
    .bind(org, body.host)
    .first<{ id: string }>();
  if (!hostRow) return context.json({ error: "host_not_found" }, 404);

  const clientId = agentClientId();
  const secret = agentClientSecret();
  await context.env.DB.prepare(
    `INSERT INTO agent_client
     (client_id, org_id, host, name, secret_hash, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      clientId,
      org,
      body.host,
      body.name,
      await sha256hex(secret),
      Date.now(),
    )
    .run();

  // Shown once and stored only as a hash, exactly as a device token is.
  return context.json(
    {
      client_id: clientId,
      client_secret: secret,
      address: formatAgentAddress(body.name, body.host),
      token_endpoint: new URL("/oauth/token", context.req.url).toString(),
    },
    201,
  );
});

app.delete("/api/agent-clients/:clientId", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const result = await context.env.DB.prepare(
    "UPDATE agent_client SET revoked_at = ? WHERE org_id = ? AND client_id = ? AND revoked_at IS NULL",
  )
    .bind(Date.now(), org, context.req.param("clientId"))
    .run();
  if (result.meta.changes === 0) {
    return context.json({ error: "agent_client_not_found" }, 404);
  }
  return context.json({ revoked: true, client_id: context.req.param("clientId") });
});

/**
 * Consent, enforced by the server rather than requested by the client.
 *
 * Better Auth's authorize handler records `requireConsent: query.prompt ===
 * "consent"` and, when the prompt is absent, mints the code and redirects
 * BEFORE it ever looks at the consent page (`mcp/authorize.mjs:96-113`). So the
 * consent screen gates nothing against a client that simply omits the
 * parameter — which an attacker's client does. Combined with registration, that
 * was a one-click read of a victim's whole organization.
 *
 * The plugin exposes no option for this, so the prompt is forced here unless a
 * prior grant already covers this exact user, client and scopes. Forcing rather
 * than rejecting: Claude does not send the parameter either, and rejecting
 * would break the connector instead of protecting it.
 */
app.get("/api/auth/mcp/authorize", async (context) => {
  const url = new URL(context.req.url);
  const clientId = url.searchParams.get("client_id");
  // Absent scope means the plugin's own default, so the comparison below has to
  // use the same value rather than an empty set that trivially "covers".
  const requested = (url.searchParams.get("scope") ?? "openid")
    .split(" ")
    .filter(Boolean);
  const session = await authFor(context).api.getSession({
    headers: context.req.raw.headers,
  });

  let alreadyGranted = false;
  if (session && clientId) {
    // Better Auth appends a row per approval rather than updating one, so the
    // grant is the union across rows, not the newest of them.
    const rows = await context.env.DB.prepare(
      `SELECT scopes FROM oauth_consent
       WHERE client_id = ? AND user_id = ? AND consent_given = 1`,
    )
      .bind(clientId, session.user.id)
      .all<{ scopes: string | null }>();
    const granted = new Set(
      rows.results.flatMap((row) => (row.scopes ?? "").split(" ").filter(Boolean)),
    );
    alreadyGranted =
      rows.results.length > 0 && requested.every((scope) => granted.has(scope));
  }
  if (!alreadyGranted) url.searchParams.set("prompt", "consent");

  // An unauthenticated visitor is redirected to sign in with this query stored
  // in a signed cookie and replayed afterwards, so the forced prompt survives
  // the login round trip.
  return authFor(context).handler(new Request(url, context.req.raw));
});

/**
 * Registration is for an operator, not for the internet.
 *
 * The plugin's `/mcp/register` resolves a session but does not require one, and
 * applies no allowlist or limit. An open registration endpoint lets anyone mint
 * a client called "Claude" pointing at their own redirect URI, which is the
 * second link in the chain the forced consent above breaks.
 *
 * The trade-off is real and deliberate: Claude performs DCR unauthenticated
 * during connector setup, so gating this means an operator registers the client
 * by hand and enters the id and secret into Claude as a custom connector. For a
 * deployment with one operator that is strictly safer — the client is scoped to
 * the organization that created it instead of to whoever found the URL. A
 * self-hoster who wants open DCR can remove this route; `docs/security.md` says
 * so, and `registration_endpoint` is left out of the advertised metadata rather
 * than advertised and refused.
 */
app.post("/api/auth/mcp/register", async (context) => {
  const membership = await sessionOrganization(context);
  if (!membership) return context.json({ error: "Unauthorized" }, 401);
  if (!canAdministerOrganization(membership.role)) {
    return context.json({ error: "forbidden" }, 403);
  }
  return authFor(context).handler(context.req.raw);
});

/**
 * `/mcp/get-session` returns the whole `oauthAccessToken` row — including the
 * REFRESH token — to any holder of the one-hour access token, which turns a
 * leaked access token into seven days of access. Transit never calls it over
 * HTTP: `/mcp` reads the session through `auth.api.getMcpSession()` in process.
 * It exists here only to leak, so it is closed.
 */
app.all("/api/auth/mcp/get-session", (context) =>
  context.json({ error: "not_found" }, 404),
);

app.on(["GET", "POST"], "/api/auth/*", (context) => {
  return authFor(context).handler(context.req.raw);
});
app.get("/api/docs", (context) => {
  context.header("Cache-Control", "public, max-age=300");
  return context.json({ documents: publicDocs });
});


app.get("/api/me", async (context) => {
  const session = await authFor(context).api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session) return context.json({ authenticated: false }, 401);
  return context.json({
    authenticated: true,
    user: session.user,
    active_organization_id: session.session.activeOrganizationId ?? null,
  });
});

app.get("/api/organization-connections", async (context) => {
  const membership = await sessionOrganization(context);
  if (!membership) return context.json({ error: "Unauthorized" }, 401);
  const rows = await context.env.DB.prepare(
    `SELECT c.id, c.status, c.requested_by_org_id, c.created_at, c.accepted_at,
            peer.id AS peer_id, peer.name AS peer_name, peer.slug AS peer_slug
     FROM organization_connection c
     JOIN organization peer
       ON peer.id = CASE WHEN c.org_a_id = ? THEN c.org_b_id ELSE c.org_a_id END
     WHERE c.org_a_id = ? OR c.org_b_id = ?
     ORDER BY c.status, peer.name, peer.slug`,
  )
    .bind(membership.id, membership.id, membership.id)
    .all<{
      id: string;
      status: "pending" | "active";
      requested_by_org_id: string;
      created_at: number;
      accepted_at: number | null;
      peer_id: string;
      peer_name: string;
      peer_slug: string;
    }>();
  return context.json({
    connections: rows.results.map((row) => ({
      id: row.id,
      status: row.status,
      requested_by_me: row.requested_by_org_id === membership.id,
      can_accept:
        row.status === "pending" &&
        row.requested_by_org_id !== membership.id &&
        canAdministerOrganization(membership.role),
      can_manage: canAdministerOrganization(membership.role),
      created_at: row.created_at,
      accepted_at: row.accepted_at,
      peer: {
        id: row.peer_id,
        name: row.peer_name,
        slug: row.peer_slug,
        address_prefix: `${row.peer_slug}/`,
      },
    })),
  });
});

app.post("/api/organization-connections", async (context) => {
  const membership = await sessionOrganization(context);
  if (!membership) return context.json({ error: "Unauthorized" }, 401);
  if (!canAdministerOrganization(membership.role)) {
    return context.json({ error: "organization_admin_required" }, 403);
  }
  const body = await context.req
    .json<{ organization_slug?: unknown }>()
    .catch(() => null);
  if (!body || typeof body.organization_slug !== "string") {
    return context.json({ error: "organization_slug is required" }, 400);
  }
  try {
    validateOrganizationSlug(body.organization_slug);
  } catch {
    return context.json({ error: "invalid_organization_slug" }, 400);
  }
  const peer = await organizationBySlug(
    context.env.DB,
    body.organization_slug,
  );
  if (!peer) return context.json({ error: "organization_not_found" }, 404);
  if (peer.id === membership.id) {
    return context.json({ error: "cannot_connect_same_organization" }, 400);
  }

  const [orgAId, orgBId] = organizationPair(membership.id, peer.id);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const inserted = await context.env.DB.prepare(
    `INSERT INTO organization_connection
     (id, org_a_id, org_b_id, requested_by_org_id, status, created_at, accepted_at)
     VALUES (?, ?, ?, ?, 'pending', ?, NULL)
     ON CONFLICT(org_a_id, org_b_id) DO NOTHING`,
  )
    .bind(id, orgAId, orgBId, membership.id, createdAt)
    .run();
  if (inserted.meta.changes === 0) {
    return context.json({ error: "organization_connection_exists" }, 409);
  }
  return context.json(
    {
      connection: {
        id,
        status: "pending",
        requested_by_me: true,
        can_accept: false,
        created_at: createdAt,
        can_manage: true,
        accepted_at: null,
        peer: {
          id: peer.id,
          name: peer.name,
          slug: peer.slug,
          address_prefix: `${peer.slug}/`,
        },
      },
    },
    201,
  );
});

app.post("/api/organization-connections/:id/accept", async (context) => {
  const membership = await sessionOrganization(context);
  if (!membership) return context.json({ error: "Unauthorized" }, 401);
  if (!canAdministerOrganization(membership.role)) {
    return context.json({ error: "organization_admin_required" }, 403);
  }
  const connection = await context.env.DB.prepare(
    `SELECT org_a_id, org_b_id, requested_by_org_id, status
     FROM organization_connection WHERE id = ? LIMIT 1`,
  )
    .bind(context.req.param("id"))
    .first<{
      org_a_id: string;
      org_b_id: string;
      requested_by_org_id: string;
      status: "pending" | "active";
    }>();
  if (
    !connection ||
    (connection.org_a_id !== membership.id &&
      connection.org_b_id !== membership.id)
  ) {
    return context.json({ error: "organization_connection_not_found" }, 404);
  }
  if (connection.requested_by_org_id === membership.id) {
    return context.json({ error: "requesting_organization_cannot_accept" }, 403);
  }
  if (connection.status === "active") {
    return context.json({ accepted: true, connection: context.req.param("id") });
  }
  const acceptedAt = Date.now();
  await context.env.DB.prepare(
    `UPDATE organization_connection
     SET status = 'active', accepted_at = ?
     WHERE id = ? AND status = 'pending'`,
  )
    .bind(acceptedAt, context.req.param("id"))
    .run();
  return context.json({
    accepted: true,
    connection: context.req.param("id"),
    accepted_at: acceptedAt,
  });
});

app.delete("/api/organization-connections/:id", async (context) => {
  const membership = await sessionOrganization(context);
  if (!membership) return context.json({ error: "Unauthorized" }, 401);
  if (!canAdministerOrganization(membership.role)) {
    return context.json({ error: "organization_admin_required" }, 403);
  }
  const deleted = await context.env.DB.prepare(
    `DELETE FROM organization_connection
     WHERE id = ? AND (org_a_id = ? OR org_b_id = ?)`,
  )
    .bind(context.req.param("id"), membership.id, membership.id)
    .run();
  if (deleted.meta.changes === 0) {
    return context.json({ error: "organization_connection_not_found" }, 404);
  }
  return context.json({ deleted: true, connection: context.req.param("id") });
});


app.post("/api/hosts/enroll", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);

  const body = await context.req.json<{ slug?: unknown }>().catch(() => null);
  if (!body || typeof body.slug !== "string") {
    return context.json({ error: "slug is required" }, 400);
  }
  try {
    validateHost(body.slug);
  } catch (error) {
    const code = error instanceof AddressError ? error.code : "invalid_name";
    return context.json({ error: code }, 400);
  }

  const existing = await context.env.DB.prepare(
    "SELECT revoked_at FROM host WHERE org_id = ? AND slug = ? LIMIT 1",
  )
    .bind(org, body.slug)
    .first<{ revoked_at: number | null }>();
  if (existing && existing.revoked_at === null) {
    return context.json({ error: "host_exists" }, 409);
  }



  const code = enrollCode();
  const codeHash = await sha256hex(code);
  const now = Date.now();
  const expiresAt = now + ENROLL_TTL_MS;
  await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE enroll_code SET used_at = ? WHERE org_id = ? AND slug = ? AND used_at IS NULL",
    ).bind(now, org, body.slug),
    context.env.DB.prepare(
      "INSERT INTO enroll_code (code_hash, org_id, slug, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)",
    ).bind(codeHash, org, body.slug, expiresAt),
  ]);

  // The enrollment command has to name an origin the daemon can reach.
  // `BETTER_AUTH_URL` is that origin on a configured deployment; falling back
  // to the request's own origin keeps the command correct on a fresh
  // self-hosted Worker whose var is still unset or malformed.
  let origin: string;
  try {
    origin = new URL(context.env.BETTER_AUTH_URL).origin;
  } catch {
    origin = new URL(context.req.url).origin;
  }
  return context.json({
    code,
    expires_at: new Date(expiresAt).toISOString(),
    command: `transit enroll --url ${origin} --code ${code}`,
  });
});

/**
 * Issue a host its device token, creating or re-arming the host row.
 *
 * Shared by both enrollment paths: the pre-issued code and the device flow.
 * The token is returned once and only its hash is kept, so a caller that fails
 * to persist what it gets back has to enroll again.
 */
async function provisionHost(
  database: D1Database,
  org: string,
  slug: string,
  daemonVer: string,
): Promise<{ device_token: string; host_id: string; host: string; org: string }> {
  const token = deviceToken();
  const tokenHash = await sha256hex(token);
  const existing = await database
    .prepare("SELECT id FROM host WHERE org_id = ? AND slug = ? LIMIT 1")
    .bind(org, slug)
    .first<{ id: string }>();
  const id = existing?.id ?? hostId();

  await database
    .prepare(
      `INSERT INTO host
       (id, org_id, slug, token_hash, token_issued_at, daemon_ver, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(org_id, slug) DO UPDATE SET
         token_hash = excluded.token_hash,
         token_issued_at = excluded.token_issued_at,
         daemon_ver = excluded.daemon_ver,
         last_seen_at = NULL,
         revoked_at = NULL`,
    )
    .bind(id, org, slug, tokenHash, Date.now(), daemonVer)
    .run();

  return { device_token: token, host_id: id, host: slug, org };
}

/**
 * Start a device-authorization flow. Unauthenticated by design: the daemon has
 * no credential yet, which is the whole point. What it gets back is a secret
 * `device_code` to poll with and a short `user_code` for a person to confirm.
 */
app.post("/api/device/authorize", async (context) => {
  const body = await context.req
    .json<{ hostname?: unknown; daemon_ver?: unknown }>()
    .catch(() => null);
  if (
    !body ||
    typeof body.daemon_ver !== "string" ||
    body.daemon_ver.length === 0 ||
    body.daemon_ver.length > 100 ||
    typeof body.hostname !== "string" ||
    body.hostname.length === 0 ||
    body.hostname.length > 100
  ) {
    return context.json({ error: "invalid_request" }, 400);
  }

  const code = deviceToken();
  const codeHash = await sha256hex(code);
  const expiresAt = Date.now() + ENROLL_TTL_MS;

  // A user code collides only against the live rows the sweep has not yet
  // removed, so a couple of retries is plenty.
  let userCode = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = enrollCode();
    const taken = await context.env.DB.prepare(
      "SELECT 1 FROM device_authorization WHERE user_code = ? AND expires_at > ? LIMIT 1",
    )
      .bind(candidate, Date.now())
      .first();
    if (!taken) {
      userCode = candidate;
      break;
    }
  }
  if (!userCode) return context.json({ error: "server_error" }, 503);

  await context.env.DB.prepare(
    `INSERT INTO device_authorization
     (device_code_hash, user_code, org_id, slug, hostname, daemon_ver, expires_at,
      approved_at, claimed_at, polled_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)`,
  )
    .bind(codeHash, userCode, body.hostname, body.daemon_ver, expiresAt)
    .run();

  let origin: string;
  try {
    origin = new URL(context.env.BETTER_AUTH_URL).origin;
  } catch {
    origin = new URL(context.req.url).origin;
  }

  return context.json({
    device_code: code,
    user_code: userCode,
    verification_uri: `${origin}/activate`,
    verification_uri_complete: `${origin}/activate?code=${userCode}`,
    expires_in: Math.floor(ENROLL_TTL_MS / 1000),
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  });
});

/**
 * Poll for the result of a device flow. Answers in RFC 8628's vocabulary:
 * `authorization_pending` until a person approves, `slow_down` if the daemon
 * polls faster than the interval it was given, `expired_token` once the window
 * closes. The device code is single-use — `claimed_at` closes it the moment a
 * token is handed over.
 */
app.post("/api/device/token", async (context) => {
  const body = await context.req
    .json<{ device_code?: unknown }>()
    .catch(() => null);
  if (!body || typeof body.device_code !== "string") {
    return context.json({ error: "invalid_request" }, 400);
  }

  const codeHash = await sha256hex(body.device_code);
  const now = Date.now();
  const row = await context.env.DB.prepare(
    `SELECT user_code, org_id, slug, daemon_ver, expires_at, approved_at, claimed_at, polled_at
     FROM device_authorization WHERE device_code_hash = ? LIMIT 1`,
  )
    .bind(codeHash)
    .first<{
      user_code: string;
      org_id: string | null;
      slug: string | null;
      daemon_ver: string;
      expires_at: number;
      approved_at: number | null;
      claimed_at: number | null;
      polled_at: number | null;
    }>();

  // An unknown or already-claimed code is the same answer: nothing to give.
  if (!row || row.claimed_at !== null) {
    return context.json({ error: "invalid_grant" }, 400);
  }
  if (row.expires_at <= now) {
    return context.json({ error: "expired_token" }, 400);
  }
  if (
    row.polled_at !== null &&
    now - row.polled_at < DEVICE_POLL_INTERVAL_SECONDS * 1_000 * 0.8
  ) {
    return context.json({ error: "slow_down" }, 429);
  }

  await context.env.DB.prepare(
    "UPDATE device_authorization SET polled_at = ? WHERE device_code_hash = ?",
  )
    .bind(now, codeHash)
    .run();

  if (row.approved_at === null || !row.org_id || !row.slug) {
    return context.json({ error: "authorization_pending" }, 400);
  }

  // Claim first. If provisioning then fails the flow is spent rather than
  // replayable, which is the safe direction for a credential-issuing step.
  const claimed = await context.env.DB.prepare(
    "UPDATE device_authorization SET claimed_at = ? WHERE device_code_hash = ? AND claimed_at IS NULL RETURNING user_code",
  )
    .bind(now, codeHash)
    .first<{ user_code: string }>();
  if (!claimed) return context.json({ error: "invalid_grant" }, 400);

  const provisioned = await provisionHost(
    context.env.DB,
    row.org_id,
    row.slug,
    row.daemon_ver,
  );
  return context.json(provisioned);
});

/**
 * Approve a pending flow from the browser. Authenticated, so this is where the
 * flow acquires an organization; the daemon never names one.
 */
app.post("/api/device/approve", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);

  const body = await context.req
    .json<{ user_code?: unknown; slug?: unknown }>()
    .catch(() => null);
  if (!body || typeof body.user_code !== "string") {
    return context.json({ error: "user_code is required" }, 400);
  }

  const userCode = body.user_code.trim().toUpperCase();
  const now = Date.now();
  const pending = await context.env.DB.prepare(
    `SELECT device_code_hash, hostname, approved_at FROM device_authorization
     WHERE user_code = ? AND expires_at > ? AND claimed_at IS NULL LIMIT 1`,
  )
    .bind(userCode, now)
    .first<{ device_code_hash: string; hostname: string; approved_at: number | null }>();
  if (!pending) return context.json({ error: "unknown_code" }, 404);
  if (pending.approved_at !== null) {
    return context.json({ error: "already_approved" }, 409);
  }

  const slug = typeof body.slug === "string" && body.slug ? body.slug : pending.hostname;
  try {
    validateHost(slug);
  } catch (error) {
    const code = error instanceof AddressError ? error.code : "invalid_name";
    return context.json({ error: code }, 400);
  }

  // Re-enrolling a live host is how a machine is rebuilt or its token rotated,
  // so an existing slug is allowed here — unlike the pre-issued code path,
  // which refuses because the operator picked the name before seeing a conflict.
  await context.env.DB.prepare(
    "UPDATE device_authorization SET approved_at = ?, org_id = ?, slug = ? WHERE device_code_hash = ?",
  )
    .bind(now, org, slug, pending.device_code_hash)
    .run();

  return context.json({ approved: true, host: slug });
});

/**
 * What the browser shows before asking someone to approve. Read-only, and
 * deliberately unauthenticated-but-useless: it reveals only the hostname the
 * daemon offered, never an organization.
 */
app.get("/api/device/pending/:code", async (context) => {
  const userCode = context.req.param("code").trim().toUpperCase();
  const row = await context.env.DB.prepare(
    `SELECT hostname, daemon_ver, approved_at FROM device_authorization
     WHERE user_code = ? AND expires_at > ? AND claimed_at IS NULL LIMIT 1`,
  )
    .bind(userCode, Date.now())
    .first<{ hostname: string; daemon_ver: string; approved_at: number | null }>();
  if (!row) return context.json({ error: "unknown_code" }, 404);
  return context.json({
    hostname: row.hostname,
    daemon_ver: row.daemon_ver,
    approved: row.approved_at !== null,
  });
});

app.post("/api/daemon/enroll", async (context) => {
  const body = await context.req
    .json<{ code?: unknown; daemon_ver?: unknown }>()
    .catch(() => null);
  if (
    !body ||
    typeof body.code !== "string" ||
    typeof body.daemon_ver !== "string" ||
    body.daemon_ver.length === 0 ||
    body.daemon_ver.length > 100
  ) {
    return context.json({ error: "Unauthorized" }, 401);
  }

  const normalizedCode = body.code.trim().toUpperCase();
  const codeHash = await sha256hex(normalizedCode);
  const usedAt = Date.now();
  const enrollment = await context.env.DB.prepare(
    `UPDATE enroll_code SET used_at = ?
     WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
     RETURNING org_id, slug`,
  )
    .bind(usedAt, codeHash, usedAt)
    .first<{ org_id: string; slug: string }>();
  if (!enrollment) return context.json({ error: "Unauthorized" }, 401);

  try {
    return context.json(
      await provisionHost(
        context.env.DB,
        enrollment.org_id,
        enrollment.slug,
        body.daemon_ver,
      ),
    );
  } catch (error) {
    // Hand the code back if the host never got written, so a transient failure
    // does not burn the operator's single-use code.
    await context.env.DB.prepare(
      "UPDATE enroll_code SET used_at = NULL WHERE code_hash = ? AND used_at = ?",
    )
      .bind(codeHash, usedAt)
      .run();
    throw error;
  }
});

app.get("/api/daemon/ws", async (context) => {
  if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return context.json({ error: "WebSocket upgrade required" }, 426);
  }
  const authorization = context.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return context.json({ error: "Unauthorized" }, 401);
  }
  const token = authorization.slice("Bearer ".length);
  if (!token) return context.json({ error: "Unauthorized" }, 401);

  const tokenHash = await sha256hex(token);
  const row = await context.env.DB.prepare(
    `SELECT id, org_id, slug FROM host
     WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{ id: string; org_id: string; slug: string }>();
  if (!row) return context.json({ error: "Unauthorized" }, 401);

  const hub = context.env.HOST_HUB.getByName(`org:${row.org_id}:host:${row.slug}`);
  return hub.fetch(
    websocketRequest(context.req.raw, {
      "x-transit-role": "daemon",
      "x-transit-host-id": row.id,
      "x-transit-org": row.org_id,
      "x-transit-slug": row.slug,
    }),
  );
});

app.get("/api/hosts", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);

  const rows = await context.env.DB.prepare(
    `SELECT h.id, h.slug, h.daemon_ver, h.last_seen_at, h.token_issued_at,
            substr(h.token_hash, 1, 8) AS token_fingerprint,
            COUNT(a.name) AS agent_count
     FROM host h LEFT JOIN agent_snapshot a ON a.host_id = h.id
     WHERE h.org_id = ? AND h.revoked_at IS NULL
     GROUP BY h.id
     ORDER BY h.slug`,
  )
    .bind(org)
    .all<{
      id: string;
      slug: string;
      daemon_ver: string;
      last_seen_at: number | null;
      token_issued_at: number;
      token_fingerprint: string;
      agent_count: number;
    }>();

  const hosts = await Promise.all(
    rows.results.map(async (row) => {
      const state = await context.env.HOST_HUB.getByName(
        `org:${org}:host:${row.slug}`,
      ).status();
      return {
        ...row,
        connected: Boolean(state.connected),
        queue_depth: state.queueDepth,
        // Null distinguishes "this daemon has not reported" from "none", so an
        // old daemon cannot read as a clean box.
        spooled_dead: state.spooledDead ?? null,
      };
    }),
  );
  return context.json({ hosts });
});

app.delete("/api/hosts/:slug", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const slug = context.req.param("slug");
  try {
    validateHost(slug);
  } catch {
    return context.json({ error: "host_not_found" }, 404);
  }

  const result = await context.env.DB.prepare(
    "UPDATE host SET revoked_at = ? WHERE org_id = ? AND slug = ? AND revoked_at IS NULL",
  )
    .bind(Date.now(), org, slug)
    .run();
  if (result.meta.changes === 0) return context.json({ error: "host_not_found" }, 404);

  await context.env.HOST_HUB.getByName(`org:${org}:host:${slug}`).revoke(org);
  return context.json({ revoked: true, host: slug });
});

app.get("/api/agents", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const hostFilter = context.req.query("host");
  if (hostFilter) {
    try {
      validateHost(hostFilter);
    } catch {
      return context.json({ error: "invalid_host" }, 400);
    }
  }
  try {
    return context.json({
      agents: await listAgents(context.env.DB, {
        org,
        host: hostFilter ?? null,
        organization: context.req.query("organization") ?? null,
      }),
    });
  } catch (error) {
    if (error instanceof ServiceError) return context.json({ error: error.code }, 409);
    throw error;
  }
});

app.get("/api/activity", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const activity = await context.env.DB.prepare(
    `SELECT m.id, m.kind, m.from_addr, m.to_addr,
            substr(m.body, 1, 240) AS preview, m.created_at,
            CASE WHEN SUM(CASE WHEN d.status = 'dead' THEN 1 ELSE 0 END) > 0
              THEN 'dead'
              WHEN SUM(CASE WHEN d.status = 'queued' THEN 1 ELSE 0 END) > 0
              THEN 'queued'
              ELSE 'injected'
            END AS status,
            COALESCE(MAX(d.attempts), 0) AS attempts,
            MAX(d.last_error) AS last_error
     FROM message m
     LEFT JOIN message_delivery d ON d.message_id = m.id
     WHERE m.org_id = ? OR m.recipient_org_id = ?
     GROUP BY m.id
     ORDER BY m.created_at DESC
     LIMIT 101`,
  )
    .bind(org, org)
    .all();
  // The feed is a window, so the tiles cannot be derived from it: counting
  // `dead` over the newest 100 messages hides every dead letter older than
  // them, which is a health number that cannot fail. Count over the whole
  // 24-hour window instead, and say when the feed itself is clipped.
  const since = Date.now() - 24 * 60 * 60_000;
  const window = await context.env.DB.prepare(
    `SELECT COUNT(*) AS deliveries,
            SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
            SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
     FROM (
       SELECT CASE WHEN SUM(CASE WHEN d.status = 'dead' THEN 1 ELSE 0 END) > 0
                     THEN 'dead'
                   WHEN SUM(CASE WHEN d.status = 'queued' THEN 1 ELSE 0 END) > 0
                     THEN 'queued'
                   ELSE 'injected'
              END AS status
       FROM message m
       LEFT JOIN message_delivery d ON d.message_id = m.id
       WHERE (m.org_id = ? OR m.recipient_org_id = ?) AND m.created_at >= ?
       GROUP BY m.id
     )`,
  )
    .bind(org, org, since)
    .first<{ deliveries: number; dead: number | null; queued: number | null }>();
  return context.json({
    activity: activity.results.slice(0, 100),
    truncated: activity.results.length > 100,
    window: {
      deliveries_24h: window?.deliveries ?? 0,
      dead_24h: window?.dead ?? 0,
      queued_24h: window?.queued ?? 0,
    },
  });
});

app.get("/api/rooms", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  return context.json({
    rooms: await listRooms(context.env.DB, {
      org,
      activityWindowMs: 24 * 60 * 60_000,
    }),
  });
});

app.post("/api/rooms", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const body = await context.req
    .json<{ name?: unknown; policy?: unknown }>()
    .catch(() => null);
  if (
    !body ||
    typeof body.name !== "string" ||
    (body.policy !== "open" && body.policy !== "invite")
  ) {
    return context.json({ error: "name and policy are required" }, 400);
  }
  try {
    validateName(body.name);
  } catch (error) {
    const code = error instanceof AddressError ? error.code : "invalid_name";
    return context.json({ error: code }, 400);
  }
  const created = await createRoom(context.env, {
    org,
    name: body.name,
    policy: body.policy,
  });
  if (!created.created) return context.json({ error: "room_exists" }, 409);
  return context.json({ room: created.room }, 201);
});

app.get("/api/rooms/:name", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const name = context.req.param("name");
  const exists = await context.env.DB.prepare(
    "SELECT 1 AS present FROM room WHERE org_id = ? AND name = ? LIMIT 1",
  )
    .bind(org, name)
    .first();
  if (!exists) return context.json({ error: "room_not_found" }, 404);
  return context.json({
    room: await context.env.ROOM.getByName(`org:${org}:room:${name}`).detail(),
  });
});

app.post("/api/rooms/:name/members", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const name = context.req.param("name");
  const body = await context.req.json<{ address?: unknown }>().catch(() => null);
  if (!body || typeof body.address !== "string") {
    return context.json({ error: "address is required" }, 400);
  }
  let address;
  try {
    address = parseAddress(body.address);
  } catch {
    return context.json({ error: "invalid_address" }, 400);
  }
  if (address.kind !== "agent") return context.json({ error: "invalid_address" }, 400);

  const connected = address.organization
    ? await resolveConnectedOrganization(context.env.DB, org, address.organization)
    : null;
  if (address.organization && !connected) {
    return context.json({ error: "organization_not_connected" }, 409);
  }
  const memberOrg = connected?.targetOrgId ?? org;
  if (
    !(await agentExists(context.env.DB, {
      org: memberOrg,
      host: address.host,
      name: address.name,
    }))
  ) {
    return context.json({ error: "agent_not_found" }, 404);
  }
  try {
    const result = await context.env.ROOM.getByName(
      `org:${org}:room:${name}`,
    ).join(
      address.address,
      "operator",
      connected
        ? {
            org: connected.targetOrgId,
            orgSlug: connected.targetSlug,
            connectionId: connected.connectionId,
          }
        : undefined,
    );
    if (result.error) return context.json({ error: result.error }, 409);
    return context.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "room_error";
    return context.json({ error: message }, message === "room_full" ? 409 : 404);
  }
});

app.delete("/api/rooms/:name/members/:address", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const result = await context.env.ROOM.getByName(
    `org:${org}:room:${context.req.param("name")}`,
  ).leave(context.req.param("address"));
  return context.json(result);
});

app.post("/api/rooms/:name/post", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const body = await context.req
    .json<{ body?: unknown; reply_to?: unknown }>()
    .catch(() => null);
  if (!body || typeof body.body !== "string") {
    return context.json({ error: "body is required" }, 400);
  }
  const room = context.env.ROOM.getByName(
    `org:${org}:room:${context.req.param("name")}`,
  );
  if (!(await room.canPost())) return context.json({ error: "plan_limit" }, 402);
  try {
    const message = await room.post(
      "operator@transit",
      body.body,
      typeof body.reply_to === "string" ? body.reply_to : undefined,
    );
    return context.json({ message }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "room_error";
    const status = message === "body_too_large" ? 413 : message === "plan_limit" ? 402 : 404;
    return context.json({ error: message }, status);
  }
});

app.delete("/api/rooms/:name", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const name = context.req.param("name");
  const exists = await context.env.DB.prepare(
    "SELECT 1 AS present FROM room WHERE org_id = ? AND name = ? LIMIT 1",
  )
    .bind(org, name)
    .first();
  if (!exists) return context.json({ error: "room_not_found" }, 404);
  await context.env.ROOM.getByName(`org:${org}:room:${name}`).destroy();
  return context.json({ deleted: true, room: name });
});

app.get("/api/integrations", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const rows = await context.env.DB.prepare(
    `SELECT id, org_id, connector, name, target_addr, status, created_at
     FROM integration WHERE org_id = ? ORDER BY created_at DESC`,
  )
    .bind(org)
    .all<IntegrationRow>();
  const integrations = await Promise.all(
    rows.results.map(async (row) => {
      try {
        return await context.env.INTEGRATION.getByName(
          `org:${org}:integration:${row.id}`,
        ).detail();
      } catch (error) {
        return {
          meta: {
            org: row.org_id,
            id: row.id,
            connector: row.connector,
            name: row.name,
            targetAddr: row.target_addr,
            status: row.status,
            createdAt: row.created_at,
          },
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return context.json({
    integrations,
    connectors: Object.values(CONNECTORS)
      .filter((connector) => connector.name !== "ingest")
      .map((connector) => ({
        name: connector.name,
        mode: connector.mode,
        configFields: [...connector.configFields, HEALTH_CONFIG_FIELD],
      })),
  });
});

app.post("/api/integrations", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const body = await context.req
    .json<{
      connector?: unknown;
      name?: unknown;
      target_addr?: unknown;
      config?: unknown;
    }>()
    .catch(() => null);
  if (
    !body ||
    typeof body.connector !== "string" ||
    typeof body.name !== "string" ||
    typeof body.target_addr !== "string" ||
    typeof body.config !== "object" ||
    body.config === null ||
    !(body.connector in CONNECTORS) ||
    body.name.trim().length === 0 ||
    body.name.length > 64
  ) {
    return context.json({ error: "invalid integration" }, 400);
  }


  try {
    if (!(await targetExists(context, org, body.target_addr))) {
      return context.json({ error: "target_not_found" }, 404);
    }
  } catch {
    return context.json({ error: "invalid_target" }, 400);
  }
  const id = intId();
  const createdAt = Date.now();
  const detail = await context.env.INTEGRATION.getByName(
    `org:${org}:integration:${id}`,
  ).configure({
    org,
    id,
    connector: body.connector,
    name: body.name.trim(),
    targetAddr: body.target_addr,
    config: body.config as Record<string, string>,
    createdAt,
  });
  return context.json({ integration: detail }, 201);
});

app.get("/api/integrations/:id", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const row = await integrationForOrg(context, org, context.req.param("id"));
  if (!row) return context.json({ error: "integration_not_found" }, 404);
  return context.json({
    integration: await context.env.INTEGRATION.getByName(
      `org:${org}:integration:${row.id}`,
    ).detail(),
  });
});

app.patch("/api/integrations/:id", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const row = await integrationForOrg(context, org, context.req.param("id"));
  if (!row) return context.json({ error: "integration_not_found" }, 404);
  const body = await context.req
    .json<{ name?: unknown; target_addr?: unknown; config?: unknown }>()
    .catch(() => null);
  if (!body) return context.json({ error: "invalid integration" }, 400);
  const stub = context.env.INTEGRATION.getByName(
    `org:${org}:integration:${row.id}`,
  );
  const existing = await stub.detail();
  const name = typeof body.name === "string" ? body.name.trim() : row.name;
  const target =
    typeof body.target_addr === "string" ? body.target_addr : row.target_addr;
  if (!name || name.length > 64) {
    return context.json({ error: "invalid_name" }, 400);
  }
  try {
    if (!(await targetExists(context, org, target))) {
      return context.json({ error: "target_not_found" }, 404);
    }
  } catch {
    return context.json({ error: "invalid_target" }, 400);
  }
  const config = {
    ...existing.config,
    ...(typeof body.config === "object" && body.config !== null
      ? (body.config as Record<string, string>)
      : {}),
  };
  return context.json({
    integration: await stub.configure({
      org,
      id: row.id,
      connector: row.connector,
      name,
      targetAddr: target,
      config,
      status: row.status,
      createdAt: row.created_at,
    }),
  });
});

app.delete("/api/integrations/:id", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const row = await integrationForOrg(context, org, context.req.param("id"));
  if (!row) return context.json({ error: "integration_not_found" }, 404);
  await context.env.INTEGRATION.getByName(
    `org:${org}:integration:${row.id}`,
  ).destroy();
  return context.json({ deleted: true, integration: row.id });
});

app.post("/api/integrations/:id/pause", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const row = await integrationForOrg(context, org, context.req.param("id"));
  if (!row) return context.json({ error: "integration_not_found" }, 404);
  const body = await context.req.json<{ paused?: unknown }>().catch(() => null);
  const paused = typeof body?.paused === "boolean" ? body.paused : row.status !== "paused";
  await context.env.INTEGRATION.getByName(
    `org:${org}:integration:${row.id}`,
  ).pause(paused);
  return context.json({ paused });
});

app.get("/api/deliveries", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const filter = context.req.query("f") ?? "all";
  const allowed = [
    "all",
    "unsettled",
    "pending",
    "dispatched",
    "read",
    "replied",
    "handled",
    "dead",
  ];
  if (!allowed.includes(filter)) return context.json({ error: "invalid_filter" }, 400);
  // The cap used to be hardcoded at 200 in both statements with no way to raise
  // it and no way to see it: a caller asking for more silently received 200 and
  // read it as the whole ledger, which is how a fleet sweep during an incident
  // came back reassuring. An out-of-range limit is refused rather than clamped,
  // because a quietly adjusted answer is the same defect again.
  const requested = context.req.query("limit");
  const limit = requested === undefined ? 200 : Number(requested);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return context.json({ error: "invalid_limit" }, 400);
  }
  const channel = await context.env.DB.prepare(
    `SELECT d.id, 'channel' AS kind, i.connector AS source, d.target_addr,
            d.status, d.attempts AS dispatches, d.wire_sends AS sends,
            d.injections AS arrivals,
            d.read_at, d.settled_at, d.created_at,
            e.conversation_id, e.user, substr(e.content, 1, 240) AS preview,
            r.posted_at, r.post_error, d.via
     FROM integration_delivery d
     JOIN integration_event e ON e.id = d.event_id
     JOIN integration i ON i.id = e.integration_id
     LEFT JOIN integration_reply r ON r.delivery_id = d.id
     WHERE i.org_id = ?
       AND (? = 'all' OR d.status = ? OR
            (? = 'unsettled' AND d.status IN ('pending','dispatched','read','replied')))
     ORDER BY d.created_at DESC LIMIT ?`,
  )
    .bind(org, filter, filter, filter, limit + 1)
    .all<Record<string, unknown>>();
  const messages = await context.env.DB.prepare(
    `SELECT m.id, m.kind, m.from_addr AS source,
            CASE WHEN COUNT(d.target_addr) > 1
              THEN CAST(COUNT(d.target_addr) AS TEXT) || ' members'
              ELSE COALESCE(MAX(d.target_addr), m.to_addr)
            END AS target_addr,
            CASE WHEN SUM(CASE WHEN d.status = 'dead' THEN 1 ELSE 0 END) > 0
              THEN 'dead'
              WHEN SUM(CASE WHEN d.status = 'queued' THEN 1 ELSE 0 END) > 0
              THEN 'queued'
              ELSE 'injected'
            END AS status,
            -- Wire sends, the same meaning "sends" carries on a channel row:
            -- message_delivery.attempts is already the HostHub's send count.
            COALESCE(MAX(d.attempts), 0) AS sends,
            NULL AS dispatches,
            -- Arrivals, not sends. The queue re-sends an unacked entry, and
            -- the daemon dedupes a tx_ id, so a message can be sent five
            -- times and surface once. Count the recipients it actually
            -- reached instead.
            SUM(CASE WHEN d.status = 'injected' THEN 1 ELSE 0 END) AS arrivals,
            NULL AS read_at, NULL AS settled_at,
            m.created_at, m.id AS conversation_id, NULL AS user,
            substr(m.body, 1, 240) AS preview, NULL AS posted_at,
            MAX(d.last_error) AS post_error,
            -- The transport that actually reached the agent. Aggregated with
            -- MAX because a message fanned out to several recipients can have
            -- taken a different path to each; the per-recipient truth is in
            -- message_delivery.
            MAX(d.via) AS via
     FROM message m LEFT JOIN message_delivery d ON d.message_id = m.id
     WHERE m.org_id = ? OR m.recipient_org_id = ?
     GROUP BY m.id
     ORDER BY m.created_at DESC LIMIT ?`,
  )
    .bind(org, org, limit + 1)
    .all<Record<string, unknown>>();
  const filteredMessages = messages.results.filter((delivery) =>
    filter === "all"
      ? true
      : filter === "unsettled"
        ? delivery.status === "queued"
        : delivery.status === filter,
  );
  const merged = [...channel.results, ...filteredMessages].sort(
    (left, right) => Number(right.created_at) - Number(left.created_at),
  );
  // Both statements fetch one row past the limit so truncation can be reported
  // rather than inferred: a ledger that silently ends at its cap reads as a
  // complete ledger, which is how a fleet sweep came back reassuring while a
  // redelivery loop was running. The message rows are status-filtered after the
  // statement, so `truncated` answers "more rows existed", not "more rows would
  // have matched this filter".
  const truncated =
    channel.results.length > limit || messages.results.length > limit || merged.length > limit;
  return context.json({
    deliveries: merged.slice(0, limit),
    limit,
    truncated,
  });
});

// Drops a stuck agent delivery from every HostHub queue holding it. `requeue`
// and `handle` only settle integration (`dlv_`) deliveries; before this an
// operator had no way to stop an agent message (`tx_`) that keeps redelivering
// because its recipient never acks — it just retried to the attempt cap.
app.post("/api/messages/:id/cancel", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const id = context.req.param("id");
  const rows = await context.env.DB.prepare(
    `SELECT d.target_addr FROM message_delivery d
     JOIN message m ON m.id = d.message_id
     WHERE d.message_id = ? AND m.org_id = ? AND d.status = 'queued'`,
  )
    .bind(id, org)
    .all<{ target_addr: string }>();
  if (rows.results.length === 0) return context.json({ error: "delivery_not_found" }, 404);
  const routes = new Map<string, { org: string; host: string }>();
  for (const row of rows.results) {
    try {
      const parsed = parseAddress(row.target_addr);
      if (parsed.kind !== "agent") continue;
      const targetOrg = parsed.organization
        ? await organizationIdBySlug(context.env.DB, parsed.organization)
        : org;
      if (targetOrg) {
        routes.set(`${targetOrg}\u0000${parsed.host}`, {
          org: targetOrg,
          host: parsed.host,
        });
      }
    } catch (error) {
      if (!(error instanceof AddressError)) throw error;
    }
  }
  let cancelled = 0;
  for (const route of routes.values()) {
    cancelled += await context.env.HOST_HUB.getByName(
      `org:${route.org}:host:${route.host}`,
    ).cancelDelivery(id);
  }
  await context.env.DB.prepare(
    `UPDATE message_delivery
     SET status = 'dead', last_error = 'cancelled_by_operator', updated_at = ?
     WHERE message_id = ? AND status = 'queued'`,
  )
    .bind(Date.now(), id)
    .run();
  return context.json({
    cancelled,
    hosts: [...new Set([...routes.values()].map((route) => route.host))],
  });
});

app.post("/api/deliveries/:id/requeue", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const row = await context.env.DB.prepare(
    `SELECT e.integration_id
     FROM integration_delivery d
     JOIN integration_event e ON e.id = d.event_id
     JOIN integration i ON i.id = e.integration_id
     WHERE d.id = ? AND i.org_id = ? LIMIT 1`,
  )
    .bind(context.req.param("id"), org)
    .first<{ integration_id: string }>();
  if (!row) return context.json({ error: "delivery_not_found" }, 404);
  await context.env.INTEGRATION.getByName(
    `org:${org}:integration:${row.integration_id}`,
  ).requeue(context.req.param("id"));
  return context.json({ requeued: true });
});

app.post("/api/deliveries/:id/handle", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const integrationId = await integrationForDelivery(context.env.DB, {
    org,
    deliveryId: context.req.param("id"),
  });
  if (!integrationId) return context.json({ error: "delivery_not_found" }, 404);
  const result = await context.env.INTEGRATION.getByName(
    `org:${org}:integration:${integrationId}`,
  ).operatorMarkHandled(context.req.param("id"));
  return context.json(result);
});

app.get("/api/attachments", async (context) => {
  const token = context.req.query("token");
  if (!token) return context.text("Attachment not found", 404);
  try {
    const claims = await readAttachmentCapability(
      token,
      context.env.TRANSIT_MASTER_KEY,
    );
    const stub = context.env.INTEGRATION.getByName(
      `org:${claims.org}:integration:${claims.integrationId}`,
    );
    const url = new URL("https://integration.invalid/attachment");
    url.searchParams.set("event", claims.eventId);
    url.searchParams.set("index", String(claims.index));
    return await stub.fetch(new Request(url));
  } catch {
    return context.text("Attachment not found", 404, {
      "cache-control": "private, no-store",
    });
  }
});

for (const connector of ["telegram", "kaneo"] as const) {
  app.post(`/hooks/${connector}/:id`, async (context) => {
    const row = await context.env.DB.prepare(
      `SELECT id, org_id, status FROM integration
       WHERE id = ? AND connector = ? LIMIT 1`,
    )
      .bind(context.req.param("id"), connector)
      .first<{ id: string; org_id: string; status: string }>();
    if (!row) return context.json({ error: "integration_not_found" }, 404);
    if (row.status !== "active") {
      return context.json({ error: "integration_paused" }, 409);
    }
    return context.env.INTEGRATION.getByName(
      `org:${row.org_id}:integration:${row.id}`,
    ).webhook(context.req.raw);
  });
}

app.get("/api/sources", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const rows = await context.env.DB.prepare(
    `SELECT s.source, s.secret_enc, s.reply_url, s.reply_url_prefixes,
            s.instructions, s.created_at, i.id AS integration_id,
            i.target_addr, i.status
     FROM ingest_source s
     JOIN integration i
       ON i.org_id = s.org_id AND i.connector = 'ingest' AND i.name = s.source
     WHERE s.org_id = ? ORDER BY s.source`,
  )
    .bind(org)
    .all<{
      source: string;
      secret_enc: string;
      reply_url: string | null;
      reply_url_prefixes: string;
      instructions: string | null;
      created_at: number;
      integration_id: string;
      target_addr: string;
      status: string;
    }>();
  const sources = await Promise.all(
    rows.results.map(async ({ secret_enc, ...row }) => ({
      ...row,
      reply_url_prefixes: parseReplyPrefixes(row.reply_url_prefixes),
      secret_fingerprint: await sha256hex(
        await openSecret(secret_enc, context.env.TRANSIT_MASTER_KEY),
      ),
    })),
  );
  return context.json({ sources });
});

app.post("/api/sources", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const body = await context.req
    .json<{
      source?: unknown;
      target_addr?: unknown;
      reply_url?: unknown;
      reply_url_prefixes?: unknown;
      instructions?: unknown;
    }>()
    .catch(() => null);
  if (
    !body ||
    typeof body.source !== "string" ||
    !SOURCE_NAME_PATTERN.test(body.source) ||
    body.source in CONNECTORS ||
    typeof body.target_addr !== "string" ||
    !Array.isArray(body.reply_url_prefixes) ||
    !body.reply_url_prefixes.every((value) => typeof value === "string") ||
    (body.reply_url !== undefined && typeof body.reply_url !== "string") ||
    (body.instructions !== undefined && typeof body.instructions !== "string")
  ) {
    return context.json({ error: "invalid source" }, 400);
  }
  const replyURL = body.reply_url || null;
  const replyPrefixes = body.reply_url_prefixes as string[];
  try {
    validateReplyConfiguration(replyURL, replyPrefixes);
    if (!(await targetExists(context, org, body.target_addr))) {
      return context.json({ error: "target_not_found" }, 404);
    }
  } catch (error) {
    return context.json(
      { error: error instanceof Error ? error.message : "invalid source" },
      400,
    );
  }
  const existing = await context.env.DB.prepare(
    "SELECT 1 AS present FROM ingest_source WHERE org_id = ? AND source = ? LIMIT 1",
  )
    .bind(org, body.source)
    .first();
  if (existing) return context.json({ error: "source_exists" }, 409);

  const secret = sourceSecret();
  const secretEnc = await sealSecret(secret, context.env.TRANSIT_MASTER_KEY);
  const integrationId = intId();
  const createdAt = Date.now();
  const integration = context.env.INTEGRATION.getByName(
    `org:${org}:integration:${integrationId}`,
  );
  await integration.configure({
    org,
    id: integrationId,
    connector: "ingest",
    name: body.source,
    targetAddr: body.target_addr,
    createdAt,
    config: {
      source: body.source,
      secret,
      reply_url: replyURL ?? "",
      reply_url_prefixes: JSON.stringify(replyPrefixes),
      instructions: typeof body.instructions === "string" ? body.instructions : "",
    },
  });
  try {
    await context.env.DB.prepare(
      `INSERT INTO ingest_source
       (org_id, source, secret_enc, reply_url, reply_url_prefixes, instructions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        org,
        body.source,
        secretEnc,
        replyURL,
        JSON.stringify(replyPrefixes),
        typeof body.instructions === "string" ? body.instructions : null,
        createdAt,
      )
      .run();
  } catch (error) {
    await integration.destroy();
    throw error;
  }
  return context.json(
    {
      source: {
        name: body.source,
        integration_id: integrationId,
        target_addr: body.target_addr,
        reply_url: replyURL,
        reply_url_prefixes: replyPrefixes,
        instructions: typeof body.instructions === "string" ? body.instructions : null,
        created_at: createdAt,
      },
      secret,
      endpoint: `${new URL(context.env.BETTER_AUTH_URL).origin}/ingest/${body.source}`,
    },
    201,
  );
});

app.patch("/api/sources/:source", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const source = context.req.param("source");
  const row = await context.env.DB.prepare(
    `SELECT s.secret_enc, s.reply_url, s.reply_url_prefixes, s.instructions,
            s.created_at, i.id AS integration_id, i.target_addr, i.status
     FROM ingest_source s
     JOIN integration i
       ON i.org_id = s.org_id AND i.connector = 'ingest' AND i.name = s.source
     WHERE s.org_id = ? AND s.source = ? LIMIT 1`,
  )
    .bind(org, source)
    .first<{
      secret_enc: string;
      reply_url: string | null;
      reply_url_prefixes: string;
      instructions: string | null;
      created_at: number;
      integration_id: string;
      target_addr: string;
      status: "active" | "paused";
    }>();
  if (!row) return context.json({ error: "source_not_found" }, 404);
  const body = await context.req
    .json<{
      target_addr?: unknown;
      reply_url?: unknown;
      reply_url_prefixes?: unknown;
      instructions?: unknown;
      rotate_secret?: unknown;
    }>()
    .catch(() => null);
  if (!body) return context.json({ error: "invalid source" }, 400);
  const target =
    typeof body.target_addr === "string" ? body.target_addr : row.target_addr;
  const replyURL =
    typeof body.reply_url === "string"
      ? body.reply_url || null
      : row.reply_url;
  const replyPrefixes = Array.isArray(body.reply_url_prefixes) &&
    body.reply_url_prefixes.every((value) => typeof value === "string")
    ? (body.reply_url_prefixes as string[])
    : parseReplyPrefixes(row.reply_url_prefixes);
  const instructions =
    typeof body.instructions === "string" ? body.instructions : row.instructions ?? "";
  try {
    validateReplyConfiguration(replyURL, replyPrefixes);
    if (!(await targetExists(context, org, target))) {
      return context.json({ error: "target_not_found" }, 404);
    }
  } catch (error) {
    return context.json(
      { error: error instanceof Error ? error.message : "invalid source" },
      400,
    );
  }
  const secret =
    body.rotate_secret === true
      ? sourceSecret()
      : await openSecret(row.secret_enc, context.env.TRANSIT_MASTER_KEY);
  const secretEnc =
    body.rotate_secret === true
      ? await sealSecret(secret, context.env.TRANSIT_MASTER_KEY)
      : row.secret_enc;
  await context.env.INTEGRATION.getByName(
    `org:${org}:integration:${row.integration_id}`,
  ).configure({
    org,
    id: row.integration_id,
    connector: "ingest",
    name: source,
    targetAddr: target,
    status: row.status,
    createdAt: row.created_at,
    config: {
      source,
      secret,
      reply_url: replyURL ?? "",
      reply_url_prefixes: JSON.stringify(replyPrefixes),
      instructions,
    },
  });
  await context.env.DB.prepare(
    `UPDATE ingest_source
     SET secret_enc = ?, reply_url = ?, reply_url_prefixes = ?, instructions = ?
     WHERE org_id = ? AND source = ?`,
  )
    .bind(
      secretEnc,
      replyURL,
      JSON.stringify(replyPrefixes),
      instructions || null,
      org,
      source,
    )
    .run();
  return context.json({
    updated: true,
    ...(body.rotate_secret === true ? { secret } : {}),
  });
});

app.delete("/api/sources/:source", async (context) => {
  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  const source = context.req.param("source");
  const row = await context.env.DB.prepare(
    `SELECT i.id AS integration_id
     FROM ingest_source s
     JOIN integration i
       ON i.org_id = s.org_id AND i.connector = 'ingest' AND i.name = s.source
     WHERE s.org_id = ? AND s.source = ? LIMIT 1`,
  )
    .bind(org, source)
    .first<{ integration_id: string }>();
  if (!row) return context.json({ error: "source_not_found" }, 404);
  await context.env.INTEGRATION.getByName(
    `org:${org}:integration:${row.integration_id}`,
  ).destroy();
  await context.env.DB.prepare(
    "DELETE FROM ingest_source WHERE org_id = ? AND source = ?",
  )
    .bind(org, source)
    .run();
  return context.json({ deleted: true, source });
});

app.get("/ingest/:source/health", async (context) => {
  const row = await context.env.DB.prepare(
    "SELECT 1 AS present FROM ingest_source WHERE source = ? LIMIT 1",
  )
    .bind(context.req.param("source"))
    .first();
  if (!row) return context.json({ error: "source_not_found" }, 404);
  return context.json({ ok: true, schema: "transit.ingest/1" });
});

app.post("/ingest/:source", async (context) => {
  const source = context.req.param("source");
  const candidates = await context.env.DB.prepare(
    `SELECT s.org_id, s.source, s.secret_enc, s.reply_url,
            s.reply_url_prefixes, s.instructions, i.id AS integration_id
     FROM ingest_source s
     JOIN integration i
       ON i.org_id = s.org_id AND i.connector = 'ingest' AND i.name = s.source
     WHERE s.source = ? AND i.status = 'active'`,
  )
    .bind(source)
    .all<{
      org_id: string;
      source: string;
      secret_enc: string;
      reply_url: string | null;
      reply_url_prefixes: string;
      instructions: string | null;
      integration_id: string;
    }>();
  if (candidates.results.length === 0) {
    return context.json({ error: "source_not_found" }, 404);
  }

  const raw = new Uint8Array(await context.req.raw.arrayBuffer());
  if (raw.byteLength > MAX_INGEST_BYTES) {
    return context.json({ error: "request_too_large" }, 413);
  }
  const timestamp = context.req.header("Transit-Timestamp") ?? "";
  const signatureHeader = context.req.header("Transit-Signature") ?? "";
  if (
    !/^\d+$/u.test(timestamp) ||
    !/^v1=[0-9a-f]{64}$/u.test(signatureHeader)
  ) {
    return context.json({ error: "Unauthorized" }, 401);
  }
  const timestampNumber = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampNumber) ||
    Math.abs(Math.floor(Date.now() / 1_000) - timestampNumber) >
      INGEST_TIMESTAMP_SKEW_SECONDS
  ) {
    return context.json({ error: "Unauthorized" }, 401);
  }
  const payload = signedIngestPayload(timestamp, raw);
  const expectedHex = signatureHeader.slice("v1=".length);
  const verified = await Promise.all(
    candidates.results.map(async (candidate) => {
      try {
        const secret = await openSecret(
          candidate.secret_enc,
          context.env.TRANSIT_MASTER_KEY,
        );
        return (await hmacVerify(secret, payload, expectedHex))
          ? { candidate, secret }
          : null;
      } catch {
        return null;
      }
    }),
  );
  const matches = verified.filter(
    (match): match is NonNullable<typeof match> => match !== null,
  );
  if (matches.length !== 1) {
    return context.json({ error: "Unauthorized" }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw),
    );
  } catch {
    return context.json({ error: "invalid_json" }, 400);
  }
  const match = matches[0];
  if (!match) return context.json({ error: "Unauthorized" }, 401);
  let event;
  try {
    event = validateIngestBody(
      parsed,
      parseReplyPrefixes(match.candidate.reply_url_prefixes),
    );
  } catch (error) {
    return context.json(
      { error: error instanceof Error ? error.message : "invalid_request" },
      400,
    );
  }
  event.meta = {
    ...event.meta,
    source,
  };
  try {
    const result = await context.env.INTEGRATION.getByName(
      `org:${match.candidate.org_id}:integration:${match.candidate.integration_id}`,
    ).ingestEvent(event);
    if (result.status === "rate_limited") {
      return context.json({ error: "rate_limited" }, 429);
    }
    if (result.status === "plan_limit") {
      return context.json({ error: "plan_limit" }, 402);
    }
    return context.json(
      {
        status: result.status,
        event_id: result.eventId,
        delivery_id: result.deliveryId,
      },
      result.status === "duplicate" ? 200 : 202,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("rate_limited")) {
      return context.json({ error: "rate_limited" }, 429);
    }
    throw error;
  }
});
app.get("/api/ui/ws", async (context) => {

  const org = await sessionOrg(context);
  if (!org) return context.json({ error: "Unauthorized" }, 401);
  if (context.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return context.json({ error: "WebSocket upgrade required" }, 426);
  }

  const scope = context.req.query("scope") ?? "fleet";
  let hubName: string;
  if (scope === "fleet") {
    hubName = `org:${org}:host:transit`;
  } else if (scope.startsWith("host:")) {
    const slug = scope.slice("host:".length);
    try {
      validateHost(slug);
    } catch {
      return context.json({ error: "invalid_scope" }, 400);
    }
    hubName = `org:${org}:host:${slug}`;
  } else if (scope.startsWith("room:")) {
    const name = scope.slice("room:".length);
    try {
      validateName(name);
    } catch {
      return context.json({ error: "invalid_scope" }, 400);
    }
    return context.env.ROOM.getByName(`org:${org}:room:${name}`).fetch(
      websocketRequest(context.req.raw, {
        "x-transit-role": "viewer",
        "x-transit-org": org,
        "x-transit-scope": scope,
      }),
    );
  } else {
    return context.json({ error: "invalid_scope" }, 400);
  }

  return context.env.HOST_HUB.getByName(hubName).fetch(
    websocketRequest(context.req.raw, {
      "x-transit-role": "viewer",
      "x-transit-org": org,
      "x-transit-scope": scope,
    }),
  );
});

export type AppOptions = {
  /** Extra Better Auth plugins, e.g. a subscription plugin. Defaults to none. */
  authPlugins?: AuthPluginFactory;
};

/**
 * Builds the Transit Worker app. The route table above is shared verbatim; a
 * deployment customizes it only through {@link AppOptions}, and may register
 * additional routes on the returned instance.
 */
export function createApp(options: AppOptions = {}) {
  const authPlugins = options.authPlugins ?? noAuthPlugins;
  const root = new Hono<TransitEnv>();
  root.use("*", async (context, next) => {
    context.set("authPlugins", authPlugins);
    await next();
  });
  root.route("/", app);
  return root;
}

/** Daily retention sweep. Shared by every distribution's entry point. */
export const scheduled: ExportedHandlerScheduledHandler<Env> = (
  _controller,
  env,
  executionContext,
) => {
  executionContext.waitUntil(
    sweep(env.DB)
      .then((result) => {
        console.log(JSON.stringify({ event: "retention_sweep", ...result }));
      })
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: "retention_sweep_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
  );
};

export { HostHub, Integration, Room };

const worker = createApp();
export default {
  fetch(request, env, executionContext) {
    return worker.fetch(request, env, executionContext);
  },
  scheduled,
} satisfies ExportedHandler<Env>;
