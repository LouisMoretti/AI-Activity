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
  const apiCalls = $derived(data ? data.api.days.reduce((sum, d) => sum + d.calls, 0) : 0);
  const apiToday = $derived(data?.api.days.at(-1) ?? null);
  const apiDayLabels = $derived(data ? data.api.days.map((d) =>
    `${fmtDay(d.day)}: ${plural(d.calls, "call")}, ${plural(d.clients, "client")}`) : []);
  const originLabel = (o: string) => (o === "none" ? "No origin (servers, scripts)" : o);
  const clientLabels: Record<string, string> = {
    browser: "Browser", curl: "curl", wget: "wget", python: "Python", node: "Node.js", deno: "Deno", bun: "Bun",
    go: "Go", bot: "Bots and previews", none: "No user agent", other: "Other",
  };
  const peak = $derived(data ? Math.max(0, ...data.online.minutes) : 0);
  const minuteLabels = $derived(data ? data.online.minutes.map((n, i) => {
    const ago = data!.online.minutes.length - 1 - i;
    return `${ago ? `${ago} min ago` : "This minute"}: ${plural(n, "visitor")}`;
  }) : []);
  const dayLabels = $derived(data ? data.days.map((d) =>
    `${fmtDay(d.day)}: ${plural(d.visitors, "visitor")} (${d.new_visitors} new, ${d.returning_visitors} returning), ${plural(d.pageviews, "page view")}, ${plural(d.signups, "sign-up")}`) : []);
</script>

<p class="privacy">Counts only: page category, referrer domain, visitors and external API reads. No full URLs, profile names, account links, cookies or third-party requests. Each browser keeps a random id for 13 months (stored here only as a keyed hash) to tell returning visitors apart; without one, and for API clients, a hash of IP address and user agent rotated daily is used. Who is online is kept in memory only; daily counts are deleted after 90 days.</p>
{#if data && totals && today}
  <div class="tiles">
    <div class="tile">
      <small><i class="live" class:on={data.online.now > 0}></i>Online now</small>
      <strong>{fmtNum(data.online.now)}</strong><span>open tabs, last minute</span>
    </div>
    <div class="tile"><small>Visitors today (UTC)</small><strong>{fmtCompact(today.visitors)}</strong><span>{today.new_visitors} new · {today.returning_visitors} returning</span></div>
    <div class="tile"><small>Unique visitors</small><strong>{fmtCompact(data.unique_visitors)}</strong><span>last 30 days</span></div>
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

  <h3 class="part">Public API <span>other sites and programs reading it, not this site's pages</span></h3>
  <div class="tiles">
    <div class="tile"><small>Calls</small><strong>{fmtCompact(apiCalls)}</strong><span>last 30 days</span></div>
    <div class="tile"><small>Calls today (UTC)</small><strong>{fmtCompact(apiToday?.calls ?? 0)}</strong><span>{plural(apiToday?.clients ?? 0, "client")}</span></div>
    <div class="tile"><small>Calling sites</small><strong>{fmtNum(data.api.origins.filter((o) => o.origin !== "none").length)}</strong><span>last 30 days</span></div>
  </div>
  <AnalyticsChart bars={data.api.days.map((d) => d.calls)} line={data.api.days.map((d) => d.clients)} labels={apiDayLabels}
    label="Public API calls per day (bars) and distinct clients (line), last 30 days"
    summary="{plural(apiCalls, 'call')} in 30 days" />
  <p class="legend"><i class="key bars"></i>Calls <i class="key line"></i>Clients</p>
  <div class="columns">
    <div>
      <h3>Origins</h3>
      {#each data.api.origins as row (row.origin)}
        <div class="row"><span>{originLabel(row.origin)}</span><strong>{fmtCompact(row.calls)}</strong></div>
      {:else}<p class="empty">No external calls yet.</p>{/each}
    </div>
    <div>
      <h3>Clients</h3>
      {#each data.api.clients as row (row.client)}
        <div class="row"><span>{clientLabels[row.client] ?? row.client}</span><strong>{fmtCompact(row.calls)}</strong></div>
      {:else}<p class="empty">No external calls yet.</p>{/each}
    </div>
    <div>
      <h3>Endpoints</h3>
      {#each data.api.routes as row (row.route)}
        <div class="row"><span>{row.route}</span><strong>{fmtCompact(row.calls)}</strong></div>
      {:else}<p class="empty">No external calls yet.</p>{/each}
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
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 24px; }
  h3 { margin: 18px 0 8px; font-size: 13px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); padding: 7px 0; font-size: 12px; }
  .row span { color: var(--muted); }
  .row strong { font-weight: 500; }
  .online-pages { margin-top: 8px; }
  .legend { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; font-size: 12px; color: var(--muted); }
  .key { display: inline-block; width: 10px; }
  .key.bars { height: 10px; border-radius: 2px; background: var(--heat-3); }
  .key.line { height: 2px; margin-left: 10px; background: var(--ai-violet); }
  .part { margin-top: 32px; font-size: 14px; }
  .part span { font-weight: 400; font-size: 12px; color: var(--muted); margin-left: 8px; }
  .error { color: var(--warn); font-size: 13px; }
</style>
