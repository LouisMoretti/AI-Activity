import { createHash, randomInt, timingSafeEqual } from "node:crypto";

// No 0/O or 1/I/L: the code is read from a terminal and typed by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A one-time code like "K7QM-2XRB-9PTW" (about 60 bits), printed in the server log. */
export function newSetupCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const digest = (s: string) => createHash("sha256").update(normalize(s)).digest();

/** Case, spaces and dashes do not matter; compared in constant time. */
export function setupCodeMatches(expected: string, candidate: unknown): boolean {
  return typeof candidate === "string" && timingSafeEqual(digest(expected), digest(candidate));
}
