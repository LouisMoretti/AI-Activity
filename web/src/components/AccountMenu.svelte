<script lang="ts">
  import type { Account } from "../../../shared/types.ts";

  let { account, onnavigate, onlogout }: {
    account: Account;
    /** In-app navigation to a path. */
    onnavigate: (path: string) => void;
    onlogout: () => void;
  } = $props();

  let open = $state(false);
  let root: HTMLDivElement;

  const pick = (fn: () => void) => () => {
    open = false;
    fn();
  };

  function onWindowClick(e: MouseEvent) {
    if (open && !root.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => { if (e.key === "Escape") open = false; }} />

<div class="account" bind:this={root}>
  <button type="button" class="trigger" aria-haspopup="menu" aria-expanded={open} onclick={() => (open = !open)}>
    <span class="avatar" aria-hidden="true">{account.display_name.slice(0, 1).toUpperCase()}</span>
    <span class="name">{account.display_name}</span>
    <span class="caret" aria-hidden="true">▾</span>
  </button>
  {#if open}
    <div class="menu" role="menu">
      <p class="who">Signed in as <span class="mono">@{account.username}</span></p>
      <button type="button" role="menuitem" onclick={pick(() => onnavigate(`/u/${encodeURIComponent(account.username)}`))}>Your profile</button>
      <button type="button" role="menuitem" onclick={pick(() => onnavigate("/leaderboard"))}>Leaderboard</button>
      <button type="button" role="menuitem" onclick={pick(() => onnavigate("/settings"))}>Settings</button>
      {#if account.is_admin}
        <button type="button" role="menuitem" onclick={pick(() => onnavigate("/admin"))}>Admin panel</button>
      {/if}
      <button type="button" role="menuitem" onclick={pick(onlogout)}>Sign out</button>
    </div>
  {/if}
</div>

<style>
  .account { position: relative; }
  .trigger { display: flex; align-items: center; gap: 8px; padding: 3px 8px 3px 3px; border: 1px solid var(--line); border-radius: 999px; color: var(--text); }
  .trigger:hover, .trigger[aria-expanded="true"] { background: var(--surface-2); }
  .avatar { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--raised); font-size: 12px; font-weight: 500; }
  .name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
  .caret { font-size: 10px; color: var(--muted); }
  .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 10; min-width: 190px; display: grid; padding: 6px; background: var(--raised); border: 1px solid var(--line); border-radius: var(--radius-sm); box-shadow: 0 8px 24px rgb(0 0 0 / .35); }
  .who { font-size: 12px; color: var(--muted); padding: 6px 8px 8px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
  .menu button { text-align: left; padding: 7px 8px; border-radius: 4px; font-size: 13px; color: var(--text); }
  .menu button:hover, .menu button:focus-visible { background: var(--surface-2); }
  @media (max-width: 720px) { .name { display: none; } }
</style>
