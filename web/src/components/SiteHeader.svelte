<script lang="ts">
  import type { Account } from "../../../shared/types.ts";
  import AccountMenu from "./AccountMenu.svelte";
  import Avatar from "./Avatar.svelte";
  import Logo from "./Logo.svelte";

  // Same header on every page: it never reads the route itself, the page
  // only hands it the breadcrumb.
  let { account, demo, crumb, signIn, onnavigate, onlogout }: {
    account: Account | null;
    /** Current page, shown as "AI Activity / <label>". */
    crumb: { label: string; mono?: boolean; picture?: { name: string; url: string | null } } | null;
    /** Fictional data on screen: always labeled. */
    demo: boolean;
    /** Show "Sign in" when signed out (off on the sign-in screen itself). */
    signIn: boolean;
    onnavigate: (path: string) => void;
    onlogout: () => void;
  } = $props();
</script>

<header class="top">
  <div class="left">
    <a class="brand" href="/" onclick={(e) => { e.preventDefault(); onnavigate("/"); }}><Logo /><h1>AI Activity</h1></a>
    {#if crumb}<span class="crumb"><span class="sep" aria-hidden="true">/</span>{#if crumb.picture}<Avatar name={crumb.picture.name} url={crumb.picture.url} size={22} />{/if}<span class="label" class:mono={crumb.mono}>{crumb.label}</span></span>{/if}
  </div>
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
  .left { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .crumb { display: flex; align-items: center; gap: 10px; min-width: 0; color: var(--muted); font-size: 15px; }
  .crumb .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sep { color: var(--line); font-size: 19px; font-weight: 300; }
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
