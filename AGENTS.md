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
components), recent conversations (10 + "Show more"). No cost or
subscription tracking (removed on purpose). Palette: the
original dark theme; type: Geist, with Geist Mono only for ids and model
names. Quota bars carry a mark for how far into the window we are.

**Pages:** `/` has two tabs, Sign in and Create account (sign-up is always
open; or first-account setup while none exists); once signed
in it redirects to `/u/<you>`, so the address bar is the shareable link.
`/u/<username>` is **public and read-only**, no account needed: activity,
stats, tools/quotas and conversations ("Copy link" in the profile header).
Clicking the avatar opens Your profile / Settings / Admin panel (admins) /
Sign out. `/settings` (signed in) holds Account and Devices; `/admin`
(admins) holds the server overview and the users (reset password,
disable). The demo (`?demo=1`) needs a sign-in and only replaces your own
page.

**Hard rule:** the old demo dataset was fictional and deterministic. It is only
visible via `?demo=1` (once signed in), always labeled "Demonstration data",
and never presented as a real measurement.

## 2. Quick start

```bash
npm install
cp .env.example .env        # set PORT, DB_PATH (loaded by npm start/dev/
                            # gen-key/user; real env vars win)
npm start                   # http://localhost:3000
```

Viewer accounts. Nothing is viewable until the first one exists; that first
account is an admin and owns the data collected so far (collectors keep
posting with `gen-key` keys meanwhile). Create it in the browser with the
one-time **setup code** the server prints at start (new on every start, only
while no account exists), or from the CLI. After that, sign-up is free:
anyone creates their own account from the sign-in page (5 accounts per
client per hour). There are no invite links and no accounts created from
the admin panel (the server CLI `npm run user -- add` still works).

```bash
npm run user -- add louis --name "Louis"   # password prompt (or piped stdin)
npm run user -- add alice [--admin]
npm run user -- passwd louis               # also signs that user out
npm run user -- list
```

Create a device ingestion key (printed once, stored hashed), for the first
account unless `--user` says otherwise:

```bash
npm run gen-key -- "laptop-louis" [--user alice]
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
  config.ts         env → Config (PORT, DB_PATH, DASHBOARD_USER/PASSWORD, STATIC_DIR)
  db/schema.ts      open + migrate
  db/queries.ts     every SQL statement lives here
  lib/ingest.ts     payload normalization (flat + raw statusLine shapes)
  lib/viewer-auth.ts  viewer sessions + login throttling
  lib/passwords.ts    scrypt hashing, username/password rules
  lib/accounts.ts     DASHBOARD_PASSWORD → first account migration
  lib/setup.ts        one-time setup code for the first account
  lib/http.ts
  routes/           auth, ingest, usage (stats/activity/quotas/sessions),
                    devices, account (profile + admin users)
shared/types.ts     API response types shared with the web client
web/
  src/lib/api.ts          typed fetch client (401 → UnauthorizedError)
  src/lib/view-model.ts   what components render (DashboardVM)
  src/lib/live.ts         API responses → DashboardVM ("Unavailable", never guessed)
  src/lib/demo.ts         FICTIONAL ?demo=1 dataset → DashboardVM (always labeled)
  src/lib/series.ts       pure helpers: dense UTC series, streaks, calendar grid
  src/lib/dashboard.svelte.ts  state: provider, auth status, 15 s refresh
  src/components/         StatsBar, ActivityChart (Heatmap, TrendChart),
                          QuotaCard, SessionList,
                          DevicesPanel, AccountMenu,
                          ProfilePanel, ProfileSwitcher, ProfileHeader, UsersPanel,
                          NewAccountForm, AuthPanel,
                          AdminOverview, …
  src/styles/tokens.css   design tokens — components only use these variables
public/             legacy UI, removed at the switch-over
```

Components never branch on live vs demo: both sources map into the same
`DashboardVM`, so the "demo is always labeled" rule lives in `demo.ts` only.

