# AI Activity

## Send Claude Code usage from a device

1. Create a device key on the server: `npm run gen-key -- "my-laptop"`, or
   **Settings → Devices** in the dashboard (one key per machine, it serves
   every tool on it; **Copy key** there gives it back any time).
2. Add this to `~/.claude/settings.json` on the device, replacing
   `<server>` (e.g. `http://localhost:3000` or your tunnel URL) and
   `<device key>`:

```json
"statusLine": {
  "type": "command",
  "command": "input=$(cat); printf '%s' \"$input\" | setsid -f python3 -c \"import sys,json,os,glob,fcntl,signal,urllib.request as R;signal.alarm(900);N=chr(10);exec('def J(l):'+N+' d=json.JSONDecoder();i=0;r=[]'+N+' while 1:'+N+'  try: o,i=d.raw_decode(l,i)'+N+'  except Exception: return r'+N+'  r.append(o)');H=os.path.expanduser('~/.cache/ai-activity');os.makedirs(H,exist_ok=True);L=open(H+'/lock','w');fcntl.flock(L,fcntl.LOCK_EX);S=H+'/offsets.json';st=([o for o in (J(open(S).read()) if os.path.exists(S) else []) if isinstance(o,dict)] or [{}])[0];s=([o for o in J(sys.stdin.read()) if isinstance(o,dict)] or [{}])[0];off=lambda f,z:st.get(f,0) if st.get(f,0)<=z else 0;F=[(f,os.path.getsize(f)) for f in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'),recursive=True)];F=[(f,off(f,z)) for f,z in F if z!=st.get(f)];NO={};RD=lambda f,o:(lambda b:b.seek(o) and 0 or b.read())(open(f,'rb'));E=[(m['id'],(u.get('output_tokens') or 0,os.path.basename(f)[:-6]==o.get('sessionId')),{'message_id':m['id'],'session_id':o.get('sessionId'),'model':m.get('model'),'occurred_at':T,'utc_offset_min':__import__('time').localtime(T).tm_gmtoff//60,'usage':{k:u.get(k) or 0 for k in ('input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens')}}) for f,o0 in F for d in [RD(f,o0)] for k in [d.rfind(bytes([10]))+1] if NO.__setitem__(f,o0+k) is None for l in d[:k].decode('utf-8','replace').split(N) for o in J(l) if isinstance(o,dict) and o.get('type')=='assistant' and o.get('timestamp') for m in [o.get('message')] if isinstance(m,dict) and isinstance(m.get('id'),str) and isinstance(m.get('usage'),dict) for u in [m['usage']] for T in [int(__import__('datetime').datetime.fromisoformat(o['timestamp'].replace('Z','+00:00')).timestamp())]];M=list({i:e for i,q,e in sorted(E,key=lambda x:x[1])}.values());c=s.get('context_window') or {};B=dict(rate_limits=s.get('rate_limits') or {},context=dict(session_id=s.get('session_id'),used_pct=c.get('used_percentage'),window_size=c.get('context_window_size')),occurred_at=int(__import__('time').time()));P=lambda b:R.urlopen(R.Request('<server>/api/ingest/claude-code',data=json.dumps(b).encode(),headers={'Authorization':'Bearer <device key>','Content-Type':'application/json'}),timeout=60);[P(dict(B,messages=M[i:i+400])) for i in range(0,max(len(M),1),400)];st.update(NO);open(S+'.tmp','w').write(json.dumps(st));os.replace(S+'.tmp',S)\" >/dev/null 2>&1"
}
```

It needs `python3` and `setsid` (util-linux), both standard on Linux, and
runs as your user: no root, no script to install, nothing printed in the
status line.

What it does on every status line refresh:

