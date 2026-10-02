<script lang="ts">
  import { onMount } from "svelte";
  import type { SiteAnalyticsOverview } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { fmtCompact, fmtDay, fmtNum, plural } from "../lib/format.ts";
  import AnalyticsChart from "./AnalyticsChart.svelte";

  /** The online count moves by the minute: refresh while the panel is visible. */
  const REFRESH_MS = 10_000;

  let data = $state<SiteAnalyticsOverview | null>(null);
  let error = $state("");
  async function load() {
    try {
      data = await api.siteAnalytics();
      error = "";
    } catch (e) {
      // Keep the last data on screen; say why only if there is none.
      if (!data) error = (e as Error).message;
    }
  }
  onMount(() => {
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => clearInterval(id);
  });

  const labels: Record<string, string> = {
    signin: "Sign in", profile: "Profiles", leaderboard: "Leaderboard", demo: "Demo",
    friends: "Friends", settings: "Settings", admin: "Admin",
  };
  const totals = $derived(data ? data.days.reduce((sum, row) => ({
    pageviews: sum.pageviews + row.pageviews,
    signups: sum.signups + row.signups,
  }), { pageviews: 0, signups: 0 }) : null);
  const today = $derived(data?.days.at(-1) ?? null);
  const peak = $derived(data ? Math.max(0, ...data.online.minutes) : 0);
  const minuteLabels = $derived(data ? data.online.minutes.map((n, i) => {
    const ago = data!.online.minutes.length - 1 - i;
    return `${ago ? `${ago} min ago` : "This minute"}: ${plural(n, "visitor")}`;
  }) : []);
  const dayLabels = $derived(data ? data.days.map((d) =>
    `${fmtDay(d.day)}: ${plural(d.visitors, "visitor")}, ${plural(d.pageviews, "page view")}, ${plural(d.signups, "sign-up")}`) : []);
</script>

<p class="privacy">Counts only: page category, referrer domain and daily visitors. No full URLs, profile names, account links, cookies or third-party requests. Visitor counts use a daily rotating hash of IP address and browser user agent; raw values are not stored. Who is online is kept in memory only; the rest is deleted after 90 days.</p>
{#if data && totals && today}
  <div class="tiles">
    <div class="tile">
      <small><i class="live" class:on={data.online.now > 0}></i>Online now</small>
      <strong>{fmtNum(data.online.now)}</strong><span>open tabs, last minute</span>
    </div>
    <div class="tile"><small>Visitors today</small><strong>{fmtCompact(today.visitors)}</strong><span>{plural(today.pageviews, "page view")} (UTC)</span></div>
    <div class="tile"><small>Page views</small><strong>{fmtCompact(totals.pageviews)}</strong><span>last 30 days</span></div>
    <div class="tile"><small>New accounts</small><strong>{fmtCompact(totals.signups)}</strong><span>last 30 days</span></div>
  </div>

  <div class="columns">
    <div>
      <h3>Online, last hour</h3>
      <AnalyticsChart bars={data.online.minutes} labels={minuteLabels} label="Visitors online per minute, last hour"
        summary="Peak {plural(peak, 'visitor')} in one minute" />
      {#if data.online.pages.length}
        <div class="online-pages">
          {#each data.online.pages as row (row.page)}
            <div class="row"><span>{labels[row.page] ?? row.page}</span><strong>{fmtNum(row.visitors)}</strong></div>
          {/each}
        </div>
      {/if}
    </div>
    <div>
      <h3>Last 30 days</h3>
      <AnalyticsChart bars={data.days.map((d) => d.visitors)} line={data.days.map((d) => d.pageviews)} labels={dayLabels}
        label="Daily visitors (bars) and page views (line), last 30 days"
        summary="{plural(today.visitors, 'visitor')} today, {plural(today.pageviews, 'page view')}" />
      <p class="legend"><i class="key bars"></i>Visitors <i class="key line"></i>Page views</p>
    </div>
  </div>

  <div class="columns">
    <div>
      <h3>Pages</h3>
      {#each data.pages as row (row.page)}
        <div class="row"><span>{labels[row.page] ?? row.page}</span><strong>{fmtCompact(row.views)}</strong></div>
      {:else}<p class="empty">No page views yet.</p>{/each}
    </div>
    <div>
      <h3>Referrers</h3>
      {#each data.sources as row (row.source)}
        <div class="row"><span>{row.source}</span><strong>{fmtCompact(row.views)}</strong></div>
      {:else}<p class="empty">No external referrers yet.</p>{/each}
    </div>
  </div>
{:else if error}
  <p class="error" role="alert">Could not load site analytics: {error}</p>
{/if}

<style>
  .privacy, .empty { color: var(--muted); font-size: 12px; line-height: 1.6; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 12px; margin: 16px 0; }
  .tile { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; display: grid; gap: 4px; }
  .tile small { color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .tile strong { font-size: 20px; font-weight: 600; }
  .tile span { font-size: 12px; color: var(--faint); }
  .live { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
  .live.on { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 24px; }
  h3 { margin: 18px 0 8px; font-size: 13px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding: 7px 0; font-size: 12px; }
  .row span { color: var(--muted); }
  .row strong { font-weight: 500; }
  .online-pages { margin-top: 8px; }
  .legend { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; font-size: 12px; color: var(--muted); }
  .key { display: inline-block; width: 10px; }
  .key.bars { height: 10px; border-radius: 2px; background: var(--heat-3); }
  .key.line { height: 2px; margin-left: 10px; background: var(--ai-violet); }
  .error { color: var(--warn); font-size: 13px; }
</style>
