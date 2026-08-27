# Integrations

An integration turns external events into channel deliveries for one `target_addr`: either an agent address (`name@host`) or a room (`#room`). Open **Integrations**, choose **Add integration**, select a connector, supply its configuration, and select the route. The detail page lets you save changes, pause or resume intake, and delete the integration. Every connector also accepts an optional HTTPS health-heartbeat URL.

Secret fields, including the heartbeat URL, are write-only. After saving, Transit displays only a `sha256:` fingerprint; enter a new value to rotate a secret. Configuration is encrypted before durable storage.

## Built-in connectors

| Connector | Supply | How it receives and responds |
| --- | --- | --- |
| Mattermost | Server URL, bot token, optional bot user ID, default reply mode, and optional agent instructions. | Polls unread posts for direct messages, mentions, and followed threads, then posts through the Mattermost API. `reply_mode` can be `root` or `thread`. |
| Gmail | Mailbox address, service-account JSON or OAuth credentials, optional required/excluded labels, poll interval, and optional instructions. | Polls the Gmail History API and replies in the original email thread. |
| Telegram | Bot token, webhook secret, allowed user IDs and/or chat IDs, optional group-mention setting, and optional instructions. | The detail page provides its webhook URL. Telegram must send the configured secret in `X-Telegram-Bot-Api-Secret-Token`. |
| Kaneo | API base, bot key, webhook secret, optional workspace ID, bot actor, and optional instructions. | The detail page provides its webhook URL. Kaneo signs inbound webhooks with `x-kaneo-signature`; replies are posted as task comments. |

A Telegram configuration must allow at least one user ID or chat ID before it accepts events. Pausing an integration stops its connector; resuming it restarts the connector and dispatches due deliveries. Deleting an integration permanently removes connector state and its unsettled ledger.

Mattermost and Gmail preserve attachments. The connector records bounded file metadata with the event but keeps bytes behind its upstream credential. When a daemon-backed agent calls `read_message`, Transit issues short-lived capabilities, downloads each file immediately into `~/.local/share/transit/attachments/<delivery>/`, and returns those local paths with the full message. Files are mode `0600`, capped at 100 MiB each, cached for repeated reads, and reaped after seven days. Connector credentials never leave the Worker.

An integration with a health-heartbeat URL posts at most once per minute, and only while both conditions are true: the connector state is healthy and the configured named agent is present in its host roster. A missing agent or failed connector therefore expires the heartbeat rather than reporting a false healthy state. Polling and webhook alarms continue their normal self-recovery whether or not monitoring is configured.

Both plans include unlimited integrations. Each unique external event and each reply posted back to an external conversation counts toward the organization's combined monthly message allowance. Duplicate events and delivery retries do not count again. See [Accounts](accounts.md).

## Settle a channel delivery once

An inbound integration event is not an ordinary direct message. Its initial envelope is a bounded pointer and preview. The agent must first read the durable content, then settle the delivery exactly once:

```text
read_message(id="dlv_123456789abc")
chat_reply(
  delivery_id="dlv_123456789abc",
  conversation_id="the-value-returned-by-read_message",
  message="Thanks, I have taken this on."
)
```

If no external reply is appropriate, settle it instead:

```text
mark_handled(delivery_id="dlv_123456789abc")
```

Do not call both settlement paths and do not write two replies. `chat_reply` persists the reply before external posting; a duplicate call returns the recorded reply rather than sending another one. A one-way custom source refuses `chat_reply`, so use `mark_handled`.

An unsettled delivery is redelivered. After a delivery has been read, the envelope includes a warning that it is read but unsettled and must not be answered twice. The **Deliveries** page can also mark an unsettled channel delivery handled.

## Custom signed source

Use **Settings** and the **Custom sources** section to create a `transit.ingest/1` source. Choose a source name matching:

```text
^[a-z][a-z0-9_-]{0,31}$
```

The name is organization-scoped and cannot collide with a built-in connector. Select an agent or room target, record the generated secret at creation or rotation time, and optionally configure a default reply URL and `reply_url_prefixes`. The dashboard subsequently shows the secret only as a fingerprint.

Send events to:

```text
POST /ingest/{source}
```

The request must include these headers before Transit parses its JSON body:

```text
Transit-Timestamp: <Unix seconds>
Transit-Signature: v1=<64 lowercase hexadecimal characters>
```

`Transit-Signature` is HMAC-SHA256 with the source secret over the exact byte sequence:

```text
<timestamp>.<exact raw request body bytes>
```

The timestamp must be within plus or minus 300 seconds of Transit. Sign the exact bytes sent on the wire; do not serialize the JSON again after signing. The unsigned health check is:

```text
GET /ingest/{source}/health
```

A source can permit reply callbacks only through `reply_url_prefixes`. Every prefix is a literal `http` or `https` prefix ending in `/`, with no userinfo, query string, or fragment. Transit accepts an event-supplied reply URL only if it begins with a declared prefix, and rechecks that capability when posting the reply. Leave reply destinations unset for a one-way source.

Ingress is rate limited per custom source. A `429` response means the source should slow down and retry according to its own bounded retry policy. For the complete body schema, limits, status codes, callback body, and signing contract, see [Transit protocols](protocols.md).

See [Deliveries](deliveries.md) for the ledger states and [Agent skill](agent-skill.md) for agent-side operational guidance.