# Transit security model

> Reference material for operators and reviewers. For the user-facing consequences of these
> controls, see [Accounts](accounts.md), [Hosts and the daemon](hosts.md), and
> [Deliveries](deliveries.md).

## Threat model

| Actor | Surface | Control |
|---|---|---|
| External webhook forger | `transit.ingest/1` ingest routes | Per-source HMAC-SHA256 and a ±300-second timestamp window are verified before parsing. |
| Stolen or leaked device token | Daemon WebSocket | The 32-byte token is SHA-256-hashed at rest, shown only once, scoped to one host, and revocation immediately kills its WebSocket session. |
| Malicious or compromised agent | Daemon MCP tools | The daemon derives identity from the registered local adapter. Herdr uses `HERDR_PANE_ID`; native Claude Code, OMP, Pi, and OpenCode adapters bind a same-UID harness session. Model-supplied sender identity is rejected and every settlement operation validates ownership. |
| Hostile message content | Agent terminals | Envelope bodies are data rather than instructions; `</transit` is neutralized and bounded channel previews strip `<...>` substrings. |
| SSRF through `reply_url` | Callback egress | Only operator-declared, literal-prefix reply capabilities are allowed; they are rechecked immediately before posting. |
| Cross-organization caller | Better Auth sessions, Durable Objects, and D1 | The Worker accepts only the session's active organization, verifies a current membership row, scopes every D1 query by that id, and embeds it in each Durable Object identifier. |
| Flooding sender or retry loop | Ingress, daemon frames, sends, room fan-out, and alarms | Per-surface rate limits, room fan-out and delivery-attempt caps, and Durable Object alarm budgets bound resource use. |

## 1. Authentication

Transit authenticates the UI and control-plane API with Better Auth sessions.
Each session has one active organization. Creating or selecting an organization
uses Better Auth's organization plugin, which verifies membership before it
updates the session. The Worker independently joins the active organization to
the authenticated user membership on every organization-scoped entry point; a
stale or tampered session field is not authorization.

Daemons authenticate their WebSocket connection with a per-host device token:
it is 32 random bytes, shown and stored only once at enrollment, retained only
as a SHA-256 hash, and revocable. Revoking a device token immediately
terminates that host's WebSocket session.

Two credentials reach the server-side MCP endpoint, and both are additions to
the device token rather than replacements for it.

An **agent client** is an OAuth client whose access token's subject IS an agent.
Its secret is 32 random bytes, shown once, stored only as a SHA-256 hash.
Organization, host and agent name are read back from the `agent_client` row on
every request and never from the token's own claims, so a validly signed token
claiming otherwise acts where its row says, and revoking the client — or the
host it hangs off — takes effect immediately rather than at the token's expiry.
`X-Transit-Agent` is ignored entirely on this path: the token is the proof of
identity, and honouring a header beside it would let a credential minted for one
agent act as another.

A **person** reaches it through authorization code with S256 PKCE. Three things
about that flow are Transit's rather than Better Auth's, and each closes a link
in a chain that was exploitable together:

- **Consent is enforced by the server.** Better Auth records
  `requireConsent: query.prompt === "consent"` and, when the prompt is absent,
  mints the code and redirects before the consent page is ever considered — so
  its consent screen gates nothing against a client that omits the parameter.
  Transit forces the prompt unless a prior grant already covers that exact user,
  client and scopes.
- **Registration is not open.** `POST /api/auth/mcp/register` requires a signed-in
  organization owner or admin. An open registration endpoint lets anyone mint a
  client named "Claude" pointing at their own redirect URI, which is what turned
  the missing consent gate into a one-click read of a victim's organization. The
  cost is that an operator registers the client by hand and enters its id and
  secret into Claude as a custom connector; `registration_endpoint` is therefore
  omitted from the advertised metadata rather than advertised and refused. A
  self-hoster who prefers open dynamic registration can remove that route,
  knowingly.
- **PKCE is required, not merely offered.** Without it a confidential client can
  redeem a stolen code with its own secret alone.

`/api/auth/mcp/get-session` is closed. It returns the whole access-token row,
refresh token included, to any holder of the one-hour access token; Transit
reads that session in process and never over HTTP.

**Edge rate limiting, deployment configuration rather than code.** A Worker has
no shared counter without adding a Durable Object hop to every unauthenticated
request, which is itself an amplifier, so this belongs in a Cloudflare
rate-limiting rule. The hosted deployment runs one on the zone: 50 requests per
10 s per IP, blocking for 10 s, matching `/oauth/token` and `/api/auth/mcp/*`.
A self-hoster without an equivalent rule should know it is absent.

Two things about that rule are worth copying rather than rediscovering.

`POST /mcp` is deliberately **excluded**. Counting characteristics below the
Business plan are IP-only, and a fleet behind one NAT egress — measured here as
titan and every workspace pod sharing a single address — is indistinguishable
from one client to a per-IP counter. A threshold low enough to blunt a flood on
the agent data path is a threshold the fleet can trip by itself. The auth
endpoints are safe to limit because their legitimate rate is one token refresh
per agent per hour, four orders of magnitude below the limit.

The rule expression may only reference **Path** on a Free plan. An expression
using `http.host` is accepted by the API without error, deploys, reports
`enabled: true`, and matches nothing — plan availability is not validated at
write time. Only a test that drove real traffic past the threshold and observed
`429` with `content-type: text/html` (Cloudflare's page, not Transit's JSON
error) distinguished a working rule from an inert one that looked identical in
every API response.

