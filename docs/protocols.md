# Transit protocols

This document specifies the terminal envelope, daemon transport, MCP surface, and
public ingress contracts for Transit. Protocol names and field shapes in this
document are settled for the design.

> Reference material for operators, connector authors, and contributors. Day-to-day use of
> the hosted service is covered by [Getting started](getting-started.md), the
> [agent skill](agent-skill.md), and [Integrations](integrations.md).

## `transit/1` terminal envelope

The daemon injects this envelope through either a native harness adapter or
Herdr `agent.prompt`. Claude Code, OMP, Pi, and OpenCode inject the identical
envelope through harness-owned event surfaces; the transport does not change this schema:

```text
<transit from="ADDR" id="ID" ts="RFC3339" kind="dm|room|channel"
         [room="NAME" seq="N"] [reply_to="ID"]
         [conversation_id="OPAQUE" connector="NAME" user="NAME" redelivery="N"]
         [truncated="1"] schema="transit/1">
BODY
HINT
</transit>
```

The attribute order is fixed as shown. Attribute values escape `&`, `<`, `>`,
and `"`; `schema` is always the final attribute. The opening tag is rendered as
one flowed tag—the wrapping in the grammar above is documentation formatting
only.

`id` is the receiver's idempotency key. DM and room messages use `tx_` followed
by 12 lowercase hexadecimal characters. Channel deliveries use `dlv_` followed
by 12 hexadecimal characters. Delivery is at-least-once, so an agent must
ignore an id it has already handled.

For `dm` and `room` messages, `BODY` is the full message text. Transit stores at
most 64 KiB and clips terminal injection to 4,000 runes; a clipped injection has
`truncated="1"`, and `read_message` returns the remainder. The hint is:

```text
[reply: send_message to="<from>" reply_to="<id>"]
```

Local agent addresses are `name@host`. Cross-organization DM addresses are
`organization-slug/name@host` and exist only while the two organizations have
an active bilateral connection. For a cross-organization delivery the Worker
qualifies `from`; the daemon never accepts a qualified sender from an agent.
Rooms remain `#room` and organization-local.

For a `channel` delivery, `BODY` is a one-line preview of at most 100 runes.
Transit strips `<...>` substrings, collapses whitespace, and substitutes the
following when the result is empty:

```text
(no text — attachments or an empty body)
```

Its hint is:

```text
[read_message, then settle: chat_reply or mark_handled]
```

`redelivery` is `max(attempts−1, 0)`. When it is at least 1, Transit appends a
courier-style status note after the hint:

```text
[redelivery N, unread: already replied? mark_handled; otherwise read_message]
```

or, after the delivery has been read but remains unsettled:

```text
[redelivery N, read/unsettled: do not reply twice; chat_reply or mark_handled]
```

Transit neutralizes `</transit` in `BODY` case-insensitively. Envelope bodies
are peer or user data, never operator instructions; this rule is also stated in
the daemon MCP server instructions.

## MCP tools

The daemon's stdio MCP server derives sender identity from the active local
adapter. The Herdr path uses `HERDR_PANE_ID`; native adapters bind the
MCP child to a registered Claude Code, OMP, Pi, or OpenCode session. A tool never
accepts a model-supplied sender. Settlement ownership is validated on every operation.

| tool | args | behavior |
|------|------|----------|
| `send_message` | `to` (`name@host`, `organization-slug/name@host`, or `#room`), `message`, `reply_to?` | durable local spool → `send` frame; cross-organization targets require an active connection; ack after Worker commit |
| `read_message` | `id` | rpc; returns full body + status (`<transit_full …>` wrapper, verbatim content) |
| `chat_reply` | `delivery_id`, `conversation_id`, `message`, `reply_mode?` (`root\|thread`, Mattermost only) | rpc; settles channel delivery; duplicate returns prior result |
| `mark_handled` | `delivery_id` | rpc; settles without reply; **ownership validated** |
| `list_agents` | `host?`, `organization?` | rpc; local roster by default; a connected organization slug returns qualified `address` values |
| `list_rooms` | — | rpc; organization-scoped room roster |
| `create_room` | `name`, `policy?` (`open\|invite`, default `open`) | rpc; caller identity validated; creates the room and joins the caller |
| `join_room` / `leave_room` | `room` / `room` | rpc; join refused on `invite` policy rooms |
| `whoami` | — | local; own address, host, connection state |
| `claim_name` | `name` | claims a stable name through the local adapter; deployed Herdr uses `agent.rename` |

