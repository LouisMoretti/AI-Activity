// Viewer accounts, from the server machine. Accounts are only created by
// signing in with GitHub (the first one with the setup code, issue #127):
//   npm run user -- link <username> <github-login> [--id <github id>] [--force]
//   npm run user -- list
// link: an account from before GitHub sign-in, to the GitHub account it
// signs in with from then on (the only way: a session alone cannot link an
// account, it may be stolen). Its username becomes the GitHub login and its
// other sessions end. An account already linked to another GitHub account
// needs --force. The GitHub account is looked up by login on GitHub's
// public API, unless --id gives its numeric id (offline).
import { loadConfig } from "../server/config.ts";
import { deleteUserSessions, findUserByGithubId, findUserByUsername, listUsers, setGithubId } from "../server/db/queries.ts";
import { openDb } from "../server/db/schema.ts";
import { applyGithubProfile } from "../server/lib/accounts.ts";
import { GITHUB_LOGIN, lookupLogin, type GithubUser } from "../server/lib/github.ts";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const USAGE = "usage: npm run user -- link <username> <github-login> [--id <github id>] [--force] | list";

const [cmd, ...args] = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const flag = (name: string) => args.includes(name);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--id"));

/** The GitHub account behind a login: --id as given, else GitHub's public API. */
async function github(login: string | undefined): Promise<GithubUser> {
  if (!login || !GITHUB_LOGIN.test(login)) fail(`"${login ?? ""}" is not a GitHub login`);
  const id = option("--id");
  if (id !== null) {
    if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) fail("--id must be a GitHub numeric user id");
    return { id: Number(id), login, name: null, avatar_url: null };
  }
  const apiUrl = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
  let user: GithubUser | null;
  try {
    user = await lookupLogin(apiUrl, login);
  } catch (err) {
    fail(`could not reach GitHub (${(err as Error).message}): pass --id <github id> instead`);
  }
  if (!user) fail(`no GitHub account "${login}"`);
  return user;
}

const config = loadConfig();
const db = openDb(config.dbPath, config.backupDir);

if (cmd === "link") {
  const user = positional[0] ? findUserByUsername(db, positional[0]) : null;
  if (!user) fail(`no user "${positional[0] ?? ""}"`);
  const gh = await github(positional[1]);
  const holder = findUserByGithubId(db, gh.id);
  if (holder && holder.id !== user.id) fail(`GitHub account "${gh.login}" is already linked to "${holder.username}"`);
  if (user.github_id !== null && user.github_id !== gh.id && !flag("--force")) {
    fail(`"${user.username}" is already linked to another GitHub account: add --force to replace it`);
  }
  db.transaction(() => {
    setGithubId(db, user.id, gh.id);
    // Offline (--id): name and picture come at the next sign-in.
    applyGithubProfile(db, user.id, gh, { known: option("--id") === null });
    // Sessions from before (a stolen one included) end: it signs in with GitHub now.
    deleteUserSessions(db, user.id);
  })();
  const now = findUserByGithubId(db, gh.id)!;
  console.log(`"${now.username}" is linked to GitHub "${gh.login}" and signs in with GitHub; its other sessions were signed out.`);
  if (now.username !== gh.login) console.log(`(its username stays "${now.username}": "${gh.login}" is taken by an account not linked to GitHub)`);
} else if (cmd === "list") {
  for (const u of listUsers(db)) {
    const tags = [u.is_admin ? "admin" : "", u.disabled ? "disabled" : "", u.github_id === null ? "not linked to GitHub" : ""];
    console.log(`#${u.id} ${u.username}${tags.filter(Boolean).map((t) => ` [${t}]`).join("")}`);
  }
} else {
  fail(USAGE);
}
db.close();
