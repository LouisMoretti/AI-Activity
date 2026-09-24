# AGENTS.md — AI Usage Dashboard

> All project instructions live here. `CLAUDE.md` only points to this file.
> Everything in this repo (code, docs, UI) is in English.

## 1. What this is

A personal, multi-device dashboard showing **real measured usage** of AI coding
tools. Current scope: **Claude Code ingestion only**. Codex and OpenCode
connectors are inventoried but not implemented yet; the UI shows them as
"Unavailable — connector coming soon" instead of fake numbers.

Visual direction (kept from the demo): statistics + token activity on top,
tool limits at the bottom, then conversation context and cost.

**Hard rule:** the old demo dataset was fictional and deterministic. It is only
visible via `?demo=1`, always labeled "Demonstration data", and never presented
as a real measurement.

## 2. Quick start

```bash
npm install
cp .env.example .env        # set PORT, DB_PATH, DASHBOARD_PASSWORD
npm start                   # http://localhost:3000
```

Create a device ingestion key (printed once, stored hashed):

```bash
npm run gen-key -- "laptop-louis"
```

Health check: `GET /api/health` → `{"ok":true}`.

## 3. Architecture

```
Claude Code statusLine (bash POST, on the user's device, NOT this repo)
   │  HTTPS  Authorization: Bearer <device key> (never in the URL)
   ▼
Node server (server.js, no framework) + SQLite (better-sqlite3, db.js)
   │  serves public/ + JSON APIs
   ▼
Browser dashboard (public/index.html, app.js, style.css)
```

- The server derives the user from the ingestion key (`devices.key_hash`).
  Schema already has `users` / `devices.user_id`; viewer login is a shared
  `DASHBOARD_PASSWORD` for the testing phase (multi-user login comes later).
- The local collector is just a bash `POST` from the Claude Code statusLine.
  This repo only provides the endpoint plus the documented contract below.
- Never transmit prompts, transcripts, or provider keys — metrics only.

## 4. Data model (SQLite, `data/dashboard.db`)

- `usage_events` — one row per **incremental** consumption event: tokens
  consumed since the last event, model, session/task id, device, date.
- `quota_snapshots` — one row per observed quota window
  (`five_hour`, `seven_day`): account, limit type, % used, window length,
  reset time, measurement date. Latest snapshot wins; never summed.
- `billing_records` / `subscriptions` — actually invoiced API charges and
  manually entered subscription prices (promotions and currency included).

Counting rules:

- Conversations = `COUNT(DISTINCT session_id)`. "Messages" means user messages,
  separate from assistant replies and tool calls (the statusLine JSON alone
  does not provide this count; it can be enriched from local session files —
  otherwise the UI shows "Unavailable").
- Only sum **incremental** token counts (`context_window.current_usage`).
  Never sum cumulative counters (`total_input_tokens`, `total_cost_usd`) or
  observed quotas across devices of the same account.
- Missing data is displayed as "Unavailable", never interpolated.

## 5. Ingestion API

`POST /api/ingest` with header `Authorization: Bearer <device key>`.
Unknown or revoked keys → `401`. Small JSON bodies only (256 KB max).

```json
{
  "event_id": "uuid generated once, replayed identically on retry",
  "tool": "claude-code",
  "session_id": "abc123",
  "prompt_id": "550e8400-... (dedup key when present)",
  "model": "claude-opus-5-5",
  "usage": {
    "input_tokens": 8500,
    "output_tokens": 1200,
    "cache_creation_input_tokens": 5000,
    "cache_read_input_tokens": 2000
  },
  "cost_estimated_usd_delta": 0.01234,
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  },
  "occurred_at": 1738425600,
  "account_ref": "default"
}
```

Notes:

- The server also accepts the near-raw statusLine shape (`model: {id}`,
  `context_window: {current_usage: {...}}`, `cost: {...}`, `rate_limits`).
- `cost.total_cost_usd` from the statusLine is **cumulative per session** and
  is ignored by design. Send an explicit per-event **delta** computed by the
  collector (previous session total kept in a local state file); otherwise the
  cost estimate stays empty and only tokens are counted.
- Dedup: `event_id` primary key (`INSERT OR IGNORE`) plus a
  `(device_id, prompt_id)` guard. Replays return `{"ok":true,"deduped":true}`.
- Offline recovery: the collector spools unsent payloads with their original
  `occurred_at` and replays them in order; the server orders by `occurred_at`.
- Quotas: every window with a numeric `used_percentage` becomes a snapshot
  row. The dashboard reads the latest row per `(account_ref, limit_type)`.

### Claude Code statusLine → payload mapping

Official contract: https://code.claude.com/docs/en/statusline

| statusLine field | Payload field |
| --- | --- |
| `session_id` | `session_id` |
| `prompt_id` | `prompt_id` |
| `model.id` | `model` |
| `context_window.current_usage` | `usage` (incremental, summed) |
| `cost.total_cost_usd` | **delta only** → `cost_estimated_usd_delta` |
| `rate_limits.*.used_percentage` / `resets_at` | `rate_limits` snapshots |
| absent `rate_limits` | show "Unavailable" |

