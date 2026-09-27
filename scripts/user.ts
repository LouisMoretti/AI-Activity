// Manage viewer accounts from the server machine. Accounts sign in with
// GitHub (issue #127); these commands link them to a GitHub account:
//   npm run user -- add <github-login> [--admin] [--id <github id>]
//   npm run user -- link <username> <github-login> [--id <github id>]
//   npm run user -- list
// The GitHub account is looked up by login on GitHub's public API, unless
// --id gives its numeric id (offline). Name and picture come at sign-in.
import { loadConfig } from "../server/config.ts";
import {
  accountsExist, createAccount, findUserByGithubId, findUserByUsername, listUsers, setGithubId,
} from "../server/db/queries.ts";
import { openDb } from "../server/db/schema.ts";
import { GITHUB_LOGIN, lookupLogin, type GithubUser } from "../server/lib/github.ts";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const USAGE = "usage: npm run user -- add <github-login> [--admin] [--id <github id>]"
  + " | link <username> <github-login> [--id <github id>] | list";

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

if (cmd === "add") {
  const gh = await github(positional[0]);
  if (findUserByGithubId(db, gh.id)) fail(`GitHub account "${gh.login}" is already linked to an account`);
  if (findUserByUsername(db, gh.login)) fail(`user "${gh.login}" already exists: link it instead`);
  const first = !accountsExist(db);
  const id = createAccount(db, {
    username: gh.login,
    display_name: gh.name,
    avatar_url: gh.avatar_url,
    github_id: gh.id,
    // The first account owns the existing data and must be able to manage it.
    is_admin: first || flag("--admin"),
  });
  console.log(`Account "${gh.login}" created (#${id}${first || flag("--admin") ? ", admin" : ""}): it signs in with GitHub.`);
  if (first) console.log("It owns the existing data; the dashboard now requires a sign-in.");
} else if (cmd === "link") {
  const user = positional[0] ? findUserByUsername(db, positional[0]) : null;
  if (!user) fail(`no user "${positional[0] ?? ""}"`);
  const gh = await github(positional[1]);
  const holder = findUserByGithubId(db, gh.id);
  if (holder && holder.id !== user.id) fail(`GitHub account "${gh.login}" is already linked to "${holder.username}"`);
  setGithubId(db, user.id, gh.id);
  console.log(`"${user.username}" is linked to GitHub "${gh.login}": it signs in with GitHub, and its username follows the login from then on.`);
} else if (cmd === "list") {
  for (const u of listUsers(db)) {
    const tags = [u.is_admin ? "admin" : "", u.disabled ? "disabled" : "", u.github_id === null ? "not linked to GitHub" : ""];
    console.log(`#${u.id} ${u.username}${tags.filter(Boolean).map((t) => ` [${t}]`).join("")}`);
  }
} else {
  fail(USAGE);
}
db.close();
