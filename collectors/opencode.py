#!/usr/bin/env python3
"""AI Activity collector for OpenCode (see README.md, "Send OpenCode usage").

Run by the OpenCode plugin (collectors/opencode-plugin.js) when OpenCode
starts and whenever a session goes idle (or by hand, or from cron: it is
idempotent). It reads the assistant messages changed in OpenCode's local
database since the last accepted upload and posts one entry per message
with its token counts, provider and model. Only ids, provider, model, time
and counts are selected from the database: prompts, replies and tool output
are never read.

Subagent sessions are sent as their root session, so a conversation with
subagents counts once (like Claude Code's subagents).

How far the database was sent is kept in ~/.cache/ai-activity/opencode.json
and only moves forward once the server accepted a batch, so nothing is lost
while the server is down: the next run sends the backlog with its original
times. Delete that file to send everything again (the server stores each
message once).
"""
import _thread
import errno
import json
import os
import signal
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.request

if os.name == "nt":
    import msvcrt
else:
    import fcntl

SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>")
# os.path.join, not "~/.local/share": the offset is keyed by the database's
# path, which must use one separator on Windows.
HOME = os.path.expanduser("~")
DATA = os.environ.get("XDG_DATA_HOME") or os.path.join(HOME, ".local", "share")
DB = os.environ.get("OPENCODE_DB") or os.path.join(DATA, "opencode", "opencode.db")
CACHE = os.path.join(HOME, ".cache", "ai-activity")
BATCH = 400

# Numeric fields only: the message's text lives in other tables, never read.
QUERY = """
SELECT id, session_id, time_updated,
       json_extract(data, '$.providerID'), json_extract(data, '$.modelID'),
       json_extract(data, '$.time.completed'), json_extract(data, '$.time.created'),
       json_extract(data, '$.tokens.input'), json_extract(data, '$.tokens.output'),
       json_extract(data, '$.tokens.reasoning'), json_extract(data, '$.tokens.cache.read'),
       json_extract(data, '$.tokens.cache.write'), json_extract(data, '$.tokens.total')
FROM message
WHERE time_updated >= ? AND json_extract(data, '$.role') = 'assistant'
ORDER BY time_updated
"""


def utc_offset(ts):
    """This machine's UTC offset at that time, in minutes (daylight saving included)."""
    return time.localtime(ts).tm_gmtoff // 60


def num(v):
    return v if isinstance(v, (int, float)) and v > 0 else 0


def roots(db):
    """Each session's root: a subagent's session points to its parent's."""
    parent = dict(db.execute("SELECT id, parent_id FROM session"))

    def root(s):
        seen = set()
        while parent.get(s) and s not in seen:
            seen.add(s)
            s = parent[s]
        return s
    return root


def read(since):
    """Assistant messages with tokens changed since `since` (ms), oldest first, as (time_updated, entry)."""
    db = sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(DB), uri=True, timeout=30)
    try:
        root = roots(db)
        out = []
        for (mid, session, updated, provider, model, completed, created,
             inp, output, reasoning, cread, cwrite, total) in db.execute(QUERY, (since,)):
            when = completed or created
            usage = {"input_tokens": num(inp), "output_tokens": num(output), "reasoning_tokens": num(reasoning),
                     "cache_read_tokens": num(cread), "cache_write_tokens": num(cwrite)}
            if not isinstance(when, (int, float)) or not any(usage.values()):
                continue
            if isinstance(total, (int, float)):
                usage["total_tokens"] = total
            ts = int(when // 1000)
            out.append((updated, {
                "message_id": mid,
                "session_id": root(session),
                "provider_id": provider,
                "model_id": model,
                "occurred_at": ts,
                "utc_offset_min": utc_offset(ts),
                "usage": usage,
            }))
        return out
    finally:
        db.close()


def post(body):
    req = urllib.request.Request(
        SERVER.rstrip("/") + "/api/ingest/opencode", data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=60).read()


def save(path, state):
    with open(path + ".tmp", "w") as out:
        json.dump(state, out)
    os.replace(path + ".tmp", path)


def timeout(signum, frame):
    raise TimeoutError("time limit reached; resumes next run")


def time_limit(seconds):
    """TimeoutError in the main thread after that long."""
    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, timeout)
        signal.alarm(seconds)
    else:  # Windows: no SIGALRM, a timer raises it through the SIGINT handler
        signal.signal(signal.SIGINT, timeout)
        timer = threading.Timer(seconds, _thread.interrupt_main)
        timer.daemon = True
        timer.start()


def lock(path):
    """The file, once holding an exclusive lock on it (released when the run
    exits). flock, or on Windows msvcrt on its first byte (never truncated:
    another run may hold it)."""
    f = os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT, 0o600), "r+b")
    if os.name != "nt":
        fcntl.flock(f, fcntl.LOCK_EX)
        return f
    while True:
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            return f
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EDEADLK):
                raise
            time.sleep(0.1)


def main():
    time_limit(900)
    if not os.path.exists(DB):
        return
    os.makedirs(CACHE, exist_ok=True)
    held = lock(os.path.join(CACHE, "opencode.lock"))  # runs wait for each other
    path = os.path.join(CACHE, "opencode.json")
    try:
        state = json.load(open(path))
        state = state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        state = {}
    # time_updated (ms) of the last message accepted, per database. The next
    # run starts at that same millisecond: a message updated then is sent
    # again rather than missed (the server stores it once). A message still
    # being written is sent again with its final counts once it changes.
    since = state.get(DB, 0)
    rows = read(since)
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        post({"messages": [e for _, e in chunk]})
        state[DB] = chunk[-1][0]
        save(path, state)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never break OpenCode; retried next time
        print("ai-activity opencode collector: %s" % e, file=sys.stderr)
        sys.exit(1)
