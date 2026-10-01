<script lang="ts">
  import { onMount } from "svelte";
  import type { SiteAnalyticsOverview } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { fmtCompact } from "../lib/format.ts";

  let data = $state<SiteAnalyticsOverview | null>(null);
  let error = $state("");
  onMount(async () => {
    try { data = await api.siteAnalytics(); }
    catch (e) { error = (e as Error).message; }
  });

  const labels: Record<string, string> = {
    signin: "Sign in", profile: "Profiles", leaderboard: "Leaderboard", demo: "Demo",
    friends: "Friends", settings: "Settings", admin: "Admin",
  };
  const totals = $derived(data ? data.days.reduce((sum, row) => ({
    pageviews: sum.pageviews + row.pageviews,
    visitors: sum.visitors + row.visitors,
    signups: sum.signups + row.signups,
  }), { pageviews: 0, visitors: 0, signups: 0 }) : null);
</script>

<p class="privacy">Last 30 days. Counts only: page category, referrer domain and daily visitors. No full URLs, profile names, account links, cookies or third-party requests. Visitor counts use a daily rotating hash of IP address and browser user agent; raw values are not stored. Data is deleted after 90 days.</p>
{#if data && totals}
  <div class="tiles">
    <div class="tile"><small>Page views</small><strong>{fmtCompact(totals.pageviews)}</strong></div>
    <div class="tile"><small>Daily unique visitors</small><strong>{fmtCompact(totals.visitors)}</strong></div>
    <div class="tile"><small>New accounts</small><strong>{fmtCompact(totals.signups)}</strong></div>
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
  <h3>Daily totals</h3>
  <div class="daily">
    {#each data.days.slice().reverse() as row (row.day)}
      <div class="row"><time datetime={row.day}>{row.day}</time><span>{fmtCompact(row.pageviews)} views · {fmtCompact(row.visitors)} visitors · {fmtCompact(row.signups)} sign-ups</span></div>
    {:else}<p class="empty">No analytics collected yet.</p>{/each}
  </div>
{:else if error}
  <p class="error" role="alert">Could not load site analytics: {error}</p>
{/if}

<style>
  .privacy, .empty { color: var(--muted); font-size: 12px; line-height: 1.6; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); gap: 12px; margin: 16px 0; }
  .tile { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; display: grid; gap: 4px; }
  .tile small { color: var(--muted); font-size: 12px; }
  .tile strong { font-size: 20px; font-weight: 600; }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 24px; }
  h3 { margin: 18px 0 8px; font-size: 13px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding: 7px 0; font-size: 12px; }
  .row span, time { color: var(--muted); }
  .row strong { font-weight: 500; }
  .daily .row { flex-wrap: wrap; }
  .error { color: var(--warn); font-size: 13px; }
</style>