- The server derives the user from the ingestion key (`devices.key_hash`);
  viewers are users with a username + scrypt password hash, and every viewer
  API is scoped to the signed-in user (`c.get("userId")`, set by
  `viewer-auth.ts`). Sessions live in `viewer_sessions` (token stored as a
  SHA-256 hash), so they survive restarts.
- Migration from the shared-password phase: if `DASHBOARD_PASSWORD` is set
  and no account exists, boot creates an admin account named
  `DASHBOARD_USER` (default `admin`) with that password. After that the
  variable is ignored.
- The local collector is just a bash `POST` from the Claude Code statusLine.
  This repo only provides the endpoint plus the documented contract below.
- Never transmit prompts, transcripts, or provider keys — metrics only.

## 4. Data model (SQLite, `data/dashboard.db`)

- `users` — viewer accounts (`username` unique, case-insensitive;
  `password_hash`, `is_admin`, `disabled`). Every other table carries
  `user_id`. `viewer_sessions` holds hashed session tokens with expiry.

- `usage_events` — one row per **incremental** consumption event: tokens
  consumed since the last event, model, session/task id, device, date.
- `quota_snapshots` — one row per observed quota window
  (`five_hour`, `seven_day`): account, limit type, % used, window length,
  reset time, measurement date. Latest snapshot wins; never summed.
- Older databases may still contain `usage_events.cost_estimated_usd` and
  the `billing_records` / `subscriptions` tables from the removed cost
  feature; nothing reads or writes them.

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
  `context_window: {current_usage: {...}}`, `rate_limits`). Cost fields
  (`cost`, `cost_estimated_usd_delta`) are ignored: the dashboard does not
  track cost.
- Dedup: `event_id` primary key (`INSERT OR IGNORE`) plus an identical-snapshot
  guard per `(device_id, prompt_id, token tuple, model)`. The statusLine fires
  several times per prompt (one snapshot per API call in the agentic loop, plus
  unchanged re-fires); each distinct snapshot is one call's consumption and is
  kept, only byte-identical re-fires are dropped. Dropping everything after the
  first snapshot per prompt undercounts ~3x (measured against session files).
  Replays return `{"ok":true,"deduped":true}`.
