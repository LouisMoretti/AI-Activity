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
import sqlite3
import subprocess
import sys
import time

SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>")
ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
MAX_BLOB = 1024 * 1024
MAX_ROWS = 100000
MAX_PAGE_BYTES = 64 * MAX_BLOB
MAX_DATABASES = 2000
MAX_RUN_SECONDS = 900
MAX_SCAN_SECONDS = 30
MAX_LOCK_SECONDS = 900


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
                return {}
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
                return {}
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
        return {}
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

        times = matched_times(db, rows, deadline)
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
        return out, skipped, last if more else None, more
    finally:
        db.close()


def databases():
    home = Path(os.environ.get("GEMINI_CLI_HOME") or Path.home() / ".gemini")
    seen = set()
    for app in ("antigravity", "antigravity-cli", "antigravity-ide"):
        for root in (home / app, home / app / "conversations"):
            if not root.exists():
                continue
            for path in sorted(root.glob("*.db")):
                resolved = path.resolve()
                if resolved not in seen and ID.fullmatch(path.stem):
                    seen.add(resolved)
                    yield path


@contextlib.contextmanager
def locked(path):
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
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def save_state(path, state):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state))
    os.replace(temp, path)


def collect():
    import urllib.request
    cache = Path.home() / ".cache" / "ai-activity"
    cache.mkdir(parents=True, exist_ok=True)
    with locked(cache / "antigravity.lock"):
        state_path = cache / "antigravity.json"
        try:
            state = json.loads(state_path.read_text())
            if not isinstance(state, dict):
                state = {}
        except (OSError, ValueError):
            state = {}
        # Scope checkpoints to destination + device key; switching servers
        # or accounts must import history again. Credentials are never saved.
        scope = hashlib.sha256((SERVER.rstrip("/") + "\n" + KEY).encode()).hexdigest()
        can_save = state.get("scope") == scope
        if state.get("scope") != scope:
            state = {"scope": scope, "sent": {}}
        sent = state.setdefault("sent", {})
        if not isinstance(sent, dict):
            raise ValueError("invalid collector state; remove antigravity.json to replay")
        positions = state.setdefault("positions", {})
        if not isinstance(positions, dict):
            raise ValueError("invalid collector positions; remove antigravity.json to replay")
        # Rotate after the last attempted source. Even a failing source must
        # not starve every database that follows it. Never persist raw paths.
        paths = list(databases())
        names = [hashlib.sha256(str(p.resolve()).encode()).hexdigest() for p in paths]
        cursor = state.get("cursor")
        start = names.index(cursor) + 1 if cursor in names else 0
        sources = list(zip(names, paths))
        sources = sources[start:] + sources[:start]
        failed = False
        deferred = False
        started = time.monotonic()
        for number, (name, path) in enumerate(sources):
            if number >= MAX_DATABASES or (number and time.monotonic() - started > MAX_RUN_SECONDS):
                deferred = True
                break
            state["cursor"] = name
            try:
                after = positions.get(name)
                if after is not None and not isinstance(after, int):
                    raise ValueError("invalid generation position")
                entries, skipped, next_after, more = read_database(path, after)
                deferred |= more
                if skipped:
                    print("ai-activity antigravity: %d metadata rows unavailable; skipped (unsupported or incomplete)" % skipped, file=sys.stderr)
                # A database can retain partial and final rows for the same
                # response. Select one stable version before comparing the
                # checkpoint, so older rows cannot cause endless replays.
                best = {}
                for entry in entries:
                    ident = entry["session_id"] + ":" + entry["response_id"]
                    digest = hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()
                    rank = (entry["usage"]["output_tokens"], sum(entry["usage"].values()), entry["occurred_at"], digest)
                    if ident not in best or rank > best[ident][0]:
                        best[ident] = (rank, entry)
                pending = []
                for ident, (rank, entry) in best.items():
                    prior = sent.get(ident)
                    # Old checkpoints stored only the digest. Migrate them
                    # without replaying entries already accepted by the server.
                    if prior == rank[-1]:
                        sent[ident] = {"rank": rank}
                    elif not isinstance(prior, dict) or tuple(prior.get("rank", ())) < rank:
                        pending.append((ident, rank, entry))
                page_complete = True
                for i in range(0, len(pending), 200):
                    # Permit one first batch so a slow first snapshot still
                    # makes forward progress; check the budget between batches.
                    if (number or i) and time.monotonic() - started > MAX_RUN_SECONDS:
                        deferred = True
                        page_complete = False
                        if can_save:
                            save_state(state_path, state)
                        break
                    chunk = pending[i:i + 200]
                    request = urllib.request.Request(SERVER.rstrip("/") + "/api/ingest/antigravity",
                        data=json.dumps({"messages": [e for _, _, e in chunk]}).encode(),
                        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
                    with urllib.request.urlopen(request, timeout=30) as response:
                        result = json.load(response)
                    if result.get("ok") is not True or result.get("messages") != len(chunk):
                        raise ValueError("server did not accept every metadata entry")
                    sent.update({ident: {"rank": rank} for ident, rank, _ in chunk})
                    can_save = True
                    save_state(state_path, state)
                if not page_complete:
                    break
                # A page only advances once all its uploads succeeded. Finishing
                # the scan resets it so later edits to old rows are revisited.
                if next_after is None:
                    positions.pop(name, None)
                else:
                    positions[name] = next_after
                can_save = True
                save_state(state_path, state)
            except Exception:
                # Do not print paths, response bodies, credentials or raw DB data.
                print("ai-activity antigravity: collection/upload failed; retry on next run", file=sys.stderr)
                failed = True
                if can_save:
                    save_state(state_path, state)
        if deferred:
            print("ai-activity antigravity: scan budget reached; saved progress for next run", file=sys.stderr)
        if failed:
            raise RuntimeError("collection/upload failed")


if __name__ == "__main__":
    if "--hook" in sys.argv or "--post-invocation" in sys.argv:
        # Consume the hook payload locally, never forward transcript/workspace paths.
        sys.stdin.read()
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--hook-worker"], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options)
        # PostInvocation must not inject steps or change execution flow.
        # Antigravity's Stop contract requires a decision; only "continue"
        # re-enters the loop, and every other value permits the normal stop:
        # https://antigravity.google/docs/hooks/#stop
        print('{}' if "--post-invocation" in sys.argv else '{"decision":"stop"}')
    else:
        try:
            if "--hook-worker" in sys.argv:
                # Allow the app to persist final generation metadata before
                # taking the read-only snapshot. The hook itself never waits.
                time.sleep(2)
            collect()
        except Exception:
            print("ai-activity antigravity: collector did not complete; retry on next run", file=sys.stderr)
            sys.exit(1)
