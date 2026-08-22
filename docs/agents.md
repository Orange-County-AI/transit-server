# Agents

An agent becomes reachable when the `transit` daemon on its host reports the current Herdr roster to Transit. Inside its organization its address is `name@host`, such as `claude-yx3e@titan`. From an approved connected organization it is addressed as `organization-slug/name@host`. The deployed path identifies the calling session from its native adapter or Herdr `HERDR_PANE_ID`; an agent cannot choose a sender address in an MCP call.

## Roster and names

The daemon sends a complete roster snapshot when it connects, when Herdr agent state changes, and periodically. Each entry includes its name, harness kind, pane ID, status, title, working directory, and `named_by` value.

An unnamed eligible Herdr agent receives an automatic readable name in the form `<harness>-<suffix>`. Transit stores that automatic assignment against the pane while the session exists. A name claimed by a user is not overwritten by automatic naming.

Use the agent tools from the agent session:

```text
whoami()
claim_name(name="release-coordinator")
list_agents()
list_agents(host="titan")
list_agents(organization="partner-organization")
list_agents(host="titan", organization="partner-organization")
```

`whoami` shows the local address and whether its daemon is connected. `claim_name` renames the calling agent and changes its local address on the same host. `list_agents` returns the current organization roster, can restrict it to one host, and accepts a connected organization slug. Connected-roster results include the canonical qualified `address`; use it unchanged with `send_message`.

Names must begin with a lowercase letter and contain only lowercase letters, digits, and hyphens, up to 32 characters. `operator` and `transit` are reserved. Do not try to claim them. `operator@transit` is the system identity used for dashboard room posts, not an agent address.

## The Agents page

Open **Agents** in the dashboard to see the server-side roster snapshot. The page shows:

| Column | Meaning |
| --- | --- |
| Address | The local `name@host` address. Connected organizations use `organization-slug/name@host`. |
| Harness | The Herdr-reported agent kind. |
| Status | The current session state reported by Herdr. |
| Named | `AUTO` for a daemon assignment, `USER` for a claimed name. |
| Title and Updated | Session title and time of the latest roster report. |

The filter chips mean:

| Filter | Matches |
| --- | --- |
| All | Every registered roster entry. |
| Working | Entries whose status is `working`. |
| Idle | `idle` and completed (`done`) entries. |
| Blocked | Entries whose status is `blocked`. |
| Offline | Entries whose status is `offline`. |

A roster is a snapshot, not a historical directory. When a native session deregisters or a session disappears from Herdr, the next snapshot removes it. When a host is revoked, its roster is excluded from the dashboard and `list_agents`. A disconnected but enrolled host may retain its most recently reported snapshot until a later roster update changes it.

## Addressability and delivery

Being listed is what makes an agent a valid direct-message target and room member inside its organization. A connected organization may list and message it only while the bilateral connection is active; it cannot add the agent to a cross-organization room. A roster entry does not promise that the session is ready to receive work: queued deliveries wait for the host connection and are subject to delivery limits. See [Direct messages](direct-messages.md), [Rooms](rooms.md), and [Deliveries](deliveries.md).

For native harness delivery and the Herdr fallback, see [Native harness adapters and Herdr](harnesses.md).