import { TOOLS, type PreviewSeedConfig, type Tool } from "../../shared/types.ts";

export const DEFAULT_PREVIEW_SEED: PreviewSeedConfig = {
  days: 60,
  events_per_day: 2,
  tools: [...TOOLS],
  models: ["claude-sonnet-4", "gpt-5", "gemini-2.5-pro", "claude-opus-4"],
  input_tokens: 1200,
  output_tokens: 400,
  cache_read_tokens: 500,
  cache_write_tokens: 100,
};

/** Reject unexpected fields too: typos in edited JSON must not be silently ignored. */
export function parsePreviewSeed(value: unknown): PreviewSeedConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings must be a JSON object");
  const v = value as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_PREVIEW_SEED);
  if (Object.keys(v).some((key) => !keys.includes(key))) throw new Error("unknown sample setting");
  const integer = (key: keyof PreviewSeedConfig, min: number, max: number): number => {
    const n = v[key];
    if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) {
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    }
    return n as number;
  };
  const days = integer("days", 1, 365);
  const events_per_day = integer("events_per_day", 1, 20);
  if (days * events_per_day > 5000) throw new Error("at most 5000 events can be generated");
  const tools = v.tools;
  if (!Array.isArray(tools) || !tools.length || tools.length > TOOLS.length ||
      tools.some((tool) => typeof tool !== "string" || !TOOLS.includes(tool as Tool)) ||
      new Set(tools).size !== tools.length) throw new Error("tools must be a nonempty list of distinct supported tools");
  const models = v.models;
  if (!Array.isArray(models) || !models.length || models.length > 16 ||
      models.some((model) => typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,79}$/.test(model)) ||
      new Set(models).size !== models.length) throw new Error("models must be 1 to 16 distinct model names");
  return {
    days, events_per_day, tools: tools as Tool[], models: models as string[],
    input_tokens: integer("input_tokens", 0, 1000000),
    output_tokens: integer("output_tokens", 0, 1000000),
    cache_read_tokens: integer("cache_read_tokens", 0, 1000000),
    cache_write_tokens: integer("cache_write_tokens", 0, 1000000),
  };
}
