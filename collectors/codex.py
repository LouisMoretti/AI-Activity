#!/usr/bin/env python3
"""AI Activity collector for Codex (see README.md, "Send Codex usage").

Run by Codex hooks: after every tool call (so a long turn shows up while it
runs), at the end of every turn, and on every prompt submit (the Stop hook
does not fire on rate-limit stops, so without it the final snapshot of an
exhausted quota would never be posted); or by hand, or from cron: it is
idempotent. It reads what was added to every rollout under
~/.codex/sessions and ~/.codex/archived_sessions since the last accepted
upload and posts one entry per model response with its token counts, plus
the latest rate limits and context fill of each session. Prompts, replies
and tool output never leave the device: only ids, model, time and counts.

How far each file was sent is kept in ~/.cache/ai-activity/codex.json, per
server and device key (a new one gets the whole history), and only moves
forward once the server accepted everything, so nothing is lost while the
server is down: the next run sends the backlog with its original times. Delete that file to send everything again (the server stores each
response once).

With --hook (the Windows hook command), it answers the hook at once and runs
itself again, detached, to do the upload.
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
VERSION = 3
COLLECTOR = {"name": "codex", "version": VERSION}
SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>")
# os.path.join, not "~/.codex": offsets are keyed by path, which must use
# one separator on Windows.
HOME = os.path.expanduser("~")
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
CACHE = os.path.join(HOME, ".cache", "ai-activity")
BATCH = 400
# Bump when messages carry new fields: each target's history is sent once
# more, so the server fills them in on the messages it already has.
FIELDS = 2


def when(ts):
    """Unix time of an ISO timestamp, or None if it does not parse (the line is skipped)."""
    try:
        return int(datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp())
    except (AttributeError, TypeError, ValueError):
        return None


def utc_offset(ts):
    """This machine's UTC offset at that time, in minutes (daylight saving included)."""
    return time.localtime(ts).tm_gmtoff // 60


def lines(data):
    """JSON objects in a chunk of complete lines; broken lines are skipped."""
    dec = json.JSONDecoder()
    for line in data.decode("utf-8", "replace").split("\n"):
        i = 0
        while True:
            while i < len(line) and line[i] in " \t\r":
                i += 1
            if i >= len(line):
                break
            try:
                obj, i = dec.raw_decode(line, i)
            except ValueError:
                break
            if isinstance(obj, dict):
                yield obj


def usage_of(u):
    keys = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens")
    return {k: u.get(k) or 0 for k in keys if isinstance(u.get(k) or 0, (int, float))}


def limits_of(p):
    """The quota snapshot of a token_count or standalone rate_limits payload,
    or None. Same object shape either way; the caller dates it with the
    line's own time, never re-dated."""
    rl = p.get("rate_limits")
    if not isinstance(rl, dict):
        return None
    w = {k: {f: rl[k].get(f) for f in ("used_percent", "window_minutes", "resets_at")}
         for k in ("primary", "secondary") if isinstance(rl.get(k), dict)}
    return w or None


def read(path, state):
    """New messages, rate limits and context of one rollout since its saved offset."""
    size = os.path.getsize(path)
    # [offset, session id, model, has token_usage_record lines, service tier,
    # model provider]: what applies to the lines after the offset.
    saved = state.get(path)
    offset, session, model, records, tier, provider = (
        (list(saved) + [None, None])[:6] if isinstance(saved, list) and len(saved) >= 4
        else [0, None, None, False, None, None])
    if offset > size:  # rewritten: start over
        offset, session, model, records, tier, provider = 0, None, None, False, None, None
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read(size - offset)
    end = data.rfind(b"\n") + 1  # never read a line still being written
    messages, limits, context, last_total = [], None, None, None
    for o in lines(data[:end]):
        t, p, ts = o.get("type"), o.get("payload"), when(o.get("timestamp"))
        if not isinstance(p, dict):
            continue
        if t == "session_meta":
            session = session or p.get("session_id") or p.get("id")
        elif t == "turn_context" and p.get("model"):
            model = p["model"]
        elif p.get("type") == "thread_settings_applied" and isinstance(p.get("thread_settings"), dict):
            # The tier (Fast mode) and the provider price the next responses.
            settings = p["thread_settings"]
            model = settings.get("model") or model
            tier = settings.get("service_tier") if isinstance(settings.get("service_tier"), str) else tier
            provider = settings.get("model_provider_id") if isinstance(settings.get("model_provider_id"), str) else provider
        elif t == "token_usage_record" and isinstance(p.get("usage"), dict) and ts:
            records = True
            messages.append({
                "response_id": p.get("response_id"),
                "session_id": p.get("session_id") or p.get("thread_id") or session,
                "turn_id": p.get("turn_id"),
                "model": model,
                "service_tier": tier,
                "model_provider": provider,
                "occurred_at": ts,
                "utc_offset_min": utc_offset(ts),
                "usage": usage_of(p["usage"]),
            })
        elif p.get("type") == "token_count" and ts:
            info = p.get("info") if isinstance(p.get("info"), dict) else {}
            last = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else None
            total = (info.get("total_token_usage") or {}).get("total_tokens")
            if last and session:
                context = {"session_id": session, "used_tokens": last.get("total_tokens"),
                           "window_size": info.get("model_context_window")}
            rl = limits_of(p)
            if rl:
                limits = (rl, ts)
            # Rollouts older than token_usage_record: one token_count per response,
            # sometimes repeated. Keyed by the thread's running total, so a replay
            # or a repeat is the same id.
            if not records and last and session and isinstance(total, int) and total != last_total:
                messages.append({
                    "event_id": "tc_%s_%d" % (session, total),
                    "session_id": session,
                    "model": model,
                    "service_tier": tier,
                    "model_provider": provider,
                    "occurred_at": ts,
                    "utc_offset_min": utc_offset(ts),
                    "usage": usage_of(last),
                })
            last_total = total
        elif p.get("type") == "rate_limits" and ts:
            # A limit snapshot without token counts (e.g. recorded when a turn
            # failed on a quota): same object as on token_count lines, dated by
            # this line. Without it the final 100% would never be posted: the
            # Stop hook does not fire on rate-limit stops.
            rl = limits_of(p)
            if rl:
                limits = (rl, ts)
    return messages, limits, context, [offset + end, session, model, records, tier, provider]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never redirect a device bearer key to a different destination.
    def redirect_request(self, *args, **kwargs):
        return None


