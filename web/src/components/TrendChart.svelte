<script lang="ts">
  import { fmtNum } from "../lib/format.ts";

  let { values, kind, demo }: { values: number[]; kind: "weekly" | "cumulative"; demo: boolean } = $props();

  const max = $derived(Math.max(1, ...values));
  const n = $derived(Math.max(1, values.length));
  const y = (v: number) => 103 - (v / max) * 95;
  const line = $derived(values.map((v, i) => `${i ? "L" : "M"}${(i / Math.max(1, n - 1)) * 990},${y(v)}`).join(" "));
</script>

<svg viewBox="0 0 1000 110" preserveAspectRatio="none" role="img"
  aria-label="{kind === 'weekly' ? 'Weekly' : 'Cumulative'} consumption, {demo ? 'demonstration' : 'measured'} data">
  <path d="M0 108H1000 M0 55H1000 M0 7H1000" stroke="var(--line)" stroke-dasharray="3 5" />
  {#if kind === "weekly"}
    {#each values as v, i (i)}
      <rect x={(i / n) * 1000} y={y(v)} width="12" height={(v / max) * 95} rx="2" fill="var(--heat-3)">
        <title>Week {i + 1}: {fmtNum(v)} tokens{demo ? " (fictional)" : ""}</title>
      </rect>
    {/each}
  {:else}
    <path d="{line} L990,108 L0,108 Z" fill="var(--accent)" opacity=".09" />
    <path d={line} stroke="var(--accent)" stroke-width="2" fill="none" />
  {/if}
</svg>
<div class="axis" aria-hidden="true">{values.length} weeks</div>

<style>
  svg { display: block; width: 100%; height: 108px; min-width: 650px; }
  .axis { color: var(--faint); font-size: 12px; margin-top: 8px; }
</style>
