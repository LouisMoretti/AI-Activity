# AGENTS.md — AI Activity

> All project instructions live here. `CLAUDE.md` only points to this file.
> Everything in this repo (code, docs, UI) is in English.

## 1. What this is

A personal, multi-device dashboard showing **real measured usage** of AI coding
tools. Current scope: **Claude Code, Codex and OpenCode ingestion**.
OpenCode has no quota of its own: its card shows the conversations active
now (a reply in the last 10 minutes; listed in creation order so parallel
ones never swap places), else the last one, on the right; today's tokens, conversations,
calls, models and providers on the left.

Layout, top to bottom: token activity (centered year calendar, readout shows
today unless a day is hovered), four stats (all-time tokens, today, sessions,
current streak; hover shows the split by tool and model, or the longest
streak), one card per tool (Claude Code, Codex, OpenCode are separate
components; OpenCode takes 2/3 of its row, next to "Today by tool": today's
tokens split by tool), recent conversations (10 + "Show more"). No tool filter:
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
cp .env.example .env        # set PORT, DB_PATH, BACKUP_DIR (loaded by npm
                            # start/dev/gen-key/user/backup; real env vars win)
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

Create a device ingestion key (also copyable later from Settings →
Devices), for the first account unless `--user` says otherwise:

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
every PR and push to main, on x64 and ARM64 runners (`better-sqlite3` is
native). It also builds the Docker image on both and smoke-tests it
(healthy, setup code, first account, device key, backup, clean stop).

### Deploy (Docker + Caddy)

Production runs in Docker behind the server's own **Caddy** container
(reverse proxy, automatic HTTPS), which this repo does not ship.
`compose.yaml` has two services: `app` (the server; no published port) and
`backup` (the same image, `npm run backup` every day into the `data`
volume). It creates the `ai-activity-proxy` network (`PROXY_SUBNET`,
default `172.29.94.0/24`), where the app answers as `ai-activity`; Caddy
joins it. Start this stack first: it creates the network.

```yaml
# Caddy's compose file: add the network to the caddy service
services:
  caddy:
    networks: [default, ai-activity-proxy]   # keep its existing networks
networks:
  ai-activity-proxy:
    external: true
```

```
# Caddy's Caddyfile (DNS A/AAAA record → this server), then reload Caddy
ai.example.com {
	encode zstd gzip
	reverse_proxy ai-activity:3000
}
```

```bash
docker compose up -d --build       # build, start, restart on crash/reboot
docker compose logs app            # setup code for the first account
docker compose exec app node scripts/user.ts add louis   # or the setup code
docker compose exec app node scripts/gen-key.ts "laptop" [--user alice]
docker compose exec app node scripts/backup.ts
git pull && docker compose up -d --build                  # upgrade by hand
```

Upgrades are normally deployed from GitHub (Continuous deployment below).

