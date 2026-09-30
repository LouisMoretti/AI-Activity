#!/usr/bin/env python3
"""Cursor Agent metrics from afterAgentResponse (README.md).

--hook reads stdin, retains only ids/model/time/counts in a private metrics
journal, answers {}, and starts a detached uploader. Without --hook, retry
that journal. No transcript, prompt, reply, path or provider key is stored.
Hook input includes cache; the server subtracts it into disjoint counters.
A stable conversation + generation pair counts once, including stop replays.
"""
import _thread
import contextlib
import datetime
import errno
import hashlib
import json
import math
import os
import re
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

# Bump with shared/collectors.ts on every change to this file.
VERSION = 2
COLLECTOR = {"name": "cursor", "version": VERSION}
SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>")
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "ai-activity")
JOURNAL = os.path.join(CACHE, "cursor-events")
BATCH = 200
KEPT_TARGETS = 8
BUSY = (errno.EACCES, errno.EAGAIN, errno.EDEADLK)
ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never redirect a device bearer key to a different destination.
    def redirect_request(self, *args, **kwargs):
        return None

def post(body):
    req = urllib.request.Request(
        SERVER.strip().rstrip("/") + "/api/ingest/cursor", data=json.dumps(dict(body, collector=COLLECTOR)).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    try:
        raw = urllib.request.build_opener(NoRedirect).open(req, timeout=60).read()
    except urllib.error.HTTPError as error:
        if error.code == 426:  # too old for this server: nothing is accepted until updated
            report_update(answer_of(error.read(1 << 16)))
        raise
    answer = answer_of(raw)
    report_update(answer)
    if answer.get("ok") is not True:
        raise ValueError("server did not acknowledge the metrics batch")

def answer_of(raw):
    try:
        answer = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return {}
    return answer if isinstance(answer, dict) else {}

def report_update(answer):
    """The server's answer says when a newer collector exists ("update"): tell
    it on stderr and in ~/.cache/ai-activity/update-available-cursor, which
    goes away once this copy is up to date."""
    path = os.path.join(CACHE, "update-available-cursor")
    update = answer.get("update")
    if isinstance(update, dict):
        latest = update.get("latest")
        text = ("ai-activity cursor collector v%d is outdated (latest v%s): run the install command "
                "again (Settings > Devices)\n" % (VERSION, latest if type(latest) is int else "?"))
        sys.stderr.write(text)
        with open(path, "w") as out:
            out.write(text)
    else:
        with contextlib.suppress(FileNotFoundError):
            os.remove(path)

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


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save(path, data):
    # The journal and progress never carry credentials; keep metrics private too.
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(path + ".tmp", path)


def metric_event(payload):
    """Allowlist a turn's measured counters. Missing counters are unavailable."""
    if not isinstance(payload, dict):
        return None
    if payload.get("hook_event_name", "afterAgentResponse") not in ("afterAgentResponse", "stop"):
        return None
    # Like the server's `??`: only a missing (None) conversation_id falls back
    # to session_id. An empty one is invalid, like on the server.
    session = payload.get("conversation_id")
    if session is None:
        session = payload.get("session_id")
    generation = payload.get("generation_id")
    if not all(isinstance(v, str) and ID.fullmatch(v) for v in (session, generation)):
        return None
    usage = {}
    for snake, camel in (("input_tokens", "inputTokens"), ("output_tokens", "outputTokens"),
                         ("cache_read_tokens", "cacheReadTokens"), ("cache_write_tokens", "cacheWriteTokens")):
        value = payload.get(snake)
        if value is None:
            value = payload.get(camel)
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            return None
        usage[snake] = int(value)
    if not any(usage.values()):
        return None
    stamp = payload.get("timestamp")
    if stamp is None:
        ts = int(time.time())  # live hook receipt, persisted before any upload
    elif type(stamp) in (int, float) and math.isfinite(stamp):
        # Epoch seconds (or milliseconds) when the hook sends a number.
        ts = int(stamp // 1000) if stamp > 1e12 else int(stamp)
        if ts < 0:
            return None
    else:
        try:
            text = str(stamp)
            ts = int(datetime.datetime.fromisoformat(
                text[:-1] + "+00:00" if text.endswith("Z") else text).timestamp())
        except (AttributeError, TypeError, ValueError, OverflowError):
            return None
    model = payload.get("model_id") or payload.get("model")
    model = model if isinstance(model, str) and model else None
    try:
        offset = int((datetime.datetime.fromtimestamp(ts).astimezone().utcoffset()
                      or datetime.timedelta(0)).total_seconds() // 60)
    except (OSError, OverflowError, ValueError):
        return None
    return {"conversation_id": session, "generation_id": generation, "model": model,
            "occurred_at": ts, "utc_offset_min": offset, "usage": usage}


def record(payload):
    event = metric_event(payload)
    if event is None:
        return
    os.makedirs(JOURNAL, mode=0o700, exist_ok=True)
    identity = event["conversation_id"] + "\n" + event["generation_id"]
    name = hashlib.sha256(identity.encode()).hexdigest()
    held = lock(os.path.join(CACHE, "cursor-state.lock"))
    try:
        path = os.path.join(JOURNAL, name + ".json")
        try:
            old = load(path)
        except (ValueError, OSError):
            old = None  # corrupt entry: overwrite it below
        if (isinstance(old, dict) and isinstance(old.get("usage"), dict)
                and isinstance(old["usage"].get("output_tokens"), (int, float))):
            # A replay never re-dates a turn or lowers its final counts.
            if event["usage"]["output_tokens"] <= old["usage"]["output_tokens"]:
                return
            event["occurred_at"] = old.get("occurred_at", event["occurred_at"])
            event["utc_offset_min"] = old.get("utc_offset_min", event["utc_offset_min"])
        save(path, event)
    finally:
        unlock(held)


def digest(event):
    return hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()


def main():
    os.makedirs(CACHE, mode=0o700, exist_ok=True)
    waiter = lock(os.path.join(CACHE, "cursor-waiter.lock"), wait=False)
    if waiter is None:
        return
    try:
        held = lock(os.path.join(CACHE, "cursor.lock"))
        try:
            unlock(waiter)
            waiter = None
            path = os.path.join(CACHE, "cursor.json")
            try:
                stored = load(path)
            except (ValueError, OSError) as error:
                # Corrupt progress: start fresh (dedup makes the resend safe).
                print("ai-activity cursor collector: ignoring corrupt %s (%s)" % (path, type(error).__name__), file=sys.stderr)
                stored = {}
            saved, state = for_target(stored)
            if state.get("retry_at", 0) > time.time():
                return
            accepted = state.setdefault("accepted", {})
            chunk = []

            def upload():
                try:
                    post({"messages": [event for _, event in chunk]})
                except urllib.error.HTTPError as error:
                    if error.code == 429:
                        try:
                            delay = max(1, min(86400, int(error.headers.get("Retry-After", "60"))))
                        except ValueError:
                            delay = 60
                        state["retry_at"] = int(time.time()) + delay
                        save(path, saved)
                    raise
                for name, event in chunk:
                    accepted[name] = digest(event)
                state.pop("retry_at", None)
                save(path, saved)
                chunk.clear()

            if not os.path.isdir(JOURNAL):
                return
            seen = set()
            for name in sorted(os.listdir(JOURNAL)):
                if not re.fullmatch(r"[0-9a-f]{64}\.json", name):
                    continue
                try:
                    event = load(os.path.join(JOURNAL, name))
                except (ValueError, OSError) as error:
                    # One poisoned file must not block the queue.
                    print("ai-activity cursor collector: skipping unreadable %s (%s)" % (name, type(error).__name__), file=sys.stderr)
                    continue
                if not isinstance(event, dict):
                    continue
                seen.add(name)
                if accepted.get(name) == digest(event):
                    continue
                chunk.append((name, event))
                if len(chunk) >= BATCH:
                    upload()
            # Forget hashes of files gone from the journal: they only grow it.
            pruned = [name for name in accepted if name not in seen]
            for name in pruned:
                del accepted[name]
            if chunk:
                upload()
            elif pruned:
                save(path, saved)
        finally:
            unlock(held)
    finally:
        if waiter:
            unlock(waiter)


def launch_worker():
    options = {"start_new_session": True}
    if os.name == "nt":
        options = {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                   | subprocess.CREATE_BREAKAWAY_FROM_JOB}
    streams = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    args = [sys.executable, os.path.abspath(__file__)]
    try:
        subprocess.Popen(args, **streams, **options)
    except OSError as error:
        if os.name != "nt" or getattr(error, "winerror", None) != 5:
            raise
        options["creationflags"] &= ~subprocess.CREATE_BREAKAWAY_FROM_JOB
        subprocess.Popen(args, **streams, **options)


if __name__ == "__main__":
    if "--hook" in sys.argv:
        try:
            with time_limit(5):
                record(json.loads(sys.stdin.buffer.read(1 << 20)))
            launch_worker()
        except Exception as error:
            # Do not print the payload: a parser error could disclose reply text.
            print("ai-activity cursor collector: could not queue metrics (%s)" % type(error).__name__, file=sys.stderr)
        print("{}")
        sys.exit(0)
    try:
        with time_limit(900):
            main()
    except Exception as error:
        print("ai-activity cursor collector: %s" % error, file=sys.stderr)
        sys.exit(1)
