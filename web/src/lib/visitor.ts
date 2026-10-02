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
