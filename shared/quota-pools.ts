import type { Tool } from "./types.ts";

/** Length of each quota window type, in seconds. */
export const QUOTA_WINDOW_SEC = { five_hour: 5 * 3600, seven_day: 7 * 86400 } as const;
export type QuotaWindowType = keyof typeof QUOTA_WINDOW_SEC;

/**
 * Tools with independent quota pools, one `account_ref` each (never summed).
 * The server records quotas only for these refs; collectors/antigravity.py
 * sends the same ids (its POOLS constant).
 */
export const QUOTA_POOLS = {
  antigravity: ["gemini", "claude-gpt"],
} as const satisfies Partial<Record<Tool, readonly string[]>>;
