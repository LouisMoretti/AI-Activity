<script lang="ts">
  import type { Account } from "../../../shared/types.ts";
  import AccountMenu from "./AccountMenu.svelte";
  import Logo from "./Logo.svelte";

  // Same header on every page: nothing here may depend on the route.
  let { account, demo, signIn, onnavigate, onlogout }: {
    account: Account | null;
    /** Fictional data on screen: always labeled. */
    demo: boolean;
    /** Show "Sign in" when signed out (off on the sign-in screen itself). */
    signIn: boolean;
    onnavigate: (path: string) => void;
    onlogout: () => void;
  } = $props();
</script>

<header class="top">
  <a class="brand" href="/" onclick={(e) => { e.preventDefault(); onnavigate("/"); }}><Logo /><h1>AI Activity</h1></a>
  <div class="top-right">
    {#if demo}<span class="badge demo">Demonstration data</span>{/if}
    {#if account}
      <AccountMenu {account} {onnavigate} {onlogout} />
    {:else if signIn}
      <button type="button" class="signin"
        onclick={() => onnavigate(`/?next=${encodeURIComponent(location.pathname)}`)}>Sign in</button>
    {/if}
  </div>
</header>

<style>
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
  .brand { display: flex; align-items: center; gap: 11px; color: inherit; text-decoration: none; }
  h1 { font-size: 19px; font-weight: 600; letter-spacing: -0.4px; }
  .top-right { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
  .signin { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 4px 10px; font-size: 12px; color: var(--text); }
  .badge { border: 1px solid var(--line); font-size: 12px; padding: 5px 10px; border-radius: var(--radius-sm); }
  .badge.demo { border-color: var(--demo-line); background: var(--demo-bg); color: var(--demo-text); }
  @media (max-width: 720px) {
    .top { gap: 12px; align-items: flex-start; }
    h1 { white-space: nowrap; }
  }
</style>