def post(body):
    req = urllib.request.Request(
        SERVER.rstrip("/") + "/api/ingest/codex", data=json.dumps(dict(body, collector=COLLECTOR)).encode(),
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
    it on stderr and in ~/.cache/ai-activity/update-available-codex, which
    goes away once this copy is up to date."""
    path = os.path.join(CACHE, "update-available-codex")
    update = answer.get("update")
    if isinstance(update, dict):
        latest = update.get("latest")
        text = ("ai-activity codex collector v%d is outdated (latest v%s): run the install command "
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
    before targets (at the top level) are dropped: one full resend."""
    targets = saved.get("targets") if isinstance(saved, dict) else None
    targets = {k: v for k, v in targets.items() if isinstance(v, dict)} if isinstance(targets, dict) else {}
    fp = target()
    offsets = targets.pop(fp, {})
    # Saved before messages carried the current FIELDS: one full resend.
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


def main():
    os.makedirs(CACHE, exist_ok=True)
    # One active run and at most one waiting behind it: the tool-call hook
    # fires often, and any other run can stop here, since the waiter reads
    # the rollouts only once it holds the lock, so it sends what they would.
    waiter = lock(os.path.join(CACHE, "codex-waiter.lock"), wait=False)
    if waiter is None:
        return
    try:
        collection = lock(os.path.join(CACHE, "codex.lock"))
        try:
            unlock(waiter)  # a hook firing from now on queues the next run
            waiter = None
            path = os.path.join(CACHE, "codex.json")
            try:
                with open(path) as f:
                    stored = json.load(f)
            except (OSError, ValueError):
                stored = {}
            stored, state = for_target(stored)  # state: this target's offsets, inside stored
            files = glob.glob(os.path.join(CODEX_HOME, "sessions", "**", "*.jsonl"), recursive=True)
            files += glob.glob(os.path.join(CODEX_HOME, "archived_sessions", "**", "*.jsonl"), recursive=True)
            # Progress is kept per accepted file and saved as the run goes and when it
            # ends, even cut short (time limit, server error): a long backlog still
            # gets through over several runs instead of starting over each time.
            changed, saved_at = False, time.monotonic()
            try:
                for f in sorted(files):
                    saved = state.get(f)
                    if saved and saved[0] == os.path.getsize(f):
                        continue
                    messages, limits, context, new = read(f, state)
                    base = {"context": context}
                    if limits:
                        base["rate_limits"], base["occurred_at"] = limits
                    if messages or limits or context:
                        for i in range(0, max(len(messages), 1), BATCH):
                            post(dict(base, messages=messages[i:i + BATCH]))
                    state[f], changed = new, True
                    if time.monotonic() - saved_at > 10:
                        save(path, stored)
                        changed, saved_at = False, time.monotonic()
            finally:
                if changed:
                    save(path, stored)
        finally:
            unlock(collection)
    finally:
        if waiter:
            unlock(waiter)


def launch_worker():
    """Run this script again without --hook, detached, so the hook returns at once."""
    options = {"start_new_session": True}
    if os.name == "nt":
        options = {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                   | subprocess.CREATE_BREAKAWAY_FROM_JOB}
    args = [sys.executable, os.path.abspath(__file__)]
    streams = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        subprocess.Popen(args, **streams, **options)
    except OSError as error:
        # Some Windows jobs forbid breakaway: keep the console/group detachment.
        if os.name != "nt" or getattr(error, "winerror", None) != 5:
            raise
        options["creationflags"] &= ~subprocess.CREATE_BREAKAWAY_FROM_JOB
        subprocess.Popen(args, **streams, **options)


if __name__ == "__main__":
    if "--hook" in sys.argv:
        try:
            sys.stdin.buffer.read(1 << 20)  # the hook payload (bounded): never sent
            launch_worker()
        except Exception as e:  # never break the Codex turn; retried next time
            print("ai-activity codex collector: %s" % e, file=sys.stderr)
        print("{}")  # the (empty) JSON answer Codex expects from a hook
        sys.exit(0)
    try:
        with time_limit(900):
            main()
    except Exception as e:  # never break the Codex turn; retried next time
        print("ai-activity codex collector: %s" % e, file=sys.stderr)
        sys.exit(1)
