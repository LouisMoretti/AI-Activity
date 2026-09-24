# AGENTS.md — AI Usage Dashboard

> All project instructions live here. `CLAUDE.md` only points to this file.
> Everything in this repo (code, docs, UI) is in English.

## 1. What this is

A personal, multi-device dashboard showing **real measured usage** of AI coding
tools. Current scope: **Claude Code ingestion only**. Codex and OpenCode
connectors are inventoried but not implemented yet; the UI shows them as
"Unavailable — connector coming soon" instead of fake numbers.

Layout, top to bottom: token activity (centered year calendar, readout shows
today unless a day is hovered), four stats (all-time tokens, today, sessions,
current streak; hover shows the split by tool and model, or the longest
streak), one card per tool (Claude Code, Codex, OpenCode are separate
components), recent conversations (10 + "Show more"), cost. Palette: the
original dark theme; type: Geist, with Geist Mono only for ids and model
names. Quota bars carry a mark for how far into the window we are.

**Hard rule:** the old demo dataset was fictional and deterministic. It is only
visible via `?demo=1`, always labeled "Demonstration data", and never presented
as a real measurement.

## 2. Quick start

```bash
npm install
cp .env.example .env        # set PORT, DB_PATH, DASHBOARD_PASSWORD (loaded by
                            # npm start/dev/gen-key; real env vars win)
npm start                   # http://localhost:3000
```

Create a device ingestion key (printed once, stored hashed):

```bash
npm run gen-key -- "laptop-louis"
```

Health check: `GET /api/health` → `{"ok":true}`.

Web client (Svelte 5 + Vite, in `web/`):

