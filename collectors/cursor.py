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
import email.utils
import errno
import hashlib
import json
import math
import os
import re
import signal
import sqlite3
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
VERSION = 3
COLLECTOR = {"name": "cursor", "version": VERSION}
SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>").strip().rstrip("/")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>").strip()
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "ai-activity")
JOURNAL = os.path.join(CACHE, "cursor-events")
DATABASE = os.path.join(CACHE, "cursor.db")
BATCH = 200
BODY_LIMIT = 240 * 1024  # below the server's 256 KiB limit, including metadata
MAX_INTEGER = (1 << 53) - 1  # the JSON server's exact integer range
KEPT_TARGETS = 8
BUSY = (errno.EACCES, errno.EAGAIN, errno.EDEADLK)
ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never redirect a device bearer key to a different destination.
    def redirect_request(self, *args, **kwargs):
        return None

def post(body):
    req = urllib.request.Request(
        SERVER.strip().rstrip("/") + "/api/ingest/cursor", data=wire(body),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=60) as response:
            raw = response.read(1 << 16)
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
    except (ValueError, RecursionError):
        return {}
    return answer if isinstance(answer, dict) else {}

def wire(body):
    return json.dumps(dict(body, collector=COLLECTOR), ensure_ascii=False, separators=(",", ":")).encode()

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


