// A random id for site analytics, kept in this browser for 13 months
// (then replaced): it tells returning visitors apart without the IP
// address. Never sent anywhere but /api/analytics, never a cookie, and the
// server stores only an HMAC of it.
const KEY = "ai-activity:visitor";
const LIFETIME_MS = 395 * 86400_000;

/** This browser's id, or null when storage is unavailable (the server then falls back to a daily hash). */
export function visitorId(now = Date.now()): string | null {
  try {
    let saved: { id?: unknown; created?: unknown } | null = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { /* damaged: replaced below */ }
    if (saved && typeof saved.id === "string" && /^[0-9a-f]{32}$/.test(saved.id)
      && typeof saved.created === "number" && now - saved.created < LIFETIME_MS && saved.created <= now) return saved.id;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(KEY, JSON.stringify({ id, created: now }));
    return id;
  } catch {
    return null;
  }
}

const SIGN_IN_KEY = "ai-activity:signing-in";
/** A sign-in round trip takes at most the server's 10-minute state lifetime. */
const SIGN_IN_MS = 10 * 60_000;

/**
 * Called before leaving for a sign-in provider (its host name): the next
 * page view is its return, not a referral. The host is kept here because
 * the return has no referrer (the callback's redirect is `no-referrer`).
 */
export function markSignIn(provider: string, now = Date.now()): void {
  try { sessionStorage.setItem(SIGN_IN_KEY, JSON.stringify({ at: now, provider })); } catch { /* no storage: counted as a referral */ }
}

/** The provider's host, once, if this page load is the return from a sign-in started in this tab; else null. */
export function takeSignIn(now = Date.now()): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SIGN_IN_KEY) ?? "null") as { at?: unknown; provider?: unknown } | null;
    sessionStorage.removeItem(SIGN_IN_KEY);
    const at = typeof saved?.at === "number" ? saved.at : 0;
    if (!(at > 0 && now - at >= 0 && now - at < SIGN_IN_MS)) return null;
    return typeof saved?.provider === "string" ? saved.provider : "";
  } catch {
    return null;
  }
}
