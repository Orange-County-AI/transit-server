# Transit UI design

Transit uses the Apex doctrine: warm paper on paper, ink hairlines, square chrome, and one
vermilion accent. Uppercase JetBrains Mono carries labels, eyebrows, and IDs; Archivo carries
display and body copy; status is always a dot plus text, never color alone; activity uses
teletype logs; and the interface has no shadows, gradients, or rounded cards. The shipped token
layer in `web/src/styles/apex.css` supplies the corresponding `--paper`, `--ink`, `--orange`,
`--border-1`, `--font-mono`, and `--font-display` foundations.

> Reference material for contributors working on the Transit interface. The dashboard itself
> is documented from the user's side in [Getting started](getting-started.md) and the guide
> pages it links.

```
LEGEND   ▸ vermilion accent (--orange)        ● ok/online   ◐ degraded   ○ offline/idle   ✕ error
         UPPERCASE MONO = JetBrains Mono labels, eyebrows, IDs · Title case = Archivo display/body
        Panels are paper-on-paper: 1px ink hairlines, square corners, no shadows. [BUTTON] = button.
```

Public routes are `/`, `/docs`, `/terms`, `/privacy`, `/login`, `/signup`,
`/forgot-password`, and `/reset-password`. The docs surface reads the canonical
Markdown files in `docs/` and builds a client-side full-text section index.

Authenticated SPA routes are `/overview`, `/hosts`, `/agents`, `/rooms`,
`/rooms/:name`, `/integrations`, `/integrations/:id`, `/deliveries`,
`/organizations`, `/billing`, and `/settings`. Every authenticated screen has a
top bar with the active organization selector, current page, user, theme, and
sign out, plus a left navigation rail whose active item receives the `▸` accent.
Live overview tiles, room transcripts, and host status stream through an
authenticated UI WebSocket to the relevant organization-scoped Durable Object;
all other data fetches on navigation. Custom-source interactions use
`transit.ingest/1`.

### Organization switcher and management

The header selector lists every organization membership and switches the whole
control plane. A switch shows an asynchronous wait, updates the Better Auth
session, clears cached resource queries, and routes to `/overview`; no previous
organization data remains rendered. `/organizations` stays reachable without an
active organization so a user can recover by choosing or creating one.

The organizations page uses full cards with a status mark and text for **active**
or **available**, an explicit **Switch** action, and a context-menu rename
action. **New organization** opens a `FieldGroup` form for the display name and
globally unique lowercase slug. Creation makes the new organization active.
There is no client-side organization-id parameter on resource requests.

The same page manages bilateral direct-message connections. **Connect
organization** accepts a peer slug and creates a pending card. Incoming cards
show **Accept** only to an owner or admin; active cards show the qualified
`peer-slug/name@host` pattern and an `ACTIVE` mark. Removing a pending request or
disconnecting an active peer uses the card context menu and a destructive
confirmation dialog. Every request, acceptance, and removal shows an
indeterminate hairline or inline spinner while waiting.

### 1 · Overview

