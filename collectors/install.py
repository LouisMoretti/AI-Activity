#!/usr/bin/env python3
"""AI Activity one-command install (see README.md, "One-command install").

Served by the server with the collectors embedded below (FILES), and run on
a device, as the user who runs the tools:

    Linux / macOS:
    curl -fsSL <server>/install.sh | AI_ACTIVITY_URL=<server> AI_ACTIVITY_KEY=<device key> sh
    Windows (PowerShell):
    $env:AI_ACTIVITY_URL="<server>"; $env:AI_ACTIVITY_KEY="<device key>"; irm <server>/install.ps1 | iex

Installs the collectors of the tools found on this machine (or those listed
in AI_ACTIVITY_TOOLS, e.g. "claude-code,codex"), with the server URL and
device key filled in. The key comes from the environment, never from a URL.
Existing ~/.claude/settings.json, ~/.codex/hooks.json and
~/.gemini/config/hooks.json keep their other entries; running it again only
updates what changed. Messages stay ASCII: a Windows console may not print
anything else.
"""
import json
import os
import re
import shlex
import shutil
import sys
import urllib.error
import urllib.request

# Replaced by the server: {"claude-code.py": ..., "codex.py": ..., "opencode.py": ...,
# "opencode-plugin.js": ..., "antigravity.py": ...}
FILES = {}

TOOLS = ("claude-code", "codex", "antigravity", "opencode")  # TOOLS order (shared/types.ts)
NAMES = {"claude-code": "Claude Code", "codex": "Codex", "antigravity": "Antigravity", "opencode": "OpenCode"}
WINDOWS = os.name == "nt"
HOME = os.path.expanduser("~")
CLAUDE_DIR = os.path.join(HOME, ".claude")
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
GEMINI_HOME = os.environ.get("GEMINI_CLI_HOME") or os.path.join(HOME, ".gemini")
OPENCODE_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "opencode")
# The JSON files the installs merge into (OpenCode has none).
CONFIGS = {"claude-code": os.path.join(CLAUDE_DIR, "settings.json"),
           "codex": os.path.join(CODEX_HOME, "hooks.json"),
           "antigravity": os.path.join(GEMINI_HOME, "config", "hooks.json")}
# Claude Code events that send the tokens: during a turn, after it (StopFailure:
# ended by an API error, e.g. a rate limit), before the next one (neither fires
# on an interrupted turn) and at exit.
CLAUDE_HOOKS = ("UserPromptSubmit", "PostToolUse", "Stop", "StopFailure", "SessionEnd")
# PostToolUse sends a long turn as it runs. UserPromptSubmit catches up on
# rollouts left by a turn whose Stop hook did not fire (e.g. a rate limit).
CODEX_HOOKS = ("Stop", "UserPromptSubmit", "PostToolUse")
ANTIGRAVITY_HOOKS = (("PostInvocation", "--post-invocation"), ("Stop", "--hook"))


def fail(msg):
    print("ai-activity: " + msg, file=sys.stderr)
    sys.exit(1)


def say(msg):
    print("ai-activity: " + msg)


def fill(text, url, key):
    """The collector with its SERVER / KEY defaults set (the quoted placeholders only)."""
    return text.replace('"<server>"', json.dumps(url)).replace('"<device key>"', json.dumps(key))


def write(path, content, mode=None):
    """Write only if different (exact bytes, LF kept on Windows); True when the file changed.
    A symlink (dotfiles managers) stays one: its target is what gets written."""
    path = os.path.realpath(path)
    try:
        with open(path, encoding="utf-8", newline="") as f:
            if f.read() == content:
                if mode is not None:
                    os.chmod(path, mode)
                return False
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".ai-activity-tmp"
    # Created with its final mode: a key is never readable by others, not even briefly.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode if mode is not None else 0o644)
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    if mode is None and os.path.exists(path):
        shutil.copymode(path, tmp)
    elif mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)
    return True


