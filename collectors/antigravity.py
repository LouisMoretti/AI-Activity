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

SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>")
ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
MAX_BLOB = 1024 * 1024
MAX_ROWS = 100000
MAX_PAGE_BYTES = 64 * MAX_BLOB
MAX_DATABASES = 2000
MAX_RUN_SECONDS = 900
MAX_SCAN_SECONDS = 30
# A bounded pass can finish its last scan/upload, then probe quotas, after
# reaching the 15-minute run budget. Give the single waiter that headroom.
MAX_LOCK_SECONDS = 1200


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


def matched_times(db, rows, deadline):
    """Stream full metadata scans; retain only the current page's keys.

    A truncated scan cannot prove uniqueness, so it resolves no timestamps.
    Native generation timestamps remain usable even if this scan times out.
    """
    wanted = {(r["step"], r["bot"]) for r in rows if r["occurred_at"] is None and r["step"] and r["bot"]}
    if not wanted or not schema(db, "steps", ("idx", "metadata")):
        return {}
    uses = {key: set() for key in wanted}
    times = {key: set() for key in wanted}
    try:
        # The generation page alone cannot detect another response with the
        # same step/bot key on a different page. Check the entire snapshot.
        for (blob,) in db.execute("SELECT CASE WHEN length(data) <= ? THEN data END FROM gen_metadata", (MAX_BLOB,)):
            if time.monotonic() > deadline:
                return None
            try:
                root = fields(blob)
                usage = message(message(root, 1), 4)
                key = (text(root, 4), text(usage, 7))
                response = text(usage, 11)
                if key in uses and response and ID.fullmatch(response) and len(uses[key]) < 2:
                    uses[key].add(response)
            except (ValueError, UnicodeError):
                pass
        # Each blob is bounded, but aggregate bytes do not accumulate in
        # memory. Even very large step tables can be streamed safely.
        for (blob,) in db.execute("SELECT CASE WHEN length(metadata) <= ? THEN metadata END FROM steps", (MAX_BLOB,)):
            if time.monotonic() > deadline:
                return None
            try:
                meta = fields(blob)
                key = (text(meta, 12), text(message(meta, 9), 7))
                if key in times and len(times[key]) < 2:
                    when = stamp(message(meta, 1))
                    if when:
                        times[key].add(when)
            except (ValueError, UnicodeError):
                pass
    except sqlite3.OperationalError:
        if time.monotonic() <= deadline:
            raise
        return None
    return {key: next(iter(times[key])) for key in wanted if len(uses[key]) == 1 and len(times[key]) == 1}


