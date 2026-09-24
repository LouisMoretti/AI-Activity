const compact = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" });
const plain = new Intl.NumberFormat("en-US");

export const fmtCompact = (n: number) => compact.format(n);
export const fmtNum = (n: number) => plain.format(n);
export const fmtMoney = (n: number, currency = "USD") =>
  `${currency} ${plain.format(Math.round(n * 100) / 100)}`;

export const fmtDateTime = (sec: number) => new Date(sec * 1000).toLocaleString("en-US");

/** "YYYY-MM-DD" (UTC bucket) → "September 24, 2026". */
export const fmtDay = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

export const monthShort = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
