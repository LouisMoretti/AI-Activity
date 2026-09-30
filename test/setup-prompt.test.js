import { test } from "node:test";
import assert from "node:assert/strict";
import { setupPrompt } from "../web/src/lib/setup-prompt.ts";

const origin = "https://activity.example";
const key = "ak_private_test_key";

test("AI setup prompt selects only requested collectors and keeps the key out of URLs", () => {
  const prompt = setupPrompt(key, "unix", ["codex", "opencode"], origin);
  assert.match(prompt, /AI_ACTIVITY_TOOLS=codex,opencode sh/);
  assert.match(prompt, /AI_ACTIVITY_KEY=ak_private_test_key/);
  assert.match(prompt, /https:\/\/activity\.example\/install\.sh/);
  assert.doesNotMatch(prompt, /Claude Code:|Antigravity:/);
  assert.match(prompt, /Codex \/hooks/);
  assert.match(prompt, /restart OpenCode/);
  assert.match(prompt, /Preserve my existing settings/);
  assert.match(prompt, /Never put it in a URL, print it in your response/);
  assert.doesNotMatch(prompt, /https?:\/\/[^\s]+ak_private_test_key/);
});

test("Windows prompt uses PowerShell and refuses an empty selection", () => {
  const prompt = setupPrompt(key, "windows", ["antigravity"], origin);
  assert.match(prompt, /Windows \(PowerShell\)/);
  assert.match(prompt, /\$env:AI_ACTIVITY_TOOLS="antigravity"; irm https:\/\/activity\.example\/install\.ps1 \| iex/);
  assert.match(prompt, /quota collection off/);
  assert.throws(() => setupPrompt(key, "unix", [], origin), /Select at least one tool/);
});
