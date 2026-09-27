#!/usr/bin/env python3
"""AI Activity one-command install (see README.md, "One-command install").

Served by the server as /install.sh, with the collectors embedded below
(FILES), and run on a device:

    curl -fsSL <server>/install.sh | AI_ACTIVITY_URL=<server> AI_ACTIVITY_KEY=<device key> sh

Installs the collectors of the tools found on this machine (or those listed
in AI_ACTIVITY_TOOLS, e.g. "claude-code,codex"), with the server URL and
device key filled in. The key comes from the environment, never from a URL.
Existing ~/.claude/settings.json and ~/.codex/hooks.json keep their other
entries; running it again only updates what changed.
"""
import json
import os
import re
import shutil
import stat
import sys
import urllib.error
import urllib.request

# Replaced by the server: {"statusline": ..., "codex.py": ..., "opencode.py": ..., "opencode-plugin.js": ...}
FILES = {}

TOOLS = ("claude-code", "codex", "opencode")
HOME = os.path.expanduser("~")
CODEX_HOME = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
OPENCODE_DIR = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "opencode")
CODEX_HOOK = "setsid -f python3 {} >/dev/null 2>&1 </dev/null; echo '{{}}'"


def fail(msg):
    print("ai-activity: " + msg, file=sys.stderr)
    sys.exit(1)


def say(msg):
    print("ai-activity: " + msg)


def fill(text, url, key):
    return text.replace("<server>", url).replace("<device key>", key)


def write(path, content, mode=None):
    """Write only if different; returns True when the file changed."""
    try:
        with open(path, encoding="utf-8") as f:
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
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
    if mode is None and os.path.exists(path):
        shutil.copymode(path, tmp)
    elif mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)
    return True


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
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


def present(tool):
    on_path = lambda name: shutil.which(name) is not None
    if tool == "claude-code":
        return on_path("claude") or os.path.isdir(os.path.join(HOME, ".claude"))
    if tool == "codex":
        return on_path("codex") or os.path.isdir(CODEX_HOME)
    return on_path("opencode") or os.path.isdir(OPENCODE_DIR)


def install_claude(url, key):
    path = os.path.join(HOME, ".claude", "settings.json")
    settings = load_json(path)
    command = fill(FILES["statusline"], url, key)
    current = settings.get("statusLine")
    other = isinstance(current, dict) and "ai-activity" not in str(current.get("command", ""))
    if current and other and os.environ.get("AI_ACTIVITY_FORCE") != "1":
        say(f"Claude Code: skipped, {path} already has another statusLine. "
            "AI_ACTIVITY_FORCE=1 replaces it (Claude Code runs one status line).")
        return False
    settings["statusLine"] = {"type": "command", "command": command}
    changed = write(path, dump(settings))
    say(f"Claude Code: {'statusLine set in' if changed else 'already up to date:'} {path}")
    return True


def install_codex(url, key):
    script = os.path.join(CODEX_HOME, "ai-activity-codex.py")
    changed = write(script, fill(FILES["codex.py"], url, key), 0o600)
    path = os.path.join(CODEX_HOME, "hooks.json")
    config = load_json(path)
    hooks = config.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        fail(f"{path}: \"hooks\" is not an object: fix it, then run this again")
    # ~ in the command, like the README, when Codex lives in the default place.
    shown = "~/.codex/ai-activity-codex.py" if CODEX_HOME == os.path.join(HOME, ".codex") else script
    ours = {"hooks": [{"type": "command", "command": CODEX_HOOK.format(shown), "timeout": 10}]}
    for event in ("Stop", "UserPromptSubmit"):
        entries = hooks.get(event)
        entries = entries if isinstance(entries, list) else []
        # Drop our earlier entries (any path), keep everyone else's.
        kept = [e for e in entries if "ai-activity-codex.py" not in json.dumps(e)]
        hooks[event] = kept + [ours]
    changed = write(path, dump(config)) or changed
    say(f"Codex: {'installed' if changed else 'already up to date'} ({script}, hooks in {path})")
    return True


def install_opencode(url, key):
    changed = write(os.path.join(OPENCODE_DIR, "ai-activity-opencode.py"), fill(FILES["opencode.py"], url, key), 0o600)
    changed = write(os.path.join(OPENCODE_DIR, "plugins", "ai-activity.js"), FILES["opencode-plugin.js"]) or changed
    say(f"OpenCode: {'installed' if changed else 'already up to date'} (plugin in {OPENCODE_DIR}/plugins)")
    return True


def check(url, key):
    """The server answers and takes the key (an empty batch stores nothing)."""
    try:
        urllib.request.urlopen(url + "/api/health", timeout=15).read()
    except (urllib.error.URLError, OSError) as e:
        say(f"warning: {url} does not answer ({e}); the collectors will retry later")
        return
    req = urllib.request.Request(url + "/api/ingest/claude-code", data=b"{}", headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=15).read()
        say(f"{url} accepts this device key")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            fail("the server refused this device key (unknown or revoked): copy it again from Settings → Devices")
        say(f"warning: key check answered {e.code}; the collectors will retry later")
    except (urllib.error.URLError, OSError) as e:
        say(f"warning: key check failed ({e})")


def main():
    url = os.environ.get("AI_ACTIVITY_URL", "").rstrip("/")
    key = os.environ.get("AI_ACTIVITY_KEY", "")
    if not re.fullmatch(r"https?://[A-Za-z0-9.\-]+(:[0-9]+)?(/[A-Za-z0-9._~\-/]*)?", url):
        fail("set AI_ACTIVITY_URL to the server, e.g. https://ai.example.com")
    if not re.fullmatch(r"ak_[0-9a-f]{32}", key):
        fail("set AI_ACTIVITY_KEY to a device key (Settings → Devices → Copy key)")
    if os.geteuid() == 0 and os.environ.get("AI_ACTIVITY_ALLOW_ROOT") != "1":
        fail("running as root: install as the user who runs the tools (no sudo), "
             "or set AI_ACTIVITY_ALLOW_ROOT=1 if root really runs them")
    if not shutil.which("setsid"):
        say("warning: setsid (util-linux) is missing; the collectors need it")

    wanted = os.environ.get("AI_ACTIVITY_TOOLS")
    if wanted:
        tools = [t.strip() for t in wanted.split(",") if t.strip()]
        unknown = [t for t in tools if t not in TOOLS]
        if unknown:
            fail(f"unknown tool {', '.join(unknown)}; choose from {', '.join(TOOLS)}")
    else:
        tools = [t for t in TOOLS if present(t)]
        if not tools:
            fail("no Claude Code, Codex or OpenCode found in " + HOME +
                 "; set AI_ACTIVITY_TOOLS=claude-code,codex,opencode to install anyway")

    check(url, key)
    install = {"claude-code": install_claude, "codex": install_codex, "opencode": install_opencode}
    done = [t for t in tools if install[t](url, key)]
    if "codex" in done:
        say("Codex: review the new hook once with /hooks, then it runs after every turn")
    if "opencode" in done:
        say("OpenCode: restart it to load the plugin")
    if "claude-code" in done:
        say("Claude Code: usage is sent at the next status line refresh")


if __name__ == "__main__":
    main()
