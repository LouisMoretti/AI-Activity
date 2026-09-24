<script lang="ts">
  import AccountMenu from "./components/AccountMenu.svelte";
  import ActivityChart from "./components/ActivityChart.svelte";
  import ClaudeCodeCard from "./components/ClaudeCodeCard.svelte";
  import CodexCard from "./components/CodexCard.svelte";
  import Conversations from "./components/Conversations.svelte";
  import DevicesPanel from "./components/DevicesPanel.svelte";
  import InviteSignup from "./components/InviteSignup.svelte";
  import LoginBar from "./components/LoginBar.svelte";
  import Logo from "./components/Logo.svelte";
  import NewAccountForm from "./components/NewAccountForm.svelte";
  import OpenCodeCard from "./components/OpenCodeCard.svelte";
  import ProfileHeader from "./components/ProfileHeader.svelte";
  import ProfilePanel from "./components/ProfilePanel.svelte";
  import ProfileSwitcher from "./components/ProfileSwitcher.svelte";
  import Section from "./components/Section.svelte";
  import Segmented from "./components/Segmented.svelte";
  import StatsRow from "./components/StatsRow.svelte";
  import UsersPanel from "./components/UsersPanel.svelte";
  import { Dashboard } from "./lib/dashboard.svelte.ts";
  import type { Provider } from "./lib/view-model.ts";

  const dash = new Dashboard();
  $effect(() => dash.start());
  $effect(() => {
    const page = dash.route.page;
    document.title = page === "settings" ? "Settings · AI Activity"
      : page === "profile" && dash.shown ? `${dash.shown.display_name} · AI Activity${dash.vm?.demo ? " · Demo" : ""}`
        : "AI Activity";
  });

  const providers: { value: Provider; label: string }[] = [
    { value: "all", label: "All tools" },
    { value: "claude-code", label: "Claude Code" },
    { value: "codex", label: "Codex" },
    { value: "opencode", label: "OpenCode" },
  ];

  /** Back to the sign-in screen, then here. */
  const signInHere = () => dash.go(`/?next=${encodeURIComponent(location.pathname)}`);
</script>

<main>
  <header class="top">
    <a class="brand" href="/" onclick={(e) => { e.preventDefault(); dash.go("/"); }}><Logo /><h1>AI Activity</h1></a>
    <div class="top-right">
      {#if dash.vm}
        <span class="badge" class:demo={dash.vm.demo} class:live={!dash.vm.demo}>{dash.vm.demo ? "Demonstration data" : "Live data"}</span>
      {/if}
      {#if dash.account}
        {#if dash.profiles.length > 1}
          <ProfileSwitcher profiles={dash.profiles}
            current={dash.route.page === "profile" ? dash.route.username : dash.account.username}
            self={dash.account.username} onchange={(u) => dash.openProfile(u)} />
        {/if}
        <AccountMenu account={dash.account} onnavigate={(p) => dash.go(p)} onlogout={() => dash.logout()} />
      {:else if dash.route.page === "profile"}
        <button type="button" class="signin" onclick={signInHere}>Sign in</button>
      {/if}
    </div>
  </header>

  {#if dash.route.page === "invite"}
    {#if dash.status === "signed-out"}
      <InviteSignup token={dash.route.token} oncreate={(a, c) => dash.createAccount(a, c)} onsignin={() => dash.go("/")} />
    {:else if dash.account}
      <p class="gate">
        This is an invite link for someone else: open it signed out, e.g. in a private window.
        <button type="button" onclick={() => dash.go("/")}>Go to your profile</button>
      </p>
    {/if}
  {:else if dash.status === "signed-out"}
    <LoginBar onlogin={(u, p) => dash.login(u, p)} />
  {:else if dash.status === "setup"}
    <NewAccountForm withSetupCode title="Create the first account"
      intro="No account exists yet. The setup code is printed in the server log. This account becomes the admin and keeps the data collected so far."
      submitLabel="Create admin account" oncreate={(a, c) => dash.createAccount(a, c)} />
  {/if}

  {#if dash.status === "missing"}
    <p class="gate">
      No profile named <span class="mono">@{dash.route.page === "profile" ? dash.route.username : ""}</span>.
      {#if dash.account}<button type="button" onclick={() => dash.go("/")}>Go to your profile</button>{/if}
    </p>
  {/if}

  {#if dash.status === "error"}
    <p class="notice" role="alert">Could not reach the server. Retrying every 15 seconds.</p>
  {/if}

  {#if dash.route.page === "settings" && dash.account && dash.status === "ready"}
    <div class="settings-head">
      <h2>Settings</h2>
      <button type="button" onclick={() => dash.go("/")}>Back to your profile</button>
    </div>

    <Section title="Account" subtitle="Your profile and password">
      {#key dash.account.id}
        <ProfilePanel account={dash.account} onchange={() => dash.load()} />
      {/key}
    </Section>

    <Section title="Devices" subtitle="One ingestion key per machine">
      <DevicesPanel />
    </Section>

    {#if dash.account.is_admin}
      <Section title="Users" subtitle="Profile pages are public; devices and settings stay private">
        <UsersPanel selfId={dash.account.id} />
      </Section>
    {/if}
  {/if}

  {#if dash.vm && dash.shown}
    {@const vm = dash.vm}
    <ProfileHeader profile={dash.shown} own={dash.own} />

    <div class="toolbar">
      <Segmented label="Tools" options={providers} value={dash.provider} onchange={(p) => dash.setProvider(p)} />
    </div>

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
  {/if}
</main>

<style>
  main { max-width: 1080px; margin: 0 auto; padding: 44px 42px 56px; }
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
  .brand { display: flex; align-items: center; gap: 11px; color: inherit; text-decoration: none; }
  h1 { font-size: 19px; font-weight: 600; letter-spacing: -0.4px; }
  .top-right { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
  .gate { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 20px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .gate button, .settings-head button, .signin { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 4px 10px; font-size: 12px; color: var(--text); }
  .settings-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
  .settings-head h2 { font-size: 17px; font-weight: 600; }
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