def metric_event(payload, live=True):
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
        if (type(value) not in (int, float) or value < 0 or value > MAX_INTEGER
                or not math.isfinite(value) or value != int(value)):
            return None
        usage[snake] = int(value)
    # Reject a changed/invalid counter convention instead of inventing totals.
    if (usage["cache_read_tokens"] + usage["cache_write_tokens"] > usage["input_tokens"]
            or usage["input_tokens"] + usage["output_tokens"] > MAX_INTEGER):
        return None
    if not any(usage.values()):
        return None
    stamp = payload.get("timestamp")
    if stamp is None:
        ts = int(time.time())  # live hook receipt, persisted before any upload
    elif type(stamp) in (int, float) and 0 <= stamp <= MAX_INTEGER and math.isfinite(stamp):
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
    if ts < 0:
        return None
    # Clock skew is capped once, when observed, never on a later retry.
    if live:
        ts = min(ts, int(time.time()))
    model = payload.get("model_id")
    if model is None:
        model = payload.get("model")
    model = model[:120] if isinstance(model, str) and model else None
    if model:
        try:
            model.encode("utf-8")
        except UnicodeEncodeError:
            model = None  # malformed model text must not lose measured tokens
    try:
        offset = int((datetime.datetime.fromtimestamp(ts).astimezone().utcoffset()
                      or datetime.timedelta(0)).total_seconds() // 60)
    except (OSError, OverflowError, ValueError):
        return None
    return {"conversation_id": session, "generation_id": generation, "model": model,
            "occurred_at": ts, "utc_offset_min": offset, "usage": usage}


def identity(event):
    return hashlib.sha256((event["conversation_id"] + "\n" + event["generation_id"]).encode()).hexdigest()


def retained_event(raw):
    """Revalidate local data too: corrupted files never become upload payloads."""
    if not isinstance(raw, dict) or not isinstance(raw.get("usage"), dict):
        return None
    if type(raw.get("occurred_at")) is not int:
        return None
    event = metric_event({**raw["usage"], "conversation_id": raw.get("conversation_id"),
                          "generation_id": raw.get("generation_id"), "model": raw.get("model"),
                          "timestamp": raw["occurred_at"]}, live=False)
    if event is not None:
        offset = raw.get("utc_offset_min")
        # Preserve the original local day even after travel or a timezone change.
        if offset is None:
            event["utc_offset_min"] = 0
        elif type(offset) is int and -720 <= offset <= 840 and offset % 15 == 0:
            event["utc_offset_min"] = offset
        else:
            return None
    return event


@contextlib.contextmanager
def journal():
    os.makedirs(CACHE, mode=0o700, exist_ok=True)
    fd = os.open(DATABASE, os.O_RDWR | os.O_CREAT, 0o600)
    os.close(fd)
    db = sqlite3.connect(DATABASE, timeout=2)
    try:
        # WAL lets a hook retain its metrics while an uploader reads. Network
        # requests never hold a transaction. FULL keeps committed hooks durable.
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("PRAGMA synchronous = FULL")
        # Serialize first-run schema creation across simultaneous hooks.
        db.execute("BEGIN IMMEDIATE")
        with db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise ValueError("local metrics database is newer than this collector")
            if version == 0:
                schema = """
                CREATE TABLE events (
                    identity TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL UNIQUE,
                    payload TEXT NOT NULL
                );
                CREATE TABLE targets (
                    fingerprint TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL DEFAULT 0,
                    retry_at REAL NOT NULL DEFAULT 0,
                    used_at REAL NOT NULL
                );
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
                INSERT INTO metadata VALUES ('revision', 0), ('legacy_migrated', 0);
                PRAGMA user_version = 1;
                """
                for statement in schema.split(";"):
                    if statement.strip():
                        db.execute(statement)
        yield db
    finally:
        db.close()


def store_event(db, event):
    """Caller owns a short write transaction; one compact row per generation.
    Revisions are globally increasing, so targets need one cursor, not one
    accepted hash for every turn. The revision index selects only new work."""
    name = identity(event)
    old = db.execute("SELECT payload FROM events WHERE identity = ?", (name,)).fetchone()
    if old:
        try:
            previous = retained_event(json.loads(old[0]))
        except (ValueError, TypeError, RecursionError):
            previous = None
        if previous:
            if event["usage"]["output_tokens"] <= previous["usage"]["output_tokens"]:
                return
            event["occurred_at"] = previous["occurred_at"]
            event["utc_offset_min"] = previous["utc_offset_min"]
    db.execute("UPDATE metadata SET value = value + 1 WHERE key = 'revision'")
    revision = db.execute("SELECT value FROM metadata WHERE key = 'revision'").fetchone()[0]
    db.execute("INSERT INTO events VALUES (?, ?, ?) ON CONFLICT(identity) DO UPDATE SET "
               "revision = excluded.revision, payload = excluded.payload",
               (name, revision, json.dumps(event, ensure_ascii=False)))


def read_legacy(path):
    try:
        with open(path, encoding="utf-8") as f:
            return retained_event(json.loads(f.read(16384)))
    except (ValueError, OSError, TypeError, RecursionError):
        return None


def record(payload):
    event = metric_event(payload)
    if event is None:
        return
    with journal() as db:
        # BEGIN IMMEDIATE prevents competing hooks reading then overwriting a
        # newer final count. Even a replay performs only one indexed lookup.
        db.execute("BEGIN IMMEDIATE")
        with db:
            # Preserve receipt time when an existing v1/v2 turn is replayed
            # before the detached worker has migrated the JSON directory.
            old = read_legacy(os.path.join(JOURNAL, identity(event) + ".json"))
            if old and identity(old) == identity(event):
                store_event(db, old)
            store_event(db, event)


def migrate_legacy(db):
    if db.execute("SELECT value FROM metadata WHERE key = 'legacy_migrated'").fetchone()[0]:
        return
    if os.path.isdir(JOURNAL):
        # Only the detached worker scans old files, once. A crash after the
        # commit but before unlink is safe: the next import deduplicates it.
        try:
            with os.scandir(JOURNAL) as files:
                for entry in files:
                    if not re.fullmatch(r"[0-9a-f]{64}\.json", entry.name):
                        continue
                    try:
                        event = read_legacy(entry.path)
                        if event is not None and identity(event) + ".json" == entry.name:
                            db.execute("BEGIN IMMEDIATE")
                            with db:
                                store_event(db, event)
                            os.remove(entry.path)
                        else:
                            print("ai-activity cursor collector: skipping corrupt legacy metrics " + entry.name, file=sys.stderr)
                            # Keep the unreadable source for manual recovery,
                            # outside the queue. Never upload unvalidated fields.
                            invalid = os.path.join(CACHE, "cursor-invalid")
                            os.makedirs(invalid, mode=0o700, exist_ok=True)
                            os.replace(entry.path, os.path.join(invalid, entry.name))
                    except OSError as error:
                        print("ai-activity cursor collector: skipping unreadable legacy metrics (%s)" % type(error).__name__, file=sys.stderr)
        except OSError as error:
            print("ai-activity cursor collector: could not read legacy directory (%s); --replay retries it" % type(error).__name__, file=sys.stderr)
    with db:
        db.execute("UPDATE metadata SET value = 1 WHERE key = 'legacy_migrated'")
    # v1/v2 accepted hashes are intentionally discarded: server dedup makes
    # the one-time replay safe, including damaged JSON progress files.
    with contextlib.suppress(FileNotFoundError):
        os.remove(os.path.join(CACHE, "cursor.json"))


def select_target(db):
    fp = target()
    with db:
        # A logical LRU order survives wall-clock corrections. Otherwise the
        # just-selected target could be evicted after the clock moves back.
        used = db.execute("SELECT COALESCE(MAX(used_at), 0) + 1 FROM targets").fetchone()[0]
        db.execute("INSERT INTO targets (fingerprint, used_at) VALUES (?, ?) "
                   "ON CONFLICT(fingerprint) DO UPDATE SET used_at = excluded.used_at", (fp, used))
        db.execute("DELETE FROM targets WHERE fingerprint IN "
                   "(SELECT fingerprint FROM targets ORDER BY used_at DESC LIMIT -1 OFFSET ?)", (KEPT_TARGETS,))
    return fp, db.execute("SELECT revision, retry_at FROM targets WHERE fingerprint = ?", (fp,)).fetchone()


def retry_delay(error):
    value = error.headers.get("Retry-After", "60") if isinstance(error, urllib.error.HTTPError) else "60"
    try:
        delay = float(value)
        if not math.isfinite(delay):
            raise ValueError()
    except (TypeError, ValueError):
        try:
            delay = email.utils.parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError, OverflowError):
            delay = 60
    return max(1, min(86400, delay))


