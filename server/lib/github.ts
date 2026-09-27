// Sign in with GitHub (OAuth web flow, issue #127). The server exchanges the
// code itself and reads the public profile: no scope is asked for, and the
// token is dropped once the profile is read (never stored).
import { parseAvatarUrl } from "./avatar.ts";

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** https://github.com (the authorize and token endpoints). */
  webUrl: string;
  /** https://api.github.com. */
  apiUrl: string;
}

/** What an account takes from its GitHub account. */
export interface GithubUser {
  /** Numeric, stable: a login can be renamed and reused. */
  id: number;
  /** The login, which is the account's username. */
  login: string;
  /** GitHub's name, or null (the username is shown then). */
  name: string | null;
  /** An allowlisted picture link, or null. */
  avatar_url: string | null;
}

/** GitHub logins: letters, digits and single inner dashes, 39 characters at most. */
export const GITHUB_LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const NAME_MAX = 60;
const TIMEOUT_MS = 10_000;

/** The account fields from a GitHub user object, or null when it is not one. */
export function githubUser(v: unknown): GithubUser | null {
  const u = v as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown } | null;
  if (!u || typeof u !== "object") return null;
  if (!Number.isSafeInteger(u.id) || (u.id as number) <= 0) return null;
  if (typeof u.login !== "string" || !GITHUB_LOGIN.test(u.login)) return null;
  const name = typeof u.name === "string" ? u.name.trim().slice(0, NAME_MAX) : "";
  const avatar = parseAvatarUrl(typeof u.avatar_url === "string" ? u.avatar_url : null);
  return { id: u.id as number, login: u.login, name: name || null, avatar_url: "url" in avatar ? avatar.url : null };
}

/** Where to send the browser: GitHub asks the user to authorize this app. */
export function authorizeUrl(gh: GithubConfig, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: gh.clientId, redirect_uri: redirectUri, state, allow_signup: "true" });
  return `${gh.webUrl}/login/oauth/authorize?${q}`;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const r = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return r.json();
}

/** The user who authorized: code → token (server to server) → /user. */
export async function signedInUser(gh: GithubConfig, code: string, redirectUri: string): Promise<GithubUser> {
  const token = (await fetchJson(`${gh.webUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code, redirect_uri: redirectUri }),
  })) as { access_token?: unknown };
  if (typeof token?.access_token !== "string" || !token.access_token) throw new Error("GitHub gave no token");
  const user = githubUser(await fetchJson(`${gh.apiUrl}/user`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token.access_token}`, "user-agent": "ai-activity" },
  }));
  if (!user) throw new Error("GitHub gave no usable user");
  return user;
}

/** A public GitHub account by login (the CLI links accounts with it); null if there is none. */
export async function lookupLogin(apiUrl: string, login: string): Promise<GithubUser | null> {
  const r = await fetch(`${apiUrl}/users/${encodeURIComponent(login)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ai-activity" },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return githubUser(await r.json());
}
