const compact = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });
const plain = new Intl.NumberFormat("en-US");

export const fmtCompact = (n: number) => compact.format(n);
export const fmtNum = (n: number) => plain.format(n);
export const fmtPct = (n: number) => `${Math.round(n * 10) / 10}`;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "YYYY-MM-DD" (UTC bucket) → "24 September 2026". */
export const fmtDay = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

export const monthShort = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

/** Seconds → "2 d 3 h", "3 h 33 min", "12 min", "<1 min". */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return m ? `${m} min` : "<1 min";
}

export function fmtAgo(then: number, now: number): string {
  const s = now - then;
  if (s < 60) return "just now";
  return `${fmtDuration(s)} ago`;
}

/** Activity within this many seconds counts as "recent" (green dot). */
export const RECENT_SEC = 10 * 60;
