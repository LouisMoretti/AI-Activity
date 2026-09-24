<script lang="ts">
  import AccountMenu from "./components/AccountMenu.svelte";
  import ActivityChart from "./components/ActivityChart.svelte";
  import ClaudeCodeCard from "./components/ClaudeCodeCard.svelte";
  import CodexCard from "./components/CodexCard.svelte";
  import Conversations from "./components/Conversations.svelte";
  import CostPanel from "./components/CostPanel.svelte";
  import DevicesPanel from "./components/DevicesPanel.svelte";
  import LoginBar from "./components/LoginBar.svelte";
  import Logo from "./components/Logo.svelte";
  import OpenCodeCard from "./components/OpenCodeCard.svelte";
  import ProfilePanel from "./components/ProfilePanel.svelte";
  import Section from "./components/Section.svelte";
  import Segmented from "./components/Segmented.svelte";
  import StatsRow from "./components/StatsRow.svelte";
  import SubscriptionForm from "./components/SubscriptionForm.svelte";
  import UsersPanel from "./components/UsersPanel.svelte";
  import { Dashboard } from "./lib/dashboard.svelte.ts";
  import type { Provider } from "./lib/view-model.ts";

  const dash = new Dashboard();
  $effect(() => dash.start());
  $effect(() => { document.title = dash.demo ? "AI Activity · Demo" : "AI Activity"; });

  const providers: { value: Provider; label: string }[] = [
    { value: "all", label: "All tools" },
    { value: "claude-code", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "opencode", label: "OpenCode" },
  ];
</script>

<main>
  <header class="top">
    <div class="brand"><Logo /><h1>AI Activity</h1></div>
    <div class="top-right">
      <span class="badge" class:demo={dash.demo}>{dash.demo ? "Demonstration data" : "Live data"}</span>
      {#if dash.account && !dash.demo}<AccountMenu account={dash.account} onlogout={() => dash.logout()} />{/if}
    </div>
  </header>

  {#if dash.status === "locked"}
    <LoginBar onlogin={(u, p) => dash.login(u, p)} />
  {/if}

  <div class="toolbar">
    <Segmented label="Tools" options={providers} value={dash.provider} onchange={(p) => dash.setProvider(p)} />
  </div>

  {#if dash.status === "error"}
    <p class="notice" role="alert">Could not reach the server. Retrying every 15 seconds.</p>
  {/if}

  {#if dash.vm}
    {@const vm = dash.vm}
    <!-- Management only acts on the real server, never on demo data. -->
    {@const canManage = !vm.demo && dash.status !== "locked"}
    <ActivityChart series={vm.series} today={vm.today} demo={vm.demo} hasActivity={vm.hasActivity} />
    <StatsRow stats={vm.stats} />

    <Section title="Tools" subtitle="Limits are per account, latest snapshot">
      <div class="tools">
        {#if vm.tools.includes("claude-code")}<ClaudeCodeCard vm={vm.claude} />{/if}
        {#if vm.tools.includes("codex")}<CodexCard vm={vm.codex} />{/if}
        {#if vm.tools.includes("opencode")}<OpenCodeCard />{/if}
      </div>
    </Section>

    <Section title="Conversations" subtitle="Most recent first">
      <Conversations sessions={vm.sessions} total={vm.sessionsTotal} onmore={() => dash.showMoreSessions()} />
    </Section>

    <Section title="Cost" subtitle="Paid and estimated stay separate">
      <CostPanel cards={vm.cost} />
      {#if canManage}
        <SubscriptionForm onadded={() => dash.load()} />
      {/if}
    </Section>

    {#if canManage}
      <Section title="Devices" subtitle="One ingestion key per machine">
        <DevicesPanel />
      </Section>

      <Section title="Account" subtitle={dash.account ? "Your profile and password" : "Open dashboard"}>
        {#if dash.account}
          {#key dash.account.id}
            <ProfilePanel account={dash.account} onchange={() => dash.load()} />
          {/key}
        {:else}
          <p class="open-note">
            No account exists yet, so anyone with the link sees this dashboard. On the server, run
            <code class="mono">npm run user -- add &lt;username&gt;</code> to create yours: it keeps the data
            collected so far and turns on sign-in.
          </p>
        {/if}
      </Section>

      {#if dash.account?.is_admin}
        <Section title="Users" subtitle="Each account sees only its own devices and usage">
          <UsersPanel selfId={dash.account.id} />
        </Section>
      {/if}
    {/if}
  {/if}
</main>

<style>
  main { max-width: 1080px; margin: 0 auto; padding: 44px 42px 56px; }
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
  .brand { display: flex; align-items: center; gap: 11px; }
  h1 { font-size: 19px; font-weight: 600; letter-spacing: -0.4px; }
  .top-right { display: flex; align-items: center; gap: 14px; min-width: 0; }
  .open-note { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 20px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .open-note code { color: var(--text); }
  .badge { border: 1px solid var(--line); color: var(--muted); font-size: 12px; padding: 5px 10px; border-radius: var(--radius-sm); }
  .badge.demo { border-color: var(--demo-line); background: var(--demo-bg); color: var(--demo-text); }
  .toolbar { display: flex; justify-content: center; margin-bottom: 8px; }
  .notice { color: var(--warn); margin: 12px 0; text-align: center; }
  .tools { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr)); gap: 16px; }
  @media (max-width: 720px) {
    main { padding: 24px 16px 40px; }
    .toolbar { justify-content: flex-start; overflow-x: auto; }
  }
</style>
