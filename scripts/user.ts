// Manage viewer accounts from the server machine:
//   npm run user -- add <username> [--admin] [--name "Display name"]
//   npm run user -- passwd <username>
//   npm run user -- list
// The password is read from a hidden prompt, or from stdin when piped.
import { createInterface } from "node:readline";
import { loadConfig } from "../server/config.ts";
import {
  accountsExist, createAccount, deleteUserSessions, findUserByUsername, listUsers, setPasswordHash,
} from "../server/db/queries.ts";
import { openDb } from "../server/db/schema.ts";
import { hashPassword, passwordProblem, usernameProblem } from "../server/lib/passwords.ts";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.split(/\r?\n/)[0];
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Echo nothing while the password is typed.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  process.stdout.write(prompt);
  const answer = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function newPassword(): Promise<string> {
  const password = await readPassword("Password: ");
  const problem = passwordProblem(password);
  if (problem) fail(problem);
  if (process.stdin.isTTY && (await readPassword("Repeat: ")) !== password) fail("passwords do not match");
  return hashPassword(password);
}

const [cmd, username, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const option = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] ?? null : null;
};

const db = openDb(loadConfig().dbPath);

if (cmd === "add") {
  const problem = usernameProblem(username);
  if (problem) fail(problem);
  if (findUserByUsername(db, username)) fail(`user "${username}" already exists`);
  const first = !accountsExist(db);
  const id = createAccount(db, {
    username,
    display_name: option("--name"),
    password_hash: await newPassword(),
    // The first account owns the existing data and must be able to manage it.
    is_admin: first || flag("--admin"),
  });
  console.log(`Account "${username}" created (#${id}${first || flag("--admin") ? ", admin" : ""}).`);
  if (first) console.log("It owns the existing data; the dashboard now requires a login.");
} else if (cmd === "passwd") {
  const user = username ? findUserByUsername(db, username) : null;
  if (!user) fail(`no user "${username ?? ""}"`);
  setPasswordHash(db, user.id, await newPassword());
  deleteUserSessions(db, user.id);
  console.log(`Password changed for "${user.username}"; its sessions were signed out.`);
} else if (cmd === "list") {
  for (const u of listUsers(db)) {
    console.log(`#${u.id} ${u.username}${u.is_admin ? " (admin)" : ""}${u.disabled ? " [disabled]" : ""}`);
  }
} else {
  fail("usage: npm run user -- add <username> [--admin] [--name \"Display name\"] | passwd <username> | list");
}
db.close();