def drain(db):
    fp, (revision, retry_at) = select_target(db)
    if retry_at > time.time():
        return
    while True:
        # The UNIQUE revision index means an idle run never scans old turns.
        rows = db.execute("SELECT identity, revision, payload FROM events WHERE revision > ? "
                          "ORDER BY revision LIMIT ?", (revision, BATCH)).fetchall()
        if not rows:
            return
        chunk = []
        end = revision
        size = len(wire({"messages": []}))
        for name, number, payload in rows:
            try:
                event = retained_event(json.loads(payload))
            except (ValueError, TypeError, RecursionError):
                event = None
            if event is None or identity(event) != name:
                print("ai-activity cursor collector: skipping corrupt metrics " + name, file=sys.stderr)
                end = number
                continue
            added = len(json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode()) + 1
            if chunk and size + added > BODY_LIMIT:
                break
            size += added
            chunk.append(event)
            end = number
        if chunk:
            try:
                post({"messages": chunk})
            except (urllib.error.URLError, OSError, ValueError) as error:
                # Do not advance on redirects, malformed acknowledgements,
                # refusal or outages. Avoid hammering the server every hook.
                with db:
                    db.execute("UPDATE targets SET retry_at = ? WHERE fingerprint = ?",
                               (time.time() + retry_delay(error), fp))
                raise
        with db:
            db.execute("UPDATE targets SET revision = ?, retry_at = 0 WHERE fingerprint = ?", (end, fp))
        revision = end


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
            with journal() as db:
                if "--replay" in sys.argv:
                    with db:
                        db.execute("DELETE FROM targets WHERE fingerprint = ?", (target(),))
                        db.execute("UPDATE metadata SET value = 0 WHERE key = 'legacy_migrated'")
                migrate_legacy(db)
                drain(db)
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
