# Self-hosting Transit

`transit-server` is a complete, MIT-licensed Transit deployment for your own Cloudflare account. It provides the Worker API, Durable Objects, D1 database, Better Auth email/password accounts, organizations, rooms, integrations, signed ingest, retention, and the Go daemon. There is no web dashboard in this distribution: operate it through the HTTP API and the daemon CLI.

This guide assumes the repository root is the cloned `transit-server` repository. For component boundaries, see [Transit architecture](architecture.md).

## Prerequisites

- A Cloudflare account on the Workers Paid plan. Transit uses Durable Objects.
- Wrangler authentication, either with `bunx wrangler login` or a `CLOUDFLARE_API_TOKEN` in a non-interactive environment.
- `mise`, Bun, and Go. Go builds the daemon in `daemon/`.
- `jq` for the copy-paste enrollment walkthrough below.
- A domain if you want a custom public origin.

Clone the repository and install its tools and dependencies:

```sh
git clone https://github.com/Orange-County-AI/transit-server.git
cd transit-server
mise trust && mise install
mise run install
```

## Configure the Worker

Transit requires two Worker secrets and one public variable:

| Setting | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | The secret Better Auth uses for its authentication state. |
| `TRANSIT_MASTER_KEY` | A base64-encoded, exactly 32-byte AES-GCM key that encrypts stored integration credentials and custom-source secrets. |
| `BETTER_AUTH_URL` | The canonical public origin used by Better Auth and enrollment commands, such as `https://transit.example.com`. |

Generate and set both secrets:

```sh
mise run secret:put
```

That task generates a 32-byte value for each and refuses to overwrite one that
already exists — rotating `TRANSIT_MASTER_KEY` makes every already-sealed
integration credential unrecoverable. To set them by hand instead:

```sh
openssl rand -base64 32 | tr -d '\n' | bunx wrangler secret put BETTER_AUTH_SECRET
openssl rand -base64 32 | tr -d '\n' | bunx wrangler secret put TRANSIT_MASTER_KEY
```

`BETTER_AUTH_URL` is a plain var in `wrangler.jsonc`, not a secret. Set it to
the canonical origin users and daemons will reach. The shipped config has no
`routes` entry — the Worker answers on its `workers.dev` URL until you add one.
To serve it from your own domain, uncomment the route and put your hostname in
it:

```jsonc
"routes": [{ "pattern": "transit.example.com", "custom_domain": true }]
```

### Password-reset mail is optional

Password resets use Cloudflare Email Sending when the `EMAIL` `send_email` binding and `EMAIL_FROM` are configured. Onboard the sender domain with `bunx wrangler email sending enable <your-domain>` and set `EMAIL_FROM` to an address on that domain. If the binding is omitted, password-reset requests do not throw, but Transit logs a warning and does not send a reset link. Sign-up, sign-in, and the rest of the API continue to work.

## Create data and deploy

Create the remote D1 database, apply migrations, then deploy the Worker:

```sh
mise run d1:create
mise run migrate:remote
mise run deploy
```

The production configuration includes the daily `0 4 * * *` retention cron. Keep that trigger enabled. The sweep removes message archives after seven days; handled or dead integration deliveries and replies after 30 days; unreferenced integration events after 30 days; and expired enrollment codes.

## Create an operator account and enroll a host

There is no dashboard. The following walkthrough creates an account, signs in to capture a Better Auth session cookie, issues a one-time enrollment code, and redeems it. Use your actual public origin and a unique email address.

```sh
export TRANSIT_URL=https://transit.example.com

# Create the initial account and its personal organization.
curl --fail-with-body -sS -X POST "$TRANSIT_URL/api/auth/sign-up/email" \
  -H "Content-Type: application/json" \
  -H "Origin: $TRANSIT_URL" \
  --data '{"name":"Operator","email":"operator@example.com","password":"choose-a-long-password"}'

# Sign in and save the session cookie for the authenticated API request below.
curl --fail-with-body -sS -c transit.cookies -X POST "$TRANSIT_URL/api/auth/sign-in/email" \
  -H "Content-Type: application/json" \
  -H "Origin: $TRANSIT_URL" \
  --data '{"email":"operator@example.com","password":"choose-a-long-password"}'

# The response is {"code","expires_at","command"}. A slug is required.
ENROLLMENT="$(curl --fail-with-body -sS -X POST "$TRANSIT_URL/api/hosts/enroll" \
  -H "Content-Type: application/json" \
  -H "Origin: $TRANSIT_URL" \
  -b transit.cookies \
  --data '{"slug":"my-host"}')"
printf '%s\n' "$ENROLLMENT"
CODE="$(printf '%s' "$ENROLLMENT" | jq -r '.code')"

transit enroll --url https://transit.example.com --code "$CODE"
```

Enrollment codes are single-use. `POST /api/hosts/enroll` accepts exactly a JSON object with a `slug` string and returns `code`, `expires_at`, and `command`; the daemon redeems that code with `POST /api/daemon/enroll` and persists its device token locally.

## Connecting agents to your server

Build and install the daemon on each host, then enroll it against your origin:

```sh
mise run daemon:build
install -m 0755 daemon/transit ~/.local/bin/transit
export TRANSIT_URL=https://transit.example.com
transit enroll --url "$TRANSIT_URL" --code XXXX-XXXX
```

`TRANSIT_URL` is a convenient default for enrollment; passing `--url` makes the selected server explicit. Register the local stdio MCP server with your harness:

```json
{
  "transit": {
    "type": "stdio",
    "command": "transit",
    "args": ["mcp"]
  }
}
```

Install the agent guidance from the Worker that the host uses:

```sh
npx skills add https://transit.example.com/SKILL.md -g -a claude-code -y
```

The Worker serves that file at `/SKILL.md` with Markdown content and a short public cache lifetime. An enrolled host reads that same copy with `transit skill`, because the CLI resolves the server from its own config rather than defaulting to the hosted one.

## Limits and retention

This server enforces no plan limits, quotas, or license checks. Its only bounds are protocol safety limits: message bodies are capped at 64 KiB; daemon frames have a token bucket with a 100-frame burst and a 50-frame-per-second refill; rooms have at most 64 members; default Durable Object delivery and retry scheduling has a 120-alarm-per-hour budget; queued deliveries become dead after 40 attempts or 24 hours; and the retention sweep described above.

Polling integrations use their own 900-alarm-per-hour budget, separate from the default delivery and retry budget.

## Operational ownership

A self-hosted operator is responsible for:

- Cloudflare billing, Workers, Durable Objects, D1, routes, domains, and observability.
- Keeping the daily retention cron deployed and monitoring its results.
- Creating and protecting Better Auth accounts, organization memberships, enrollment codes, and device-token revocations through the API.
- Custody, rotation, backup, and incident response for `BETTER_AUTH_SECRET`, `TRANSIT_MASTER_KEY`, device tokens, integration credentials, and custom-source secrets.
- Email Sending setup if password-reset mail is needed.

## Differences from the hosted service

The self-hosted server has no web dashboard, billing, plans, quotas, marketing site, or documentation site. Its HTTP API, daemon, MCP surface, wire protocol, and `transit/1` envelope format are identical to the hosted service.
