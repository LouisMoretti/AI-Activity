#!/usr/bin/env python3
"""Read Antigravity generation metadata, never conversation content.

The SQLite/protobuf layout is undocumented. Field evidence:
https://github.com/junhoyeo/tokscale/blob/62ca1eb1677556972ba963fdfa3a41ab23c1eb4b/crates/tokscale-core/src/sessions/antigravity_cli.rs
Only standard protobuf timestamps are accepted; opaque timestamp layouts
are skipped with a diagnostic, never dated using file mtime or import time.
"""
import contextlib
import datetime
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime

# Bump on every change to this file, with COLLECTOR_VERSIONS in
# shared/collectors.ts: the server flags older copies as outdated.
VERSION = 2
COLLECTOR = {"name": "antigravity", "version": VERSION}
SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>")
ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
MAX_BLOB = 1024 * 1024
MIN_AGY = (1, 1, 11)  # first agy with a print-mode /usage command
# Mirror shared/quota-pools.ts: bucket id prefix -> account_ref (QUOTA_POOLS),
# suffix -> limit type and window length in seconds (QUOTA_WINDOW_SEC).
POOLS = {"gemini": "gemini", "3p": "claude-gpt"}
WINDOWS = {"5h": ("five_hour", 5 * 3600), "weekly": ("seven_day", 7 * 86400)}
# An unused window resets a full window length after the probe; allow for the
# probe's own duration (up to 95 s) and clock skew.
NOT_STARTED_SLACK = 300


def fields(blob):
    """Bounded protobuf wire reader; repeated message fields merge."""
    if not isinstance(blob, bytes) or len(blob) > MAX_BLOB:
        raise ValueError("unsupported metadata size/type")
    pos = 0

    def varint():
        nonlocal pos
        value = 0
        for i in range(10):
            if pos >= len(blob):
                break
            b = blob[pos]
            pos += 1
            if i == 9 and b > 1:
                break
            value |= (b & 127) << (7 * i)
            if b < 128:
                return value
        raise ValueError("invalid metadata varint")

    out = {}
    while pos < len(blob):
        tag = varint()
        number, wire = tag >> 3, tag & 7
        if not 0 < number <= 536870911:
            raise ValueError("invalid metadata field")
        if wire == 0:
            value = varint()
        else:
            length = varint() if wire == 2 else {1: 8, 5: 4}.get(wire)
            if length is None or length > len(blob) - pos:
                raise ValueError("invalid metadata wire/length")
            value = blob[pos:pos + length]
            pos += length
        out.setdefault(number, []).append((wire, value))
    return out


def scalar(obj, key, wire, default=None):
    values = obj.get(key, [])
    if any(w != wire for w, _ in values):
        raise ValueError("unexpected metadata field type")
    return values[-1][1] if values else default


def message(obj, key):
    values = obj.get(key, [])
    if any(w != 2 for w, _ in values):
        raise ValueError("unexpected metadata message type")
    return fields(b"".join(v for _, v in values))


def text(obj, key):
    value = scalar(obj, key, 2)
    if value is None:
        return None
    value = value.decode("utf-8")
    return value if value.strip() else None


def stamp(obj):
    seconds = scalar(obj, 1, 0)
    nanos = scalar(obj, 2, 0, 0)
    if seconds is None:
        return None
    if not 0 < seconds <= time.time() + 300 or not 0 <= nanos < 1000000000:
        raise ValueError("invalid metadata timestamp")
    return seconds


def parse(blob):
    root = fields(blob)
    chat = message(root, 1)
    usage = message(chat, 4)
    counts = [scalar(usage, k, 0, 0) for k in (1, 2, 5, 9, 10)]
    if any(n > 9007199254740991 for n in counts) or sum(counts) > 9007199254740991:
        raise ValueError("metadata token count overflow")
    return {
        "response_id": text(usage, 11), "model": text(chat, 19),
        "step": text(root, 4), "bot": text(usage, 7),
        "occurred_at": stamp(message(message(chat, 9), 4)),
        "usage": {"input_tokens": counts[0] + counts[1],
                  "cache_read_tokens": counts[2], "output_tokens": counts[3] + counts[4]},
    }


