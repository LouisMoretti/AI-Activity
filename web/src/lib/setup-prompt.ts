import { installCommand } from "./clipboard.ts";

/** A reviewable prompt. The installer, not the page, detects the tools present. */
export function setupPrompt(key: string, origin: string): string {
  return `Set up AI Activity's collectors on this device. Check which operating system and shell this device uses, then run exactly one of these commands as the user who runs the AI tools (no sudo or administrator shell). If your environment is different from the device that needs collection, ask me where to run it. Python 3 is required.

Linux or macOS (sh):
${installCommand(key, "unix", origin)}

Windows (PowerShell):
${installCommand(key, "windows", origin)}

The installer automatically finds supported tools on this device: Claude Code, Codex, Cursor, Antigravity and OpenCode. Do not set AI_ACTIVITY_TOOLS or choose collectors in advance. Review the installer script from ${origin} if needed before running it. Preserve existing settings and hooks. If a configuration file is invalid, explain the problem and ask before changing it. The installer is safe to rerun.

The device key is an ingestion credential. Keep it in local collector configuration and send it only to this dashboard's ingest endpoint. Never put it in a URL, print it in your response, commit it, or send it to another service. Do not quote either command in your response because both contain the key.

Read the installer's stdout and stderr, then explain what actually happened in plain language:
- Installer messages start with "ai-activity:". A line saying the server "accepts this device key" means the connection and key check passed; a warning about reachability or the key check means collection may retry later, so do not claim the connection was verified.
- For every detected tool, report whether its line says "installed" or "already up to date". Mention any tool that was not detected only if relevant to my setup. If it says no supported tool was found, explain that nothing was installed and ask me what is present before forcing an install.
- Explain each follow-up line for the tools actually installed: restart Claude Code, Antigravity or OpenCode when requested; review Codex hooks with /hooks; check Cursor's hook in Settings > Hooks. If Claude Code already has another statusLine, explain that token collection works but AI Activity quotas remain unavailable unless I choose to replace it. Antigravity quota collection stays off unless I opt in.
- Call out warnings and errors, especially a missing Python 3, invalid configuration, a refused key or a failed install. State what needs my action. Verify installed hooks or plugins without echoing the key or posting fake usage, and summarize what you checked. Never claim success from a partial or failed run.`;
}
