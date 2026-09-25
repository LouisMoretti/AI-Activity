# AGENTS.md — AI Activity

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
components), recent conversations (10 + "Show more"). No tool filter:
every tool is always shown. No cost or subscription tracking (removed on
purpose). Only demo data carries a badge ("Demonstration data"). Palette: the
original dark theme; type: Geist, with Geist Mono only for ids and model
names. Quota bars carry a mark for how far into the window we are.

**Pages:** `/` has two tabs, Sign in and Create account (sign-up is open
unless an admin closed it; or first-account setup while none exists); once signed
in it redirects to `/u/<you>`, so the address bar is the shareable link.
`/u/<username>` is **public and read-only**, no account needed: activity,
stats, tools/quotas and conversations.
`/leaderboard` is **public** too: every enabled account (idle ones last,
with zeros) ranked by tokens over 7 days / 30 days / all time, with
server-wide totals, the model split and a global activity calendar. The
header (`SiteHeader`) is the same on every page: logo, demo badge, and the
avatar menu (or "Sign in"), plus a breadcrumb of the current page
(`AI Activity / (picture) @name`, `/ Leaderboard`, `/ Settings`, `/ Admin panel`) that
replaces in-page titles. It never reads the route itself (`App.svelte`
passes the breadcrumb); site chrome (a
future footer too) is rendered once in `App.svelte`, outside the pages.
Clicking the avatar opens Your profile / Leaderboard / Settings / Admin
panel (admins) / Sign out. `/settings` (signed in) holds Account and Devices; `/admin`
(admins) holds the server overview, the account-creation switch and the
users (make or remove admin, reset password, disable). The demo (`?demo=1`) needs a sign-in and only replaces your own
page.

**Hard rule:** the old demo dataset was fictional and deterministic. It is only
visible via `?demo=1` (once signed in), always labeled "Demonstration data",
and never presented as a real measurement.

## 2. Quick start

```bash
npm install
cp .env.example .env        # set PORT, DB_PATH (loaded by npm start/dev/
                            # gen-key/user; real env vars win)
npm run build               # the UI, served from web/dist
npm start                   # http://localhost:3000
```

Viewer accounts. Nothing is viewable until the first one exists; that first
account is an admin and owns the data collected so far (collectors keep
posting with `gen-key` keys meanwhile). Create it in the browser with the
one-time **setup code** the server prints at start (new on every start, only
while no account exists), or from the CLI. After that, sign-up is open:
anyone creates their own account from the sign-in page (5 accounts per
client per hour), until an admin turns account creation off in the admin
panel. There are no invite links and no accounts created from the admin
panel (the server CLI `npm run user -- add` always works).

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
npm run dev                 # API server on :3000 (watch mode; restart
                            # it after editing .env)
