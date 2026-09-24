import type { Config } from "../config.ts";
import { accountsExist, createAccount } from "../db/queries.ts";
import type { DB } from "../db/schema.ts";
import { hashPassword, passwordProblem, usernameProblem } from "./passwords.ts";

/**
 * Migration from the shared-password phase: with DASHBOARD_PASSWORD set and
 * no account yet, create an admin account (DASHBOARD_USER, default "admin")
 * with that password. It claims the existing data. Afterwards the variable
 * is ignored; passwords change through the dashboard or `npm run user`.
 * Returns the created username, or null.
 */
export async function bootstrapAccounts(db: DB, config: Config): Promise<string | null> {
  if (!config.viewerPassword || accountsExist(db)) return null;
  const problem = usernameProblem(config.viewerUsername);
  if (problem) throw new Error(`DASHBOARD_USER: ${problem}`);
  createAccount(db, {
    username: config.viewerUsername,
    display_name: null,
    password_hash: await hashPassword(config.viewerPassword),
    is_admin: true,
  });
  if (passwordProblem(config.viewerPassword)) {
    console.warn("DASHBOARD_PASSWORD is shorter than the account minimum; change it from the dashboard.");
  }
  return config.viewerUsername;
}