```bash
npm run dev                 # API server on :3000 (watch mode)
npm run dev:web             # UI with HMR on :5173, proxies /api → :3000
npm run build               # → web/dist
STATIC_DIR=web/dist npm start   # serve the built UI (default is still public/
                                # until the redesign switch-over)
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests and the web build on
every PR and push to main.

Tests: `npm test` boots the real server on a temp DB and exercises the HTTP
API black-box (`test/api.test.js`), so they must stay green across refactors;
`test/series.test.js` and `test/format.test.js` cover pure helpers of the web
client.
Types: `npm run typecheck` (tsc for server, svelte-check for web). Node >= 22.18 runs the TypeScript server directly
(type stripping, no build step), so only erasable TS syntax is allowed (no
`enum`, no parameter properties) and relative imports keep their `.ts`
extension.

## 3. Architecture

```
Claude Code statusLine (bash POST, on the user's device, NOT this repo)
   │  HTTPS  Authorization: Bearer <device key> (never in the URL)
   ▼
Node server (Hono + TypeScript, server/) + SQLite (better-sqlite3)
   │  serves the static web root (STATIC_DIR, default public/) + JSON APIs
   ▼
Browser dashboard (web/: Svelte 5 + TypeScript, built by Vite)
```

```
server/
  index.ts          boot: config, DB, listen
  app.ts            Hono app: /api mount, viewer-auth gate, static + SPA fallback
  config.ts         env → Config (PORT, DB_PATH, DASHBOARD_PASSWORD, STATIC_DIR)
  db/schema.ts      open + migrate
  db/queries.ts     every SQL statement lives here
  lib/ingest.ts     payload normalization (flat + raw statusLine shapes)
  lib/viewer-auth.ts, lib/http.ts
  routes/           auth, ingest, usage (stats/activity/quotas/sessions),
                    billing, devices
shared/types.ts     API response types shared with the web client
web/
  src/lib/api.ts          typed fetch client (401 → UnauthorizedError)
  src/lib/view-model.ts   what components render (DashboardVM)
  src/lib/live.ts         API responses → DashboardVM ("Unavailable", never guessed)
  src/lib/demo.ts         FICTIONAL ?demo=1 dataset → DashboardVM (always labeled)
  src/lib/series.ts       pure helpers: dense UTC series, streaks, calendar grid
  src/lib/dashboard.svelte.ts  state: provider, auth status, 15 s refresh
  src/components/         StatsBar, ActivityChart (Heatmap, TrendChart),
                          QuotaCard, SessionList, BillingCards, LoginBar,
                          DevicesPanel, SubscriptionForm, …
  src/styles/tokens.css   design tokens — components only use these variables
public/             legacy UI, removed at the switch-over
```

Components never branch on live vs demo: both sources map into the same
`DashboardVM`, so the "demo is always labeled" rule lives in `demo.ts` only.

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
- Dedup: `event_id` primary key (`INSERT OR IGNORE`) plus an identical-snapshot
  guard per `(device_id, prompt_id, token tuple, model)`. The statusLine fires
  several times per prompt (one snapshot per API call in the agentic loop, plus
  unchanged re-fires); each distinct snapshot is one call's consumption and is
  kept, only byte-identical re-fires are dropped. Dropping everything after the
  first snapshot per prompt undercounts ~3x (measured against session files).
  Replays return `{"ok":true,"deduped":true}`.
- Empty snapshots (zero tokens, no cost delta, e.g. session-start triggers)
  store no usage row (`stored: false`) but their quota snapshots are still
  recorded.
- Offline recovery: the collector spools unsent payloads with their original
  `occurred_at` and replays them in order; the server orders by `occurred_at`.
- Quotas: every window with a numeric `used_percentage` becomes a snapshot
  row dated by the event's `occurred_at` (so spool replays never overwrite a
  newer value). The dashboard reads the latest row per
  `(account_ref, limit_type)`.

### Claude Code statusLine → payload mapping

Official contract: https://code.claude.com/docs/en/statusline

| statusLine field | Payload field |
| --- | --- |
| `session_id` | `session_id` |
| `prompt_id` | `prompt_id` |
| `model.id` | `model` |
| `context_window.current_usage` | `usage` (incremental, summed) |
| `context_window.used_percentage` | `context_used_pct` (gauge, latest per session, never summed) |
| `context_window.context_window_size` | `context_window_size` |
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
- Login is throttled: 10 failures per client (`CF-Connecting-IP` behind the
  tunnel) or 50 in total per 15 min → `429` with `Retry-After` (the global
  cap locks everyone out, owner included, until the window ends). The session
  cookie is `Secure` when the request is HTTPS (incl. `X-Forwarded-Proto`).
- `GET /api/stats?days=30&tool=claude-code`
- `GET /api/activity?days=364&tool=...` (daily buckets for the heatmap)
- `GET /api/quotas` (latest snapshot per account + limit type)
- `GET /api/summary?tool=...` (all-time and current-UTC-day tokens,
  sessions, events, each split `by_model` and `by_tool`)
- `GET /api/sessions?limit=10&tool=...` (grouped by unique session id, with
  latest `context_used_pct` / `context_window_size`, plus `total` for paging)
- `GET /api/billing` (paid vs actual vs estimated, with disclaimer;
  `estimated_available: false` means no cost delta was ever received, shown
  as "Unavailable", not 0)
- `POST /api/billing/subscription` `{tool, plan_name, amount, currency, period_start, period_end, note}`
  (amount >= 0, ISO 4217 currency, YYYY-MM-DD dates with start <= end; 400 otherwise)
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

Live review (edits show up instantly for the tester): keep the Node API on
:3000 (collectors post there) and point the tunnel at the Vite dev server
instead, which proxies `/api` to :3000 and pushes changes over HMR:

```bash
STATIC_DIR=web/dist npm run dev     # API on :3000, restarts on server/ edits
npm run dev:web                     # UI on :5173 with HMR
cloudflared tunnel --url http://localhost:5173
```

`web/vite.config.ts` allows `*.trycloudflare.com` hosts and limits what the
dev server can read to `web/`, `shared/` and `node_modules/`, so `data/`
(the SQLite DB) and `.env` are never served through the tunnel.

## 10. Roadmap (later, not now)

- Codex connector (App Server `thread/tokenUsage/updated`,
  `account/rateLimits/read`, `account/usage/read`; verify desktop-task
  tracking experimentally).
- OpenCode connector (`opencode stats`, session/message DB, local server
  events; record provider + billing mode per session; no 5h/weekly quota
  unless the provider exposes one).
- Per-user viewer login replacing the shared password.
