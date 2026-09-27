import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";

/**
 * /install.sh: collectors/install.py with every collector embedded, so a
 * device needs one download and no checkout of the repo. The Claude Code
 * statusLine comes from README.md, the copy the collector tests run.
 * The server URL and device key are never in it: the device passes them
 * as environment variables.
 */
export function buildInstaller(root = ROOT): string {
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  const readme = read("README.md").match(/```json\n([\s\S]*?)\n```/);
  if (!readme) throw new Error("README.md: statusLine block not found");
  const files = {
    statusline: (JSON.parse(`{${readme[1]}}`) as { statusLine: { command: string } }).statusLine.command,
    "codex.py": read("collectors/codex.py"),
    "opencode.py": read("collectors/opencode.py"),
    "opencode-plugin.js": read("collectors/opencode-plugin.js"),
  };
  const py = read("collectors/install.py").replace(/^FILES = \{\}$/m, () => `FILES = ${JSON.stringify(files)}`);
  if (py.includes("AI_ACTIVITY_INSTALL_PY")) throw new Error("installer delimiter clash");
  return [
    "#!/bin/sh",
    "# AI Activity: installs the collectors on this device (README.md, \"One-command install\").",
    "# curl -fsSL <server>/install.sh | AI_ACTIVITY_URL=<server> AI_ACTIVITY_KEY=<device key> sh",
    "command -v python3 >/dev/null 2>&1 || { echo 'ai-activity: python3 is required' >&2; exit 1; }",
    "exec python3 - <<'AI_ACTIVITY_INSTALL_PY'",
    py.trimEnd(),
    "AI_ACTIVITY_INSTALL_PY",
    "",
  ].join("\n");
}
