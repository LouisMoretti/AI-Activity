import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  port: number;
  dbPath: string;
  /** Only used to create the first account (see bootstrapAccounts). */
  viewerPassword: string;
  viewerUsername: string;
  staticDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT || 3000),
    dbPath: env.DB_PATH || path.join(ROOT, "data", "dashboard.db"),
    viewerPassword: env.DASHBOARD_PASSWORD || "",
    viewerUsername: env.DASHBOARD_USER || "admin",
    staticDir: env.STATIC_DIR || path.join(ROOT, "web", "dist"),
  };
}
