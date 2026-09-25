import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockList } from "node:net";
import { defaultBackupDir } from "./db/schema.ts";
import { parseTrustProxy } from "./lib/client.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  port: number;
  dbPath: string;
  staticDir: string;
  backupDir: string;
  /** Reverse proxies whose X-Forwarded-For / -Proto are believed (TRUST_PROXY). */
  trustProxy: BlockList;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dbPath = env.DB_PATH || path.join(ROOT, "data", "dashboard.db");
  return {
    port: Number(env.PORT || 3000),
    dbPath,
    staticDir: env.STATIC_DIR || path.join(ROOT, "web", "dist"),
    // Next to the database by default (the same volume in Docker): copy it
    // off the machine too (AGENTS.md, Backups).
    backupDir: env.BACKUP_DIR || defaultBackupDir(dbPath),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
