#!/usr/bin/env python3
"""AI Activity collector for Claude Code (see README.md, "Send Claude Code usage").

Run as the statusLine command (Linux, macOS, Windows): it reads the status
line's JSON, answers at once (it prints nothing) and runs itself again,
detached, with --worker to do the upload, so Claude Code cancelling the
status line command does not stop it. --worker alone collects in the
foreground (errors on stderr).

The worker reads what was added to every transcript under
~/.claude/projects since the last accepted upload and posts one entry per
Anthropic message id with its token counts, plus the status line's quotas
and context fill. Prompts and replies never leave the device: only ids,
model, time and counts.

How far each file was sent is kept in ~/.cache/ai-activity/offsets.json (the
file and lock of the former statusLine one-liner, so replacing it sends
nothing twice) and only moves forward once the server accepted everything,
so nothing is lost while the server is down. Delete that file to send
everything again (the server stores each message id once).
"""
import _thread
import datetime
import errno
import glob
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request

if os.name == "nt":
    import msvcrt
else:
    import fcntl

SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>")
HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "ai-activity")
BATCH = 400
USAGE = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")


def objects(line):
    """JSON objects written one after the other on a line; stops at the first broken one."""
    dec = json.JSONDecoder()
    i = 0
    while True:
        while i < len(line) and line[i] in " \t\r":
            i += 1
        if i >= len(line):
            return
        try:
            obj, i = dec.raw_decode(line, i)
        except ValueError:
            return
        yield obj


def first_dict(text):
    return next((o for o in objects(text) if isinstance(o, dict)), {})


def when(ts):
    """Unix time of an ISO timestamp, or None if it does not parse (the entry is skipped)."""
    try:
        return int(datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp())
    except (AttributeError, TypeError, ValueError):
        return None


def utc_offset(ts):
    """This machine's UTC offset at that time, in minutes (daylight saving included)."""
    return time.localtime(ts).tm_gmtoff // 60


def read(path, offset):
    """Messages of one transcript from that offset, and the offset after its last complete line."""
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n") + 1  # never read a line still being written
    main_file = os.path.basename(path)[:-len(".jsonl")]
    found = []
    for line in data[:end].decode("utf-8", "replace").split("\n"):
        for o in objects(line):
            if not isinstance(o, dict) or o.get("type") != "assistant":
                continue
            m, t = o.get("message"), when(o.get("timestamp"))
            if not isinstance(m, dict) or not isinstance(m.get("id"), str) or not isinstance(m.get("usage"), dict) or t is None:
                continue
            u = m["usage"]
            # A message seen again with more output tokens is its final entry;
            # at a tie, the session's own file wins over a subagent's.
            rank = (u.get("output_tokens") or 0, main_file == o.get("sessionId"))
            found.append((m["id"], rank, {
                "message_id": m["id"],
                "session_id": o.get("sessionId"),
                "model": m.get("model"),
                "occurred_at": t,
                "utc_offset_min": utc_offset(t),
                "usage": {k: u.get(k) or 0 for k in USAGE},
            }))
    return found, offset + end


def post(body):
    req = urllib.request.Request(
        SERVER.rstrip("/") + "/api/ingest/claude-code", data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=60).read()


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


def collect(status):
    time_limit(900)
    os.makedirs(CACHE, exist_ok=True)
    held = lock(os.path.join(CACHE, "lock"))  # uploads wait for each other
    path = os.path.join(CACHE, "offsets.json")
    try:
        with open(path) as f:
            state = first_dict(f.read())
    except OSError:
        state = {}
    found, offsets = [], {}
    for f in glob.glob(os.path.join(HOME, ".claude", "projects", "**", "*.jsonl"), recursive=True):
        size = os.path.getsize(f)
        if size == state.get(f):
            continue
        saved = state.get(f, 0)
        messages, offsets[f] = read(f, saved if isinstance(saved, int) and saved <= size else 0)
        found += messages
    # One entry per message id: the last of its entries sorted by rank.
    messages = list({mid: e for mid, _, e in sorted(found, key=lambda x: x[1])}.values())
    context = status.get("context_window") or {}
    base = {
        "rate_limits": status.get("rate_limits") or {},
        "context": {"session_id": status.get("session_id"), "used_pct": context.get("used_percentage"),
                    "window_size": context.get("context_window_size")},
        "occurred_at": int(time.time()),
    }
    for i in range(0, max(len(messages), 1), BATCH):
        post(dict(base, messages=messages[i:i + BATCH]))
    state.update(offsets)
    with open(path + ".tmp", "w") as out:
        json.dump(state, out)
    os.replace(path + ".tmp", path)
    held.close()


def launch_worker(status):
    """Run this script again with --worker, detached, handing it the status line's JSON on stdin."""
    options = {"start_new_session": True}
    if os.name == "nt":
        options = {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                   | subprocess.CREATE_BREAKAWAY_FROM_JOB}
    args = [sys.executable, os.path.abspath(__file__), "--worker"]
    streams = dict(stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        worker = subprocess.Popen(args, **streams, **options)
    except OSError as error:
        # Some Windows jobs forbid breakaway: keep the console/group detachment.
        if os.name != "nt" or getattr(error, "winerror", None) != 5:
            raise
        options["creationflags"] &= ~subprocess.CREATE_BREAKAWAY_FROM_JOB
        worker = subprocess.Popen(args, **streams, **options)
    worker.stdin.write(status)
    worker.stdin.close()


if __name__ == "__main__":
    try:
        if "--worker" in sys.argv:
            collect(first_dict(sys.stdin.buffer.read().decode("utf-8", "replace")))
        else:
            launch_worker(sys.stdin.buffer.read())
    except Exception as e:  # never break the status line; retried next refresh
        print("ai-activity claude-code collector: %s" % e, file=sys.stderr)
        sys.exit(1)
