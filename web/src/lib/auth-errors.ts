// Why a GitHub sign-in failed: the server sends the browser back with
// ?auth_error=<code> (routes/auth.ts, AuthError), and the page says it in
// words. Only these codes are shown: a link cannot put its own text here.
const MESSAGES: Record<string, string> = {
  denied: "GitHub sign-in was cancelled.",
  expired: "That sign-in expired or was started in another browser. Try again.",
  github: "GitHub could not be reached or refused the sign-in. Try again.",
  disabled: "This account is disabled.",
  setup: "No account exists yet: the first one needs the setup code from the server log.",
  exists: "An account already exists: sign in instead.",
  closed: "Account creation is closed on this server: only existing accounts can sign in.",
  too_many: "Too many accounts were created from here. Try again later.",
  taken: "Your GitHub login is the username of an account not linked to GitHub yet: an admin links it (npm run user -- link).",
  other_account: "That GitHub account is not the one signed in here: sign in again with this account's GitHub account.",
};

/** The message for an auth_error code, or null for an unknown one. */
export function authErrorMessage(code: string | null): string | null {
  return code !== null && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : null;
}
