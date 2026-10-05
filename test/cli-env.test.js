// The environment real CLIs get in the smoke tests (test/real-cli-smoke.mjs).
// Run by npm test, so it holds on every platform without the CLIs installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeEnv } from "./cli-env.mjs";

test("real CLI child environment excludes inherited provider settings", () => {
  assert.deepEqual(runtimeEnv({
    PATH: "/test/bin", ANTHROPIC_AUTH_TOKEN: "private", GOOGLE_API_KEY: "private",
    AWS_ACCESS_KEY_ID: "private", OPENAI_BASE_URL: "https://example.invalid",
  }), { PATH: "/test/bin" });
});
