<script lang="ts">
  import { cumulative, weeklyTotals, type DayPoint } from "../lib/series.ts";
  import Heatmap from "./Heatmap.svelte";
  import Section from "./Section.svelte";
  import Segmented from "./Segmented.svelte";
  import TrendChart from "./TrendChart.svelte";

  type View = "daily" | "weekly" | "cumulative";
  let { series, demo, hasActivity }: { series: DayPoint[]; demo: boolean; hasActivity: boolean } = $props();

  let view = $state<View>("daily");
  let wrap = $state<HTMLDivElement>();
  // Narrow screens scroll the calendar: start on the most recent weeks.
  $effect(() => {
    if (wrap && view && series.length) wrap.scrollLeft = wrap.scrollWidth;
  });
  let focused = $state("");
  const weekly = $derived(weeklyTotals(series));

  const hint = $derived.by(() => {
    if (!hasActivity) return "No measured activity yet. Connect a device to see real tokens here.";
    const src = demo ? "simulated data" : "measured data";
    if (view === "weekly") return `Tokens consumed each week · ${src}.`;
    if (view === "cumulative") return `Total tokens over time · ${src}.`;
    return `Hover a day to see its ${demo ? "activity (fictional)" : "measured activity"}.`;
  });
</script>

<Section title="Token activity">
  {#snippet actions()}
    <Segmented variant="tabs" label="Activity view" value={view}
      onchange={(v) => { view = v; focused = ""; }}
      options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "cumulative", label: "Cumulative" }]} />
  {/snippet}
  <div class="wrap" bind:this={wrap}>
    {#if view === "daily"}
      <Heatmap {series} {demo} onfocusday={(l) => (focused = l)} />
    {:else}
      <TrendChart values={view === "weekly" ? weekly : cumulative(weekly)} kind={view} {demo} />
    {/if}
  </div>
  <div class="footer">
    <span aria-live="polite">{focused || hint}</span>
    {#if view === "daily"}
      <div class="legend" aria-hidden="true">
        <span>Less</span>{#each [0, 1, 2, 3, 4] as l (l)}<i style:background="var(--heat-{l})"></i>{/each}<span>More</span>
      </div>
    {/if}
  </div>
</Section>

<style>
  .wrap { overflow-x: auto; padding: 2px; }
  .footer { display: flex; justify-content: space-between; gap: 15px; margin-top: 16px; color: var(--faint); font-size: 12px; min-height: 20px; flex-wrap: wrap; }
  .legend { display: flex; align-items: center; gap: 4px; }
  .legend i { width: 10px; height: 10px; border-radius: 2px; }
  .legend span:first-child { margin-right: 5px; }
  .legend span:last-child { margin-left: 5px; }
</style>