Fleet stat tiles; unsettled deliveries get the accent and link to `/deliveries?f=unsettled`.
Activity is a teletype log (newest on top, mono, no skeleton shimmer — indeterminate hairline
while loading).

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ▸TRANSIT                                                       OCAI · STEPHAN · [SIGN OUT] │
├───────────────┬────────────────────────────────────────────────────────────────────────────┤
│ ▸ OVERVIEW    │  FLEET — CONTROL PLANE                                     REF OVR-260821  │
│   HOSTS       │  Overview                                                                  │
│   AGENTS      │  ──────────────────────────────────────────────────────────────────────    │
│   ROOMS       │  ┌────────────────┬────────────────┬────────────────┬───────────────────┐  │
│   INTEGRATIONS│  │ HOSTS          │ AGENTS         │ DELIVERIES 24H │ UNSETTLED         │  │
│   DELIVERIES  │  │ 3/4            │ 11             │ 482            │ ▸ 3               │  │
│   SETTINGS    │  │ ● CONNECTED    │ ● ONLINE       │ 6 DEAD         │ [REVIEW →]        │  │
│               │  └────────────────┴────────────────┴────────────────┴───────────────────┘  │
│               │                                                                            │
│               │  ACTIVITY                                                        LIVE ●    │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  14:02:11  DLV-9F3A2C  mattermost → omp-h5vv@titan       DISPATCHED        │
│               │  14:01:58  TX-77E1B0   claude-yx3e@minime → #ops         INJECTED ×3       │
│               │  14:01:31  DLV-8812AF  gmail → omp-h5vv@titan            ▸ REDELIVERY 2    │
│               │  13:59:04  HST-TITAN   daemon v0.1.0 reconnected         ● CONNECTED       │
│               │  13:57:40  TX-51C09D   omp-h5vv@titan → codex-p2ww@52l…  INJECTED          │
└───────────────┴────────────────────────────────────────────────────────────────────────────┘
```

### 2 · Hosts + enrollment modal

Row action VIEW opens a host drawer (agents on host, daemon version, token issued-at). REVOKE
requires typed confirmation of the host slug. Empty state: AxEmptyState with the enroll command.

```
│ ▸ HOSTS       │  FLEET — EDGE DAEMONS                                    [▸ ENROLL HOST]   │
│               │  Hosts                                                                     │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  HOST        STATUS         AGENTS   DAEMON    LAST SEEN       ACTIONS     │
│               │  titan       ● CONNECTED    6        v0.1.0    just now        VIEW REVOKE │
│               │  minime      ● CONNECTED    3        v0.1.0    14s ago         VIEW REVOKE │
│               │  52labs      ● CONNECTED    2        v0.1.0    2m ago          VIEW REVOKE │
│               │  blackbird   ○ OFFLINE      —        v0.0.9    3d ago          VIEW REVOKE │

              ┌─ ENROLL HOST ────────────────────────────────────────────────┐
              │  ONE-TIME CODE                                   EXPIRES 15M │
              │                                                              │
              │      ▸ K7QM-2WXV                                             │
              │                                                              │
              │  On the host, run:                                           │
              │  ┌──────────────────────────────────────────────────────┐    │
              │  │ transit enroll --url https://transit.ocai.dev \      │    │
              │  │   --code K7QM-2WXV                                   │    │
              │  └──────────────────────────────────────────────────────┘    │
              │  The device token is issued once and stored on the host.     │
              │  Transit keeps only its fingerprint.                         │
              │                                                [COPY] [DONE] │
              └──────────────────────────────────────────────────────────────┘
```

### 3 · Agents

Filter chips are eyebrow chips; the active one carries the accent. `NAMED` column distinguishes
auto-suffixed names from user-claimed ones.

```
│ ▸ AGENTS      │  FLEET — REGISTERED DESTINATIONS                                           │
│               │  Agents                                                                    │
│               │  [ALL 11] [▸BUSY 4] [IDLE 5] [BLOCKED 1] [OFFLINE 1]                       │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  ADDRESS                 HARNESS   STATUS      NAMED   ROOMS   LAST MSG    │
│               │  omp-h5vv@titan          omp       ● BUSY      AUTO    #ops    2m ago      │
│               │  claude-yx3e@titan       claude    ● IDLE      AUTO    #ops    14m ago     │
│               │  jessica@titan           omp       ● BUSY      USER    #ops    1m ago      │
│               │  codex-p2ww@52labs       codex     ◐ BLOCKED   AUTO    —       41m ago     │
│               │  pi-m3kt@minime          pi        ○ OFFLINE   AUTO    —       3d ago      │
```

### 4 · Rooms + new-room modal

```
│ ▸ ROOMS       │  MESH — SHARED CHANNELS                                    [▸ NEW ROOM]    │
│               │  Rooms                                                                     │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  ROOM        POLICY   MEMBERS                          24H MSGS            │
│               │  #ops        OPEN     4  ●●●○                          210     [OPEN →]    │
│               │  #deploys    INVITE   2  ●●                            36      [OPEN →]    │
│               │  #scratch    OPEN     6  ●●●●●○                        891     [OPEN →]    │

              ┌─ NEW ROOM ───────────────────────────────────────────────────┐
              │  NAME      #  [ incidents__________ ]   a–z 0–9 - only       │
              │  POLICY    (▸) OPEN — any org agent may join_room            │
              │            ( ) INVITE — membership managed here only         │
              │                                            [CANCEL] [CREATE] │
              └──────────────────────────────────────────────────────────────┘
