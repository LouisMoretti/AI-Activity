<script lang="ts">
  import { fmtNum } from "../lib/format.ts";

  let { values, kind, demo }: { values: number[]; kind: "weekly" | "cumulative"; demo: boolean } = $props();

  const W = 760;
  const max = $derived(Math.max(1, ...values));
  const n = $derived(Math.max(1, values.length));
  const y = (v: number) => 103 - (v / max) * 95;
  const line = $derived(values.map((v, i) => `${i ? "L" : "M"}${(i / Math.max(1, n - 1)) * (W - 4) + 2},${y(v)}`).join(" "));
</script>

<svg viewBox="0 0 {W} 110" preserveAspectRatio="none" role="img"
  aria-label="{kind === 'weekly' ? 'Weekly' : 'Cumulative'} tokens, {demo ? 'demonstration' : 'measured'} data">
  <path d="M0 108H{W} M0 55H{W} M0 7H{W}" stroke="var(--line)" stroke-dasharray="3 5" fill="none" />
  {#if kind === "weekly"}
    {#each values as v, i (i)}
      <rect x={(i / n) * W + 2} y={y(v)} width={W / n - 4} height={(v / max) * 95} rx="2" fill="var(--heat-3)">
        <title>Week {i + 1}: {fmtNum(v)} tokens{demo ? " (fictional)" : ""}</title>
      </rect>
    {/each}
  {:else}
    <path d="{line} L{W - 2},108 L2,108 Z" fill="var(--accent)" opacity=".09" />
    <path d={line} stroke="var(--accent)" stroke-width="2" fill="none" />
  {/if}
</svg>

<style>
  svg { display: block; width: 760px; max-width: 100%; height: 110px; }
</style>
