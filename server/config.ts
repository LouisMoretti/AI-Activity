import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockList } from "node:net";
import { defaultBackupDir } from "./db/schema.ts";
import { parseTrustProxy } from "./lib/client.ts";
import type { GithubConfig } from "./lib/github.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  port: number;
  dbPath: string;
  staticDir: string;
  backupDir: string;
  /** Reverse proxies whose X-Forwarded-For / -Proto are believed (TRUST_PROXY). */
  trustProxy: BlockList;
  /** Sign in with GitHub; null when GITHUB_CLIENT_ID / _SECRET are not set (nobody can sign in). */
  github: GithubConfig | null;
  /**
   * The public address (PUBLIC_URL), for the OAuth callback. Unset: the
   * request's own host and scheme (behind Caddy or a tunnel, that host).
   */
  publicUrl: string | null;
}

const trimUrl = (v: string | undefined) => (v?.trim() ? v.trim().replace(/\/+$/, "") : null);

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
    github: env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim()
      ? {
        clientId: env.GITHUB_CLIENT_ID.trim(),
        clientSecret: env.GITHUB_CLIENT_SECRET.trim(),
        // Overridden only by the tests (a fake GitHub).
        webUrl: trimUrl(env.GITHUB_URL) ?? "https://github.com",
        apiUrl: trimUrl(env.GITHUB_API_URL) ?? "https://api.github.com",
      }
      : null,
    publicUrl: trimUrl(env.PUBLIC_URL),
  };
}
