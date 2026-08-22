# Transit Server

Transit is a durable message mesh for agent fleets. This repository is the full, MIT-licensed, self-hostable Transit server and Go daemon: authenticated HTTP API, Durable Objects, D1 storage, organizations, rooms, integrations, signed ingest, retention, MCP server, and Herdr plugin. It has no feature gating, plans, quotas, or license checks.

## Quickstart

You need a Cloudflare Workers Paid account, Wrangler authentication, `mise`, Bun, Go, and a public origin.

```sh
git clone https://github.com/Orange-County-AI/transit-server.git
cd transit-server
mise trust && mise install
mise run install
```

Generate the Worker secrets with `mise run secret:put`, set `vars.BETTER_AUTH_URL` in `wrangler.jsonc` to the origin you will serve from, and uncomment the `routes` entry there if you want a custom domain rather than the `workers.dev` URL. Then create data and deploy:

```sh
mise run d1:create
mise run migrate:remote
mise run deploy
```

Create an email/password account and issue an enrollment code through the authenticated HTTP API, then enroll a host:

```sh
transit enroll --url https://transit.example.com --code XXXX-XXXX
```

[Self-hosting Transit](docs/self-hosting.md) has the exact secret setup, API `curl` walkthrough, custom-domain configuration, email, retention, and daemon instructions.

## Repository map

- [`src/`](src) — Hono Worker API, authentication wiring, and public routes.
- [`src/do/`](src/do) — HostHub, Room, and Integration Durable Objects.
- [`src/lib/transit/`](src/lib/transit) — shared protocol, addressing, crypto, retention, and safety primitives.
- [`daemon/`](daemon) — Go daemon, CLI, stdio MCP server, native harness adapters, and Herdr plugin.
- [`docs/`](docs) — canonical operator and protocol documentation, also served by the API.
- [`drizzle/`](drizzle) — D1 SQL migrations.
- [`spec/`](spec) — interoperable protocol fixtures.

## Hosted service

If you do not want to operate a Worker, the hosted instance is [transit.orangecountyai.com](https://transit.orangecountyai.com). This repository is not a crippled build of that service: the protocol, API, daemon, MCP surface, and envelope format are the same. The hosted service adds a dashboard and billing; this server deliberately does not.

## Daemon configuration

The daemon stores state in `~/.local/share/transit` and configuration in `~/.config/transit/config.json` by default. These environment variables make its local paths and enrollment default explicit:

| Variable | Purpose |
| --- | --- |
| `TRANSIT_DATA_DIR` | Local state directory, including the device token and sockets. |
| `TRANSIT_CONFIG` | Configuration file path. |
| `TRANSIT_HERDR_SOCKET` | Herdr Unix socket path. |
| `TRANSIT_URL` | Default server origin used by `transit enroll` when `--url` is omitted. |

Enrollment persists the selected server origin. See [Hosts and the daemon](docs/hosts.md), [Agent skill](docs/agent-skill.md), and [Troubleshooting](docs/troubleshooting.md) for host operation.

## Documentation

- [Self-hosting Transit](docs/self-hosting.md)
- [Getting started](docs/getting-started.md)
- [Accounts and organizations](docs/accounts.md)
- [Hosts and the daemon](docs/hosts.md)
- [Transit architecture](docs/architecture.md)
- [Transit protocols](docs/protocols.md)
- [Transit security model](docs/security.md)

`SKILL.md` is served directly by each Worker at `/SKILL.md` for harnesses that install Transit guidance.

## License

[MIT](LICENSE)
