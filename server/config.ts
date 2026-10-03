import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockList } from "node:net";
import { defaultBackupDir } from "./db/schema.ts";
import { parseTrustProxy } from "./lib/client.ts";
import { parseAllowedLogins, type GithubConfig } from "./lib/github.ts";
import { DEFAULT_LITELLM_URL } from "./lib/litellm.ts";

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
  /**
   * The only GitHub logins that may sign in (ALLOWED_GITHUB_LOGINS,
   * lowercase), or null for anyone. With a list, the first of them to sign
   * in becomes the admin: no setup code.
   */
  allowedLogins: ReadonlySet<string> | null;
  /** Only isolated PR previews expose sample data controls. */
  preview: boolean;
  /**
   * LiteLLM's model price list, the fallback for models the priority
   * pricing file lacks (LITELLM_PRICES_URL; empty: off), kept in `cacheFile`
   * next to the database.
   */
  litellm: { url: string | null; cacheFile: string };
}

const trimUrl = (v: string | undefined) => (v?.trim() ? v.trim().replace(/\/+$/, "") : null);

/** The root-installed preview Compose file can lag behind an image update. */
function isPreview(env: NodeJS.ProcessEnv): boolean {
  if (env.PREVIEW_MODE === "1") return true;
  const url = trimUrl(env.PUBLIC_URL);
  if (!url || env.TRUST_PROXY !== "172.29.95.0/24" || !env.ALLOWED_GITHUB_LOGINS?.trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /^pr-[1-9][0-9]*\.[a-z0-9.-]+$/i.test(parsed.hostname);
  } catch {
    return false;
  }
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
    allowedLogins: parseAllowedLogins(env.ALLOWED_GITHUB_LOGINS),
    preview: isPreview(env),
    litellm: {
      url: env.LITELLM_PRICES_URL === undefined ? DEFAULT_LITELLM_URL : env.LITELLM_PRICES_URL.trim() || null,
      cacheFile: path.join(path.dirname(dbPath), "litellm-prices.json"),
    },
  };
}
