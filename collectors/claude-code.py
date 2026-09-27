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

How far each file was sent is kept in ~/.cache/ai-activity/offsets.json, per
server and device key (a new one gets the whole history), and only moves
forward once the server accepted everything, so nothing is lost while the
server is down. Delete that file to send everything again (the server
stores each message id once).
"""
import _thread
import contextlib
import datetime
import errno
import glob
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

if os.name == "nt":
    import msvcrt
else:
    import fcntl

# Bump on every change to this file, with COLLECTOR_VERSIONS in
# shared/collectors.ts: the server flags older copies as outdated.
VERSION = 2
COLLECTOR = {"name": "claude-code", "version": VERSION}
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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never redirect a device bearer key to a different destination.
    def redirect_request(self, *args, **kwargs):
        return None


def post(body):
    req = urllib.request.Request(
        SERVER.rstrip("/") + "/api/ingest/claude-code", data=json.dumps(dict(body, collector=COLLECTOR)).encode(),
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
    it on stderr and in ~/.cache/ai-activity/update-available-claude-code, which
    goes away once this copy is up to date."""
    path = os.path.join(CACHE, "update-available-claude-code")
    update = answer.get("update")
    if isinstance(update, dict):
        latest = update.get("latest")
        text = ("ai-activity claude-code collector v%d is outdated (latest v%s): run the install command "
                "again (Settings > Devices)\n" % (VERSION, latest if type(latest) is int else "?"))
        sys.stderr.write(text)
        with open(path, "w") as out:
            out.write(text)
    else:
        with contextlib.suppress(FileNotFoundError):
            os.remove(path)

KEPT_TARGETS = 8  # most recently used servers / keys whose offsets are kept


def target():
    """Which server and key the offsets belong to, as a fingerprint: the
    offsets file is not secret, so it never holds the key or a part of it."""
    url = urllib.parse.urlsplit(SERVER.strip())
    server = urllib.parse.urlunsplit((url.scheme.lower(), url.netloc.lower(), url.path.rstrip("/"), url.query, ""))
    return hashlib.sha256((server + "\n" + KEY.strip()).encode()).hexdigest()[:16]


def for_target(saved):
    """The offsets file to write back, and in it this target's offsets.

    Offsets are kept per server and key: a new one starts empty, so its first
    run sends the whole local history (the server stores each message once),
    and switching back to an earlier one resumes where it was. Offsets from
    before targets (at the top level) are dropped: one full resend."""
    targets = saved.get("targets") if isinstance(saved, dict) else None
    targets = {k: v for k, v in targets.items() if isinstance(v, dict)} if isinstance(targets, dict) else {}
    fp = target()
    offsets = targets.pop(fp, {})
    targets[fp] = offsets  # most recently used last
    return {"targets": dict(list(targets.items())[-KEPT_TARGETS:])}, offsets


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


def collect(status):
    os.makedirs(CACHE, exist_ok=True)
    held = lock(os.path.join(CACHE, "lock"))  # uploads wait for each other
    try:
        send(status)
    finally:
        unlock(held)


def send(status):
    """Posts what was added to the transcripts, then saves the offsets."""
    path = os.path.join(CACHE, "offsets.json")
    try:
        with open(path) as f:
            state, offsets = for_target(first_dict(f.read()))
    except OSError:
        state, offsets = for_target({})
    found, moved = [], {}
    for f in glob.glob(os.path.join(HOME, ".claude", "projects", "**", "*.jsonl"), recursive=True):
        size = os.path.getsize(f)
        if size == offsets.get(f):
            continue
        saved = offsets.get(f, 0)
        messages, moved[f] = read(f, saved if isinstance(saved, int) and saved <= size else 0)
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
    offsets.update(moved)
    with open(path + ".tmp", "w") as out:
        json.dump(state, out)
    os.replace(path + ".tmp", path)


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
        # The status line's JSON is a few KB: anything past 1 MB is not it.
        status = sys.stdin.buffer.read(1 << 20)
        if "--worker" in sys.argv:
            with time_limit(900):
                collect(first_dict(status.decode("utf-8", "replace")))
        else:
            launch_worker(status)
    except Exception as e:  # never break the status line; retried next refresh
        print("ai-activity claude-code collector: %s" % e, file=sys.stderr)
        sys.exit(1)