- Reads what was added to every transcript under `~/.claude/projects`
  (sessions and subagents, all projects) since the last successful upload,
  and sends **one entry per Anthropic message id** with its token counts.
  Prompts and replies never leave the device, only ids, model, time (with
  the device's UTC offset at that time) and counts.
- The first refresh therefore sends every transcript still on disk (Claude
  Code keeps about 30 days by default): that is the import of past
  sessions. It also replaces the rows the old snapshot collector sent for
  those sessions, which counted most API calls twice.
- How far each file was sent is kept in `~/.cache/ai-activity/offsets.json`
  and only moves forward once the server accepted everything, so nothing
  is lost while the server is down: the next refresh sends the backlog.
  Delete that file to send everything again (safe: the server stores each
  message id once), or after pointing the device at another server.
- The server stores each message id once. Claude Code sometimes writes a
  partial entry (a few output tokens) before the final one; the final
  counts replace it.
- `setsid -f` starts the upload in its own session and returns at once.
  Claude Code cancels a status line command when the next refresh comes;
  the upload keeps running. Uploads wait for each other (a lock in
  `~/.cache/ai-activity`) and give up after 15 minutes.
- Also sends the 5-hour and 7-day quotas and the context fill.

**Days are local, like GitHub's contribution calendar.** Each entry carries
the device's UTC offset when it happened (daylight saving included), and
counts on that local day for every visitor: it never moves afterwards,
even if you travel. "Today" and the streak end on the day it is at the
offset of your latest entry. Entries sent before collectors had offsets
count as UTC days; delete `~/.cache/ai-activity/offsets.json` (and
`codex.json`, `opencode.json`) once to resend the history with offsets: nothing is counted
twice, the server only adds the missing offsets.

The tool is part of the URL (`/api/ingest/claude-code`, `/api/ingest/codex`,
`/api/ingest/opencode`, `/api/ingest/antigravity`);
a bare `/api/ingest` answers `404`. See `AGENTS.md` §5 for the payload contract.

## Send Codex usage from a device

1. Create a device key as above (the same key can serve both tools).
2. Copy `collectors/codex.py` to `~/.codex/ai-activity-codex.py` on the
   device and replace `<server>` and `<device key>` at its top (or set
   `AI_ACTIVITY_URL` / `AI_ACTIVITY_KEY` in the environment Codex runs in).
3. Add the Stop hook to `~/.codex/hooks.json`:

`~/.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "setsid -f python3 ~/.codex/ai-activity-codex.py >/dev/null 2>&1 </dev/null; echo '{}'", "timeout": 10 }] }
    ]
  }
}
```

Codex asks you to review a new hook once (`/hooks`) before running it.

What it does at the end of every turn:

- Reads what was added to every rollout under `~/.codex/sessions` and
  `~/.codex/archived_sessions` since the last successful upload. Every
  Codex front end writes those files (CLI, `codex exec`, the IDE extension
  and the desktop app), so tasks started anywhere are counted, including
  ones already in progress when the hook was added.
- Sends **one entry per model response** (`token_usage_record`, keyed by
  its `resp_…` id) with its token counts, model and the machine's UTC
  offset at that time. Rollouts from Codex
  versions without those records are read from their `token_count` lines,
  one per response, keyed by the thread's running total so a repeated line
  counts once. Prompts, replies and tool output never leave the device.
- The first run sends every rollout still on disk: that is the import of
  past sessions.
- Also sends the 5-hour and weekly rate limits and the context fill Codex
  recorded with each response, dated when Codex measured them.
- How far each file was sent is kept in `~/.cache/ai-activity/codex.json`
  and only moves forward once the server accepted everything, so nothing
  is lost while the server is down (no separate spool needed): the next
  turn sends the backlog with its original times. Delete that file to send
  everything again (safe: the server stores each response once).
- `setsid -f` detaches the upload so the turn ends at once; `echo '{}'` is
  the (empty) JSON answer Codex expects from a hook. Runs wait for each
  other and give up after 15 minutes. The script is idempotent: it can
  also run by hand or from cron.

## Send Antigravity usage from a device

1. Create a device key as above (the same key serves every tool).
2. Copy `collectors/antigravity.py` to `~/.gemini/ai-activity-antigravity.py`.
   Replace `<server>` and `<device key>` at its top, or set `AI_ACTIVITY_URL`
   and `AI_ACTIVITY_KEY` in the environment Antigravity runs in. Python 3
   with the standard-library SQLite module is required.
3. Merge this named hook into `~/.gemini/config/hooks.json` (keep existing
   hooks). For Linux/macOS:

```json
{
  "ai-activity": {
    "enabled": true,
    "PostInvocation": [
      {
        "type": "command",
        "command": "python3 ~/.gemini/ai-activity-antigravity.py --post-invocation",
        "timeout": 10
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "python3 ~/.gemini/ai-activity-antigravity.py --hook",
        "timeout": 10
      }
    ]
  }
}
```

For Windows, use this instead, replacing `<user>` with your Windows user
directory name. Backslashes and quotes below are already JSON-escaped:

```json
{
  "ai-activity": {
    "enabled": true,
    "PostInvocation": [
      {
        "type": "command",
        "command": "python \"C:\\Users\\<user>\\.gemini\\ai-activity-antigravity.py\" --post-invocation",
        "timeout": 10
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "python \"C:\\Users\\<user>\\.gemini\\ai-activity-antigravity.py\" --hook",
        "timeout": 10
      }
    ]
  }
}
```

Use **absolute paths to both Python and the collector** if Python is not
on Antigravity's PATH (desktop apps can inherit a different PATH from your
terminal). Find the interpreter with `python3 -c 'import sys; print(sys.executable)'`
on Linux/macOS, or `python -c "import sys; print(sys.executable)"` on Windows.
Quote paths containing spaces; on Windows JSON-escape the interpreter path
in the same way as the collector path. Configure the URL/key in the copied
script if Antigravity does not inherit your terminal's environment; use a
stable server URL for ongoing collection. Keep the device key out of the
hook command and never commit the configured copy.

