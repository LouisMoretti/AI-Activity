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
import contextlib
import errno
import json
import os
import signal
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.error
import urllib.request

if os.name == "nt":
    import msvcrt
else:
    import fcntl

# Bump on every change to this file or to opencode-plugin.js, with COLLECTOR_VERSIONS in
# shared/collectors.ts: the server flags older copies as outdated.
VERSION = 1
COLLECTOR = {"name": "opencode", "version": VERSION}
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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never redirect a device bearer key to a different destination.
    def redirect_request(self, *args, **kwargs):
        return None


def post(body):
    req = urllib.request.Request(
        SERVER.rstrip("/") + "/api/ingest/opencode", data=json.dumps(dict(body, collector=COLLECTOR)).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    try:
        raw = urllib.request.build_opener(NoRedirect).open(req, timeout=60).read()
    except urllib.error.HTTPError as error:
        if error.code == 426:  # too old for this server: nothing is accepted until updated
            report_update(answer_of(error.read(1 << 16)))
        raise
    report_update(answer_of(raw))


def answer_of(raw):
    try:
        answer = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return {}
    return answer if isinstance(answer, dict) else {}


def report_update(answer):
    """The server's answer says when a newer collector exists ("update"): tell
    it on stderr and in ~/.cache/ai-activity/update-available-opencode, which
    goes away once this copy is up to date."""
    path = os.path.join(CACHE, "update-available-opencode")
    update = answer.get("update")
    if isinstance(update, dict):
        latest = update.get("latest")
        text = ("ai-activity opencode collector v%d is outdated (latest v%s): run the install command "
                "again (Settings > Devices)\n" % (VERSION, latest if type(latest) is int else "?"))
        sys.stderr.write(text)
        with open(path, "w") as out:
            out.write(text)
    else:
        with contextlib.suppress(FileNotFoundError):
            os.remove(path)


def save(path, state):
    with open(path + ".tmp", "w") as out:
        json.dump(state, out)
    os.replace(path + ".tmp", path)


def timeout(signum, frame):
    raise TimeoutError("time limit reached; resumes next run")


@contextlib.contextmanager
def time_limit(seconds):
    """TimeoutError in the main thread after that long, so the finally blocks
    still save. Windows has no SIGALRM: a timer interrupts the main thread
    through SIGINT instead, and Ctrl-C there still means KeyboardInterrupt."""
    if hasattr(signal, "SIGALRM"):
        previous = signal.signal(signal.SIGALRM, timeout)
        signal.alarm(seconds)
        try:
            yield
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)
        return
    expired = threading.Event()

    def interrupted(signum, frame):
        if expired.is_set():
            timeout(signum, frame)
        raise KeyboardInterrupt

    def expire():
        expired.set()
        _thread.interrupt_main()
    previous = signal.signal(signal.SIGINT, interrupted)
    timer = threading.Timer(seconds, expire)
    timer.daemon = True
    timer.start()
    try:
        yield
    finally:
        timer.cancel()
        signal.signal(signal.SIGINT, previous)


BUSY = (errno.EACCES, errno.EAGAIN, errno.EDEADLK)  # a lock held by another run


def lock(path, wait=True):
    """The file, holding an exclusive lock on it; None if taken and not waiting.
    flock, or on Windows msvcrt on its first byte (never truncated: another
    run may hold it). Release it with unlock()."""
    f = os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT, 0o600), "r+b")
    while True:
        try:
            if os.name == "nt":
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(f, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
            return f
        except OSError as error:
            if error.errno not in BUSY:
                f.close()
                raise
            if not wait:
                f.close()
                return None
            time.sleep(0.1)


def unlock(f):
    if os.name == "nt":
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
    f.close()


def main():
    if not os.path.exists(DB):
        return
    os.makedirs(CACHE, exist_ok=True)
    held = lock(os.path.join(CACHE, "opencode.lock"))  # runs wait for each other
    try:
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
    finally:
        unlock(held)


if __name__ == "__main__":
    try:
        with time_limit(900):
            main()
    except Exception as e:  # never break OpenCode; retried next time
        print("ai-activity opencode collector: %s" % e, file=sys.stderr)
        sys.exit(1)
