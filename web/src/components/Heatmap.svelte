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

  // One tab stop for the whole calendar (today, or the last day moved to);
  // arrow keys move a day (up/down) or a week (left/right).
  let focusDay = $state<string | null>(null);
  const days = $derived(series.map((d) => d.day));
  const current = $derived(focusDay && days.includes(focusDay) ? focusDay : days.includes(today) ? today : days.at(-1));
  let grid = $state<HTMLDivElement>();
  const STEP: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7, Home: -Infinity, End: Infinity };

  function move(e: KeyboardEvent, day: string) {
    const step = STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const i = days.indexOf(day);
    const next = days[Math.min(Math.max(i + step, 0), days.length - 1)] ?? day;
    focusDay = next;
    grid?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus();
  }
</script>

<div class="cal" role="group" aria-label="Daily tokens, last 52 weeks" onmouseleave={() => onhover(null)}>
  <div class="months" aria-hidden="true">
    {#each months as m, i (i)}<span>{m}</span>{/each}
  </div>
  <div class="weekdays" aria-hidden="true">
    <span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span>
  </div>
  <div class="grid" bind:this={grid}>
    {#each weeks as week, wi (wi)}
      {#each week as d, di (di)}
        {#if d}
          <button
            class="cell"
            class:today={d.day === today}
            style:background="var(--heat-{level(d.tokens, max)})"
            aria-label={describe(d)}
            data-day={d.day}
            tabindex={d.day === current ? 0 : -1}
            onkeydown={(e) => move(e, d.day)}
            onmouseenter={() => onhover(d)}
            onfocus={() => { focusDay = d.day; onhover(d); }}
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