### Minimal collector example (reference only, runs on the device)

```bash
#!/bin/bash
# ~/.claude/statusline-post.sh — reads statusLine JSON on stdin,
# POSTs metrics, never changes the visible status line output.
input=$(cat)
ENDPOINT="https://<tunnel-url>/api/ingest"
KEY="<device key from npm run gen-key>"
STATE=~/.ai-usage/claude-state.json  # { last_cost_per_session, last_event_ids }
SPOOL=~/.ai-usage/spool
mkdir -p "$SPOOL"
event_id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
payload=$(echo "$input" | jq -c --arg eid "$event_id" '{
  event_id: $eid, tool: "claude-code",
  session_id: .session_id, prompt_id: .prompt_id,
  model: (.model.id // .model.display_name),
  usage: (.context_window.current_usage // {}),
  rate_limits: (.rate_limits // {}),
  occurred_at: now | floor
}')
# NOTE: compute cost_estimated_usd_delta from .cost.total_cost_usd minus
# the last total stored for this session in $STATE before POSTing.
echo "$payload" > "$SPOOL/$event_id.json"
for f in "$SPOOL"/*.json; do
  curl -sf -X POST "$ENDPOINT" -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' --data @"$f" && rm -f "$f" || break
done
echo "[$?] claude"   # visible status line stays minimal
```

## 6. Viewer + device APIs

Viewer (cookie session after `POST /api/auth/login {password}`; open if no
`DASHBOARD_PASSWORD` is set):

- `GET /api/auth/status`, `POST /api/auth/logout`
- `GET /api/stats?days=30&tool=claude-code`
- `GET /api/activity?days=364&tool=...` (daily buckets for the heatmap)
- `GET /api/quotas` (latest snapshot per account + limit type)
- `GET /api/sessions?limit=10` (grouped by unique session id)
- `GET /api/billing` (paid vs actual vs estimated, with disclaimer)
- `POST /api/billing/subscription` `{tool, plan_name, amount, currency, period_start, period_end, note}`
- `GET /api/devices`, `POST /api/devices {name}` (returns key once),
  `POST /api/devices/:id/revoke`

## 7. Cost section rules

- **Paid subscriptions**: manually entered, exactly what was paid (promo,
  currency). Via `POST /api/billing/subscription`.
- **Actual API charges**: verified provider invoices only (`billing_records`
  with `kind = api_actual`). Empty until an invoice source is connected.
- **Estimated API equivalent**: derived from measured tokens × list prices. The
  UI labels it "neither an invoice nor a saving". An estimate for
  subscription-included usage is never shown as money saved or spent.

## 8. Testing checklist (acceptance criteria)

1. Real Claude Code activity → new tokens and sessions appear, no duplicates.
2. Replay the same `event_id` (or same device + `prompt_id`) → `deduped: true`,
   totals unchanged.
3. Two devices, same account → quota cards show the latest snapshot, not a sum.
4. Collector spool replayed after a network outage with old `occurred_at` →
   ordered correctly by event time.
5. Payload without `rate_limits` → quota card shows "Unavailable".
6. Payload after `resets_at` passed → new snapshot replaces the old window.
7. `?demo=1` still shows labeled fictional data; normal view never does.

```bash
# manual test example
KEY=<device key>
curl -s localhost:3000/api/ingest -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
  "event_id":"test-1","tool":"claude-code","session_id":"s1",
  "prompt_id":"p1","model":"claude-opus-5-5",
  "usage":{"input_tokens":100,"output_tokens":50,
    "cache_creation_input_tokens":10,"cache_read_input_tokens":20},
  "cost_estimated_usd_delta":0.01,
  "rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1999999999}},
  "occurred_at":1750000000}'
curl -s 'localhost:3000/api/stats?days=365' ; echo
curl -s localhost:3000/api/quotas ; echo
```

## 9. Testing with the user (Cloudflare tunnel) — REQUIRED

After `npm start` works locally:

1. Install `cloudflared` if missing (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Start the tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Copy the public URL (`https://<random>.trycloudflare.com`).
4. **Send that link to the user for testing** and keep the tunnel running
   while they test. Mention the viewer password (if set) and that `?demo=1`
   shows the labeled fictional dataset.
5. Revoke/replace device keys if a test key leaks; never put keys in URLs.

## 10. Roadmap (later, not now)

- Codex connector (App Server `thread/tokenUsage/updated`,
  `account/rateLimits/read`, `account/usage/read`; verify desktop-task
  tracking experimentally).
- OpenCode connector (`opencode stats`, session/message DB, local server
  events; record provider + billing mode per session; no 5h/weekly quota
  unless the provider exposes one).
- Per-user viewer login replacing the shared password.
