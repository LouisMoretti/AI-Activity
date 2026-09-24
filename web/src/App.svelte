<script lang="ts">
  import ActivityChart from "./components/ActivityChart.svelte";
  import BillingCards from "./components/BillingCards.svelte";
  import LoginBar from "./components/LoginBar.svelte";
  import QuotaCard from "./components/QuotaCard.svelte";
  import Section from "./components/Section.svelte";
  import Segmented from "./components/Segmented.svelte";
  import SessionList from "./components/SessionList.svelte";
  import StatsBar from "./components/StatsBar.svelte";
  import { Dashboard } from "./lib/dashboard.svelte.ts";
  import type { Provider } from "./lib/view-model.ts";

  const dash = new Dashboard();
  $effect(() => dash.start());
  $effect(() => { document.title = dash.demo ? "AI Activity — Demo" : "AI Activity"; });

  const providers: { value: Provider; label: string }[] = [
    { value: "all", label: "All tools" },
    { value: "codex", label: "Codex" },
    { value: "claude-code", label: "Claude Code" },
  ];
</script>

<main>
  <header class="top">
    <div class="brand"><span class="mark" aria-hidden="true">▥</span><h1>AI Activity</h1></div>
    <span class="badge" class:demo={dash.demo}>{dash.demo ? "Demonstration data" : "Live data"}</span>
  </header>

  {#if dash.status === "locked"}
    <LoginBar onlogin={(p) => dash.login(p)} />
  {/if}

  <div class="toolbar">
    <Segmented label="Tools" options={providers} value={dash.provider} onchange={(p) => dash.setProvider(p)} />
    <span class="muted">{dash.vm?.periodLabel ?? "Loading measured data…"}</span>
  </div>

  {#if dash.status === "error"}
    <p class="notice" role="alert">Could not load data. Is the server running?</p>
  {/if}

  {#if dash.vm}
    {@const vm = dash.vm}
    <StatsBar stats={vm.stats} />
    <ActivityChart series={vm.series} demo={vm.demo} hasActivity={vm.hasActivity} />

    <Section title="Tool limits" subtitle="Account quotas · used consumption">
      <div class="quotas">
        {#each vm.quotas as card (card.tool)}<QuotaCard {card} />{/each}
      </div>
    </Section>

    <Section title="Conversation context" subtitle={vm.sessionsSubtitle}
      footnote="Context is per conversation. The 5-hour and weekly quotas are shared at account level and shown as the latest snapshot provided by the account — never summed across devices.">
      <SessionList sessions={vm.sessions} />
    </Section>

    <Section title="Cost" subtitle="Paid vs estimated — always separate"
      footnote="An API-rate estimate for usage included in a subscription is neither an invoice nor a real saving.">
      <BillingCards cards={vm.billing} />
    </Section>

    <footer><span class="dot" aria-hidden="true"></span>{vm.footer}</footer>
  {/if}
</main>

<style>
  main { max-width: 1080px; margin: 0 auto; padding: 48px 42px 30px; }
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 36px; }
  .brand { display: flex; align-items: center; gap: 12px; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.5px; }
  .mark { color: var(--accent); font-size: 27px; line-height: 1; }
  .badge { border: 1px solid var(--line); color: var(--muted); font-size: 12px; padding: 5px 10px; border-radius: var(--radius-sm); }
  .badge.demo { border-color: var(--demo-line); background: var(--demo-bg); color: var(--demo-text); }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 22px; flex-wrap: wrap; }
  .notice { color: var(--warn); margin-bottom: 16px; }
  .quotas { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  footer { display: flex; align-items: center; gap: 7px; margin-top: 35px; color: var(--faint); font-size: 12px; }
  .dot { width: 5px; height: 5px; background: #ac9a70; border-radius: 50%; }
  @media (max-width: 720px) {
    main { padding: 25px 16px; }
    .quotas { grid-template-columns: 1fr; }
  }
</style>
