<script lang="ts">
  import type { ApiValue, LeaderboardRank, LeaderboardResponse } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { clock } from "../lib/clock.svelte.ts";
  import { profilePath } from "../lib/dashboard.svelte.ts";
  import { fmtAgo, fmtCompact, fmtNum, fmtPriced, fmtShare, fmtUsd, plural, RECENT_SEC } from "../lib/format.ts";
  import { ACTIVITY_DAYS } from "../lib/live.ts";
  import { denseSeries } from "../lib/series.ts";
  import ActivityChart from "./ActivityChart.svelte";
  import Avatar from "./Avatar.svelte";
  import Section from "./Section.svelte";
  import Segmented from "./Segmented.svelte";

  let { self, onopen }: {
    /** The viewer's username, highlighted in the ranking; null for visitors. */
    self: string | null;
    onopen: (username: string) => void;
  } = $props();

  type Period = "7" | "30" | "all";
  const PERIODS: { value: Period; label: string }[] = [
    { value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "all", label: "All time" },
  ];
  const RANKS: { value: LeaderboardRank; label: string }[] = [
    { value: "tokens", label: "Tokens" }, { value: "value", label: "API value" },
  ];
  const REFRESH_MS = 5000;

  let period = $state<Period>("30");
  let rank = $state<LeaderboardRank>("tokens");
  let data = $state<LeaderboardResponse | null>(null);
  let error = $state("");

  async function load(p: Period, by: LeaderboardRank) {
    try {
      const r = await api.leaderboard(p === "all" ? null : Number(p), by);
      // A newer period or ranking was picked while this was in flight.
      if (p !== period || by !== rank) return;
      data = r;
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    const p = period;
    const by = rank;
    void load(p, by);
    let id: ReturnType<typeof setInterval> | undefined;
    const startPolling = () => {
      if (!document.hidden && id === undefined) id = setInterval(() => { if (!document.hidden) void load(p, by); }, REFRESH_MS);
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (id !== undefined) clearInterval(id);
        id = undefined;
      } else {
        startPolling();
        void load(p, by);
      }
    };
    startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (id !== undefined) clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  });

  const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();
  const periodText = $derived(period === "all" ? "all time" : `last ${period} days`);
  // The bar shows the ranking's measure: tokens, or API-equivalent value.
  // The data's own ranking, not the toggle: they differ while a new one loads.
  const shownRank = $derived(data?.rank ?? "tokens");
  const measure = (e: { tokens: number; value: ApiValue }) => (shownRank === "value" ? e.value.usd ?? 0 : e.tokens);
  const top = $derived(Math.max(1e-9, ...(data?.entries ?? []).map(measure)));
  // "≈": an estimate; "≥": some cache writes were priced at the cheaper rate.
  const usdText = (v: ApiValue) => (v.usd === null ? "—" : `${v.lower_bound ? "≥" : "≈"} ${fmtUsd(v.usd)}`);
  const partialText = (v: ApiValue) =>
    `Leaves out ${fmtCompact(v.unpriced_tokens)} tokens of models without a known retail API rate`;
  const series = $derived(data ? denseSeries(data.activity, ACTIVITY_DAYS, data.day) : []);
  const today = $derived(data?.day ?? "");
  const tiles = $derived(data ? [
    { label: "Tokens", value: fmtCompact(data.totals.tokens), note: `${fmtCompact(data.totals.events)} API calls` },
    { label: "API value (estimate)", value: usdText(data.totals.value),
      note: data.totals.value.unpriced_tokens
        ? `${fmtPriced(data.totals.value.priced_tokens, data.totals.value.unpriced_tokens)} of tokens priced`
        : "at retail API rates" },
    { label: "Conversations", value: fmtCompact(data.totals.sessions), note: "every account" },
    { label: "Active accounts", value: String(data.totals.active_accounts), note: `of ${data.accounts}` },
    { label: "Top model", value: data.by_model[0]?.name ?? "—", note: data.by_model[0] ? `${fmtCompact(data.by_model[0].tokens)} tokens` : "no usage", mono: true },
  ] : []);
  const modelTotal = $derived(data?.by_model.reduce((a, m) => a + m.tokens, 0) || 1);

  // Medals only for accounts that actually used (or, by value, priced) something.
  const medal = (i: number, amount: number) => (amount ? ["🥇", "🥈", "🥉"][i] : undefined) ?? String(i + 1);
