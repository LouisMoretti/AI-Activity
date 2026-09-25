<script lang="ts">
  import { fmtDay, fmtNum } from "../lib/format.ts";
  import { cumulative, weeklyTotals, type DayPoint } from "../lib/series.ts";
  import Heatmap from "./Heatmap.svelte";
  import Section from "./Section.svelte";
  import Segmented from "./Segmented.svelte";
  import TrendChart from "./TrendChart.svelte";

  type View = "daily" | "weekly" | "cumulative";
  let { series, today, demo, hasActivity }: {
    series: DayPoint[]; today: string; demo: boolean; hasActivity: boolean;
  } = $props();

  let view = $state<View>("daily");
  let hovered = $state<DayPoint | null>(null);
  let scroller = $state<HTMLDivElement>();
  const weekly = $derived(weeklyTotals(series));
  const todayPoint = $derived(series.find((d) => d.day === today) ?? { day: today, tokens: 0 });

  const describe = (d: DayPoint) =>
    `${fmtDay(d.day)}: ${d.tokens ? `${fmtNum(d.tokens)} tokens` : "no activity"}${demo ? " (fictional)" : ""}`;

  // The hovered day as of the latest refresh (the series is rebuilt every 15 s).
  const hoveredNow = $derived(hovered ? series.find((d) => d.day === hovered!.day) ?? hovered : null);
  const hasSeries = $derived(series.length > 0);

  // Without a hovered cell, the readout shows today.
  const readout = $derived.by(() => {
    if (view === "daily") {
      if (!hasActivity && !hoveredNow) return "No measured activity yet. Connect a device to see real tokens here.";
      return describe(hoveredNow ?? todayPoint);
    }
    const src = demo ? "fictional data" : "measured data";
    return view === "weekly" ? `Tokens per week · ${src}` : `Total tokens over time · ${src}`;
  });

  // Narrow screens scroll the calendar: start on the most recent weeks.
  // Re-applied when the area resizes (rotation, late layout), not on every
  // refresh: someone scrolled back to older months stays there.
  $effect(() => {
    if (!scroller || !view || !hasSeries) return;
    const el = scroller;
    const toEnd = () => { el.scrollLeft = el.scrollWidth; };
    requestAnimationFrame(toEnd);
    const ro = new ResizeObserver(toEnd);
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<Section title="Token activity">
  {#snippet actions()}
    <Segmented variant="tabs" label="Activity view" value={view}
      onchange={(v) => { view = v; hovered = null; }}
      options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "cumulative", label: "Cumulative" }]} />
  {/snippet}
  <div class="area">
    <div class="scroller" bind:this={scroller}>
      {#if view === "daily"}
        <Heatmap {series} {today} {describe} onhover={(d) => (hovered = d)} />
      {:else}
        <TrendChart values={view === "weekly" ? weekly : cumulative(weekly)} kind={view} {demo} />
      {/if}
    </div>
    <div class="footer">
        <span class="readout" aria-live="polite">{readout}</span>
        {#if view === "daily"}
          <div class="legend" aria-hidden="true">
            <span>Less</span>{#each [0, 1, 2, 3, 4] as l (l)}<i style:background="var(--heat-{l})"></i>{/each}<span>More</span>
          </div>
        {/if}
    </div>
  </div>
</Section>

<style>
  /* Centered when it fits; on narrow screens the chart scrolls while the
     readout below stays in view. */
  .area { width: fit-content; max-width: 100%; margin-inline: auto; }
  .scroller { overflow-x: auto; padding: 4px 2px; }
  .footer { display: flex; justify-content: space-between; align-items: center; gap: 8px 16px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; color: var(--faint); }
  .readout { color: var(--muted); }
  .legend { display: flex; align-items: center; gap: 3px; }
  .legend i { width: var(--cell); height: var(--cell); border-radius: 2px; }
  .legend span:first-child { margin-right: 4px; }
  .legend span:last-child { margin-left: 4px; }
</style>
