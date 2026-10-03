<script lang="ts">
  import { PRICED_TOOLS } from "../../../shared/pricing.ts";
  import { clock } from "../lib/clock.svelte.ts";
  import { fmtAgo, fmtCompact, fmtNum, fmtShare, fmtUsd, plural } from "../lib/format.ts";
  import { toolName } from "../lib/view-model.ts";
  import type { StatsVM } from "../lib/view-model.ts";
  import ShareList from "./ShareList.svelte";
  import StatCard from "./StatCard.svelte";

  let { stats }: { stats: StatsVM } = $props();
  const show = (n: number | null, f = fmtCompact) => (n === null ? "—" : f(n));

  const value = $derived(stats.value);
  // "≈": an estimate; "≥": some cache writes were priced at the cheaper rate.
  const usdText = (usd: number | null, lowerBound: boolean) =>
    usd === null ? "—" : `${lowerBound ? "≥" : "≈"} ${fmtUsd(usd)}`;
  const pricedTools = PRICED_TOOLS.map(toolName).join(" and ");

  const streakNote = $derived.by(() => {
    const s = stats.streak;
    if (!s) return "No activity recorded yet.";
    if (s.current === 0) return `Longest streak: ${plural(s.longest, "day")}. Use a tool today to start a new one.`;
    if (s.current >= s.longest) return `This is your longest streak so far. Keep it going!`;
    return `Longest streak: ${plural(s.longest, "day")}. ${plural(s.longest - s.current, "more day")} to beat it.`;
  });
</script>

<section class="stats" aria-label="Statistics">
  <StatCard label="Total tokens" value={show(stats.total.value)}>
    {#snippet detail()}
      <ShareList title="By tool" kind="tool" rows={stats.total.byTool} />
      <ShareList title="By model" kind="model" rows={stats.total.byModel} />
    {/snippet}
  </StatCard>
  <StatCard label="Today" value={show(stats.today.value)}>
    {#snippet detail()}
      <ShareList title="By tool" kind="tool" rows={stats.today.byTool} />
      <ShareList title="By model" kind="model" rows={stats.today.byModel} />
    {/snippet}
  </StatCard>
  <StatCard label="API value (estimate)" value={usdText(value.total.usd, value.total.lowerBound)}>
    {#snippet detail()}
      <div class="value">
        <p class="today">Today: <strong>{usdText(value.today.usd, value.today.lowerBound)}</strong></p>
        <ShareList title="By tool" kind="tool" rows={value.total.byTool} format={fmtUsd} />
        <ShareList title="By model" kind="model" rows={value.total.byModel} format={fmtUsd} />
        <p class="note">
          What these tokens would cost at the providers' published retail API rates (USD, rates of {value.pricingVersion}).
          An estimate: not what was paid, not a saving, not the providers' cost.
        </p>
        {#if value.total.unpricedTokens > 0}
          <p class="note warn">
            Partial: leaves out {fmtCompact(value.total.unpricedTokens)} tokens
            ({fmtShare(value.total.unpricedTokens, value.total.unpricedTokens + value.total.pricedTokens)}) without a published
            rate: models with no retail API price, and tools other than {pricedTools} (not priced yet).
          </p>
        {/if}
        {#if value.total.lowerBound}
          <p class="note warn">At least: some cache writes were recorded without their duration and are priced at the cheaper 5-minute rate.</p>
        {/if}
        {#if value.total.fallback}
          <p class="note warn">Some usage predates its model's oldest published rate and is priced at that rate.</p>
        {/if}
        {#if value.lastEventAt !== null}<p class="note">Latest usage {fmtAgo(value.lastEventAt, clock.now)}.</p>{/if}
      </div>
    {/snippet}
  </StatCard>
  <StatCard label="Sessions" value={show(stats.sessions.value, fmtNum)}>
    {#snippet detail()}
      <ShareList title="By tool" kind="tool" rows={stats.sessions.byTool} />
      <ShareList title="By model" kind="model" rows={stats.sessions.byModel} of={stats.sessions.value} restValue={stats.sessions.byModelOthers} />
    {/snippet}
  </StatCard>
  <StatCard label="Current streak" value={stats.streak ? plural(stats.streak.current, "day") : "—"}>
    {#snippet detail()}<p class="note">{streakNote}</p>{/snippet}
  </StatCard>
</section>

<style>
  .stats { display: grid; grid-template-columns: repeat(5, 1fr); margin-top: 28px; border: 1px solid var(--line); border-radius: 15px; padding: 16px 8px; }
  .stats > :global(.stat + .stat)::before { content: ""; position: absolute; left: -1px; top: 8%; bottom: 8%; border-left: 1px solid var(--line); }
  /* Keep edge popovers on screen. */
  .stats > :global(.stat:first-child .pop) { left: 0; translate: 0 0; }
  .stats > :global(.stat:last-child .pop) { left: auto; right: 0; translate: 0 0; }
  .note { font-size: 13px; color: var(--muted); max-width: 26ch; }
  .value { max-width: 34ch; }
  .value .note { max-width: none; font-size: 12px; margin-top: 10px; }
  .value .warn { color: var(--warn); }
  .today { font-size: 13px; color: var(--muted); margin-bottom: 10px; }
  .today strong { color: var(--text); font-weight: 500; }
  @media (max-width: 640px) {
    .stats { grid-template-columns: repeat(2, 1fr); row-gap: 18px; }
    .stats > :global(.stat:nth-child(odd))::before { display: none; }
    .stats > :global(.stat:last-child) { grid-column: 1 / -1; }
    .stats > :global(.stat:nth-child(odd) .pop) { left: 0; right: auto; translate: 0 0; }
    .stats > :global(.stat:nth-child(even) .pop) { left: auto; right: 0; translate: 0 0; }
    .stats > :global(.stat:last-child .pop) { left: 50%; right: auto; translate: -50% 0; }
  }
</style>