npm run dev:web             # UI with HMR on :5173, proxies /api → :3000
npm run build               # → web/dist (the default STATIC_DIR)
```

CI (`.github/workflows/ci.yml`) runs typecheck, the web build and tests
(tests serve `web/dist`, so the build comes first) on
every PR and push to main.

Tests: `npm test` boots the real server on a temp DB and exercises the HTTP
API black-box (`test/api.test.js`), so they must stay green across refactors;
`test/series.test.js` covers pure helpers of the web
client; `test/dashboard.test.js` runs the client's state class
(`dashboard.svelte.ts`, compiled with `svelte/compiler`) against a fake
browser and fetch; `test/collector.test.js` runs the README collector.
Types: `npm run typecheck` (tsc for server, svelte-check for web). Node >= 22.18 runs the TypeScript server directly
(type stripping, no build step), so only erasable TS syntax is allowed (no
`enum`, no parameter properties) and relative imports keep their `.ts`
extension.

## 3. Architecture

```
Claude Code statusLine one-liner (python3 via setsid, on the user's device; README.md)
   │  HTTPS  Authorization: Bearer <device key> (never in the URL)
   ▼
Node server (Hono + TypeScript, server/) + SQLite (better-sqlite3)
   │  serves the static web root (STATIC_DIR, default web/dist) + JSON APIs
   ▼
Browser dashboard (web/: Svelte 5 + TypeScript, built by Vite)
```

```
server/
  index.ts          boot: config, DB, listen
  app.ts            Hono app: /api mount, viewer-auth gate, static + SPA fallback
  config.ts         env → Config (PORT, DB_PATH, STATIC_DIR)
  db/schema.ts      open + migrate
  db/queries.ts     every SQL statement lives here
  lib/ingest.ts     payload normalizers, one per tool slug
  lib/viewer-auth.ts  viewer sessions + login throttling
  lib/passwords.ts    scrypt hashing, username/password rules
  lib/setup.ts        one-time setup code for the first account
  lib/avatar.ts       profile picture link allowlist
  lib/http.ts
  routes/           auth, ingest, usage (public profiles + leaderboard),
                    devices, account (profile + admin users)
shared/types.ts     API response types shared with the web client
web/
  src/lib/api.ts          typed fetch client (401 → UnauthorizedError)
  src/lib/view-model.ts   what components render (DashboardVM)
  src/lib/live.ts         API responses → DashboardVM ("Unavailable", never guessed)
  src/lib/demo.ts         FICTIONAL ?demo=1 dataset → DashboardVM (always labeled)
  src/lib/series.ts       pure helpers: dense UTC series, streaks, calendar grid
  src/lib/format.ts       number, day, duration and "ago" formatting
  src/lib/dashboard.svelte.ts  state: provider, auth status, 15 s refresh
  src/App.svelte          routes the pages; renders the site chrome once
  src/components/         StatsRow (StatCard), ActivityChart (Heatmap,
                          TrendChart), ClaudeCodeCard / CodexCard /
                          OpenCodeCard (ToolHeader, QuotaWindow, Meter),
                          Conversations, DevicesPanel, AccountMenu,
                          SiteHeader, ProfilePanel, UsersPanel,
                          NewAccountForm, AuthPanel, Leaderboard,
                          AdminOverview, …
  src/styles/tokens.css   design tokens — components only use these variables
```

Components never branch on live vs demo: both sources map into the same
`DashboardVM`, so the "demo is always labeled" rule lives in `demo.ts` only.

- The server derives the user from the ingestion key (`devices.key_hash`);
  viewers are users with a username + scrypt password hash, and every viewer
  API is scoped to the signed-in user (`c.get("userId")`, set by
  `viewer-auth.ts`). Sessions live in `viewer_sessions` (token stored as a
  SHA-256 hash), so they survive restarts.
- The first account is created with the setup code or `npm run user --
  add`: both need access to the server, so whoever reaches the public
  tunnel first cannot take it.
- The collector is a one-liner in the Claude Code statusLine (README.md,
  exercised by `test/collector.test.js`): it reads what was added to every
  local transcript since the last accepted upload (byte offsets in
  `~/.cache/ai-activity/offsets.json`; the first run imports all history)
  and posts one entry per Anthropic message id, detached with `setsid -f`
  so Claude Code cancelling the status line does not kill it.
- Never transmit prompts, transcripts, or provider keys — metrics only.

## 4. Data model (SQLite, `data/dashboard.db`)

- `users` — viewer accounts (`username` unique, case-insensitive;
  `password_hash`, `is_admin`, `disabled`, `avatar_url`). Device, usage, quota and session tables carry
  `user_id`. `viewer_sessions` holds hashed session tokens with expiry.
- `settings` — server-wide key/value settings set from the admin panel
  (`signup_open`: `0` closes account creation; absent means open).

- `usage_events` — one row per **Anthropic message id** (`event_id`,
  `source = 'message'`): that API response's tokens, model, session,
  device, date. Rows from the old statusLine snapshot collector have
  `source = 'snapshot'` and counted most API calls about twice; a session's
  snapshot rows are deleted from the time of its oldest message received
  (minus 2 minutes: a snapshot is stamped when the statusLine fired).
- `quota_snapshots` — one row per observed quota window
  (`five_hour`, `seven_day`): account, limit type, % used, reset time,
  measurement date (an unchanged value only moves the latest row's
  measurement date forward). Never summed; see §5 for which row is shown.
- Reads go through two covering indexes on `usage_events`
  (`idx_usage_user_read`: user, time, tool, session, model, token counts;
  `idx_usage_user_session_read`: user, session, tool, time, token counts).
  Any new read query should be answerable from one of them.
- Migrations are additive (`ADD COLUMN` when missing) and also drop the
  leftovers of removed features: `usage_events.cost_estimated_usd` and the
  `billing_records`, `subscriptions`, `invites`, `app_settings` tables.

Counting rules:

- Conversations = `COUNT(DISTINCT session_id)`. User messages (separate
  from assistant replies and tool calls) are not counted yet (issue #6):
  nothing in the API or the UI shows a message count.
- Count each message id once, with its final counts (the transcript may
  write a partial entry first). Never store the statusLine's
  `context_window.current_usage`: it re-fires with a partial then a final
  snapshot per API call. Never sum cumulative counters (`total_input_tokens`, `total_cost_usd`) or
  observed quotas across devices of the same account.
- Missing data is displayed as "Unavailable", never interpolated.

## 5. Ingestion API

`POST /api/ingest/<tool>` with header `Authorization: Bearer <device key>`.
The tool slug in the URL picks the payload normalizer
(`server/lib/ingest.ts`, one entry per slug); only `claude-code` exists so
far. There is no default: a bare `/api/ingest` and unknown slugs → `404`.
Unknown or revoked keys → `401`. Small JSON bodies only (256 KB max).
The payload's `tool` is optional; when present it must equal the slug
(`400` otherwise).

A batch of transcript messages (what the README collector sends):

```json
{
  "messages": [
    {
      "message_id": "msg_011CfQ1q3CGJXyE6UmWhehGs",
      "session_id": "7d891161-…",
      "model": "claude-opus-5-5",
      "occurred_at": 1790334657,
      "usage": {
        "input_tokens": 2,
        "output_tokens": 281,
        "cache_creation_input_tokens": 19373,
        "cache_read_input_tokens": 20882
      }
    }
  ],
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  },
  "context": { "session_id": "7d891161-…", "used_pct": 42, "window_size": 200000 },
  "occurred_at": 1790334657,
  "account_ref": "default"
}
```

→ `{ok, messages, stored, updated, deduped}`. One flat event is also
accepted: its `event_id` is the message id (`usage`, `session_id`, `model`,
`occurred_at` at the top level) → `{ok, stored, updated, deduped, event_id}`.

Notes:

- Dedup: `event_id` = Anthropic message id, stored once. Claude Code writes
  a response in several transcript entries, sometimes a partial one (a few
  output tokens) before the final one: a message seen again with more
  output tokens replaces the stored counts (`updated`), anything else is a
  replay (`deduped`). A message id stored by another account is never
  touched. The collector resends the recent messages on every refresh;
  that is safe by design.
- Entries without an Anthropic message id (`msg_…`; e.g. a random per-fire
  UUID) store no usage, and neither does a raw
  statusLine payload (`context_window.current_usage`): it re-fires with a
  partial then a final snapshot per API call, which counted about twice.
  Such a payload still records its quotas and context gauge.
- When messages of a session arrive, that session's old `snapshot` rows
  from 2 minutes before the oldest of those messages on are deleted, so the
  two never add up. The collector's first run sends whole transcripts, so
  every session still on disk is fully replaced.
- Context gauge: `context` (or a raw statusLine `context_window`) is put on
  the session's newest row; `recentSessions` shows the latest one.
- Empty messages (zero tokens) store no row.
- Quotas: every window with a numeric `used_percentage` (or `used_pct`) is
  recorded, dated by the payload's `occurred_at` (capped at now). A device
  can post stale values (a terminal that has not called the API yet), so
  per `(account_ref, tool, limit_type)` the dashboard shows, among the
  rows measured in the day before the latest one, the window that resets
  last and its highest `used_pct` (usage only rises within a window). A
  window whose `resets_at` is further away than its length (5 h, 7 days,
  31 days for unknown types; plus 10 min) is dropped at ingest, since it
  would pin the display. Cost fields are ignored.

### Claude Code sources → payload mapping

| Source | Payload field |
| --- | --- |
| transcript `message.id` | `messages[].message_id` (dedup key) |
| transcript `sessionId` (also on subagent files) | `messages[].session_id` |
| transcript `message.model`, `timestamp` | `model`, `occurred_at` |
| transcript `message.usage` (4 counters) | `messages[].usage` |
| statusLine `rate_limits.*` | `rate_limits` snapshots (absent → "Unavailable") |
| statusLine `context_window.used_percentage` / `context_window_size` | `context` gauge, never summed |

Transcripts: `~/.claude/projects/<project>/<session>.jsonl`, subagents in
`<session>/subagents/agent-*.jsonl` (same `sessionId`, never in the main
file). Only ids, model, time and counts leave the device, never content.

## 6. Viewer + device APIs

Viewer (cookie session after `POST /api/auth/login {username, password}`;
every viewer API answers `401` without one, including before the first
account exists):

- `GET /api/auth/status` → `{authenticated, user, setup_required, signup_open}`
  (`user` is `{id, username, display_name, avatar_url, is_admin}` or null;
  `setup_required` while no account exists), `POST /api/auth/logout`
- `POST /api/auth/setup {setup_code, username, password, display_name}`:
  first account only (`409` once one exists), throttled like a login; the
  code ignores case, spaces and dashes. Signs in.
- `POST /api/auth/register {username, password, display_name}`: open
  sign-up once the first account exists; non-admin account, signs in.
  `403` while an admin has closed account creation, `409` before the first
  account exists or if the username is taken, `429` after 5 accounts from
  one client in an hour, or while the login throttle blocks that client
  (or everyone, at the global cap).
- `GET /api/profiles` → enabled accounts `{username, display_name, avatar_url}`,
  **no session needed** (the public leaderboard lists them too).
- Public profile pages, **no session needed**: `GET /api/u/:username` →
  `{username, display_name, avatar_url}`, and the usage routes below under
  `/api/u/:username/` (`404` if unknown or disabled). They are the only
  copy: the signed-in viewer reads their own page through them too.
  Nothing private has a public route: devices, account and users
  always need a session and only ever act on the signed-in user.
- Unknown usernames and wrong passwords get the same `401` and the same
  hashing cost.
- Login is throttled: 10 failures per client or 50 in total per 15 min →
  `429` with `Retry-After` (the global cap locks everyone out, owner
  included, until the window ends). Login, setup and password change count
  each attempt as a failure before hashing (a parallel burst cannot slip
  through) and a right password only takes back that one attempt: signing
  in to another account never resets the count. The client is
  `CF-Connecting-IP`, trusted only from localhost (the tunnel or the Vite
  proxy), else the socket address. The session cookie is `Secure` when the
  request is HTTPS (incl. `X-Forwarded-Proto`).
- Every `/api` request other than GET must be `Content-Type:
  application/json` (`415` otherwise) and not `Sec-Fetch-Site: cross-site`
  (`403`): a cross-site HTML form could otherwise post JSON-looking
  `text/plain` and sign the visitor in to another account.
- `POST /api/account {display_name?, avatar_url?}` (only the fields sent
  change; empty display name → the username, empty picture → the initial).
  Profile pictures are links, never uploads: every visitor's browser loads
  them (public pages, open sign-up), so only `https` images from GitHub,
  Gravatar or Imgur are accepted (`server/lib/avatar.ts`, per-host path
  check, no credentials or port), anything else is `400`. Hosts that show
  the uploader access logs would let anyone track every viewer's IP. The
  client loads them with `referrerpolicy="no-referrer"`.
  `POST /api/account/password {current_password, new_password}` (throttled
  like a login; signs out the user's other sessions).
- Admin only (`403` otherwise): `GET /api/users`, `POST /api/users/:id/password
  {password}` (signs that user out; not for the admin's own account, which
  goes through `/api/account/password` so a stolen session cannot take it
  over), `POST /api/users/:id/admin {is_admin}` (grant or remove admin
  rights, never your own, so an admin always remains),
  `POST /api/users/:id/disable|enable`. A disabled account cannot sign
  in and its device keys are rejected at ingest; admins cannot disable
  themselves, so one enabled admin remains.
- Admin panel (admin only): `GET /api/admin/overview` → server-wide counts
  (accounts, disabled, live devices, events, sessions, last event).
  `GET /api/admin/settings` → `{signup_open}`, `POST /api/admin/settings
  {signup_open}` opens or closes account creation (stored in `settings`;
  open by default). Closing it never affects existing accounts or the CLI.
- Public reads (`/api/u/…`, `/api/leaderboard`) are cached in memory until
  the database changes (this server's writes or the CLI's) and for 30 s at
  most (`readCache` in `server/lib/http.ts`).
- `GET /api/leaderboard?days=1..730|all` (default 30; the UI uses 7, 30 and all), **no session needed** → every enabled
  account, ranked by tokens in the period (`tokens`, `sessions`, `events`,
  `active_days`, `top_model`, `last_active` (null when idle),
  `current_streak`), plus `totals`, `accounts`, `by_model` and a 364-day
  global `activity`. Disabled accounts never appear.
- Usage, public, under `/api/u/:username/`:
  - `stats?days=30&tool=claude-code`
  - `activity?days=364&tool=...` (daily buckets for the heatmap)
  - `quotas` (current window per account, tool + limit type; see §5)
  - `summary?tool=...` (all-time and current-UTC-day tokens, sessions,
    events, each split `by_model` and `by_tool`)
  - `sessions?limit=10&offset=0&tool=...` (grouped by unique session id,
    with latest `context_used_pct` / `context_window_size`, plus `total`
    for paging)
- `GET /api/devices`, `POST /api/devices {name}` (returns key once),
  `POST /api/devices/:id/revoke`

## 7. Testing checklist (acceptance criteria)

1. Real Claude Code activity → new tokens and sessions appear, no duplicates.
2. Resend the same message ids (every status line refresh does) →
   `deduped`, totals unchanged; a partial then final entry counts once.
3. Two devices, same account → quota cards show the current window's value,
   not a sum, and a stale post from the other device does not lower it.
4. Server unreachable for a while → offsets do not move, the next refresh
   sends the whole backlog with original times. Killing the status line
   command (its whole process group) does not stop the detached upload.
5. Payload without `rate_limits` → quota card shows "Unavailable".
6. Payload after `resets_at` passed → new snapshot replaces the old window.
7. `?demo=1` still shows labeled fictional data (after sign-in); normal view
   never does.
8. `/` signed out: sign-in (or first-account) screen; signed in: redirect
   to `/u/<you>`. `/settings` and `/admin` signed out: sign-in, then back.
   Create account works for anyone (after the first account) until an
   admin closes it; then the tab is hidden and `register` answers `403`.
9. `/u/<name>` opens without an account and shows usage only: no devices
   or account sections, for visitors and other accounts alike.
10. `/leaderboard` opens without an account and lists every enabled
    account, idle ones included; disabled ones never listed.

```bash
# manual test example
KEY=<device key>
curl -s localhost:3000/api/ingest/claude-code -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
  "event_id":"msg_test_1","tool":"claude-code","session_id":"s1",
  "model":"claude-opus-5-5",
  "usage":{"input_tokens":100,"output_tokens":50,
    "cache_creation_input_tokens":10,"cache_read_input_tokens":20},
  "rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1999999999}},
  "occurred_at":1750000000}'
curl -s 'localhost:3000/api/u/<you>/stats?days=365' ; echo
curl -s localhost:3000/api/u/<you>/quotas ; echo
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
npm run dev                         # API on :3000, restarts on server/ edits
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
