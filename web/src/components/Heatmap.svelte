<script lang="ts">
  import { fmtDay, fmtNum, monthShort } from "../lib/format.ts";
  import { calendarWeeks, level, peak, type DayPoint } from "../lib/series.ts";

  let { series, demo, onfocusday }: {
    series: DayPoint[];
    demo: boolean;
    onfocusday: (label: string) => void;
  } = $props();

  const weeks = $derived(calendarWeeks(series));
  const max = $derived(peak(series));
  // Month label on the first week whose first real day starts a new month.
  // A leading partial month is dropped when the next label would collide.
  const months = $derived.by(() => {
    const labels = weeks.map((w, i) => {
      const first = w.find((d) => d !== null);
      const prev = i > 0 ? weeks[i - 1].find((d) => d !== null) : null;
      if (!first) return "";
      const m = monthShort(first.day);
      return prev && monthShort(prev.day) === m ? "" : m;
    });
    const next = labels.findIndex((l, i) => i > 0 && l);
    if (next > 0 && next < 3) labels[0] = "";
    return labels;
  });
  const describe = (d: DayPoint) => `${fmtDay(d.day)}: ${fmtNum(d.tokens)} tokens${demo ? " (fictional)" : ""}`;
</script>

<div class="cal">
  <div class="months" aria-hidden="true">
    {#each months as m, i (i)}<span>{m}</span>{/each}
  </div>
  <div class="body">
    <div class="weekdays" aria-hidden="true">
      <span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span>
    </div>
    <div class="grid">
      {#each weeks as week, wi (wi)}
        {#each week as d, di (di)}
          {#if d}
            <button
              class="cell"
              style:background="var(--heat-{level(d.tokens, max)})"
              aria-label={describe(d)}
              title={describe(d)}
              onmouseenter={() => onfocusday(describe(d))}
              onfocus={() => onfocusday(describe(d))}
              onclick={() => onfocusday(describe(d))}
            ></button>
          {:else}
            <span class="cell empty"></span>
          {/if}
        {/each}
      {/each}
    </div>
  </div>
</div>

<style>
  .cal { min-width: max-content; }
  .months { display: grid; grid-auto-flow: column; grid-auto-columns: var(--cell); gap: var(--cell-gap); margin-bottom: 6px; padding-left: 34px; color: var(--faint); font-size: 11px; }
  .months span { white-space: nowrap; }
  .body { display: flex; gap: 6px; }
  .weekdays { display: grid; grid-template-rows: repeat(7, var(--cell)); gap: var(--cell-gap); width: 28px; color: var(--faint); font-size: 9px; }
  .weekdays span { line-height: var(--cell); }
  .grid { display: grid; grid-template-rows: repeat(7, var(--cell)); grid-auto-flow: column; grid-auto-columns: var(--cell); gap: var(--cell-gap); }
  .cell { width: var(--cell); height: var(--cell); padding: 0; border-radius: 2px; border: 1px solid #ffffff0d; }
  .cell:hover { outline: 1px solid #aaa; }
  .empty { border: 0; }
</style>
