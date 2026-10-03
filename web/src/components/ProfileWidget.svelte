<script lang="ts">
  import { TOOLS, type Widget } from "../../../shared/types.ts";
  import { fmtCompact, fmtDay, fmtShare } from "../lib/format.ts";
  import { TOOL_META, type DashboardVM, type ToolKey } from "../lib/view-model.ts";
  import TodayByTool from "./TodayByTool.svelte";

  let { widget, vm }: { widget: Widget; vm: DashboardVM } = $props();

  const hourData = $derived(vm.hours);
  const hourTotals = $derived(Array.from({ length: 24 }, (_, hour) =>
    hourData?.hours.filter((r) => r.hour === hour).reduce((n, r) => n + r.tokens, 0) ?? 0));
  const peak = $derived(Math.max(...hourTotals));
  const peakHour = $derived(hourTotals.indexOf(peak));
  const best = $derived(vm.series.reduce((a, d) => d.tokens > a.tokens ? d : a, { day: vm.today, tokens: 0 }));
  const today = $derived(vm.series.find((d) => d.day === vm.today)?.tokens ?? 0);
  const barColor = (tool: string) => tool in TOOL_META ? TOOL_META[tool as ToolKey].color : "var(--accent)";
</script>

{#if widget === "today-by-tool"}
  <TodayByTool today={vm.stats.today} demo={vm.demo} />
{:else}
  <article class="card">
    <div class="heading">{widget === "today-by-hour" ? "Today by hour" : widget === "best-day" ? "Best day" : "Leaderboard · 7 days"}</div>
    {#if vm.demo}<div class="demo">Demonstration data</div>{/if}
    {#if widget === "today-by-hour"}
      {#if hourData && hourData.day === vm.today}
        {#if peak}<div class="big">Peak {peakHour}h · {fmtCompact(peak)}</div>{:else}<p>Nothing yet today</p>{/if}
        <div class="hours" role="img" aria-label="Today's tokens by local hour, peak at {peakHour}h with {fmtCompact(peak)} tokens">
          {#each Array.from({ length: 24 }, (_, i) => i) as hour}
            <div class="hour" class:current={hour === hourData.currentHour} title="{hour}h · {fmtCompact(hourTotals[hour])}">
              {#each TOOLS as tool}
                {@const value = hourData.hours.find((r) => r.hour === hour && r.tool === tool)?.tokens ?? 0}
                {#if value}<span style:height="{peak ? value / peak * 100 : 0}%" style:background={barColor(tool)}></span>{/if}
              {/each}
            </div>
          {/each}
        </div>
        <div class="ends"><span>00h</span><span>12h</span><span>23h</span></div>
      {:else}<p>Hourly data unavailable</p>{/if}
    {:else if widget === "best-day"}
      {#if best.tokens}
        <div class="big">{fmtCompact(best.tokens)} tokens</div>
        <p>{fmtDay(best.day)}</p>
        <div class="track"><span style:width="{Math.min(100, today / best.tokens * 100)}%"></span></div>
        <p>Today at {fmtShare(today, best.tokens)} of it</p>
      {:else}<p>No activity yet</p>{/if}
    {:else if widget === "leaderboard"}
      {#if vm.rank}
        {@const r = vm.rank}
        <div class="big">#{r.rank} of {r.accounts}</div>
        <p>{fmtCompact(r.tokens)} tokens this week</p>
        {#if r.neighbor}
          <p>{fmtCompact(Math.abs(r.neighbor.tokens - r.tokens))} {r.neighbor.direction} {r.neighbor.name}</p>
        {/if}
      {:else}<p>Leaderboard unavailable</p>{/if}
    {/if}
  </article>
{/if}

<style>
  .card { min-width: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 22px; }
  .heading { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .demo { color: var(--muted); font-size: 11px; margin-top: 8px; }
  .big { font-size: 21px; margin: 20px 0 12px; font-weight: 600; }
  p { color: var(--muted); font-size: 12px; margin: 10px 0; }
  .track { height: 8px; background: var(--track); border-radius: 10px; overflow: hidden; }
  .track span { display: block; height: 100%; background: var(--accent); border-radius: 10px; }
  .hours { display: flex; align-items: end; gap: 2px; height: 90px; margin-top: 18px; }
  .hour { display: flex; flex-direction: column-reverse; justify-content: flex-start; flex: 1; height: 100%; background: var(--track); min-width: 0; }
  .hour.current { outline: 1px solid var(--text); outline-offset: 1px; }
  .hour span { display: block; width: 100%; flex: none; }
  .ends { display: flex; justify-content: space-between; color: var(--muted); font-size: 10px; margin-top: 6px; }
</style>
