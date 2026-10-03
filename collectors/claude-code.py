#!/usr/bin/env python3
"""AI Activity collector for Claude Code (see README.md, "Send Claude Code usage").

Two entry points, both answering at once (they print nothing) and running
this script again detached, so Claude Code cancelling them does not stop
the upload (Linux, macOS, Windows):

- --hook, from Claude Code's hooks (UserPromptSubmit, PostToolUse, Stop,
  StopFailure, SessionEnd): tokens. The worker reads what was added to every transcript
  under ~/.claude/projects since the last accepted upload and posts one
  entry per Anthropic message id with its token counts. Prompts and
  replies never leave the device: only ids, model, time and counts.
- no argument, as the statusLine command: the 5-hour and 7-day quotas and
  the context fill from the status line's JSON, which only the status
  line receives. It never reads the transcripts.

--worker alone collects the tokens in the foreground (errors on stderr).

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
VERSION = 4
COLLECTOR = {"name": "claude-code", "version": VERSION}
SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>")
HOME = os.path.expanduser("~")
CACHE = os.path.join(HOME, ".cache", "ai-activity")
BATCH = 400
USAGE = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
# What each message's price depends on besides its model and counts: the
# cache writes' durations, fast mode and the inference region.
CACHE_SPLIT = ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")
PRICING = ("speed", "service_tier", "inference_geo")
# Bump when messages carry new fields: each target's history is sent once
# more, so the server fills them in on the messages it already has.
FIELDS = 2


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
            usage = {k: u.get(k) or 0 for k in USAGE}
            split = u.get("cache_creation")
            if isinstance(split, dict):
                # Only the durations recorded: a missing one is unknown, not 0.
                usage["cache_creation"] = {k: split[k] for k in CACHE_SPLIT
                                           if type(split.get(k)) is int}
            # A message seen again with more output tokens is its final entry;
            # at a tie, the session's own file wins over a subagent's.
            rank = (u.get("output_tokens") or 0, main_file == o.get("sessionId"))
            found.append((m["id"], rank, {
                "message_id": m["id"],
                "session_id": o.get("sessionId"),
                "model": m.get("model"),
                "occurred_at": t,
                "utc_offset_min": utc_offset(t),
                "usage": usage,
                **{k: u[k] for k in PRICING if isinstance(u.get(k), str)},
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
    scheme = url.scheme.lower()
    try:
        port = url.port
    except ValueError:
        port = None
    host = url.hostname or ""
    host = "[%s]" % host if ":" in host else host
    # The default port is the same server: https://h and https://h:443 are one target.
    if port is not None and (scheme, port) not in (("http", 80), ("https", 443)):
        host += ":%d" % port
    server = urllib.parse.urlunsplit((scheme, host, url.path.rstrip("/"), url.query, ""))
    return hashlib.sha256((server + "\n" + KEY.strip()).encode()).hexdigest()[:16]


def for_target(saved):
    """The offsets file to write back, and in it this target's offsets.

    Offsets are kept per server and key: a new one starts empty, so its first
    run sends the whole local history (the server stores each message once),
    and switching back to an earlier one resumes where it was. Offsets from
    before targets (at the top level) are dropped: one full resend, like
    offsets saved before messages carried the current FIELDS."""
    targets = saved.get("targets") if isinstance(saved, dict) else None
    targets = {k: v for k, v in targets.items() if isinstance(v, dict)} if isinstance(targets, dict) else {}
    fp = target()
    offsets = targets.pop(fp, {})
    if offsets.get("fields") != FIELDS:
        offsets = {"fields": FIELDS}
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


def collect():
    os.makedirs(CACHE, exist_ok=True)
    # One active run and at most one waiting behind it: the tool-call hook
    # fires often, and any other run can stop here, since the waiter reads
    # the transcripts only once it holds the lock, so it sends what they would.
    waiter = lock(os.path.join(CACHE, "waiter.lock"), wait=False)
    if waiter is None:
        return
    try:
        held = lock(os.path.join(CACHE, "lock"))
        try:
            unlock(waiter)  # a hook firing from now on queues the next run
            waiter = None
            send()
        finally:
            unlock(held)
    finally:
        if waiter:
            unlock(waiter)


def send():
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
    for i in range(0, len(messages), BATCH):
        post({"messages": messages[i:i + BATCH], "occurred_at": int(time.time())})
    # A status can arrive before this session's first usage row exists.
    # Reapply its measured context after insertion, including when the status
    # is unchanged and its ordinary upload is still in the five-minute cache.
    sessions = {m["session_id"] for m in messages}
    if sessions:
        # Serialize with status POSTs so reapplying an older context cannot
        # overwrite a newer refresh that finished while tokens were uploading.
        held = lock(status_upload_lock())
        try:
            with status_state() as last:
                contexts = dict(last.get("contexts", {}))
            for session in sessions:
                if session in contexts:
                    post(contexts[session])
        finally:
            unlock(held)
    offsets.update(moved)
    with open(path + ".tmp", "w") as out:
        json.dump(state, out)
    os.replace(path + ".tmp", path)
    drain_status()


STATUS_EVERY = 300  # an unchanged status is posted again after that long, not before


def status_upload_lock():
    return os.path.join(CACHE, "status-" + target() + ".lock")


@contextlib.contextmanager
def status_state():
    """Short, disk-only critical section: never hold it during a POST."""
    os.makedirs(CACHE, exist_ok=True)
    held = lock(os.path.join(CACHE, "status-state.lock"))
    try:
        path = os.path.join(CACHE, "status.json")
        try:
            with open(path) as f:
                saved = first_dict(f.read())
        except OSError:
            saved = {}
        targets = saved.get("targets") if isinstance(saved.get("targets"), dict) else {}
        targets = {k: v for k, v in targets.items() if isinstance(v, dict)}
        fp = target()
        last = targets.pop(fp, {})
        targets[fp] = last
        yield last
        with open(path + ".tmp", "w") as out:
            json.dump({"targets": dict(list(targets.items())[-KEPT_TARGETS:])}, out)
        os.replace(path + ".tmp", path)
    finally:
        unlock(held)


def drain_status():
    """One uploader per target; busy refreshes persist the latest per session.

    Releasing the uploader lock under the state lock closes the race between
    checking an empty queue and a refresh deciding someone else will drain it.
    Failed POSTs leave their observation queued for the next refresh or hook.
    """
    with status_state():
        held = lock(status_upload_lock(), wait=False)
    if held is None:
        return
    try:
        while True:
            with status_state() as last:
                pending = last.get("pending", {})
                if not pending:
                    unlock(held)
                    held = None
                    return
                session, observation = next(iter(pending.items()))
            post(observation["body"])
            with status_state() as last:
                last["seen"] = observation["seen"]
                last["at"] = observation["body"]["occurred_at"]
                pending = last.get("pending", {})
                if pending.get(session) == observation:
                    del pending[session]
    finally:
        if held is not None:
            unlock(held)


def report(status):
    """Posts the status line's quotas and context fill (no usage: the hooks send it).

    The status line refreshes several times a second while Claude Code
    works, and shares the device's request budget with the hooks' uploads:
    the same values for the same server and key are not posted again
    within STATUS_EVERY seconds."""
    context = status.get("context_window") or {}
    body = {
        "rate_limits": status.get("rate_limits") or {},
        "context": {"session_id": status.get("session_id"), "used_pct": context.get("used_percentage"),
                    "window_size": context.get("context_window_size")},
    }
    if not body["rate_limits"] and body["context"]["used_pct"] is None:
        return
    seen = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    with status_state() as last:
        now = int(time.time())
        session = body["context"]["session_id"] or ""
        if session and body["context"]["used_pct"] is not None:
            contexts = last.setdefault("contexts", {})
            contexts.pop(session, None)
            contexts[session] = {"context": body["context"], "occurred_at": now}
            last["contexts"] = dict(list(contexts.items())[-100:])
        recent = (last.get("seen") == seen and isinstance(last.get("at"), int)
                  and 0 <= now - last["at"] < STATUS_EVERY)
        pending = last.setdefault("pending", {})
        # A queued change takes precedence even when this value matches the
        # previous successful POST (e.g. the context returns to its old value).
        if not recent or session in pending:
            pending[session] = {"seen": seen, "body": dict(body, occurred_at=now)}
    drain_status()


def launch_worker(status, *flags):
    """Run this script again with --worker (and flags), detached, handing it status on stdin."""
    options = {"start_new_session": True}
    if os.name == "nt":
        options = {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                   | subprocess.CREATE_BREAKAWAY_FROM_JOB}
    args = [sys.executable, os.path.abspath(__file__), "--worker", *flags]
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
        if "--worker" not in sys.argv:
            # The status line's JSON is a few KB: anything past 1 MB is not it.
            status = sys.stdin.buffer.read(1 << 20)
            if "--hook" in sys.argv:
                launch_worker(b"")  # the hook's JSON is never sent: the worker reads every transcript
            else:
                launch_worker(status, "--status")
        elif "--status" in sys.argv:
            with time_limit(900):
                report(first_dict(sys.stdin.buffer.read(1 << 20).decode("utf-8", "replace")))
        else:
            with time_limit(900):
                collect()
    except Exception as e:  # never break the status line or a hook; retried next time
        print("ai-activity claude-code collector: %s" % e, file=sys.stderr)
        sys.exit(1)
