// Accounts follow their GitHub account (issue #127): the username is the
// GitHub login, the name and picture GitHub's, updated at each sign-in.
import { findUserByUsername, getUser, setGithubProfile, setUsername } from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import type { GithubUser } from "./github.ts";

/**
 * Frees `login` for the account `self` (null: a new account). Another
 * account holding it is stale (its GitHub user was renamed and GitHub gave
 * the login to someone else): it moves to the first free "<name>-<id>",
 * "<name>-<id>-2"… until it signs in again. Run inside a transaction.
 */
export function claimLogin(db: DB, login: string, self: number | null): void {
  const holder = findUserByUsername(db, login);
  if (!holder || holder.id === self) return;
  const base = `${holder.username}-${holder.id}`;
  let name = base;
  for (let n = 2; findUserByUsername(db, name); n++) name = `${base}-${n}`;
  setUsername(db, holder.id, name);
}

/** The account takes its GitHub profile: the login as username, the name and picture. */
export function applyGithubProfile(db: DB, userId: number, gh: GithubUser): void {
  db.transaction(() => {
    if (!getUser(db, userId)) return;
    claimLogin(db, gh.login, userId);
    setGithubProfile(db, userId, { username: gh.login, display_name: gh.name, avatar_url: gh.avatar_url });
  })();
}
