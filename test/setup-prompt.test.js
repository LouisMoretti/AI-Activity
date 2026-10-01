import { test } from "node:test";
import assert from "node:assert/strict";
import { setupPrompt } from "../web/src/lib/setup-prompt.ts";
import { installCommand } from "../web/src/lib/clipboard.ts";

test("AI setup prompt offers both unfiltered installers and explains their output", () => {
  const origin = "https://activity.example";
  const key = "ak_private_test_key";
  const prompt = setupPrompt(key, origin);

  assert.ok(prompt.includes(installCommand(key, "unix", origin)));
  assert.ok(prompt.includes(installCommand(key, "windows", origin)));
  assert.doesNotMatch(prompt, /AI_ACTIVITY_TOOLS=/);
  assert.match(prompt, /which operating system and shell/);
  assert.match(prompt, /automatically finds supported tools/);
  assert.match(prompt, /accepts this device key/);
  assert.match(prompt, /installed.*already up to date/);
  assert.match(prompt, /stdout and stderr/);
  assert.match(prompt, /Codex hooks with \/hooks/);
  assert.match(prompt, /Cursor's hook in Settings > Hooks/);
  assert.match(prompt, /quotas remain unavailable/);
  assert.match(prompt, /Never claim success from a partial or failed run/);
  assert.doesNotMatch(prompt, /https?:\/\/[^\s]+ak_private_test_key/);
});