def schema(db, table, columns):
    entry = db.execute("SELECT type, sql FROM sqlite_master WHERE name = ?", (table,)).fetchone()
    if entry is None:
        return False
    if entry[0] != "table" or "VIRTUAL TABLE" in (entry[1] or "").upper():
        raise ValueError("unsupported metadata table")
    info = {row[1]: row for row in db.execute('PRAGMA table_xinfo("%s")' % table)}
    if any(c not in info or info[c][6] != 0 for c in columns):
        raise ValueError("unsupported metadata columns")
    return True


def step_times(db, wanted):
    """Dates of generations without their own: their step's, if unique."""
    if not wanted or not schema(db, "steps", ("idx", "metadata")):
        return {}
    times = {key: set() for key in wanted}
    rows = db.execute("SELECT CASE WHEN length(metadata) <= ? THEN metadata END FROM steps", (MAX_BLOB,))
    for (blob,) in rows:
        try:
            meta = fields(blob)
            key = (text(meta, 12), text(message(meta, 9), 7))
            if key in times:
                when = stamp(message(meta, 1))
                if when:
                    times[key].add(when)
        except (ValueError, UnicodeError):
            pass
    return {key: next(iter(v)) for key, v in times.items() if len(v) == 1}


def read_database(path):
    """Read every generation of one conversation from a consistent snapshot."""
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        db.execute("PRAGMA query_only = ON")
        db.execute("BEGIN")
        if not schema(db, "gen_metadata", ("idx", "data")):
            return [], 0
        rows, skipped, uses = [], 0, {}
        blobs = db.execute("SELECT CASE WHEN length(data) <= ? THEN data END FROM gen_metadata", (MAX_BLOB,))
        for (blob,) in blobs:
            try:
                row = parse(blob)
            except (ValueError, UnicodeError):
                skipped += 1
                continue
            valid = row["response_id"] and ID.fullmatch(row["response_id"])
            if valid:
                uses.setdefault((row["step"], row["bot"]), set()).add(row["response_id"])
            if not any(row["usage"].values()):
                continue
            if not valid:
                skipped += 1
                continue
            rows.append(row)
        # A step/bot key shared by two responses cannot tell which one a
        # step's timestamp belongs to: those stay undated (skipped).
        times = step_times(db, {(r["step"], r["bot"]) for r in rows if r["occurred_at"] is None
                                and r["step"] and r["bot"] and len(uses[(r["step"], r["bot"])]) == 1})
        out = []
        for row in rows:
            when = row["occurred_at"] or times.get((row["step"], row["bot"]))
            if when is None:
                skipped += 1
                continue
            # Never substitute a hook's current model for historical model IDs.
            model = None if row["model"] == "gemini-default" else row["model"]
            offset = datetime.datetime.fromtimestamp(when).astimezone().utcoffset()
            out.append({"response_id": row["response_id"], "session_id": path.stem,
                        "model": model, "occurred_at": when,
                        "utc_offset_min": int(offset.total_seconds() // 60), "usage": row["usage"]})
        return out, skipped
    finally:
        db.close()


def databases():
    home = Path(os.environ.get("GEMINI_CLI_HOME") or Path.home() / ".gemini")
    seen = set()
    for app in ("antigravity", "antigravity-cli", "antigravity-ide"):
        for path in sorted((home / app / "conversations").glob("*.db")):
            resolved = path.resolve()
            if resolved not in seen and ID.fullmatch(path.stem):
                seen.add(resolved)
                yield path


@contextlib.contextmanager
def locked(path, wait=True):
    # Append mode ignores seek() for writes on Windows. Never truncate a
    # lock file another worker may hold. Waiting happens in the detached
    # worker, so an overlapping final-turn hook is not silently discarded.
    with os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT, 0o600), "r+b") as lock:
        if os.name == "nt":
            import msvcrt
        else:
            import fcntl
        while True:
            try:
                if os.name == "nt":
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if not wait:
                    yield False
                    return
                time.sleep(0.1)
        try:
            # Windows permits locking beyond EOF; initialize only while
            # holding the lock, avoiding a racing write to a locked byte.
            if os.name == "nt" and lock.seek(0, os.SEEK_END) == 0:
                lock.seek(0)
                lock.write(b"0")
                lock.flush()
            yield True
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def save_state(path, state):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state))
    os.replace(temp, path)


KEPT_TARGETS = 8  # most recently used servers / keys whose checkpoints are kept