def load_json(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except ValueError:
        fail(f"{path} is not valid JSON: fix it, then run this again (nothing was changed)")
    if not isinstance(data, dict):
        fail(f"{path} is not a JSON object: fix it, then run this again (nothing was changed)")
    return data


def dump(data):
    return json.dumps(data, indent=2) + "\n"


def command(script, default, *args):
    """The command a tool runs: the README's on Linux/macOS (~ when the file is
    where the README puts it); on Windows this interpreter's absolute path, so
    it works whatever the tool's PATH holds."""
    if WINDOWS:
        # Quoted, backslashes and all, as the README writes them.
        return " ".join([f'"{sys.executable}"', f'"{script}"', *args])
    if script == os.path.join(HOME, *default.split("/")[1:]):
        shown = default
    else:
        shown = shlex.quote(script)
    python = "python3" if shutil.which("python3") else shlex.quote(sys.executable)
    return " ".join([python, shown, *args])


def short_path(path):
    """8.3 short path (never any space, so never any quote): agy's hook runner
    splits the hook command naively on spaces and keeps the quotes in the
    tokens, so a quoted path never resolves there. Only meaningful on
    Windows; anywhere else, or when the short name is unavailable (8.3
    disabled on the volume), the path comes back unchanged."""
    if os.name != "nt":
        return path
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(300)
        if ctypes.windll.kernel32.GetShortPathNameW(path, buf, 300):
            return buf.value
    except Exception:
        pass
    return path


def present(tool):
    on_path = lambda name: shutil.which(name) is not None
    if tool == "claude-code":
        return on_path("claude") or os.path.isdir(CLAUDE_DIR)
    if tool == "codex":
        return on_path("codex") or os.path.isdir(CODEX_HOME)
    if tool == "antigravity":
        # ~/.gemini alone is the Gemini CLI: only Antigravity's own folders count.
        return on_path("agy") or any(os.path.isdir(os.path.join(GEMINI_HOME, d))
                                     for d in ("antigravity", "antigravity-cli", "antigravity-ide"))
    return on_path("opencode") or os.path.isdir(OPENCODE_DIR)


def preflight(tools):
    """Read every config before writing anything, so a broken one stops the
    install with nothing changed rather than halfway through."""
    for tool, path in CONFIGS.items():
        if tool not in tools:
            continue
        config = load_json(path)
        if tool in ("claude-code", "codex") and not isinstance(config.get("hooks", {}), dict):
            fail(f"{path}: \"hooks\" is not an object: fix it, then run this again (nothing was changed)")


def install_claude(url, key):
    path = CONFIGS["claude-code"]
    settings = load_json(path)
    script = os.path.join(CLAUDE_DIR, "ai-activity-claude-code.py")
    changed = write(script, fill(FILES["claude-code.py"], url, key), 0o600)
    run = lambda *args: command(script, "~/.claude/ai-activity-claude-code.py", *args)
    # Tokens: the hooks, next to the user's own.
    hooks = settings.setdefault("hooks", {})  # an object: preflight checked
    ours = {"hooks": [{"type": "command", "command": run("--hook"), "timeout": 10}]}
    for event in CLAUDE_HOOKS:
        entries = hooks.get(event)
        entries = entries if isinstance(entries, list) else []
        # A matcher group may contain both our handler and the user's handlers.
        # Remove only ours, even if an earlier install used a different path.
        kept = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
                kept.append(entry)
                continue
            handlers = [handler for handler in entry["hooks"]
                        if not (isinstance(handler, dict) and isinstance(handler.get("command"), str)
                                and "ai-activity-claude-code.py" in handler["command"])]
            if len(handlers) == len(entry["hooks"]):
                kept.append(entry)
            elif handlers:
                kept.append({**entry, "hooks": handlers})
        hooks[event] = kept + [ours]
    # Quotas and context: the status line, the only place Claude Code gives them.
    current = settings.get("statusLine")
    # Ours: this script, or the former one-liner (it named ~/.cache/ai-activity).
    other = isinstance(current, dict) and "ai-activity" not in str(current.get("command", ""))
    kept = current and other and os.environ.get("AI_ACTIVITY_FORCE") != "1"
    if not kept:
        settings["statusLine"] = {"type": "command", "command": run()}
    changed = write(path, dump(settings)) or changed
    say(f"Claude Code: {'installed' if changed else 'already up to date'} ({script}, hooks"
        f"{'' if kept else ' and statusLine'} in {path})")
    if kept:
        say(f"Claude Code: {path} already has another statusLine, kept: tokens are sent, quotas are not. "
            "AI_ACTIVITY_FORCE=1 replaces it (Claude Code runs one status line).")
    return True


def install_codex(url, key):
    script = os.path.join(CODEX_HOME, "ai-activity-codex.py")
    path = CONFIGS["codex"]
    config = load_json(path)
    hooks = config.setdefault("hooks", {})  # an object: preflight checked
    changed = write(script, fill(FILES["codex.py"], url, key), 0o600)
    if WINDOWS or not shutil.which("setsid"):
        # --hook answers Codex and detaches the upload itself (macOS has no setsid).
        run = command(script, "~/.codex/ai-activity-codex.py", "--hook")
        if WINDOWS:
            # Codex runs Windows hooks through PowerShell; quoted executables
            # need its call operator. Other tools use different shells.
            run = "& " + run
    else:
        run = f"setsid -f {command(script, '~/.codex/ai-activity-codex.py')} >/dev/null 2>&1 </dev/null; echo '{{}}'"
    ours = {"hooks": [{"type": "command", "command": run, "timeout": 10}]}
    for event in CODEX_HOOKS:
        entries = hooks.get(event)
        entries = entries if isinstance(entries, list) else []
        # Drop our earlier entries (any path), keep everyone else's.
        kept = [e for e in entries if "ai-activity-codex.py" not in json.dumps(e)]
        hooks[event] = kept + [ours]
    changed = write(path, dump(config)) or changed
    say(f"Codex: {'installed' if changed else 'already up to date'} ({script}, hooks in {path})")
    return True


def install_antigravity(url, key):
    script = os.path.join(GEMINI_HOME, "ai-activity-antigravity.py")
    changed = write(script, fill(FILES["antigravity.py"], url, key), 0o600)
    path = CONFIGS["antigravity"]
    config = load_json(path)
    if WINDOWS:
        # Quoteless 8.3 paths: see short_path(). The other tools' runners
        # (PowerShell, Git Bash) accept quoted paths, agy's does not.
        run = lambda flag: {"type": "command",
                            "command": f"{short_path(sys.executable)} {short_path(script)} {flag}",
                            "timeout": 10}
    else:
        run = lambda flag: {"type": "command", "command": command(script, "~/.gemini/ai-activity-antigravity.py", flag), "timeout": 10}
    # A named hook: ours is replaced whole, the others are kept.
    config["ai-activity"] = {"enabled": True, **{event: [run(flag)] for event, flag in ANTIGRAVITY_HOOKS}}
    changed = write(path, dump(config)) or changed
    say(f"Antigravity: {'installed' if changed else 'already up to date'} ({script}, hook in {path})")
    return True


def install_opencode(url, key):
    changed = write(os.path.join(OPENCODE_DIR, "ai-activity-opencode.py"), fill(FILES["opencode.py"], url, key), 0o600)
    plugins = os.path.join(OPENCODE_DIR, "plugins")
    changed = write(os.path.join(plugins, "ai-activity.js"), FILES["opencode-plugin.js"]) or changed
    say(f"OpenCode: {'installed' if changed else 'already up to date'} (plugin in {plugins})")
    if WINDOWS and not shutil.which("python"):
        say("warning: OpenCode's plugin runs `python`, which is not on the PATH")
    return True


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never send the device key anywhere but the server named.
    def redirect_request(self, *args, **kwargs):
        return None


def redirected(url, e):
    """A redirect is fatal: the collectors POST, and urllib follows no
    redirect of a POST, so every upload to this URL would fail."""
    if 300 <= e.code < 400:
        fail(f"{url} redirects to {e.headers.get('Location') or 'another address'}: "
             "set AI_ACTIVITY_URL to the server's final address (https://...), then run this again")


def check(url, key):
    """The server answers and takes the key (an empty batch stores nothing)."""
    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(url + "/api/health", timeout=15).read()
    except urllib.error.HTTPError as e:
        redirected(url, e)
        say(f"warning: {url} answered {e.code}; the collectors will retry later")
        return
    except (urllib.error.URLError, OSError) as e:
        say(f"warning: {url} does not answer ({e}); the collectors will retry later")
        return
    req = urllib.request.Request(url + "/api/ingest/claude-code", data=b"{}", headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        opener.open(req, timeout=15).read()
        say(f"{url} accepts this device key")
    except urllib.error.HTTPError as e:
        redirected(url, e)
        if e.code == 401:
            fail("the server refused this device key (unknown or revoked): copy it again from Settings > Devices")
        say(f"warning: key check answered {e.code}; the collectors will retry later")
    except (urllib.error.URLError, OSError) as e:
        say(f"warning: key check failed ({e})")


def main():
    url = os.environ.get("AI_ACTIVITY_URL", "").strip().rstrip("/")
    key = os.environ.get("AI_ACTIVITY_KEY", "").strip()
    if not re.fullmatch(r"https?://[A-Za-z0-9.\-]+(:[0-9]+)?(/[A-Za-z0-9._~\-/]*)?", url):
        fail("set AI_ACTIVITY_URL to the server, e.g. https://ai.example.com")
    if not re.fullmatch(r"ak_[0-9a-f]{32}", key):
        fail("set AI_ACTIVITY_KEY to a device key (Settings > Devices > Copy key)")
    if hasattr(os, "geteuid") and os.geteuid() == 0 and os.environ.get("AI_ACTIVITY_ALLOW_ROOT") != "1":
        fail("running as root: install as the user who runs the tools (no sudo), "
             "or set AI_ACTIVITY_ALLOW_ROOT=1 if root really runs them")

    wanted = os.environ.get("AI_ACTIVITY_TOOLS")
    if wanted:
        tools = [t.strip() for t in wanted.split(",") if t.strip()]
        unknown = [t for t in tools if t not in TOOLS]
        if unknown:
            fail(f"unknown tool {', '.join(unknown)}; choose from {', '.join(TOOLS)}")
    else:
        tools = [t for t in TOOLS if present(t)]
        if not tools:
            fail("no Claude Code, Codex, Antigravity or OpenCode found in " + HOME +
                 "; set AI_ACTIVITY_TOOLS=" + ",".join(TOOLS) + " to install anyway")

    preflight(tools)
    check(url, key)
    install = {"claude-code": install_claude, "codex": install_codex,
               "antigravity": install_antigravity, "opencode": install_opencode}
    done = [t for t in TOOLS if t in tools and install[t](url, key)]
    if "claude-code" in done:
        say("Claude Code: restart it (or review the hooks in /hooks), then usage is sent during and after every turn")
    if "codex" in done:
        say("Codex: review the new hooks once with /hooks, then they run during and after every turn")
    if "antigravity" in done:
        say("Antigravity: restart it and check that the ai-activity hook is enabled (/hooks)")
    if "opencode" in done:
        say("OpenCode: restart it to load the plugin")


if __name__ == "__main__":
    main()
