export type MeterLevel = "normal" | "warning" | "danger";

/** Shared meter policy, based on the same rounded percentage exposed by ARIA. */
export function meterLevel(pct: number): MeterLevel {
  const rounded = Math.round(Math.max(0, Math.min(100, pct)));
  if (rounded >= 90) return "danger";
  if (rounded >= 70) return "warning";
  return "normal";
}