def target():
    """Which server and key the checkpoints belong to, as a fingerprint: the
    state file is not secret, so it never holds the key or a part of it."""
    url = urllib.parse.urlsplit(SERVER.strip())
    server = urllib.parse.urlunsplit((url.scheme.lower(), url.netloc.lower(), url.path.rstrip("/"), url.query, ""))
    return hashlib.sha256((server + "\n" + KEY.strip()).encode()).hexdigest()[:16]


def for_target(saved):
    """The state file to write back, this target's checkpoints in it, and
    whether it held them already.

    Checkpoints are kept per server and key: a new one starts empty, so its
    first run sends the whole local history (the server stores each response
    once), and switching back to an earlier one resumes where it was. The
    single-target shape from before ({"scope": ...}) is carried over when it
    is this target's, else dropped."""
    targets = saved.get("targets") if isinstance(saved, dict) else None
    targets = {k: v for k, v in targets.items() if isinstance(v, dict)} if isinstance(targets, dict) else {}
    fp = target()
    if isinstance(saved, dict) and saved.get("scope") == hashlib.sha256((SERVER.rstrip("/") + "\n" + KEY).encode()).hexdigest():
        targets[fp] = {k: v for k, v in saved.items() if k != "scope"}
    known = fp in targets
    entry = targets.pop(fp, {})
    targets[fp] = entry  # most recently used last
    return {"targets": dict(list(targets.items())[-KEPT_TARGETS:])}, entry, known


def load_state(path):
    """Saved state, or None when missing or malformed (starting over is safe)."""
    try:
        state = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) else None


