<script lang="ts">
  import AdminOverview from "./components/AdminOverview.svelte";
  import AuthPanel from "./components/AuthPanel.svelte";
  import ActivityChart from "./components/ActivityChart.svelte";
  import ClaudeCodeCard from "./components/ClaudeCodeCard.svelte";
  import CodexCard from "./components/CodexCard.svelte";
  import Conversations from "./components/Conversations.svelte";
  import DevicesPanel from "./components/DevicesPanel.svelte";
  import Leaderboard from "./components/Leaderboard.svelte";
  import NewAccountForm from "./components/NewAccountForm.svelte";
  import OpenCodeCard from "./components/OpenCodeCard.svelte";
  import ProfilePanel from "./components/ProfilePanel.svelte";
  import SiteHeader from "./components/SiteHeader.svelte";
  import Section from "./components/Section.svelte";
  import StatsRow from "./components/StatsRow.svelte";
  import UsersPanel from "./components/UsersPanel.svelte";
  import { Dashboard } from "./lib/dashboard.svelte.ts";

  const dash = new Dashboard();
  // Breadcrumb after "AI Activity" in the header: where you are.
  const crumb = $derived(
    dash.route.page === "profile" ? (dash.shown ? { label: `@${dash.shown.username}`, mono: true, picture: { name: dash.shown.display_name, url: dash.shown.avatar_url } } : null)
    : dash.route.page === "leaderboard" ? { label: "Leaderboard" }
    : dash.route.page === "settings" && dash.account ? { label: "Settings" }
    : dash.route.page === "admin" && dash.account ? { label: "Admin panel" }
    : null);
  $effect(() => dash.start());
  $effect(() => {
    const page = dash.route.page;
    document.title = page === "settings" ? "Settings · AI Activity"
      : page === "admin" ? "Admin panel · AI Activity"
      : page === "leaderboard" ? "Leaderboard · AI Activity"
      : page === "profile" && dash.shown ? `${dash.shown.display_name} · AI Activity${dash.vm?.demo ? " · Demo" : ""}`
        : "AI Activity";
  });
</script>

<!-- Site chrome (header, and a footer if one is ever added) lives here,
     outside the page branches, so every page gets exactly the same. -->
<div class="shell">
  <SiteHeader account={dash.account} demo={!!dash.vm?.demo}
    {crumb}
    signIn={dash.status !== "loading" && dash.status !== "signed-out" && dash.status !== "setup"}
    onnavigate={(p) => dash.go(p)} onlogout={() => dash.logout()} />

  <main>
    {#if dash.status === "signed-out"}
      <AuthPanel signupOpen={dash.signupOpen} onlogin={(u, p) => dash.login(u, p)} oncreate={(a, c) => dash.createAccount(a, c)} />
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
      <Section title="Account" subtitle="Your profile and password">
        {#key dash.account.id}
          <ProfilePanel account={dash.account} onchange={() => dash.load()} />
        {/key}
      </Section>

      <Section title="Devices" subtitle="One ingestion key per machine">
        <DevicesPanel />
      </Section>

    {/if}

    {#if dash.route.page === "admin" && dash.account && dash.status === "ready"}
      {#if dash.account.is_admin}
        <Section title="Overview" subtitle="The whole server, every account">
          <AdminOverview />
        </Section>
        <Section title="Users" subtitle="Profile pages are public; devices and settings stay private">
          <UsersPanel selfId={dash.account.id} />
        </Section>
      {:else}
        <p class="gate">This page is for admins.</p>
      {/if}
    {/if}

    {#if dash.route.page === "leaderboard" && dash.status === "ready"}
      <Leaderboard self={dash.account?.username ?? null} onopen={(u) => dash.openProfile(u)} />
    {/if}

    {#if dash.vm && dash.shown}
      {@const vm = dash.vm}
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
</div>

<style>
  .shell { max-width: 1080px; margin: 0 auto; padding: 44px 42px 56px; }
  .gate { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 20px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .gate button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 4px 10px; font-size: 12px; color: var(--text); }
  .notice { color: var(--warn); margin: 12px 0; text-align: center; }
  .tools { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr)); gap: 16px; }
  @media (max-width: 720px) {
    .shell { padding: 24px 16px 40px; }
  }
</style>