The [Antigravity hook configuration](https://antigravity.google/docs/hooks/)
is shared by Antigravity 2.0, CLI, and IDE. `PostInvocation` refreshes after
each model invocation during a turn; `Stop` refreshes when the execution
loop ends. Both return immediately and launch a detached collector, which
waits two seconds for metadata to flush before reading. Overlapping workers
use the same lock, so only one uploads at a time. Updates need no manual
command after setup, while Antigravity is running and these hooks are enabled.

4. Restart Antigravity, then confirm **ai-activity is enabled**: `/hooks`
   in CLI, **Settings → Customizations → Hooks** in Antigravity 2.0, or
   **… → Customizations → Hooks** in the IDE agent side panel.
5. Run the copied script **without either hook flag** once to import history
   and see diagnostics. Exit code 0 means supported entries were processed;
   warnings can still indicate skipped unsupported rows. Exit code 1 means
   a database, upload, or resource-budget failure; fix it and run again.
6. Complete a new Antigravity turn and leave the dashboard open. Its existing
   15-second refresh should show supported persisted usage after collection.
   If it does not, check the hook is loaded, Python and script paths resolve
   in Antigravity, the configured URL/key are correct, and a manual run works.
   Unsupported database formats may still produce no usage; see below.

For retries while Antigravity is idle, or a version that persists metadata
later than its hooks run, you can additionally schedule the script without
hook flags every minute (cron on Linux/macOS or Task Scheduler on Windows).
Use the same user, configured script, and absolute interpreter/script paths;
on Windows set the task not to start another instance if already running.
Hooks and scheduled runs share checkpoints and safely deduplicate uploads.

What it does:

- Reads existing SQLite databases directly under
  `~/.gemini/{antigravity,antigravity-cli,antigravity-ide}` and their
  `conversations/` directories. `GEMINI_CLI_HOME` can replace `~/.gemini`.
  Support depends on a database containing the recognized `gen_metadata`
  table; encrypted/legacy conversation files and transcript-only versions
  are not supported.
- Selects generation metadata and, when needed, step metadata from a
  read-only snapshot. Never selects conversation text, prompts, responses,
  tool output, workspace paths, or authentication data.
- Sends ids, recorded model (unknown stays unknown), token counts, the
  original generation timestamp, and this machine's UTC offset at that
  time. Input includes recorded system and new input; cached input is
  separate; text and thinking output are added once. Subagent databases
  count as separate conversations because parent attribution is unavailable.
- Imports all supported history on the first run, then uploads only new
  or changed entries. Checkpoints in `~/.cache/ai-activity/antigravity.json`
  advance after each accepted batch. Failed batches retry on the next run;
  repeated uploads and copied databases do not add duplicate usage. Remove
  the checkpoint file to replay history. Switching server or device key
  automatically starts a new import.
- Does not collect quotas or context fill; the card shows these as
  unavailable, with today's usage and recent conversations.

**Format limitations:** Antigravity's persisted protobuf layout is
undocumented. The parser follows [independently observed field evidence](https://github.com/junhoyeo/tokscale/blob/62ca1eb1677556972ba963fdfa3a41ab23c1eb4b/crates/tokscale-core/src/sessions/antigravity_cli.rs).
It accepts standard protobuf generation timestamps, or a unique matching
step UUID and bot id with a standard step timestamp. Unknown timestamp
layouts, missing response ids, corrupt records, and ambiguous step matches
are skipped with a diagnostic and retried later. They are never assigned
the database modification time or import time, so totals may be incomplete
on unsupported versions. Automated tests use synthetic SQLite/protobuf fixtures. Read-only parsing
was also checked against local Antigravity history; triggering the installed
hook from a live Antigravity turn still needs verification.

## Send OpenCode usage from a device

1. Create a device key as above (the same key serves every tool).
2. Copy `collectors/opencode.py` to `~/.config/opencode/ai-activity-opencode.py`
   and replace `<server>` and `<device key>` at its top (or set
   `AI_ACTIVITY_URL` / `AI_ACTIVITY_KEY` in the environment OpenCode runs in).
3. Copy `collectors/opencode-plugin.js` to
   `~/.config/opencode/plugins/ai-activity.js`. OpenCode loads it at start.

What it does:

- The plugin runs the collector, detached, when OpenCode starts and
  whenever a session goes idle (one run at a time).
- The collector reads OpenCode's own database
  (`~/.local/share/opencode/opencode.db`, read-only) and sends **one entry
  per assistant message** (keyed by its `msg_…` id) with its token counts,
  provider and model (stored as `provider/model`) and the machine's UTC
  offset at that time. It selects numeric fields only: prompts, replies,
  tool output, titles and paths are never read.
- Subagent sessions are sent as their root session, so a conversation
  with subagents counts once.
- OpenCode counts reasoning apart from output; it is added to output, like
  OpenCode's own totals, never twice.
- The first run sends the whole database: that is the import of past
  sessions.
- No 5-hour or weekly limit: OpenCode has none of its own, so the card
  shows the active conversations and today's usage instead.
- How far the database was sent is kept in
  `~/.cache/ai-activity/opencode.json` and only moves forward once the
  server accepted a batch, so nothing is lost while the server is down (the
  database is the queue). Delete that file to send everything again (safe:
  the server stores each message once). The script is idempotent: it can
  also run by hand or from cron.