def quota_reports(report, measured_at):
    """Allowlist measured CLI quota buckets, keeping model pools separate.

    JSON schema/print command evidence:
    https://github.com/steipete/CodexBar/tree/main/Sources/CodexBarCore/Providers/Antigravity
    No account identity, descriptions, model configuration or credentials leave
    this function. Unknown/disabled buckets and out-of-range fractions are absent.
    """
    if not isinstance(report, dict) or report.get("status") != "SUCCESS":
        return []
    command = report.get("command", {})
    if not isinstance(command, dict) or command.get("name") != "usage":
        return []
    data = command.get("data", {})
    groups = data.get("groups", []) if isinstance(data, dict) else []
    if not isinstance(groups, list):
        return []
    pools, seen, ambiguous = {}, set(), set()
    for group in groups:
        buckets = group.get("buckets", []) if isinstance(group, dict) else []
        if not isinstance(buckets, list):
            continue
        for bucket in buckets:
            if not isinstance(bucket, dict):
                continue
            # agy 1.2.11 prints "id"; older reports used bucketId / bucket_id.
            ident = bucket.get("id", bucket.get("bucketId", bucket.get("bucket_id")))
            pool, _, cadence = ident.partition("-") if isinstance(ident, str) else ("", "", "")
            if pool not in POOLS or cadence not in WINDOWS:
                continue
            limit, span = WINDOWS[cadence]
            if ident in seen:
                ambiguous.add((pool, limit))
            seen.add(ident)
            if bucket.get("disabled", False) is not False:
                continue
            remaining = bucket.get("remaining", {})
            fraction = bucket.get("remainingFraction", bucket.get("remaining_fraction"))
            if fraction is None and isinstance(remaining, dict):
                fraction = remaining.get("remainingFraction", remaining.get("remaining_fraction"))
                if fraction is None and remaining.get("case") in ("remainingFraction", "remaining_fraction"):
                    fraction = remaining.get("value")
            if type(fraction) not in (int, float) or not 0 <= fraction <= 1:
                continue
            reset = bucket.get("resetTime", bucket.get("reset_time"))
            if reset is not None:
                try:
                    parsed = datetime.datetime.fromisoformat(reset.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        continue
                    reset = parsed.timestamp()
                except (AttributeError, ValueError, OverflowError):
                    continue
            if reset is not None and not measured_at < reset <= measured_at + span + 600:
                continue
            # A window nobody has used yet: agy reports it untouched, resetting
            # a full window length from now (or never). That is not a measured
            # window, so the pool stays Unavailable instead of showing a window
            # that has not started.
            if fraction == 1 and (reset is None or reset >= measured_at + span - NOT_STARTED_SLACK):
                continue
            pools.setdefault(pool, {})[limit] = {
                "used_percentage": round((1 - fraction) * 100, 8), "resets_at": reset}
    for pool, limit in ambiguous:
        pools.get(pool, {}).pop(limit, None)
    return [{"messages": [], "account_ref": POOLS[pool], "occurred_at": measured_at, "rate_limits": limits}
            for pool, limits in sorted(pools.items()) if limits]


class QuotaUnavailable(Exception):
    pass


def read_quotas():
    """Ask the signed-in CLI for /usage, never read provider credential files.

    Older versions could interpret an unsupported slash command as a model
    prompt. Require the first supported print-usage version before invoking it.
    An empty working directory avoids project instructions/hooks. The marker
    also prevents recursion through this collector's global hooks.
    """
    binary = shutil.which("agy")
    if binary is None:
        raise QuotaUnavailable("agy CLI not found on PATH")
    env = {k: v for k, v in os.environ.items() if k not in ("AI_ACTIVITY_KEY", "AI_ACTIVITY_URL")}
    env["AI_ACTIVITY_ANTIGRAVITY_QUOTA_PROBE"] = "1"
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    with tempfile.TemporaryDirectory(prefix="ai-activity-agy-quota-") as directory:
        def run(args, timeout):
            # Keep raw stdout off the collector's logs and bound the parsed size.
            try:
                with tempfile.TemporaryFile() as output:
                    result = subprocess.run([binary, *args], cwd=directory, env=env, timeout=timeout,
                        stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL, **flags)
                    if result.returncode == 0 and output.tell() <= MAX_BLOB:
                        output.seek(0)
                        return output.read().decode("utf-8")
            except (OSError, subprocess.SubprocessError, UnicodeError):
                pass
            raise QuotaUnavailable("agy %s failed" % " ".join(args[:2]))
        found = re.search(r"(\d+)\.(\d+)\.(\d+)", run(["--version"], 3))
        if found is None or tuple(map(int, found.groups())) < MIN_AGY:
            raise QuotaUnavailable("agy version %s; %s or later required" % (
                found.group(0) if found else "unrecognized", ".".join(map(str, MIN_AGY))))
        try:
            report = json.loads(run(["-p", "/usage", "--output-format", "json",
                                     "--print-timeout", "90s"], 95))
        except ValueError:
            raise QuotaUnavailable("agy /usage printed invalid JSON") from None
    reports = quota_reports(report, int(time.time()))
    if not reports:
        raise QuotaUnavailable("no supported quota bucket in agy /usage")
    return reports


def file_stamp(path):
    # WAL-only commits and edits to old rows invalidate the whole snapshot.
    # Identity/ctime detect replacements; the database header's change
    # counter and the WAL header's salts catch a same-size rewrite.
    def stat(p, offset, length):
        try:
            v = p.stat()
            with p.open("rb") as f:
                f.seek(offset)
                return [v.st_mtime_ns, v.st_size, v.st_ctime_ns, v.st_ino, f.read(length).hex()]
        except FileNotFoundError:
            return None
    return [stat(path, 24, 4), stat(Path(str(path) + "-wal"), 16, 8)]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never redirect a device bearer key to a different destination.
    def redirect_request(self, *args, **kwargs):
        return None


def upload(payload, state, retry_key):
    """POST one batch; HTTP 429/503 store the server's Retry-After in state[retry_key]."""
    request = urllib.request.Request(SERVER.rstrip("/") + "/api/ingest/antigravity",
        data=json.dumps(dict(payload, collector=COLLECTOR)).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            result = json.loads(response.read(MAX_BLOB + 1))
    except urllib.error.HTTPError as error:
        if error.code == 426:  # too old for this server: nothing is accepted until updated
            try:
                report_update(json.loads(error.read(1 << 16)))
            except ValueError:
                pass
        error.close()
        if error.code in (429, 503):
            header = str(error.headers.get("Retry-After", "")).strip()
            try:
                if header.isdigit():
                    delay = float(header)
                else:
                    delay = parsedate_to_datetime(header).timestamp() - time.time()
            except (ValueError, TypeError, OverflowError):
                delay = 60
            state[retry_key] = int(time.time() + min(86400, max(1, delay)))
        raise
    if not isinstance(result, dict) or result.get("ok") is not True \
            or result.get("messages") != len(payload["messages"]):
        raise ValueError("server did not accept every metadata entry")
    state.pop(retry_key, None)
    report_update(result)


def report_update(answer):
    """The server's answer says when a newer collector exists ("update"): tell
    it on stderr and in ~/.cache/ai-activity/update-available-antigravity,
    which goes away once this copy is up to date."""
    path = Path.home() / ".cache" / "ai-activity" / "update-available-antigravity"
    update = answer.get("update") if isinstance(answer, dict) else None
    if isinstance(update, dict):
        latest = update.get("latest")
        text = ("ai-activity antigravity collector v%d is outdated (latest v%s): run the install command "
                "again (Settings > Devices)\n" % (VERSION, latest if type(latest) is int else "?"))
        sys.stderr.write(text)
        path.write_text(text)
    else:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def deferred(state, key):
    retry = state.get(key, 0)
    return type(retry) in (int, float) and time.time() < retry <= time.time() + 86400


def transient(error):
    """Busy/locked SQLite clears up; any other failure only changes with the file."""
    text = str(error).lower()
    return isinstance(error, sqlite3.OperationalError) and ("locked" in text or "busy" in text)


def collect_tokens(state_path):
    """Upload new or grown responses of changed databases; True if one was busy."""
    stored, state, can_save = for_target(load_state(state_path))
    # A new target is only saved once this run achieved something.
    if deferred(state, "upload_retry_at"):
        raise RuntimeError("upload retry deferred by server")
    sources = [(hashlib.sha256(str(p.resolve()).encode()).hexdigest(), p) for p in databases()]
    # hashed path -> {"stamp": stamp once all of it was accepted,
    #                 "sent": {response id: output tokens accepted}}.
    # Entries of deleted databases and malformed ones are dropped.
    files = state.get("files") if isinstance(state.get("files"), dict) else {}
    state["files"] = files = {name: files[name] for name, _ in sources if isinstance(files.get(name), dict)
                              and isinstance(files[name].get("sent"), dict)
                              and all(type(n) is int for n in files[name]["sent"].values())}
    failed = False
    try:
        for name, path in sources:
            # A stamp taken before the read and stored once all of it was
            # accepted: a write during the read makes the next run read again.
            before = file_stamp(path)
            entry = files.setdefault(name, {"sent": {}})
            if entry.get("stamp") == before:
                continue
            try:
                entries, skipped = read_database(path)
            except (sqlite3.DatabaseError, ValueError, UnicodeError) as error:
                if transient(error):
                    print("ai-activity antigravity: conversation database busy; retry on next run",
                          file=sys.stderr)
                    failed = True
                else:
                    print("ai-activity antigravity: unsupported or unreadable conversation database skipped "
                          "until it changes", file=sys.stderr)
                    entry["stamp"] = before
                continue
            if skipped:
                print("ai-activity antigravity: %d metadata rows unavailable; skipped "
                      "(unsupported or incomplete)" % skipped, file=sys.stderr)
            # A response written twice (partial, then final) is sent once, with its final counts.
            best = {}
            for row in entries:
                digest = hashlib.sha256(json.dumps(row, sort_keys=True).encode()).hexdigest()
                rank = (row["usage"]["output_tokens"], sum(row["usage"].values()), row["occurred_at"], digest)
                if row["response_id"] not in best or rank > best[row["response_id"]][0]:
                    best[row["response_id"]] = (rank, row)
            # Only new responses, or ones with more output (the server's update rule).
            sent = entry["sent"]
            pending = [row for _, row in best.values()
                       if row["usage"]["output_tokens"] > sent.get(row["response_id"], -1)]
            for i in range(0, len(pending), 200):
                # Network/HTTP/acceptance errors end the pass; what this
                # batch holds is sent again next run.
                batch = pending[i:i + 200]
                upload({"messages": batch}, state, "upload_retry_at")
                can_save = True
                sent.update((row["response_id"], row["usage"]["output_tokens"]) for row in batch)
            # Every response now in the database was accepted; forget removed ones.
            entry.update(stamp=before, sent={rid: sent[rid] for rid in best})
    finally:
        if can_save or "upload_retry_at" in state:
            save_state(state_path, stored)
    return failed


def collect_quotas(state_path):
    """Probe agy once a minute, five after a failure, or after the server's Retry-After."""
    state = load_state(state_path) or {}
    tried = state.get("tried_at", 0)
    if type(tried) not in (int, float) or not 0 <= tried <= time.time():
        tried = 0
    if deferred(state, "retry_at") or time.time() - tried < (300 if state.get("failed") else 60):
        return
    state.update(tried_at=int(time.time()), failed=True)
    save_state(state_path, state)  # a killed probe keeps its throttle
    try:
        for report in read_quotas():
            upload(report, state, "retry_at")
        state["failed"] = False
    except QuotaUnavailable as error:
        print("ai-activity antigravity: quota report unavailable (%s); usage collection continues" % error,
              file=sys.stderr)
    finally:
        save_state(state_path, state)


def collect(on_locked=None):
    url = urllib.parse.urlsplit(SERVER)
    try:
        port = url.port  # raises on a malformed or out-of-range port
    except ValueError:
        port = 0
    if port == 0 or url.scheme not in ("http", "https") or not url.hostname or url.username \
            or url.password or url.query or url.fragment or "<" in SERVER:
        raise ValueError("configure AI_ACTIVITY_URL before collecting")
    if not KEY.strip() or "<" in KEY or any(ord(c) < 32 for c in KEY):
        raise ValueError("configure AI_ACTIVITY_KEY before collecting")
    cache = Path.home() / ".cache" / "ai-activity"
    cache.mkdir(parents=True, exist_ok=True)
    with locked(cache / "antigravity.lock"):
        if on_locked is not None:
            on_locked()
        failed = collect_tokens(cache / "antigravity.json")
    # Probe after releasing the collection lock, so a queued hook worker never
    # waits for agy; a probe already running elsewhere makes this one skip.
    # Opt-in: the probe drives the signed-in agy CLI, which contacts Google's
    # backend; Antigravity's terms restrict third-party tools using the service.
    if os.environ.get("AI_ACTIVITY_ANTIGRAVITY_QUOTAS") == "1":
        with locked(cache / "antigravity-quota.lock", wait=False) as mine:
            if mine:
                collect_quotas(cache / "antigravity-quota.json")
    if failed:
        raise RuntimeError("collection failed")


def hook_worker():
    cache = Path.home() / ".cache" / "ai-activity"
    cache.mkdir(parents=True, exist_ok=True)
    # One active worker and at most one waiting worker. A hook coalesced into
    # a waiter is safe: that waiter has not taken its database snapshot yet.
    # Release the queue lock only after acquiring the collection lock, so a
    # hook during collection can schedule the next pass (including Stop).
    with contextlib.ExitStack() as waiting:
        if not waiting.enter_context(locked(cache / "antigravity-waiter.lock", wait=False)):
            return
        def ready():
            waiting.close()
            # Delay after acquiring the main lock, including for a long-lived
            # waiter, to let the app persist final metadata after its hook.
            time.sleep(2)
        collect(on_locked=ready)


def launch_worker():
    options = {"start_new_session": True}
    if os.name == "nt":
        options = {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                   | subprocess.CREATE_BREAKAWAY_FROM_JOB}
    args = [sys.executable, str(Path(__file__).resolve()), "--hook-worker"]
    streams = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        subprocess.Popen(args, **streams, **options)
    except OSError as error:
        # Some Windows jobs forbid breakaway. Keep console/group detachment;
        # scheduled/manual retries cover hosts that terminate their entire job.
        if os.name != "nt" or getattr(error, "winerror", None) != 5:
            raise
        options["creationflags"] &= ~subprocess.CREATE_BREAKAWAY_FROM_JOB
        subprocess.Popen(args, **streams, **options)


if __name__ == "__main__":
    if "--hook" in sys.argv or "--post-invocation" in sys.argv:
        # Consume the hook payload locally, never forward transcript/workspace paths.
        try:
            sys.stdin.read(MAX_BLOB)
        except Exception:
            pass
        if os.environ.get("AI_ACTIVITY_ANTIGRAVITY_QUOTA_PROBE") != "1":
            try:
                launch_worker()
            except OSError:
                # A process limit or missing interpreter must not break the
                # app's hook protocol. A manual/scheduled pass can retry.
                print("ai-activity antigravity: worker launch failed; retry manually or on next hook",
                      file=sys.stderr)
        # PostInvocation must not inject steps or change execution flow.
        # Antigravity's Stop contract requires a decision; only "continue"
        # re-enters the loop, and every other value permits the normal stop:
        # https://antigravity.google/docs/hooks/#stop
        print('{}' if "--post-invocation" in sys.argv else '{"decision":"stop"}')
    else:
        try:
            if "--hook-worker" in sys.argv:
                hook_worker()
            else:
                collect()
        except Exception:
            print("ai-activity antigravity: collector did not complete; retry on next run", file=sys.stderr)
            sys.exit(1)