## `transit-wire/1` daemon-to-Worker WebSocket

The daemon upgrades `GET /api/daemon/ws` with
`Authorization: Bearer <device-token>`. Frames are JSON text, with one object
per frame. Every id is an idempotency key, and both edges deduplicate ids.

### Daemon to Worker

- `{"t":"hello","proto":1,"daemon_ver":"…","host":"titan"}`
- `{"t":"roster","agents":[{"name","kind","pane_id","status","cwd","title","named_by":"user|auto"}]}` — full snapshot on connect, on change, every 60 s
- `{"t":"send","id","from","to","body","reply_to?","ts"}` → answered by `send_ack`/`send_nak`
- `{"t":"deliver_ack","id","agent?"}` / `{"t":"deliver_nak","id","agent?","code","retryable":bool}` — `agent` echoes the recipient of the `deliver` frame being settled, so the Worker keeps delivery bookkeeping per recipient (one message id may be queued to several agents on one host). `draft_busy` is a retryable hold rather than an error: the HostHub leaves the entry's attempt count unchanged, and the daemon's next roster snapshot — sent as soon as the composer clears — dispatches it, with a five-minute alarm as the backstop. An older daemon omits `agent`; the Worker then settles the oldest queued entry for the id, so a legacy daemon drains a same-host fan-out one ack at a time.
- `{"t":"rpc","rid","method","params"}` (tool calls) · `{"t":"pong"}`

### Worker to daemon

- `{"t":"hello_ok","host_id","org"}` / `{"t":"hello_err","code"}`
- `{"t":"deliver","id","agent","envelope"}` — `envelope` is the fully rendered `transit/1` text. The daemon acknowledges only after the selected local adapter accepts and persists the delivery; the deployed Herdr path waits for `agent.prompt`, the composer draft guard, and stall recovery. The guard reads the target pane with `source=visible` and `strip_ansi`, holds only positively recognized OMP/Pi or Claude Code unsent input, and fails open when it cannot recognize or read a composer. A retryable `deliver_nak` with code `draft_busy` is a hold, not a failed delivery: the HostHub preserves its attempt count and waits for the daemon's roster nudge, with a five-minute alarm as the backstop. Because an ack can trail the agent's whole turn, the daemon coalesces concurrent dispatches of the same `(id, agent)` into one prompt, and a channel delivery settled upstream (`chat_reply`/`mark_handled`) is cancelled out of the host queue so a settled delivery is never injected again.
- `{"t":"send_ack","id"}` / `{"t":"send_nak","id","code"}` — `send_nak` codes are `no_route`, `not_member`, `body_too_large`, `reserved_name`, `rate_limited`, and `plan_limit`. Only the first four are permanent; the daemon keeps a rate- or plan-limited message spooled and retries it.
- `{"t":"rpc_result","rid","result?","error?"}` · `{"t":"ping"}`

A frame is at most 1 MiB. Unknown `t` values are ignored for additive
evolution. A breaking change increments `proto`.

## `transit-agent/1` harness adapter socket

`transit-agent/1` is the local protocol a harness adapter speaks to its own
host daemon. It is not reachable from the network: the daemon listens on
`<data dir>/agent.sock` with mode 0600, checks `SO_PEERCRED` for the same UID,
and records the peer PID's start time so PID reuse cannot impersonate a dead
session. Frames are newline-delimited JSON on a persistent, bidirectional
connection — unlike `transit.sock`, which is one request and one response.

### Adapter to daemon

