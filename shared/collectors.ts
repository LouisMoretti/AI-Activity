import type { Tool } from "./types.ts";

/**
 * The version of each collector in collectors/ (its VERSION constant), sent
 * in every payload as `collector: {name, version}`. Bump both on every
 * change to the collector's files (for OpenCode, opencode.py or its plugin),
 * even a compatible one: that is what tells a device it runs an old copy.
 * test/collector-versions.test.js fails when a file changed without a bump.
 * A post without it counts as version 0 (collectors from before versions).
 */
export const COLLECTOR_VERSIONS: Record<Tool, number> = {
  "claude-code": 4,
  codex: 3,
  cursor: 2,
  antigravity: 3,
  opencode: 2,
};

/**
 * The oldest collector the server still accepts, per tool: raise it only for
 * a breaking change. Older ones get 426 and keep their backlog (they only
 * advance their offsets once a post is accepted), which goes out once updated.
 */
export const MIN_COLLECTOR_VERSIONS: Record<Tool, number> = {
  "claude-code": 0,
  codex: 0,
  cursor: 0,
  antigravity: 0,
  opencode: 0,
};
