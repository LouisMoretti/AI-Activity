<script lang="ts">
  import { TOOLS, type HourBucket, type HoursResponse, type LeaderboardResponse, type Widget } from "../../../shared/types.ts";
  import { fmtCompact, fmtDay, fmtShare } from "../lib/format.ts";
  import { TOOL_META, type DashboardVM, type ToolKey } from "../lib/view-model.ts";
  import TodayByTool from "./TodayByTool.svelte";

  let { widget, vm, hours, board, username }: {
    widget: Widget; vm: DashboardVM; hours: HoursResponse | null;
    board: LeaderboardResponse | null; username: string;
  } = $props();

  // The demo uses fixed fictional shares. Its hourly totals add up to the
  // same fictional "today" total as the other cards, with a peak at 14h.
  const demoHours = (): HoursResponse => {
    const weights = Array.from({ length: 24 }, (_, h) => h === 14 ? 12 : h >= 8 && h <= 19 ? 4 : 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    const rows: HourBucket[] = [];
    for (const tool of vm.stats.today.byTool) {
      let used = 0;
      weights.forEach((weight, hour) => {
        const tokens = hour === 23 ? tool.value - used : Math.floor(tool.value * weight / sum);
        used += tokens;
        if (tokens) rows.push({ hour, tool: tool.name as ToolKey, tokens });
      });
    }
    return { day: vm.today, current_hour: 14, hours: rows, provenance: "Demonstration data" };
  };
  const hourData = $derived(vm.demo ? demoHours() : hours);
  const hourTotals = $derived(Array.from({ length: 24 }, (_, hour) =>
    hourData?.hours.filter((r) => r.hour === hour).reduce((n, r) => n + r.tokens, 0) ?? 0));
  const peak = $derived(Math.max(...hourTotals));
  const peakHour = $derived(hourTotals.indexOf(peak));
  const best = $derived(vm.series.reduce((a, d) => d.tokens > a.tokens ? d : a, { day: vm.today, tokens: 0 }));
  const today = $derived(vm.series.find((d) => d.day === vm.today)?.tokens ?? 0);
  const rank = $derived(vm.demo ? 2 : (board?.entries.findIndex((e) => e.username.toLowerCase() === username.toLowerCase()) ?? -1) + 1);
  const accountCount = $derived(vm.demo ? 5 : board?.accounts ?? 0);
  const weeklyTokens = $derived(vm.demo ? vm.series.slice(-7).reduce((n, d) => n + d.tokens, 0)
    : board?.entries[rank - 1]?.tokens ?? 0);
  const neighbor = $derived(vm.demo ? { username: "sample-user", tokens: weeklyTokens + 34_000_000 }
    : rank > 0 && board ? board.entries[rank === 1 ? 1 : rank - 2] : null);
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
            <div class="hour" class:current={hour === hourData.current_hour} title="{hour}h · {fmtCompact(hourTotals[hour])}">
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
      {#if rank > 0}
        <div class="big">#{rank} of {accountCount}</div>
        <p>{fmtCompact(weeklyTokens)} tokens this week</p>
        {#if neighbor}
          <p>{fmtCompact(Math.abs(neighbor.tokens - weeklyTokens))} {rank === 1 ? "ahead of" : "behind"} @{neighbor.username}</p>
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