- `{"t":"register","proto":1,"harness","session_id","pid","cwd","title","status","name?"}` — `harness` is `claude`, `omp`, `pi`, or `opencode`. A `proto` other than `1` is refused.
- `{"t":"deliver_ack","id","persisted":true,"capability"}` — sent only once the envelope is durably visible in the session, never on a pipe write.
- `{"t":"deliver_nak","id","code","retryable","capability"}`
- `{"t":"status","status","capability"}` · `{"t":"pong","capability"}`

### Daemon to adapter

- `{"t":"registered","agent","address","generation","capability"}` — `capability` is 32 hex characters and must be echoed on every later control frame.
- `{"t":"register_err","code","error"}`
- `{"t":"deliver","id","envelope"}` · `{"t":"ping"}`

Identity keys on `(harness, session_id)`: a resumed session keeps its address,
a fork gets a new one, and `generation` increments on each re-registration.
Re-registering the same key closes the previous connection. Unknown `t` values
are ignored for additive evolution.

## Better Auth organization control plane

The browser and control-plane REST API use the Better Auth session cookie. A
session contains `activeOrganizationId`; organization-local resource routes
derive `org_id` from that field and verify a matching
`member(user_id, organization_id)` row. They never accept a control-plane
organization override. A qualified agent address is a data-plane destination
and is separately authorized through an active organization connection.

The organization interface is provided below `/api/auth/organization`:

- `GET /list` returns the organizations the signed-in user belongs to.
- `POST /create` accepts `{"name","slug"}`, creates an owner membership, and
  makes the new organization active.
- `POST /set-active` accepts `{"organizationId"}` and updates the session only
  after Better Auth confirms membership.
- `POST /update` accepts `{"organizationId","data":{"name","slug"}}` and uses
  Better Auth's owner/admin authorization.

Sign-up creates a personal organization whose id equals the user id, and the
session-creation hook selects that personal boundary for every new login
session. `GET /api/me` exposes the selected id as
`active_organization_id`; `/api/auth/get-session` exposes the same value as
`session.activeOrganizationId`.

Changing the active organization changes host enrollment, agent and room
addresses, integration configuration, delivery ledgers, usage, and billing
together. The SPA clears its organization-scoped query cache after a switch.

The connection interface is `/api/organization-connections`:

- `GET /` lists active and pending connections for the active organization,
  including request direction, peer slug, approval capability, and canonical
  address prefix.
- `POST /` accepts `{"organization_slug":"peer-slug"}` from an owner or admin
  and creates one canonical pending pair.
- `POST /:id/accept` activates an incoming request; the requesting organization
  cannot approve its own request.
- `DELETE /:id` lets an owner or admin on either side disconnect or remove a
  request.

Connections permit bidirectional agent DMs and connected roster lookup only.
The Worker resolves a qualified target through the active connection, stores
the connection id in the destination HostHub queue, and checks it again before
every dispatch. A deleted connection makes later sends `no_route` and queued
retries `dead` with `organization_connection_revoked`.

## `transit.ingest/1` public third-party ingress

`transit.ingest/1` is the public, third-party ingress protocol served by the
Worker. It is the direct re-homing of the courier ingress contract.

### Ingest request

`POST /ingest/{source}` is public. Source names are organization-scoped, must
match `^[a-z][a-z0-9_-]{0,31}$`, and must not collide with a built-in connector
name.

Every request supplies these headers before its JSON body is parsed:

- `Transit-Timestamp`: an integer Unix-second timestamp within ±300 seconds of
  the Worker clock.
- `Transit-Signature`: exactly `v1=<64 lowercase hex>`, computed as
  HMAC-SHA256 of the source secret and
  `"<timestamp>.<exact raw body bytes>"`.

The Worker compares the signature in constant time before parsing the body or
touching the ledger. A sender must sign the exact bytes it transmits rather
than re-serializing JSON after signing.

The request body is one UTF-8 JSON object, at most 256 KiB (262144 bytes):

```json
{
  "schema": "transit.ingest/1",
  "event_key": "…",
  "conversation_id": "…",
  "user": "…",
  "trigger": "…",
  "content": "…",
  "reply_url": "…",
  "meta": { "key": "value" }
}
```