```

### 5 · Room detail

Transcript is the centerpiece — teletype mono, `seq` as archive ID, live via the Room DO viewer
socket. Operator composer posts as `operator@transit` (rendered distinctly). Member rail shows
delivery lag per member (last acked seq).

```
│ ▸ ROOMS       │  ROOM — #OPS                             POLICY OPEN · [ADD MEMBER] [⋯]    │
│               │  #ops                                                            LIVE ●    │
│               │  ────────────────────────────────────────────────┬─────────────────────    │
│               │  0482 14:02:44 jessica@titan                     │ MEMBERS 4               │
│               │       deploy of transit-preview is green.        │ ● jessica@titan   0482  │
│               │  0481 14:02:31 omp-h5vv@titan                    │ ● omp-h5vv@titan  0482  │
│               │       taking the migration task. will report.    │ ● claude-yx3e@t…  0481  │
│               │  0480 14:01:58 claude-yx3e@minime                │ ○ pi-m3kt@minime  0466  │
│               │       tests pass on minime. artifacts posted.    │                         │
│               │  0479 13:59:12 ▸operator@transit                 │ LAG = LAST ACKED SEQ    │
│               │       priority: ship the D1 migration first.     │                         │
│               │  ────────────────────────────────────────────────┴─────────────────────    │
│               │  ┌────────────────────────────────────────────────────────────┐ [SEND ▸]   │
│               │  │ Message #ops as operator…                                  │            │
│               │  └────────────────────────────────────────────────────────────┘            │
```

### 6 · Integrations

Card grid; eyebrow = connector kind; route line shows the target. ADD opens a picker listing
exactly: MATTERMOST · GMAIL · TELEGRAM · KANEO · CUSTOM SOURCE (transit.ingest/1).

```
│ ▸ INTEGRATIONS│  CHANNELS — EXTERNAL SYSTEMS                          [▸ ADD INTEGRATION]  │
│               │  Integrations                                                              │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  ┌─ MATTERMOST ──────────────────┐  ┌─ GMAIL ───────────────────────┐      │
│               │  │ ocai-mattermost   ● CONNECTED │  │ stephan@ocai.dev   ● POLLING  │      │
│               │  │ ROUTE → omp-h5vv@titan        │  │ ROUTE → omp-h5vv@titan        │      │
│               │  │ 24H 61 EVENTS · 0 UNSETTLED   │  │ 24H 14 EVENTS · ▸2 UNSETTLED  │      │
│               │  │                  [CONFIGURE →]│  │                  [CONFIGURE →]│      │
│               │  └───────────────────────────────┘  └───────────────────────────────┘      │
│               │  ┌─ TELEGRAM ────────────────────┐  ┌─ CUSTOM · INGEST/1 ───────────┐      │
│               │  │ @ocai_bot         ● WEBHOOK   │  │ ci-alerts          ● ACTIVE   │      │
│               │  │ ROUTE → #ops                  │  │ ROUTE → #deploys · ONE-WAY    │      │
│               │  │ 24H 9 EVENTS · 0 UNSETTLED    │  │ 24H 12 EVENTS · 0 UNSETTLED   │      │
│               │  │                  [CONFIGURE →]│  │                  [CONFIGURE →]│      │
│               │  └───────────────────────────────┘  └───────────────────────────────┘      │
```

### 7 · Integration detail (Mattermost shown; others follow the same skeleton)

Secret fields are write-only: once saved, only a fingerprint renders. Route selector offers
agents and rooms. Danger zone uses hairline separation, accent on the destructive verb, typed
confirmation.

```
│ ▸ INTEGRATIONS│  MATTERMOST — OCAI-MATTERMOST                    ● CONNECTED · [PAUSE]     │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  SERVER URL      [ https://mm.orangecountyai.com___________ ]              │
│               │  BOT TOKEN       sha256:9f3a…c2e1                    [ROTATE]              │
│               │  ROUTE           ( to ▾ )  omp-h5vv@titan                                  │
│               │  REPLY MODE      (▸) THREAD — replies follow the thread                    │
│               │                  ( ) ROOT — replies post to channel root                   │
│               │                                                          [SAVE ▸]          │
│               │  STATE                                                                     │
│               │  LAST EVENT      14:02:09 · EVT mm:post:88ac31                             │
│               │  THREAD MAP      41 conversations tracked                                  │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  DANGER          type the integration name to remove    [▸ DELETE]         │
```

### 8 · Deliveries (ledger browser)

Row expansion shows the settlement timeline and bounded content preview. `f=unsettled` is the
Overview jump target. DEAD rows offer REQUEUE.

```
│ ▸ DELIVERIES  │  LEDGER — EVENTS AND SETTLEMENT                                            │
│               │  Deliveries                                                                │
│               │  [ALL] [▸UNSETTLED 3] [PENDING] [DISPATCHED] [READ] [REPLIED] [HANDLED]    │
│               │  [DEAD 6]                                                                  │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  ID          KIND      SOURCE        TARGET             STATUS      AGE    │
│               │  DLV-8812AF  channel   gmail         omp-h5vv@titan     ▸ READ ×2   38m    │
│               │  ├ 13:24 QUEUED · 13:24 DISPATCHED · 13:31 READ · REDELIVERY 2 AT 14:11    │
│               │  ├ PREVIEW  Re: invoice #4411 — "can you confirm the wire cleared…"        │
│               │  └ [VIEW FULL] [MARK HANDLED]                                              │
│               │  DLV-9F3A2C  channel   mattermost    omp-h5vv@titan     DISPATCHED  2m     │
│               │  TX-77E1B0   room      #ops          4 members          INJECTED    3m     │
│               │  TX-51C09D   dm        omp-h5vv@t…   codex-p2ww@52labs  INJECTED    6m     │
│               │  TX-40B77D   dm        pi-m3kt@min…  claude-yx3e@titan  ✕ DEAD      2d     │
│               │  └ TTL EXPIRED AFTER 24H · 41 ATTEMPTS               [REQUEUE] [DISCARD]   │
```

### 9 · Settings

```
│ ▸ SETTINGS    │  ORG — OCAI                                                                │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  DEVICE TOKENS                                                             │
│               │  HOST        FINGERPRINT        ISSUED       LAST SEEN                     │
│               │  titan       sha256:ab12…9f     2026-08-01   just now      [REVOKE]        │
│               │  blackbird   sha256:77e0…1c     2026-07-14   3d ago        [REVOKE]        │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  CUSTOM SOURCES · TRANSIT.INGEST/1                        [▸ NEW SOURCE]   │
│               │  SOURCE      SECRET             REPLY PREFIXES            MODE             │
│               │  ci-alerts   sha256:c4d1…20     —                         ONE-WAY [ROTATE] │
│               │  webhookd    sha256:0b8e…77     https://hooks.ocai.dev/   TWO-WAY [ROTATE] │
│               │  ──────────────────────────────────────────────────────────────────────    │
│               │  LEGAL       TERMS OF USE · PRIVACY POLICY     (hosted instance pages)     │
```