- Empty snapshots (zero tokens, e.g. session-start triggers)
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
echo "$payload" > "$SPOOL/$event_id.json"
for f in "$SPOOL"/*.json; do
  curl -sf -X POST "$ENDPOINT" -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' --data @"$f" && rm -f "$f" || break
done
echo "[$?] claude"   # visible status line stays minimal
```

## 6. Viewer + device APIs

Viewer (cookie session after `POST /api/auth/login {username, password}`;
every viewer API answers `401` without one, including before the first
account exists):

- `GET /api/auth/status` → `{authenticated, user, setup_required}` (`user` is
  `{id, username, display_name, is_admin}` or null; `setup_required` while no
  account exists), `POST /api/auth/logout`
- `POST /api/auth/setup {setup_code, username, password, display_name}`:
  first account only (`409` once one exists), throttled like a login; the
  code ignores case, spaces and dashes. Signs in.
- `POST /api/auth/register {username, password, display_name}`: open
  sign-up, always available once the first account exists; non-admin
  account, signs in. `409` before the first account exists or if the
  username is taken, `429` after 5 accounts from one client in an hour.
- `GET /api/profiles` → enabled accounts `{username, display_name}`
  (signed in only, so visitors cannot list accounts).
- Public profile pages, **no session needed**: `GET /api/u/:username` →
  `{username, display_name}`, and `/api/u/:username/stats|activity|quotas|summary|sessions`
  (same shapes as the viewer's own routes; `404` if unknown or disabled).
  Nothing private has a public route: devices, account and users
  always need a session and only ever act on the signed-in user.
- Unknown usernames and wrong passwords get the same `401` and the same
  hashing cost.
- Login is throttled: 10 failures per client (`CF-Connecting-IP` behind the
  tunnel) or 50 in total per 15 min → `429` with `Retry-After` (the global
  cap locks everyone out, owner included, until the window ends). The session
  cookie is `Secure` when the request is HTTPS (incl. `X-Forwarded-Proto`).
- `POST /api/account {display_name}` (empty → falls back to the username),
  `POST /api/account/password {current_password, new_password}` (throttled
  like a login; signs out the user's other sessions).
- Admin only (`403` otherwise): `GET /api/users`, `POST /api/users/:id/password
  {password}` (signs that user out; not for the admin's own account, which
  goes through `/api/account/password` so a stolen session cannot take it
  over), `POST /api/users/:id/disable|enable`. A disabled account cannot sign
  in and its device keys are rejected at ingest; admins cannot disable
  themselves, so one enabled admin remains.
- Admin panel (admin only): `GET /api/admin/overview` → server-wide counts
  (accounts, disabled, live devices, events, sessions, last event).
- `GET /api/stats?days=30&tool=claude-code`
- `GET /api/activity?days=364&tool=...` (daily buckets for the heatmap)
- `GET /api/quotas` (latest snapshot per account + limit type)
- `GET /api/summary?tool=...` (all-time and current-UTC-day tokens,
  sessions, events, each split `by_model` and `by_tool`)
- `GET /api/sessions?limit=10&offset=0&tool=...` (grouped by unique session id, with
  latest `context_used_pct` / `context_window_size`, plus `total` for paging)
- `GET /api/devices`, `POST /api/devices {name}` (returns key once),
  `POST /api/devices/:id/revoke`

## 7. Testing checklist (acceptance criteria)

1. Real Claude Code activity → new tokens and sessions appear, no duplicates.
2. Replay the same `event_id` (or same device + `prompt_id`) → `deduped: true`,
   totals unchanged.
3. Two devices, same account → quota cards show the latest snapshot, not a sum.
4. Collector spool replayed after a network outage with old `occurred_at` →
   ordered correctly by event time.
5. Payload without `rate_limits` → quota card shows "Unavailable".
6. Payload after `resets_at` passed → new snapshot replaces the old window.
7. `?demo=1` still shows labeled fictional data (after sign-in); normal view
   never does.
8. `/` signed out: sign-in (or first-account) screen; signed in: redirect
   to `/u/<you>`. `/settings` and `/admin` signed out: sign-in, then back.
   Create account works for anyone (after the first account).
9. `/u/<name>` opens without an account and shows usage only: no devices
   or account sections, for visitors and other accounts alike.

```bash
# manual test example
KEY=<device key>
curl -s localhost:3000/api/ingest -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
  "event_id":"test-1","tool":"claude-code","session_id":"s1",
  "prompt_id":"p1","model":"claude-opus-5-5",
  "usage":{"input_tokens":100,"output_tokens":50,
    "cache_creation_input_tokens":10,"cache_read_input_tokens":20},
  "rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1999999999}},
  "occurred_at":1750000000}'
curl -s 'localhost:3000/api/stats?days=365' ; echo
curl -s localhost:3000/api/quotas ; echo
```

## 8. Testing with the user (Cloudflare tunnel) — REQUIRED

After `npm start` works locally:

1. Install `cloudflared` if missing (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Start the tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Copy the public URL (`https://<random>.trycloudflare.com`).
4. **Send that link to the user for testing** and keep the tunnel running
   while they test. Mention which account to sign in with (or the setup code
   from the server log if none exists yet) and that `?demo=1`
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

## 9. Roadmap (later, not now)

- Codex connector (App Server `thread/tokenUsage/updated`,
  `account/rateLimits/read`, `account/usage/read`; verify desktop-task
  tracking experimentally).
- OpenCode connector (`opencode stats`, session/message DB, local server
  events; record provider + billing mode per session; no 5h/weekly quota
  unless the provider exposes one).