- The image (`Dockerfile`) is `node:22-slim` (glibc: `better-sqlite3` has
  prebuilt binaries for amd64 and arm64 on Node 22; Node 24 would compile
  from source), runs as `node`, has a `HEALTHCHECK` on `/api/health`, and
  `npm ci` runs inside it (never copy the host's `node_modules`).
- Data lives in the `data` volume mounted on `/data` (`DB_PATH=/data/dashboard.db`,
  `BACKUP_DIR=/data/backups`): mount the directory, never the database file
  alone (its `-wal` / `-shm` sit next to it). `docker stop` sends SIGTERM:
  the server closes SQLite, which checkpoints the WAL.
- Client addresses: Caddy sets `X-Forwarded-For` to the client's address
  (it replaces what the client sent, unless Caddy's `trusted_proxies` says
  otherwise), and the app trusts it only from `TRUST_PROXY`, the whole
  `ai-activity-proxy` subnet. So nothing but Caddy and the app may join
  that network: any other container on it could forge client addresses.
  Change `PROXY_SUBNET` if the range is taken. Without it every visitor
  would look like one client to the login throttle and the sign-up cap.
  IPv6 visitors may all reach Caddy as one address, depending on how
  Caddy's own network and the host's Docker are set up (issue #102).
- Restore: `docker compose stop app backup`, then
  `docker compose run --rm --no-deps app node scripts/restore.ts /data/backups/<file>`,
  then `docker compose start app backup`.
- Before going live: revoke and reissue every device key used through
  quick tunnels, then point the collectors (statusLine, Codex hook,
  OpenCode plugin) at the new URL.
- Logs rotate (`x-logging` in `compose.yaml`: 3 × 10 MB per container);
  Docker keeps them forever otherwise.

### Continuous deployment (GHCR + SSH)

Once CI passes on a push to main, `.github/workflows/deploy.yml` builds the
image on native amd64 and arm64 runners, publishes it as
`ghcr.io/louismoretti/ai-activity:<commit>` (and `:latest`), then connects
over SSH and runs `deploy/ai-activity-deploy <commit>` on the server. It can
also be run by hand (Actions → Deploy → Run workflow, on main). The server
never builds: it pulls the tested image.

The deploy script: checks the commit is on `origin/main` and not older than
the one deployed (a slow run never undoes a newer deploy), pulls the image
(a missing one changes nothing), checks the commit out so `compose.yaml`
matches it, writes `APP_IMAGE=<image>:<commit>` into `.env` (so manual
`docker compose` commands use it too), runs
`docker compose up -d --wait` (non-zero and the app's logs if it does not
become healthy), then removes this app's older images. Volumes are never
touched. Migrations run at start and back the database up first (§4).

Server setup, once (Docker Compose ≥ 2.20 for `--wait-timeout`):

```bash
sudo useradd -m -s /bin/bash deploy && sudo usermod -aG docker deploy
sudo mkdir /srv/ai-activity && sudo chown deploy: /srv/ai-activity
sudo -u deploy git clone https://github.com/LouisMoretti/AI-Activity /srv/ai-activity
sudo -u deploy install -m 600 /dev/null /srv/ai-activity/.env   # PROXY_SUBNET=… if needed
# Outside the checkout, owned by root: a commit cannot change what the key runs.
sudo install -o root -g root -m 755 /srv/ai-activity/deploy/ai-activity-deploy /usr/local/bin/
ssh-keygen -t ed25519 -N '' -C github-deploy -f deploy_key    # on your machine
# /home/deploy/.ssh/authorized_keys (dir 700, file 600, owned by deploy):
restrict,command="/usr/local/bin/ai-activity-deploy" ssh-ed25519 AAAA… github-deploy
ssh-keyscan -p 22 ai.example.com      # from a trusted network; check the fingerprint
```

GitHub, Settings → Environments → `production`: deployment branches
limited to `main` (reviewers optional); secret `DEPLOY_SSH_KEY` (the private
key); variables `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` (the `ssh-keyscan`
lines), optional `DEPLOY_USER` (default `deploy`) and `DEPLOY_PORT`
(default 22). After the first publish, make the GHCR package public
(Package settings → Change visibility; it holds no secret), or run
`docker login ghcr.io` as `deploy` with a `read:packages` token: the
first deploy fails on the pull until then, re-run it. Once it has run (it
creates `ai-activity-proxy`), add the network and the site to Caddy (above).

- The key's forced command ignores what the client asks for except the
  commit id (40 hex characters), and `restrict` turns off shells, PTYs and
  forwarding. `deploy` is in the `docker` group, which is root-equivalent:
  that forced command is what keeps a leaked key from being a root shell.
- Workflows of pull requests and forks never get the environment's
  secrets; `deploy.yml` only deploys green pushes to main of this repo.
- After changing `deploy/ai-activity-deploy`, install it again (the
  `install` line above): the server never runs it from the checkout.
- Roll back on the server: `ALLOW_OLDER=1 ai-activity-deploy <commit>`
  (commits with this deploy setup only), restoring the `-pre-v<N>` backup
  first if the newer version migrated the database (§4). Main's next push
  deploys forward again.
- Manual upgrade without GitHub: `git pull && docker compose up -d --build`
  with `APP_IMAGE` removed from `.env`.

Tests: `npm test` boots the real server on a temp DB and exercises the HTTP
API black-box (`test/api.test.js`), so they must stay green across refactors;
`test/migrations.test.js` upgrades old databases through the
migrations; `test/rate-limit.test.js` covers the token buckets;
`test/backup.test.js` backs up during writes, prunes and
restores; `test/client.test.js` covers client addresses behind proxies;
`test/series.test.js` covers pure helpers of the web
client; `test/dashboard.test.js` runs the client's state class
(`dashboard.svelte.ts`, compiled with `svelte/compiler`) against a fake
browser and fetch; `test/live.test.js` covers the API → view-model mapping;
`test/collector.test.js` runs the README collector and
`test/codex-collector.test.js` runs `collectors/codex.py` through the
README's Codex Stop hook; `test/opencode-collector.test.js` runs
`collectors/opencode.py` through its plugin on a fake OpenCode database.
Types: `npm run typecheck` (tsc for server, svelte-check for web). Node >= 22.18 runs the TypeScript server directly
(type stripping, no build step), so only erasable TS syntax is allowed (no
`enum`, no parameter properties) and relative imports keep their `.ts`
extension.

## 3. Architecture

```
Claude Code statusLine one-liner    Codex Stop hook → collectors/codex.py
OpenCode plugin → collectors/opencode.py
(python3, detached, on the user's device; README.md)
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
  config.ts         env → Config (PORT, DB_PATH, STATIC_DIR, BACKUP_DIR)
  db/schema.ts      open + migrate (runs pending migrations)
  db/migrations.ts  ordered schema migrations (PRAGMA user_version)
  db/queries.ts     every SQL statement lives here
  lib/ingest.ts     payload normalizers, one per tool slug
  lib/viewer-auth.ts  viewer sessions + login throttling
  lib/passwords.ts    scrypt hashing, username/password rules
  lib/setup.ts        one-time setup code for the first account
  lib/avatar.ts       profile picture link allowlist
  lib/backup.ts       consistent snapshots, retention, restore
  lib/client.ts       client address + HTTPS behind the tunnel or TRUST_PROXY
  lib/rate-limit.ts   token buckets + LIMITS (ingest, public reads, per user)
  lib/http.ts
  routes/           auth, ingest, usage (public profiles + leaderboard),
                    devices, account (profile + admin users)
shared/types.ts     API response types shared with the web client
web/
  src/lib/api.ts          typed fetch client (401 → UnauthorizedError)
  src/lib/view-model.ts   what components render (DashboardVM)
  src/lib/live.ts         API responses → DashboardVM ("Unavailable", never guessed)
  src/lib/demo.ts         FICTIONAL ?demo=1 dataset → DashboardVM (always labeled)
  src/lib/series.ts       pure helpers: dense day series, streaks, calendar grid
  src/lib/format.ts       number, day, duration and "ago" formatting
  src/lib/dashboard.svelte.ts  state: provider, auth status, 15 s refresh
  src/App.svelte          routes the pages; renders the site chrome once
  src/components/         StatsRow (StatCard), ActivityChart (Heatmap,
                          TrendChart), ClaudeCodeCard / CodexCard /
                          OpenCodeCard (ToolHeader, QuotaWindow, Meter),
                          TodayByTool,
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
- The Codex collector (`collectors/codex.py`, copied to
  `~/.codex/ai-activity-codex.py`, run detached by a `Stop` hook in
  `~/.codex/hooks.json`) works the same way on the rollouts under
  `~/.codex/sessions` and `archived_sessions` (offsets in
  `~/.cache/ai-activity/codex.json`). Every Codex front end writes those
  files (CLI, `codex exec`, IDE extension, desktop app), so desktop tasks
  are counted without subscribing to its App Server: a separate App Server
  only streams the threads it runs itself. Codex runs a new user hook only
  after it was trusted once (`/hooks`); until then the script can run by
  hand or from cron (idempotent).
- The OpenCode collector (`collectors/opencode.py`, copied to
  `~/.config/opencode/ai-activity-opencode.py`) reads OpenCode's SQLite
  database read-only (`~/.local/share/opencode/opencode.db`), selecting
  numeric fields only (never the `part` table, titles or paths). It sends
  assistant messages changed since the last accepted `time_updated`
  (`~/.cache/ai-activity/opencode.json`), so the database is the queue.
  The plugin (`collectors/opencode-plugin.js` →
  `~/.config/opencode/plugins/ai-activity.js`) runs it detached at
  OpenCode start and on every `session.idle`, one run at a time.
- Never transmit prompts, transcripts, or provider keys — metrics only.

## 4. Data model (SQLite, `data/dashboard.db`)

- `users` — viewer accounts (`username` unique, case-insensitive;
  `password_hash`, `is_admin`, `disabled`, `avatar_url`). Device, usage, quota and session tables carry
  `user_id`. `viewer_sessions` holds hashed session tokens with expiry.
- `settings` — server-wide key/value settings set from the admin panel
  (`signup_open`: `0` closes account creation; absent means open).

- `usage_events` — one row per **Anthropic message id** (`event_id`,
  `source = 'message'`): that API response's tokens, model, session,
  device, date and `utc_offset_min` (the device's UTC offset then; NULL =
  UTC). Rows from the old statusLine snapshot collector have
  `source = 'snapshot'` and counted most API calls about twice; a session's
  snapshot rows are deleted from the time of its oldest message received
  (minus 2 minutes: a snapshot is stamped when the statusLine fired).
- `quota_snapshots` — one row per observed quota window
  (`five_hour`, `seven_day`): account, limit type, % used, reset time,
  measurement date (an unchanged value only moves the latest row's
  measurement date forward). Never summed; see §5 for which row is shown.
- Reads go through two covering indexes on `usage_events`
  (`idx_usage_user_read`: user, time, tool, session, model, token counts,
  offset; `idx_usage_user_session_read`: user, session, tool, time, token
  counts, offset). An index missing a covered column is rebuilt at start.
  Any new read query should be answerable from one of them.
- Migrations are versioned: `PRAGMA user_version` is the number of
  migrations a database has run, and `MIGRATIONS` in
  `server/db/migrations.ts` lists them in order. At open (server,
  `npm run user`, `gen-key`), each pending one runs in its own transaction
  with its version bump, so a failure leaves the database at the last
  completed step. A database at a higher version than the code knows (made
  by a newer server) is refused at start. An existing database with
  pending migrations is backed up first (`<BACKUP_DIR>/dashboard-…-pre-v<N>.db`,
  never pruned), so an upgrade can be undone with `npm run restore`.
- To change the schema, append one function to `MIGRATIONS`, never edit or
  reorder a shipped one, and write it without "already done?" guards (it
  runs once per database). SQLite cannot alter a column in place: a type or
  constraint change rebuilds the table (create new, copy, drop, rename)
  inside that step.
- Migration 1 is the schema from before versioning (databases then are at
  version 0 with any subset of its changes applied), so it alone keeps
  idempotent checks. It also drops the leftovers of removed features
  (`usage_events.cost_estimated_usd`; the `billing_records`,
  `subscriptions`, `invites`, `app_settings` tables).
  `test/migrations.test.js` checks that a fresh database and older ones
  (`test/fixtures/schema-v0.sql`) end at the same schema with their data.
- Migration 2 removes legacy `snapshot` rows already covered by exact
  message rows: per user and session, every snapshot from 2 minutes before
  the session's oldest stored message on (the ingest rule, applied to
  databases whose collectors had already advanced their offsets before
  the 2-minute slack existed).

### Backups

`data/dashboard.db` runs in WAL mode: never copy the file while the server
runs (recent writes sit in `dashboard.db-wal`, and a copy can catch a
half-written page).

```bash
npm run backup                          # safe while the server runs
npm run backup -- --out /mnt/backups --keep-daily 7 --keep-weekly 4
npm run restore -- data/backups/dashboard-20260925-134052.db   # server stopped
```

- `backup` takes a `VACUUM INTO` snapshot (one self-contained file, every
  write committed before it started), writes it under a temporary name,
  runs `integrity_check` on it and only then names it
  `dashboard-YYYYMMDD-HHMMSS.db` (UTC; `-2`, `-3`… for more in the same
  second) in `BACKUP_DIR` (default `data/backups`, made mode 700; files
  are 600 from the moment they are created). It exits non-zero on any
  failure.
  Then it prunes: the newest backup of each of the last 7 days and of each
  of the last 4 ISO weeks stay. Only names of that exact shape are ever
  deleted (`-pre-v2`, `-pre-restore` copies and other files stay).
- Schedule it daily: in Docker, the compose file's `backup` service does
  (`BACKUP_EVERY_SEC`, default 86400; it starts once the app is healthy
  and retries a failed run after 5 minutes); else a cron line on the
  server, e.g.
  `15 3 * * * cd /srv/ai-activity && npm run -s backup`.
- Copy the backups **off the machine** too, or they die with its disk:
  e.g. `rsync -a data/backups/ backup-host:ai-activity/` or `rclone sync
  data/backups remote:ai-activity` (an rclone `crypt` remote encrypts
  them). Backups hold password, session and device key hashes and the
  copyable device keys: the destination must be private.
- `restore` checks the backup (integrity, schema not newer than the code),
  refuses while anything has the database open (it must leave WAL mode,
  which needs every other connection gone), saves the current database as
  `…-pre-restore.db` (one it cannot read or back up, i.e. corrupt, is set
  aside as `dashboard.db.corrupt-<stamp>` instead), then replaces it and
  removes the stale `-wal` / `-shm`. Sessions are rolled back with it: users may have to sign in again,
  and events posted after the backup are missing: the collectors only send
  what their offsets say is new. Deleting `~/.cache/ai-activity/*.json` on
  a device makes its next run resend its whole local history (dedup makes
  that safe).

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
- Days are local, like GitHub's contribution calendar: an event counts on
  `date(occurred_at + utc_offset_min * 60)`, the day where and when it
  happened, for every visitor, and never moves afterwards (DST and travel
  included). "Today", the end of a profile's calendar and its current
  streak use the offset of the owner's latest event that has one (UTC if
  none); the leaderboard's streaks too, per account, and its calendar ends
  on the latest of those days. Time ranges (`stats?days`, leaderboard
  periods) stay rolling windows of 24 h days.

## 5. Ingestion API

`POST /api/ingest/<tool>` with header `Authorization: Bearer <device key>`.
The tool slug in the URL picks the payload normalizer
(`server/lib/ingest.ts`, one entry per slug): `claude-code`, `codex` and `opencode`. There is no default: a bare `/api/ingest` and unknown slugs → `404`.
Unknown or revoked keys → `401`. Small JSON bodies only (256 KB max).
Rate limits per device key **and tool** (one key serves every tool on a
machine: a Claude Code import never holds up Codex), all `429` with
`Retry-After`:

- 300 requests, refill 5/s: batches that write rows, and posts with only
  quotas / context.
- 3,000 replays, refill 50/s: batches whose messages were all stored
  already (the request is given back and charged here instead). The
  collectors resend their whole backlog after any refusal (the Claude Code
  one only saves its offsets once a run is fully accepted), so replays
  need this much larger budget.
- 20,000 rows written (stored or updated), refill 10/s. A batch is charged
  what it wrote, after the fact, so it can push the device into debt;
  while in debt, a batch that would write rows is rolled back (`429`) but
  its quotas and context are still recorded, and replays still pass. A
  backlog therefore always drains, at the refill rate once past the burst,
  which covers a first import of about a month of history.

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
      "utc_offset_min": 120,
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
- `utc_offset_min` (minutes east of UTC, −720..840, quarter hours; else
  dropped → UTC) dates the event's local day (§4). A replay that carries
  one fills it on a row stored without (resending the history fixes old
  days); a stored offset never changes.
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
| device clock at `timestamp` (`time.localtime(t).tm_gmtoff // 60`) | `messages[].utc_offset_min` |
| transcript `message.usage` (4 counters) | `messages[].usage` |
| statusLine `rate_limits.*` | `rate_limits` snapshots (absent → "Unavailable") |
| statusLine `context_window.used_percentage` / `context_window_size` | `context` gauge, never summed |

Transcripts: `~/.claude/projects/<project>/<session>.jsonl`, subagents in
`<session>/subagents/agent-*.jsonl` (same `sessionId`, never in the main
file). Only ids, model, time and counts leave the device, never content.

### Codex sources → payload mapping (`POST /api/ingest/codex`)

Same batch shape (`messages`, `rate_limits`, `context`, `occurred_at`,
`account_ref`), with Codex's own field names:

| Rollout source | Payload field |
| --- | --- |
| `token_usage_record.response_id` (`resp_…`) | `messages[].response_id` (dedup key) |
| older rollouts (no records): `token_count` → `tc_<session>_<thread total>` | `messages[].event_id` |
| `token_usage_record.session_id` / `session_meta.id` | `messages[].session_id` |
| latest `turn_context.model` (or `thread_settings_applied`) | `messages[].model` |
| `token_usage_record.usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`) | `messages[].usage` |
| machine clock at the line's `timestamp` | `messages[].utc_offset_min` |
| `token_count.rate_limits.primary` / `secondary` (`used_percent`, `window_minutes`, `resets_at`) | `rate_limits` → `five_hour` (300 min) / `seven_day` (10080 min); other lengths dropped |
| `token_count.info.last_token_usage.total_tokens` / `model_context_window` | `context.used_tokens` / `window_size` → `used_pct` |

- OpenAI counts cached input inside `input_tokens` (and reasoning inside
  `output_tokens`): stored input is `input_tokens − cached − cache write`,
  so a response's stored total equals Codex's `total_tokens`. Codex's own
  "tokens used" line excludes cached input and is smaller.
- `thread_token_usage` / `total_token_usage` are cumulative and never
  stored; older rollouts repeat `token_count` lines, which map to the same
  id. Other ids (not `resp_…` / `tc_…`) store no usage.
- `occurred_at` of a batch is when Codex measured its rate limits (the
  `token_count` line), so a replayed backlog never overrides newer values.

### OpenCode sources → payload mapping (`POST /api/ingest/opencode`)

`{messages: [...]}`, one entry per assistant message of `opencode.db`
(OpenCode 1.18 schema; `message.data` is JSON):

| Database source | Payload field |
| --- | --- |
| `message.id` (`msg_…`) | `messages[].message_id` → stored as `opencode:<id>` |
| `message.session_id`, walked up `session.parent_id` to the root | `messages[].session_id` |
| `data.providerID` / `data.modelID` | `provider_id` / `model_id` → model `provider/model` |
| `data.time.completed` (else `created`), ms | `occurred_at` (s) |
| machine clock at that time | `messages[].utc_offset_min` |
| `data.tokens.input` / `output` / `reasoning` / `cache.read` / `cache.write` / `total` | `usage.input_tokens` / `output_tokens` / `reasoning_tokens` / `cache_read_tokens` / `cache_write_tokens` / `total_tokens` |

- The `opencode:` prefix is required: OpenCode ids look like Anthropic ids
  (`msg_…`) and must never collide with them. Other ids store no usage.
- OpenCode 1.18 counts reasoning apart from output (its `total` adds it):
  stored output is `output + reasoning`. When `total` shows reasoning
  already inside output (`total = input + output + cache`, reasoning ≤
  output), it is not added twice. Input excludes the cache already.
- Subagent (child) sessions are sent as their root session, so a
  conversation counts once, like Claude Code subagents.
- A message still being written is sent with its partial counts and
  replaced by its final ones (more output tokens → `updated`).
- No `rate_limits` are recorded, whatever the payload holds: OpenCode has
  no 5-hour or weekly window. `cost` is never read. Billing mode per
  session (BYOK vs OpenCode's own) is not recorded yet: it cannot be told
  from the database (a zero cost is free, subscription or unknown price).

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
  in to another account never resets the count. The client
  (`server/lib/client.ts`) is `CF-Connecting-IP` from localhost (the quick
  tunnel or the Vite proxy); the last `X-Forwarded-For` address from a
  `TRUST_PROXY` peer (the Caddy container; earlier entries can be forged);
  else the socket address. The session cookie is `Secure` when the request
  is HTTPS (`X-Forwarded-Proto` counts only from those same proxies). An
  invalid `TRUST_PROXY` stops the server at start.
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
- Rate limits (`LIMITS` in `server/lib/rate-limit.ts`, token buckets in
  memory: they reset when the server restarts). Over one → `429` with
  `Retry-After`:
  - public reads (`/api/u/…`, `/api/leaderboard`, `/api/profiles`): 300
    per client (the client address above), refill 5/s. A dashboard polls
    7 of them every 15 s, so about ten tabs fit behind one address. A
    rate-limited refresh keeps the page as it was (the web client does
    not show it as "Could not reach the server");
  - signed-in routes (`/api/devices`, `/api/account`, `/api/users`,
    `/api/admin`): 120 per user, refill 1/s;
  - at most 20 live devices per account (`POST /api/devices` → `409`;
    revoking one frees a slot; `npm run gen-key` is not capped);
  - ingest: per device key (§5). Health and `/api/auth/*` are not rate
    limited (login, setup and sign-up have their own throttles above).
- Public reads (`/api/u/…`, `/api/leaderboard`) are cached in memory until
  the database changes (this server's writes or the CLI's) and for 30 s at
  most (`readCache` in `server/lib/http.ts`).
- `GET /api/leaderboard?days=1..730|all` (default 30; the UI uses 7, 30 and all), **no session needed** → every enabled
  account, ranked by tokens in the period (`tokens`, `sessions`, `events`,
  `active_days`, `top_model`, `last_active` (null when idle),
  `current_streak`), plus `totals`, `accounts`, `by_model` and a 364-day
  global `activity` ending on `day`. Disabled accounts never appear.
- Usage, public, under `/api/u/:username/`:
  - `stats?days=30&tool=claude-code`
  - `activity?days=364&tool=...` (local-day buckets for the heatmap,
    the `days` days ending on the owner's today)
  - `quotas` (current window per account, tool + limit type; see §5)
  - `summary?tool=...` (`day`: the owner's today; all-time and today's
    tokens, sessions, events, each split `by_model` and `by_tool`)
  - `sessions?limit=10&offset=0&tool=...` (grouped by unique session id,
    with latest `context_used_pct` / `context_window_size`, plus `total`
    for paging)
- `GET /api/devices` (never the keys, only `key_prefix` and `has_key`),
  `POST /api/devices {name}` (returns the key), `GET /api/devices/:id/key`
  → `{key}` (one key per request, own live devices only, `404` otherwise),
  `POST /api/devices/:id/revoke` (also forgets the key). A device is a
  machine: one key serves every tool on it (the tool comes from the ingest
  URL). Keys are stored in `devices.key` so the owner can copy them again
  (they only allow posting usage); ingest looks them up by `key_hash`.
  Keys made before that column existed are hash only: not copyable.

## 7. Testing checklist (acceptance criteria)

1. Real Claude Code, Codex or OpenCode activity → new tokens and sessions
   appear, no duplicates (Codex: after `codex exec`, or any turn once the
   hook is trusted; OpenCode: once a session goes idle).
2. Resend the same message ids (every status line refresh does) →
   `deduped`, totals unchanged; a partial then final entry counts once.
3. Two devices, same account → quota cards show the current window's value,
   not a sum, and a stale post from the other device does not lower it.
4. Server unreachable for a while → offsets do not move, the next refresh
   sends the whole backlog with original times. Killing the status line
   command (its whole process group) does not stop the detached upload.
5. Payload without `rate_limits` → quota card shows "Unavailable".
6. Payload after `resets_at` passed → new snapshot replaces the old window.
7. An event at 23:30 Europe/Paris shows on that local day; "Today" and the
   streak reset at the owner's local midnight.
8. `?demo=1` still shows labeled fictional data (after sign-in); normal view
   never does.
9. `/` signed out: sign-in (or first-account) screen; signed in: redirect
   to `/u/<you>`. `/settings` and `/admin` signed out: sign-in, then back.
   Create account works for anyone (after the first account) until an
   admin closes it; then the tab is hidden and `register` answers `403`.
10. `/u/<name>` opens without an account and shows usage only: no devices
   or account sections, for visitors and other accounts alike.
11. `/leaderboard` opens without an account and lists every enabled
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

Quick tunnels are for testing sessions only; the deployed server is
reached through Caddy (§2, Deploy). After `npm start` works locally:

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

- Codex: account-level usage from the App Server (`account/usage/read`)
  if it ever reports something the rollouts do not.
- OpenCode: billing mode per session (BYOK vs OpenCode's own), once it
  can be told apart without guessing; a quota only if a provider exposes
  one.
