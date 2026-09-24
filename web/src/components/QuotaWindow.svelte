<script lang="ts">
  import { clock } from "../lib/clock.svelte.ts";
  import { fmtDuration, fmtPct } from "../lib/format.ts";
  import type { QuotaWindowVM } from "../lib/view-model.ts";

  let { w, tone }: { w: QuotaWindowVM; tone: "claude" | "codex" } = $props();

  const left = $derived(w.resetsAt === null ? null : w.resetsAt - clock.now);
  // Once the reset time passes, the old percentage no longer applies.
  const expired = $derived(left !== null && left <= 0);
  const pct = $derived(expired ? null : w.pct);
  const elapsed = $derived(left === null || expired ? null : Math.max(0, Math.min(w.spanSec, w.spanSec - left)));
  const elapsedPct = $derived(elapsed === null ? null : (elapsed / w.spanSec) * 100);
  const fill = $derived(pct === null ? 0 : Math.max(0, Math.min(100, pct)));

  // Where we are in the window: only in the marker's tooltip, since the
  // footer's reset countdown already implies it.
  const position = $derived.by(() => {
    if (elapsed === null) return "";
    if (w.spanSec >= 86400) return `Day ${Math.min(7, Math.floor(elapsed / 86400) + 1)} of ${w.spanSec / 86400}`;
    return `${fmtDuration(elapsed)} of ${fmtDuration(w.spanSec)}`;
  });
  const reset = $derived(
    w.pct === null && w.resetsAt === null ? "Unavailable"
      : expired ? "Window reset · waiting for a new snapshot"
        : left === null ? "Reset time not provided"
          : `Resets in ${fmtDuration(left)}`
  );
</script>

<div class="window">
  <div class="top">
    <span>{w.label}</span>
    <strong class="num">{pct === null ? "Unavailable" : `${fmtPct(pct)} %`}</strong>
  </div>
  <div class="track" role={pct === null ? undefined : "progressbar"} aria-label="{w.label} used"
    aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct === null ? undefined : Math.round(fill)}>
    <div class="fill {tone}" class:high={fill >= 85} style:width="{fill}%"></div>
    {#if elapsedPct !== null}
      <div class="mark" style:left="{elapsedPct}%" title="{position} elapsed"></div>
    {/if}
  </div>
  <div class="foot">{reset}</div>
</div>

<style>
  .top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 9px; }
  .top strong { font-weight: 500; }
  .track { position: relative; height: 6px; background: var(--track); border-radius: 10px; }
  .fill { height: 100%; border-radius: 10px; }
  .fill.claude { background: var(--claude); }
  .fill.codex { background: var(--codex); }
  .fill.high { background: var(--warn); }
  /* Time elapsed in the window: fill past this mark = spending faster than time passes. */
  .mark { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--text); box-shadow: 0 0 0 2px var(--surface); }
  .foot { margin-top: 9px; font-size: 12px; color: var(--muted); }
</style>
