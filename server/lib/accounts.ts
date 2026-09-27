// Accounts follow their GitHub account (issue #127): the username is the
// GitHub login, the name and picture GitHub's. Shared by the sign-in
// routes and `npm run user -- link`.
import { findUserByUsername, getUser, setGithubProfile, setUsername } from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import type { GithubUser } from "./github.ts";

/**
 * Frees `login` for the account `self` (null: a new account), or false when
 * an account not linked to GitHub holds it (it keeps it: nothing proves it
 * is someone else's). A linked account holding it is stale (that GitHub
 * user was renamed and GitHub gave the login to someone else): it moves to
 * the first free "<name>-<id>", "<name>-<id>-2"… until it signs in again.
 * Run inside a transaction.
 */
export function claimLogin(db: DB, login: string, self: number | null): boolean {
  const holder = findUserByUsername(db, login);
  if (!holder || holder.id === self) return true;
  if (holder.github_id === null) return false;
  const base = `${holder.username}-${holder.id}`;
  let name = base;
  for (let n = 2; findUserByUsername(db, name); n++) name = `${base}-${n}`;
  setUsername(db, holder.id, name);
  return true;
}

/**
 * The account takes its GitHub profile: the login as username (unless an
 * account not linked to GitHub holds it: it keeps its own then), the name
 * and picture. Null name / picture from the CLI's offline --id mean
 * "unknown": they stay as they are until the next sign-in.
 */
export function applyGithubProfile(db: DB, userId: number, gh: GithubUser, { known = true } = {}): void {
  db.transaction(() => {
    const user = getUser(db, userId)!;
    const username = claimLogin(db, gh.login, userId) ? gh.login : user.username!;
    setGithubProfile(db, userId, {
      username,
      display_name: known ? gh.name : user.display_name,
      avatar_url: known ? gh.avatar_url : user.avatar_url,
    });
  })();
}