</script>

<div class="head">
  <span class="muted">Usage of every account, {periodText}</span>
  <div class="controls">
    <Segmented label="Rank by" value={rank} onchange={(v) => (rank = v)} options={RANKS} />
    <Segmented label="Period" value={period} onchange={(v) => (period = v)} options={PERIODS} />
  </div>
</div>

{#if error}<p class="error" role="alert">{error}</p>{/if}

{#if data}
  <div class="tiles">
    {#each tiles as t (t.label)}
      <div class="tile"><small>{t.label}</small><strong class:mono={t.mono}>{t.value}</strong><span>{t.note}</span></div>
    {/each}
  </div>

  <Section title="Ranking" subtitle="{shownRank === 'value' ? 'By estimated API-equivalent value' : 'By tokens'}, {periodText}">
    <ol class="list">
      {#each data.entries as e, i (e.username)}
        <li class:me={same(e.username, self)} class:idle={!e.events}>
          <span class="rank" class:medal={i < 3 && measure(e) > 0} aria-label="Rank {i + 1}">{medal(i, measure(e))}</span>
          <a class="who" href={profilePath(e.username)} onclick={(ev) => { ev.preventDefault(); onopen(e.username); }}>
            <Avatar name={e.display_name} url={e.avatar_url} size={32} />
            <span class="names">
              <strong>{e.display_name}{same(e.username, self) ? " (you)" : ""}</strong>
              <small class="mono">@{e.username}</small>
            </span>
          </a>
          <div class="bar-cell">
            <div class="line">
              <span class="num tokens">
                {fmtCompact(e.tokens)} tokens
                <span class="usd" title="Estimated API-equivalent value: these tokens at published retail API rates, not actual spend">{usdText(e.value)}</span>
                {#if e.value.unpriced_tokens > 0}<span class="partial" title={partialText(e.value)}>{fmtPriced(e.value.priced_tokens, e.value.unpriced_tokens)} priced</span>{/if}
              </span>
              <span class="share">{shownRank === "value" ? fmtShare(e.value.usd ?? 0, data.totals.value.usd ?? 0) : fmtShare(e.tokens, data.totals.tokens)}</span>
            </div>
            <div class="track" title={shownRank === "value" ? usdText(e.value) : `${fmtNum(e.tokens)} tokens`}><i style:width="{(measure(e) / top) * 100}%"></i></div>
            <div class="meta">
              {#if e.last_active !== null}
                <span>{plural(e.sessions, "conversation")}</span>
                <span>{plural(e.active_days, "active day")}</span>
                {#if e.current_streak}<span class="streak">🔥 {plural(e.current_streak, "day")}</span>{/if}
                {#if e.top_model}<span class="mono model">{e.top_model}</span>{/if}
                <span class="when"><i class="dot" class:recent={clock.now - e.last_active < RECENT_SEC}></i>{fmtAgo(e.last_active, clock.now)}</span>
              {:else}
                <span>No usage {period === "all" ? "yet" : "in this period"}</span>
              {/if}
            </div>
          </div>
        </li>
      {:else}
        <li class="empty">
          <strong>No accounts yet</strong>
          <small>Accounts show up here once they are created.</small>
        </li>
      {/each}
    </ol>
    {#if shownRank === "value"}
      <p class="fine">
        API value: what each account's tokens would cost at retail API rates (USD, verified rates of
        {data.pricing_version}, else LiteLLM's community price list). An estimate, not what anyone paid. A row showing a priced share
        leaves out models without a known rate, and accounts with nothing priced rank last.
      </p>
    {/if}
  </Section>

  {#if data.by_model.length}
    <Section title="Models" subtitle="Share of tokens, {periodText}">
      <div class="models">
        {#each data.by_model as m (m.name)}
          <div class="model-row">
            <span class="mono name">{m.name}</span>
            <div class="track"><i style:width="{(m.tokens / modelTotal) * 100}%"></i></div>
            <span class="num" title={m.value.usd === null ? "No published rate" : `${usdText(m.value)} at retail API rates`}>{fmtCompact(m.tokens)}</span>
            <span class="pct">{fmtShare(m.tokens, modelTotal)}</span>
          </div>
        {/each}
      </div>
    </Section>
  {/if}

  <ActivityChart {series} {today} demo={false} hasActivity={data.activity.length > 0} />
{/if}

<style>
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px 16px; flex-wrap: wrap; margin-bottom: 20px; }
  .muted { color: var(--muted); font-size: 13px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px 12px; }
  .usd { color: var(--muted); margin-left: 8px; }
  .partial { margin-left: 6px; font-size: 11px; color: var(--warn); border: 1px solid currentColor; border-radius: 6px; padding: 0 5px; }
  .fine { font-size: 12px; color: var(--muted); margin-top: 10px; }
  .error { color: var(--warn); margin: 8px 0; font-size: 13px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: 12px; }
  .tile { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; display: grid; gap: 4px; min-width: 0; }
  .tile small { font-size: 12px; color: var(--muted); }
  .tile strong { font-size: 20px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tile strong.mono { font-size: 15px; line-height: 27px; }
  .tile span { font-size: 12px; color: var(--faint); }

  .list { list-style: none; margin: 0; border: 1px solid var(--line); border-radius: var(--radius); padding: 0 20px; }
  li { display: grid; grid-template-columns: 32px minmax(0, 220px) minmax(0, 1fr); align-items: center; gap: 16px; padding: 14px 0; }
  li + li { border-top: 1px solid var(--line); }
  li.me .names strong { color: var(--accent); }
  .empty { display: block; }
  .empty strong { font-size: 14px; font-weight: 500; display: block; }
  .empty small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
  .rank { text-align: center; font-size: 14px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .rank.medal { font-size: 18px; }
  .who { display: flex; align-items: center; gap: 10px; min-width: 0; color: inherit; text-decoration: none; }
  .who:hover strong { text-decoration: underline; }
  .names { min-width: 0; }
  .names strong { display: block; font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .names small { display: block; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
  .bar-cell { display: grid; gap: 6px; min-width: 0; }
  .line { display: flex; justify-content: space-between; font-size: 13px; }
  .tokens { color: var(--text); }
  .share { color: var(--muted); font-size: 12px; }
  .track { height: 5px; border-radius: 3px; background: var(--track); overflow: hidden; }
  .track i { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
  li.me .track i { background: var(--claude); }
  li.idle .names strong, li.idle .tokens { color: var(--muted); }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--muted); }
  .meta .model { font-size: 11px; }
  .when { display: inline-flex; align-items: center; gap: 7px; }

  .models { display: grid; gap: 10px; border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; }
  .model-row { display: grid; grid-template-columns: minmax(0, 200px) minmax(0, 1fr) 56px 40px; align-items: center; gap: 12px; font-size: 13px; }
  .model-row .name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-row .num { text-align: right; }
  .model-row .pct { text-align: right; color: var(--muted); font-size: 12px; }

  @media (max-width: 720px) {
    li { grid-template-columns: 28px minmax(0, 1fr); gap: 10px 12px; }
    .bar-cell { grid-column: 1 / -1; }
    .model-row { grid-template-columns: minmax(0, 1fr) 56px 40px; }
    .model-row .track { grid-column: 1 / -1; grid-row: 2; }
  }
</style>
