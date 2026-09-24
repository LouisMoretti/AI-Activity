<script lang="ts">
  import { monthShort } from "../lib/format.ts";
  import { calendarWeeks, level, monthLabels, peak, type DayPoint } from "../lib/series.ts";

  let { series, today, describe, onhover }: {
    series: DayPoint[];
    today: string;
    describe: (d: DayPoint) => string;
    onhover: (d: DayPoint | null) => void;
  } = $props();

  const weeks = $derived(calendarWeeks(series));
  const max = $derived(peak(series));
  const months = $derived(monthLabels(weeks, monthShort));
</script>

<div class="cal" role="group" aria-label="Daily tokens, last 52 weeks" onmouseleave={() => onhover(null)}>
  <div class="months" aria-hidden="true">
    {#each months as m, i (i)}<span>{m}</span>{/each}
  </div>
  <div class="weekdays" aria-hidden="true">
    <span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span>
  </div>
  <div class="grid">
    {#each weeks as week, wi (wi)}
      {#each week as d, di (di)}
        {#if d}
          <button
            class="cell"
            class:today={d.day === today}
            style:background="var(--heat-{level(d.tokens, max)})"
            aria-label={describe(d)}
            onmouseenter={() => onhover(d)}
            onfocus={() => onhover(d)}
            onblur={() => onhover(null)}
            onclick={() => onhover(d)}
          ></button>
        {:else}
          <span></span>
        {/if}
      {/each}
    {/each}
  </div>
</div>

<style>
  .cal { display: grid; grid-template-columns: 28px auto; gap: 6px; width: max-content; }
  .months { grid-column: 2; display: grid; grid-auto-flow: column; grid-auto-columns: var(--cell); gap: var(--cell-gap); height: 14px; color: var(--faint); font-size: 10px; }
  .months span { white-space: nowrap; }
  .weekdays { display: grid; grid-template-rows: repeat(7, var(--cell)); gap: var(--cell-gap); color: var(--faint); font-size: 9px; }
  .weekdays span { line-height: var(--cell); }
  .grid { display: grid; grid-template-rows: repeat(7, var(--cell)); grid-auto-flow: column; grid-auto-columns: var(--cell); gap: var(--cell-gap); }
  .cell { width: var(--cell); height: var(--cell); padding: 0; border-radius: 2px; border: 1px solid #ffffff0d; }
  .cell:hover { outline: 1px solid var(--muted); outline-offset: 0; }
  .cell.today { outline: 1px solid var(--text); outline-offset: 1px; }
</style>
