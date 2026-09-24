import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt cost: N=2^15, r=8 uses 32 MiB and a few tens of ms per login (OWASP
// suggests 2^17 / 128 MiB, too heavy for a small always-on box). The
// parameters are stored with each hash, so raising them later keeps old
// passwords valid.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key)));
}

/** "scrypt$N$r$p$salt$hash", salt and hash in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

// Verified against when the username is unknown, so a miss costs the same
// time as a wrong password and does not reveal which usernames exist.
const DUMMY = hashPassword(randomBytes(16).toString("hex"));

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? (await DUMMY)).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const expected = Buffer.from(parts[5], "base64url");
  const key = await derive(password, Buffer.from(parts[4], "base64url"), n, r, p);
  return stored !== null && key.length === expected.length && timingSafeEqual(key, expected);
}

/** An error message, or null when the password is acceptable. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) {
    return `password must be at least ${PASSWORD_MIN} characters`;
  }
  if (password.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

/** An error message, or null when the username is acceptable. */
export function usernameProblem(username: unknown): string | null {
  return typeof username === "string" && USERNAME.test(username)
    ? null
    : "username must be 2-32 letters, digits, dots, dashes or underscores, starting with a letter or digit";
}