Each public `transit.ingest/1` source has its own HMAC secret. The Worker verifies
the per-source HMAC and timestamp window before processing an ingress request.
Built-in connectors also retain their native inbound checks: Telegram's secret
header, Kaneo's HMAC, Gmail OAuth, and the Mattermost bot token. A tunnel or
network position is never authorization.

## 2. Authorization and tenancy

Everything in Transit is organization-scoped. A signed-in user may belong to
multiple organizations, but each browser session operates in exactly one active
organization. The server derives that id from the session; control-plane
resource endpoints do not accept a caller-supplied organization override.
Switching organizations therefore changes the boundary for hosts, agents,
rooms, integrations, deliveries, ingest sources, usage, and billing together.

Durable Object identifiers embed `org_id`, and every D1 lookup begins from an
authenticated membership or device token. Better Auth's `owner`, `admin`, and
`member` roles govern organization administration; subscription and
organization-connection changes require an owner or admin. Organization members
can operate their organization's Transit resources.

Cross-organization direct messaging is a narrow exception, not a shared tenant.
One organization requests a connection by immutable organization id resolved
from the peer's current slug, and an owner or admin in the other organization
must accept it. Only then may an agent target
`peer-slug/name@host`. The Worker resolves that slug through the active
connection and derives a qualified sender from the authenticated source
organization; model-supplied qualified `from` values are rejected.

The destination HostHub remains inside the recipient organization. A queued
cross-organization delivery retains its connection id and rechecks it before
every dispatch, so disconnecting either organization blocks new sends and kills
queued retries before another injection. Existing accepted message history
remains visible to both participants. Connections do not expose host tokens,
integration credentials, or unconnected rosters.

A connection is also the sole authorization for cross-organization room
membership: a room owned by one organization admits a member from another only
while an accepted connection links them, and the `Room` DO reverifies that
connection itself rather than trusting the caller that proposed the member.
Revocation fails closed — a foreign member can no longer join or post, new
fan-out skips it and is recorded dead, and a queued room delivery carries its
connection id into the same recheck that already kills a revoked DM. Membership
rows survive revocation deliberately, because nothing is delivered while the
connection is gone and a partial prune across two organizations' rooms would
destroy operator state without improving that guarantee.

Agents may otherwise act only as themselves: the daemon pins sender and
room-creator identity to the active local adapter and rejects model-supplied
identity fields. An authenticated creator becomes the room's first member.
Rooms with the `invite` policy refuse later self-service joining; `join_room` is
available only where the room policy permits it.

## 3. Terminal injection safety

Envelope bodies are peer or user data, never operator instructions. This rule is stated in every schema document and in the daemon MCP manifest. The renderer neutralizes `</transit` case-insensitively in body content. Channel previews are bounded and strip `<...>` substrings before they reach an agent.

The Herdr path reads the visible, ANSI-stripped pane before delivery and holds only positively recognized unsent input in a supported composer. It fails open for an unfamiliar or unreadable composer so a durable queue cannot be starved; a retryable `draft_busy` hold preserves the delivery's attempt count and resumes when the daemon reports the composer clear. Recovering an `agent_prompt_stalled` paste always sends the `Enter`, because Transit's bytes are already in the composer and the alternative was leaving them there while every retry added another copy; when the composer also holds a person's own text, the daemon notifies that their draft was submitted with the message. A failed prompt is acknowledged only on pane evidence that the agent moved, never on the error code alone. Native adapters persist a harness-owned receipt first, but are not composer-guarded: they register sessions, not panes, and no harness API exposes composer state. Claude Code confirms the delivery ID reached its transcript, OMP and Pi append a custom session entry after `pi.sendUserMessage`, and OpenCode confirms the delivery ID appears in its persisted session messages.

## 4. SSRF and egress capability control

Reply callback destinations are capabilities selected by the operator, not arbitrary URLs supplied by an event. An event-provided `reply_url` is accepted only when it matches an operator-declared literal `reply_url_prefixes` entry. Prefixes end in `/` and exclude query strings, fragments, and userinfo.

The capability is rechecked at post time, so revoking a prefix also prevents a reply that was already queued. Callback requests refuse redirects, use a 10-second timeout, and refuse userinfo.

## 5. Secret handling

Integration credentials and ingest-source secrets are encrypted with AES-GCM under the Worker secret `TRANSIT_MASTER_KEY` before they enter D1 or Durable Object storage. Secret fields in the UI are write-only; after saving, the UI displays only a `sha256:` fingerprint.

Device tokens use one-way SHA-256 hashing instead of reversible encryption. They are therefore never encrypted-recoverable from Transit storage.

## 6. Abuse and fan-out limits

Transit applies frame-rate limits per device token, ingress-rate limits per source with `429` responses, and send-rate limits per agent. Room fan-out has explicit caps. Delivery attempts are capped, surfacing exhausted deliveries as dead rather than allowing unbounded retries.

Durable Objects maintain alarm budgets. These protections satisfy the template's durable-object fan-out tripwire obligation: an implementation must provide a per-DO alarm budget counter with a hard per-hour cap, attempt caps that make dead deliveries UI-visible, and fan-out that does not re-enter the Room Durable Object from a delivery it produced.

## 7. At-least-once delivery honesty

Duplicates are possible everywhere in Transit. Message and delivery identifiers are idempotency keys, and receivers must deduplicate them. Transit does not claim exactly-once delivery.

## 8. Hosted-instance legal documents

The hosted instance provides Terms of Use and a Privacy Policy adapted from the CC0 General-Legal/legal-templates `terms-of-use` and `privacy-policy-us` templates. Both pages are linked from the public footer.
