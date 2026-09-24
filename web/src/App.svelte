<script lang="ts">
  import AccountMenu from "./components/AccountMenu.svelte";
  import ActivityChart from "./components/ActivityChart.svelte";
  import ClaudeCodeCard from "./components/ClaudeCodeCard.svelte";
  import CodexCard from "./components/CodexCard.svelte";
  import Conversations from "./components/Conversations.svelte";
  import CostPanel from "./components/CostPanel.svelte";
  import DevicesPanel from "./components/DevicesPanel.svelte";
  import InviteSignup from "./components/InviteSignup.svelte";
  import LoginBar from "./components/LoginBar.svelte";
  import Logo from "./components/Logo.svelte";
  import NewAccountForm from "./components/NewAccountForm.svelte";
  import OpenCodeCard from "./components/OpenCodeCard.svelte";
  import ProfilePanel from "./components/ProfilePanel.svelte";
  import ProfileSwitcher from "./components/ProfileSwitcher.svelte";
  import Section from "./components/Section.svelte";
  import Segmented from "./components/Segmented.svelte";
  import StatsRow from "./components/StatsRow.svelte";
  import SubscriptionForm from "./components/SubscriptionForm.svelte";
  import UsersPanel from "./components/UsersPanel.svelte";
  import { Dashboard } from "./lib/dashboard.svelte.ts";
  import type { Provider } from "./lib/view-model.ts";

  const dash = new Dashboard();
  $effect(() => dash.start());
  $effect(() => {
    document.title = !dash.account ? "AI Activity"
      : dash.demo ? "AI Activity · Demo"
      : dash.shown && !dash.own ? `AI Activity · ${dash.shown.display_name}`
        : "AI Activity";
  });
  const signedIn = $derived(Boolean(dash.account));

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
    {#if dash.account}
      <div class="top-right">
        <span class="badge" class:demo={dash.demo} class:live={!dash.demo}>{dash.demo ? "Demonstration data" : "Live data"}</span>
        {#if !dash.demo}
          <ProfileSwitcher profiles={dash.profiles} current={dash.viewing ?? dash.account.username}
            self={dash.account.username} onchange={(u) => dash.openProfile(u)} />
        {/if}
        <AccountMenu account={dash.account} onlogout={() => dash.logout()} />
      </div>
    {/if}
  </header>

  {#if dash.status === "signed-out" && dash.invite}
    <InviteSignup token={dash.invite} oncreate={(a, c) => dash.createAccount(a, c)} onsignin={() => dash.leaveInvite()} />
  {:else if dash.status === "signed-out"}
    <LoginBar onlogin={(u, p) => dash.login(u, p)} />
  {:else if dash.status === "setup"}
    <NewAccountForm withSetupCode title="Create the first account"
      intro="No account exists yet. The setup code is printed in the server log. This account becomes the admin and keeps the data collected so far."
      submitLabel="Create admin account" oncreate={(a, c) => dash.createAccount(a, c)} />
  {/if}

  {#if signedIn && dash.invite}
    <p class="viewing">
      <span>This is an invite link for someone else: open it signed out, e.g. in a private window.</span>
      <button type="button" onclick={() => dash.leaveInvite()}>Dismiss</button>
    </p>
  {/if}

  {#if signedIn && !dash.own && !dash.demo && dash.status !== "missing"}
    <p class="viewing">
      <span>Viewing <strong>{dash.shown?.display_name ?? dash.viewing}</strong>'s profile, read-only.</span>
      <button type="button" onclick={() => dash.openProfile(null)}>Back to yours</button>
    </p>
  {/if}

  {#if dash.status === "missing"}
    <p class="gate">
      No profile named <span class="mono">@{dash.viewing}</span>.
      <button type="button" onclick={() => dash.openProfile(null)}>Back to yours</button>
    </p>
  {/if}

  {#if signedIn && dash.status !== "missing"}
    <div class="toolbar">
      <Segmented label="Tools" options={providers} value={dash.provider} onchange={(p) => dash.setProvider(p)} />
    </div>
  {/if}

  {#if dash.status === "error"}
    <p class="notice" role="alert">Could not reach the server. Retrying every 15 seconds.</p>
  {/if}

  {#if dash.vm}
    {@const vm = dash.vm}
    <!-- Management only acts on the viewer's own real data, never on demo data or another profile. -->
    {@const canManage = !vm.demo && dash.own}
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

    {#if vm.cost}
      <Section title="Cost" subtitle="Paid and estimated stay separate">
        <CostPanel cards={vm.cost} />
        {#if canManage}
          <SubscriptionForm onadded={() => dash.load()} />
        {/if}
      </Section>
    {/if}

    {#if canManage}
      <Section title="Devices" subtitle="One ingestion key per machine">
        <DevicesPanel />
      </Section>

      {#if dash.account}
        <Section title="Account" subtitle="Your profile and password">
          {#key dash.account.id}
            <ProfilePanel account={dash.account} onchange={() => dash.load()} />
          {/key}
        </Section>
      {/if}

      {#if dash.account?.is_admin}
        <Section title="Users" subtitle="Usage pages are visible to every account; devices and costs stay private">
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
  .top-right { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
  .gate { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 20px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .viewing { display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--muted); margin-bottom: 14px; }
  .viewing strong { color: var(--text); font-weight: 500; }
  .viewing button, .gate button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 3px 10px; font-size: 12px; }
  .badge { border: 1px solid var(--line); color: var(--muted); font-size: 12px; padding: 5px 10px; border-radius: var(--radius-sm); }
  .badge.demo { border-color: var(--demo-line); background: var(--demo-bg); color: var(--demo-text); }
  .toolbar { display: flex; justify-content: center; margin-bottom: 8px; }
  .notice { color: var(--warn); margin: 12px 0; text-align: center; }
  .tools { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr)); gap: 16px; }
  @media (max-width: 720px) {
    main { padding: 24px 16px 40px; }
    .top { gap: 12px; align-items: flex-start; }
    h1 { white-space: nowrap; }
    /* The demo label must stay visible; "Live data" is the default and can go. */
    .badge.live { display: none; }
    .toolbar { justify-content: flex-start; overflow-x: auto; }
  }
</style>
