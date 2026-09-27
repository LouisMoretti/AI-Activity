import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.ts";

/** The collectors install.py embeds, by the names it reads them under. */
const COLLECTORS = ["claude-code.py", "codex.py", "antigravity.py", "opencode.py", "opencode-plugin.js"];

export interface Installers {
  /** /install.sh: Linux and macOS (`curl … | sh`). */
  sh: string;
  /** /install.ps1: Windows PowerShell (`irm … | iex`). */
  ps1: string;
}

/**
 * The one-command installs: collectors/install.py with every collector
 * embedded, so a device needs one download and no checkout of the repo,
 * wrapped for sh and for PowerShell. The server URL and device key are
 * never in them: the device passes them as environment variables.
 */
export function buildInstallers(root = ROOT): Installers {
  const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
  const files = Object.fromEntries(COLLECTORS.map((f) => [f, read(path.join("collectors", f))]));
  const py = read("collectors/install.py").replace(/^FILES = \{\}$/m, () => `FILES = ${JSON.stringify(files)}`);
  if (py.includes("AI_ACTIVITY_INSTALL_PY")) throw new Error("installer delimiter clash");
  const sh = [
    "#!/bin/sh",
    "# AI Activity: installs the collectors on this device (README.md, \"One-command install\").",
    "# curl -fsSL <server>/install.sh | AI_ACTIVITY_URL=<server> AI_ACTIVITY_KEY=<device key> sh",
    "command -v python3 >/dev/null 2>&1 || { echo 'ai-activity: python3 is required' >&2; exit 1; }",
    "exec python3 - <<'AI_ACTIVITY_INSTALL_PY'",
    py.trimEnd(),
    "AI_ACTIVITY_INSTALL_PY",
    "",
  ].join("\n");
  // PowerShell: the script travels as base64 (ASCII only, whatever the
  // console's code page) and runs from a temporary file. Run through iex,
  // so it never calls `exit`, which would close the user's window: a
  // failure throws (red in the window, non-zero from powershell -Command).
  const ps1 = [
    "# AI Activity: installs the collectors on this Windows device (README.md, \"One-command install\").",
    "# $env:AI_ACTIVITY_URL=\"<server>\"; $env:AI_ACTIVITY_KEY=\"<device key>\"; irm <server>/install.ps1 | iex",
    "& {",
    "  $python = $null",
    "  # python.exe, else the py launcher; the Store's python alias fails the version check.",
    "  foreach ($candidate in 'python', 'py -3', 'python3') {",
    "    $c = @($candidate -split ' ')",
    "    if (-not (Get-Command $c[0] -CommandType Application -ErrorAction SilentlyContinue)) { continue }",
    "    $rest = @($c | Select-Object -Skip 1)",
    "    try { & $c[0] @rest -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>$null | Out-Null } catch { continue }",
    "    if ($LASTEXITCODE -eq 0) { $python = $c; break }",
    "  }",
    "  if (-not $python) { throw 'ai-activity: Python 3 is required (https://www.python.org/downloads/windows/)' }",
    "  $file = Join-Path ([IO.Path]::GetTempPath()) ('ai-activity-install-' + [guid]::NewGuid().ToString('N') + '.py')",
    `  [IO.File]::WriteAllBytes($file, [Convert]::FromBase64String('${Buffer.from(py, "utf8").toString("base64")}'))`,
    "  try {",
    "    $rest = @($python | Select-Object -Skip 1)",
    "    & $python[0] @rest $file",
    "    if ($LASTEXITCODE -ne 0) { throw 'ai-activity: install failed (see above)' }",
    "  } finally {",
    "    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue",
    "    # The key stays in the installed collectors only, not in this session.",
    "    Remove-Item Env:AI_ACTIVITY_KEY -ErrorAction SilentlyContinue",
    "  }",
    "}",
    "",
  ].join("\r\n");
  return { sh, ps1 };
}
