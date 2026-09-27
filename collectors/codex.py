#!/usr/bin/env python3
"""AI Activity collector for Codex (see README.md, "Send Codex usage").

Run by a Codex Stop hook at the end of every turn, and again on every
prompt submit (the Stop hook does not fire on rate-limit stops, so without
the second trigger the final snapshot of an exhausted quota would never be
posted), or by hand, or from cron: it is idempotent. It reads what was added to every rollout under
~/.codex/sessions and ~/.codex/archived_sessions since the last accepted
upload and posts one entry per model response with its token counts, plus
the latest rate limits and context fill of each session. Prompts, replies
and tool output never leave the device: only ids, model, time and counts.

How far each file was sent is kept in ~/.cache/ai-activity/codex.json and
only moves forward once the server accepted everything, so nothing is lost
while the server is down: the next run sends the backlog with its original
times. Delete that file to send everything again (the server stores each
response once).
"""
import datetime
import fcntl
import glob
import json
import os
import signal
import sys
import time
import urllib.request

SERVER = os.environ.get("AI_ACTIVITY_URL", "<server>")
KEY = os.environ.get("AI_ACTIVITY_KEY", "<device key>")
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
CACHE = os.path.expanduser("~/.cache/ai-activity")
BATCH = 400


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
    # [offset, session id, model, has token_usage_record lines]
    offset, session, model, records = (state.get(path) or [0, None, None, False])
    if offset > size:  # rewritten: start over
        offset, session, model, records = 0, None, None, False
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
        elif p.get("type") == "thread_settings_applied" and (p.get("thread_settings") or {}).get("model"):
            model = p["thread_settings"]["model"]
        elif t == "token_usage_record" and isinstance(p.get("usage"), dict) and ts:
            records = True
            messages.append({
                "response_id": p.get("response_id"),
                "session_id": p.get("session_id") or p.get("thread_id") or session,
                "turn_id": p.get("turn_id"),
                "model": model,
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
    return messages, limits, context, [offset + end, session, model, records]


def post(body):
    req = urllib.request.Request(
        SERVER.rstrip("/") + "/api/ingest/codex", data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=60).read()


def save(path, state):
    with open(path + ".tmp", "w") as out:
        json.dump(state, out)
    os.replace(path + ".tmp", path)


def timeout(signum, frame):
    raise TimeoutError("time limit reached; resumes next run")


def main():
    signal.signal(signal.SIGALRM, timeout)  # an exception, so the finally below still saves
    signal.alarm(900)
    os.makedirs(CACHE, exist_ok=True)
    lock = open(os.path.join(CACHE, "codex.lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)  # runs wait for each other
    path = os.path.join(CACHE, "codex.json")
    try:
        state = json.load(open(path))
        state = state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        state = {}
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
                save(path, state)
                changed, saved_at = False, time.monotonic()
    finally:
        if changed:
            save(path, state)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never break the Codex turn; retried next time
        print("ai-activity codex collector: %s" % e, file=sys.stderr)
        sys.exit(1)