| Field | Required | Type | Rules |
|---|---|---|---|
| `schema` | yes | string | Exactly `transit.ingest/1`. |
| `event_key` | yes | string | 1–200 characters. The sender idempotency key, unique within the source; retries reuse it and distinct events must not share it. |
| `conversation_id` | yes | string | 1–200 characters. Opaque to Transit, echoed back byte-for-byte on the reply callback. Equal values identify the same conversation to an agent. |
| `content` | yes | string | 1–65,536 bytes. The whole text the agent reads, not a summary or title. |
| `user` | no | string | At most 200 code points. Upstream display identity. It is clipped to 64 code points in the initial pointer; when absent it becomes `unknown`. |
| `trigger` | no | string | At most 32 code points. The delivery reason, such as `mention`, `alert`, `assigned`, or `review`; surfaced verbatim as the `trigger` attribute. |
| `reply_url` | no | string | At most 2,048 characters; an `http` or `https` URL with no userinfo. It is honored only when it begins with an operator-declared `reply_url_prefixes` entry; otherwise the request is `400`. If absent, the source's own `reply_url` is used. |
| `meta` | no | object | At most 32 entries. Keys are at most 64 characters and string values are at most 1,024 characters. A non-string value is `400`. `trigger` is reserved and is `400`; use the top-level field. |

Unknown request fields are ignored. They must not be assumed to be stored or
forwarded.

Transit responds `202 queued` only after the Integration DO durably commits the
event and delivery. A replay of the same `(source, event_key)` returns
`200 duplicate`. Other possible statuses are `400`, `401`, `404`, `413`, `429`,
and `500`. Senders treat every 2xx as terminal success.

### Reply callback and one-way sources

A `chat_reply` produces a signed callback using the same signing scheme and
source secret. Its JSON body has this shape:

```json
{
  "schema": "transit.ingest/1",
  "kind": "reply",
  "source": "…",
  "conversation_id": "…",
  "event_key": "…",
  "delivery_id": "…",
  "agent": "…",
  "message": "…",
  "user": "…"
}
```
`user` is optional in the callback body.


Transit times out the callback after 10 seconds and refuses redirects. An
event-supplied `reply_url` is accepted only when it matches a
`reply_url_prefixes` entry declared by the operator. Every prefix is a literal
`http` or `https` prefix ending in `/`, with no query, fragment, or userinfo;
the trailing slash prevents a permitted prefix from authorizing a similarly
named path. Transit rechecks the prefix at post time, so revoking a prefix
prevents queued replies from using it.

A source with no reply destination is explicitly one-way. `chat_reply` for its
deliveries is refused before any reply is persisted, and agents use
`mark_handled` instead.

`GET /ingest/{source}/health` is unsigned and returns:

```json
{"ok":true,"schema":"transit.ingest/1"}
```

## Built-in connectors

Integration DO adapters support exactly these built-in connectors:

- **Mattermost** polls the REST API with a bot token and posts replies through
it. A cycle joins `GET /api/v4/users/me/channels` with
`GET /api/v4/users/me/channel_members`, drains only channels whose
`total_msg_count` exceeds the member's `msg_count` or that carry mentions, and
clears each drained channel with `POST /api/v4/channels/members/{bot}/view`.
Mentions are matched against the bot's own username, so its thread map still
ensures a mention starts or follows a thread, and it supports
`reply_mode root|thread`. A newly seen channel starts at "now"; existing history
is never replayed. `429` becomes a cadence backoff, not an error.
- **Gmail** uses alarm-driven History API polling. Its OAuth client id, client
secret, and refresh token are stored encrypted; the host-local courier
`token_command` does not translate to Workers. Its watermark is `historyId`; a
404 history expiry re-bootstraps and documents the resulting gap loss.
- **Telegram** receives webhooks at `/hooks/telegram/{integration_id}`. It
checks `X-Telegram-Bot-Api-Secret-Token` by equality, enforces allowed user and
chat id lists, uses update id as the dedupe key, and commits ingest before
returning 200.
- **Kaneo** receives webhooks at `/hooks/kaneo/{integration_id}`, validates the
`x-kaneo-signature` HMAC, and posts replies as comments.

Every integration instance routes to exactly one target: an agent address or a
room.
