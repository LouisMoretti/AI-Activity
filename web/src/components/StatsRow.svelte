<script lang="ts">
  import { fmtCompact, fmtNum, plural } from "../lib/format.ts";
  import type { StatsVM } from "../lib/view-model.ts";
  import ShareList from "./ShareList.svelte";
  import StatCard from "./StatCard.svelte";

  let { stats }: { stats: StatsVM } = $props();
  const show = (n: number | null, f = fmtCompact) => (n === null ? "—" : f(n));

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
  <StatCard label="Sessions" value={show(stats.sessions.value, fmtNum)}>
    {#snippet detail()}
      <ShareList title="By tool" kind="tool" rows={stats.sessions.byTool} />
      <ShareList title="By model" kind="model" rows={stats.sessions.byModel} percent={false} />
    {/snippet}
  </StatCard>
  <StatCard label="Current streak" value={stats.streak ? plural(stats.streak.current, "day") : "—"}>
    {#snippet detail()}<p class="note">{streakNote}</p>{/snippet}
  </StatCard>
</section>

<style>
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 28px; border: 1px solid var(--line); border-radius: 15px; padding: 16px 8px; }
  .stats > :global(.stat + .stat)::before { content: ""; position: absolute; left: -1px; top: 8%; bottom: 8%; border-left: 1px solid var(--line); }
  /* Keep edge popovers on screen. */
  .stats > :global(.stat:first-child .pop) { left: 0; translate: 0 0; }
  .stats > :global(.stat:last-child .pop) { left: auto; right: 0; translate: 0 0; }
  .note { font-size: 13px; color: var(--muted); max-width: 26ch; }
  @media (max-width: 640px) {
    .stats { grid-template-columns: repeat(2, 1fr); row-gap: 18px; }
    .stats > :global(.stat:nth-child(3))::before { display: none; }
    .stats > :global(.stat:nth-child(odd) .pop) { left: 0; right: auto; translate: 0 0; }
    .stats > :global(.stat:nth-child(even) .pop) { left: auto; right: 0; translate: 0 0; }
  }
</style>