def read_database(path, after=None):
    """Read one bounded generation page from a consistent metadata snapshot."""
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    deadline = time.monotonic() + MAX_SCAN_SECONDS
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
    skipped = 0
    try:
        db.execute("PRAGMA query_only = ON")
        db.execute("BEGIN")
        if not schema(db, "gen_metadata", ("idx", "data")):
            return [], 0, None, False
        rows = []
        total_bytes = 0
        last = after
        more = False
        sql = "SELECT idx, CASE WHEN length(data) <= ? THEN data END FROM gen_metadata"
        args = [MAX_BLOB]
        if after is not None:
            sql += " WHERE idx > ?"
            args.append(after)
        sql += " ORDER BY idx LIMIT ?"
        args.append(MAX_ROWS + 1)
        for n, (idx, blob) in enumerate(db.execute(sql, args)):
            size = len(blob) if isinstance(blob, bytes) else 0
            if n >= MAX_ROWS or (n and (total_bytes + size > MAX_PAGE_BYTES or time.monotonic() > deadline)):
                more = True
                break
            if not isinstance(idx, int):
                raise ValueError("unsupported generation index")
            total_bytes += size
            last = idx
            try:
                row = parse(blob)
                if not any(row["usage"].values()):
                    continue
                if not row["response_id"] or not ID.fullmatch(row["response_id"]):
                    skipped += 1
                    continue
                rows.append(row)
            except (ValueError, UnicodeError):
                skipped += 1

        # Matching must not inherit a deadline already spent reading the page.
        # An interrupted uniqueness scan is unknown, not an empty result.
        deadline = time.monotonic() + MAX_SCAN_SECONDS
        times = matched_times(db, rows, deadline)
        incomplete = times is None
        times = times or {}
        out = []
        for row in rows:
            when = row["occurred_at"]
            if when is None:
                when = times.get((row["step"], row["bot"]))
            if when is None:
                skipped += 1
                continue
            # Never substitute a hook's current model for historical model IDs.
            model = row["model"]
            if model == "gemini-default":
                model = None
            offset = datetime.datetime.fromtimestamp(when).astimezone().utcoffset()
            out.append({"response_id": row["response_id"], "session_id": path.stem,
                        "model": model, "occurred_at": when,
                        "utc_offset_min": int(offset.total_seconds() // 60), "usage": row["usage"]})
        # Native dates can still be uploaded, but unresolved matches must be
        # revisited before advancing the page, including when later pages exist.
        return out, skipped, after if incomplete else (last if more else None), more or incomplete
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
        deadline = time.monotonic() + MAX_LOCK_SECONDS
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
                if time.monotonic() >= deadline:
                    raise RuntimeError("collector lock wait timed out") from None
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
    pools = {}
    seen = set()
    ambiguous = set()
    for group in groups:
        buckets = group.get("buckets", []) if isinstance(group, dict) else []
        if not isinstance(buckets, list):
            continue
        for bucket in buckets:
            if not isinstance(bucket, dict):
                continue
            ident = bucket.get("bucketId", bucket.get("bucket_id"))
            if ident not in ("gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"):
                continue
            if ident in seen:
                ambiguous.add(ident)
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
            pool, cadence = ident.split("-", 1)
            limit = "five_hour" if cadence == "5h" else "seven_day"
            span = 18000 if cadence == "5h" else 604800
            if reset is not None and not measured_at < reset <= measured_at + span + 600:
                continue
            pools.setdefault(pool, {})[limit] = {
                "used_percentage": round((1 - fraction) * 100, 8), "resets_at": reset}
    for ident in ambiguous:
        pool, cadence = ident.split("-", 1)
        pools.get(pool, {}).pop("five_hour" if cadence == "5h" else "seven_day", None)
    return [{"messages": [], "account_ref": "gemini" if pool == "gemini" else "claude-gpt",
             "occurred_at": measured_at, "rate_limits": limits}
            for pool, limits in sorted(pools.items()) if limits]


def read_quotas():
    """Ask the signed-in CLI for /usage, never read provider credential files.

    Older versions could interpret an unsupported slash command as a model
    prompt. Require the first supported print-usage version before invoking it.
    An empty working directory avoids project instructions/hooks. The marker
    also prevents recursion through this collector's global hooks.
    """
    binary = shutil.which("agy")
    if binary is None:
        raise ValueError("quota CLI unavailable")
    env = dict(os.environ)
    env.pop("AI_ACTIVITY_KEY", None)
    env.pop("AI_ACTIVITY_URL", None)
    env["AI_ACTIVITY_ANTIGRAVITY_QUOTA_PROBE"] = "1"
    with tempfile.TemporaryDirectory(prefix="ai-activity-agy-quota-") as directory:
        def run(args, timeout):
            # Keep raw stdout off the collector's logs and bound the parsed size.
            with tempfile.TemporaryFile() as output:
                result = subprocess.run([binary, *args], cwd=directory, env=env,
                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL,
                    timeout=timeout, **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
                if result.returncode != 0 or output.tell() > MAX_BLOB:
                    raise ValueError("quota command failed")
                output.seek(0)
                return output.read(MAX_BLOB).decode("utf-8")
        version = run(["--version"], 3).strip()
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or tuple(map(int, version.split("."))) < (1, 1, 11):
            raise ValueError("unsupported quota CLI version")
        report = json.loads(run(["-p", "/usage", "--output-format", "json", "--print-timeout", "90s"], 95))
        return quota_reports(report, int(time.time()))


def file_stamp(path):
    # WAL-only commits and edits to old rows invalidate the whole snapshot.
    # Include identity/ctime to detect replacements, not just appended bytes.
    def stat(p):
        try:
            v = p.stat()
            return [v.st_mtime_ns, v.st_size, v.st_ctime_ns, v.st_ino]
        except FileNotFoundError:
            return None
    return [stat(path), stat(Path(str(path) + "-wal"))]


def collect(on_locked=None):
    import urllib.request
    import urllib.error
    import urllib.parse
    from email.utils import parsedate_to_datetime
    url = urllib.parse.urlsplit(SERVER)
    url.port  # validate malformed ports before opening history
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment or "<" in SERVER:
        raise ValueError("configure AI_ACTIVITY_URL before collecting")
    if not KEY.strip() or "<" in KEY or any(ord(c) < 32 for c in KEY):
        raise ValueError("configure AI_ACTIVITY_KEY before collecting")
    cache = Path.home() / ".cache" / "ai-activity"
    cache.mkdir(parents=True, exist_ok=True)
    with locked(cache / "antigravity.lock"):
        if on_locked is not None:
            on_locked()
        state_path = cache / "antigravity.json"
        try:
            state = json.loads(state_path.read_text())
        except (OSError, ValueError):
            state = {}
        scope = hashlib.sha256((SERVER.rstrip("/") + "\n" + KEY).encode()).hexdigest()
        can_save = isinstance(state, dict) and state.get("scope") == scope
        if not can_save:
            state = {"scope": scope}
        files = state.setdefault("files", {})
        positions = state.setdefault("positions", {})
        sent = state.setdefault("sent", {})  # ranks only for unfinished scans
        if any(not isinstance(v, dict) for v in (files, positions, sent)):
            raise ValueError("invalid collector state; remove antigravity.json to replay")
        retry = state.get("upload_retry_at", 0)
        if type(retry) in (int, float) and time.time() < retry <= time.time() + 86400:
            raise RuntimeError("upload retry deferred by server")

        def upload(payload):
            nonlocal can_save
            # Never redirect a device bearer key to a different destination.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None
            request = urllib.request.Request(SERVER.rstrip("/") + "/api/ingest/antigravity",
                data=json.dumps(payload).encode(),
                headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
            try:
                with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
                    result = json.loads(response.read(MAX_BLOB + 1))
                if not isinstance(result, dict) or result.get("ok") is not True or result.get("messages") != len(payload["messages"]):
                    raise ValueError("server did not accept every metadata entry")
            except urllib.error.HTTPError as error:
                if error.code in (429, 503):
                    headers = getattr(error, "headers", None) or {}
                    header = headers.get("Retry-After", "") if hasattr(headers, "get") else ""
                    try:
                        delay = float(header) if str(header).strip().isdigit() else parsedate_to_datetime(str(header)).timestamp() - time.time()
                    except (ValueError, TypeError, OverflowError):
                        delay = 60
                    state["upload_retry_at"] = int(time.time() + min(86400, max(1, delay)))
                    can_save = True
                if hasattr(error, "close"):
                    try:
                        error.close()
                    except Exception:
                        pass
                raise
            state.pop("upload_retry_at", None)
            can_save = True

        paths = list(databases())
        sources = [(hashlib.sha256(str(p.resolve()).encode()).hexdigest(), p) for p in paths]
        names = [n for n, _ in sources]
        # Deleted sources must not retain checkpoints indefinitely.
        for mapping in (files, positions, sent):
            for name in list(mapping):
                if name not in names:
                    del mapping[name]
        cursor = state.get("cursor")
        start = names.index(cursor) + 1 if cursor in names else 0
        sources = sources[start:] + sources[:start]
        failed = deferred = False
        started = time.monotonic()
        try:
            for number, (name, path) in enumerate(sources):
                if number >= MAX_DATABASES or (number and time.monotonic() - started > MAX_RUN_SECONDS):
                    deferred = True
                    break
                state["cursor"] = name
                try:
                    before = file_stamp(path)
                    checkpoint = files.get(name, {})
                    if checkpoint.get("stamp") == before and checkpoint.get("complete") is True:
                        continue
                    if checkpoint.get("stamp") != before:
                        positions.pop(name, None)
                        sent.pop(name, None)
                    after = positions.get(name)
                    if after is not None and type(after) is not int:
                        raise ValueError("invalid generation position")
                    entries, skipped, next_after, more = read_database(path, after)
                    stable = before == file_stamp(path)
                    if skipped:
                        print("ai-activity antigravity: %d metadata rows unavailable; skipped (unsupported or incomplete)" % skipped, file=sys.stderr)
                except Exception:
                    # A corrupt/unsupported source must not block other sources.
                    print("ai-activity antigravity: collection/upload failed; retry on next run", file=sys.stderr)
                    failed = True
                    continue
                files[name] = {"stamp": before, "complete": False}
                ranks = sent.setdefault(name, {})
                best = {}
                for entry in entries:
                    ident = entry["response_id"]
                    digest = hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()
                    rank = (entry["usage"]["output_tokens"], sum(entry["usage"].values()), entry["occurred_at"], digest)
                    if ident not in best or rank > best[ident][0]:
                        best[ident] = (rank, entry)
                pending = [(ident, rank, entry) for ident, (rank, entry) in best.items()
                           if tuple(ranks.get(ident, ())) < rank]
                page_complete = True
                for i in range(0, len(pending), 200):
                    if (number or i) and time.monotonic() - started > MAX_RUN_SECONDS:
                        deferred = True
                        page_complete = False
                        break
                    chunk = pending[i:i + 200]
                    # Network/HTTP/acceptance errors escape the pass immediately.
                    upload({"messages": [e for _, _, e in chunk]})
                    ranks.update({ident: rank for ident, rank, _ in chunk})
                files[name] = {"stamp": before, "complete": stable and page_complete and not more}
                can_save = True
                if not stable:
                    positions.pop(name, None)
                    sent.pop(name, None)
                elif page_complete:
                    if next_after is None:
                        positions.pop(name, None)
                    else:
                        positions[name] = next_after
                    if not more:
                        sent.pop(name, None)
                deferred |= more or not stable
                if not page_complete:
                    break
            # Persist once per pass, not once per batch/database. Accepted ranks
            # on an interrupted scan are retryable; completed files need only stamps.
            tried = state.get("quota_tried_at", 0)
            if type(tried) not in (int, float) or not 0 <= tried <= time.time():
                tried = 0
            interval = 300 if state.get("quota_failed") else 60
            if os.environ.get("AI_ACTIVITY_ANTIGRAVITY_QUOTAS") != "0" and time.time() - tried >= interval:
                state.update(quota_tried_at=int(time.time()), quota_failed=True)
                can_save = True
                save_state(state_path, state)  # a killed probe retains its throttle
                try:
                    reports = read_quotas()
                except Exception:
                    reports = []
                if not reports:
                    print("ai-activity antigravity: quota report unavailable; usage collection continues", file=sys.stderr)
                else:
                    for report in reports:
                        upload(report)
                    state["quota_failed"] = False
            if deferred:
                print("ai-activity antigravity: scan budget reached; saved progress for next run", file=sys.stderr)
            if failed:
                raise RuntimeError("collection/upload failed")
        finally:
            if can_save:
                save_state(state_path, state)


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
        options = {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_BREAKAWAY_FROM_JOB}
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
                print("ai-activity antigravity: worker launch failed; retry manually or on next hook", file=sys.stderr)
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
