import { TOOLS, type Tool } from "../../../shared/types.ts";
import type { Platform } from "./clipboard.ts";

const names: Record<Tool, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
};

const followUp: Record<Tool, string> = {
  "claude-code": "Restart Claude Code. If it already has a statusLine, leave it in place and explain that AI Activity quotas will stay unavailable unless I choose to replace it.",
  codex: "Tell me to review and trust the new hooks once with Codex /hooks.",
  antigravity: "Tell me to restart Antigravity and check that the ai-activity hook is enabled. Leave quota collection off unless I ask for it.",
  opencode: "Tell me to restart OpenCode so its plugin loads.",
};

/** Text reviewed by the owner before it can enter the clipboard. */
export function setupPrompt(key: string, platform: Platform, selected: readonly Tool[], origin: string): string {
  const tools = TOOLS.filter((tool) => selected.includes(tool));
  if (!tools.length) throw new Error("Select at least one tool.");
  const list = tools.join(",");
  const command = platform === "windows"
    ? `$env:AI_ACTIVITY_URL="${origin}"; $env:AI_ACTIVITY_KEY="${key}"; $env:AI_ACTIVITY_TOOLS="${list}"; irm ${origin}/install.ps1 | iex`
    : `curl -fsSL ${origin}/install.sh | AI_ACTIVITY_URL=${origin} AI_ACTIVITY_KEY=${key} AI_ACTIVITY_TOOLS=${list} sh`;
  return `Set up AI Activity's collectors on this ${platform === "windows" ? "Windows (PowerShell)" : "Linux/macOS"} device for ${tools.map((tool) => names[tool]).join(", ")} only.

Dashboard server: ${origin}
Run the following command as my normal user, without sudo or an administrator shell. It needs Python 3. Review the installer script from ${origin} if needed before running it. The key is an ingestion credential: keep it in local collector configuration and send it only to this dashboard's ingest endpoint. Never put it in a URL, print it in your response, commit it, or send it to another service.

${command}

Preserve my existing settings and hooks. Do not replace unrelated configuration or install collectors for unselected tools. If a configuration file is invalid, explain the problem and ask me before changing it. The installer merges settings and is safe to rerun; inspect its output and verify that each selected collector and its hook or plugin was installed. Verify without echoing the key or posting test activity that would be mistaken for real usage. Report what you checked and any remaining manual steps without quoting the command or credential.

${tools.map((tool) => `- ${names[tool]}: ${followUp[tool]}`).join("\n")}`;
}
