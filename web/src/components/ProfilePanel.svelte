<script lang="ts">
  import type { Account } from "../../../shared/types.ts";
  import Avatar from "./Avatar.svelte";

  let { account, error: returned = null, onlink }: {
    account: Account;
    /** Why linking failed (back from GitHub), if it did. */
    error?: string | null;
    /** Leaves for GitHub to link this account; an error message if it could not start. */
    onlink: () => Promise<string | null>;
  } = $props();

  let error = $state<string | null>(null);
  let busy = $state(false);
  const shown = $derived(error ?? returned);

  async function link() {
    busy = true;
    error = await onlink();
    if (error) busy = false;
  }
</script>

<div class="box">
  <div class="who">
    <Avatar name={account.display_name} url={account.avatar_url} size={40} />
    <div>
      <strong>{account.display_name}</strong>
      <small><span class="mono">@{account.username}</span>{account.is_admin ? " · admin" : ""}</small>
    </div>
  </div>
  {#if account.github}
    <p class="muted">
      You sign in with GitHub. Your username, name and picture follow your GitHub profile: they are updated each
      time you sign in.
    </p>
  {:else}
    <p class="warn">
      This account was made before sign-in with GitHub and is not linked to a GitHub account yet. Link it now:
      once this session ends, you can only sign in with GitHub. Your username becomes your GitHub login.
    </p>
    <div class="actions">
      <button type="button" disabled={busy} onclick={link}>{busy ? "Opening GitHub…" : "Link GitHub account"}</button>
    </div>
  {/if}
  {#if shown}<p class="error" role="alert">{shown}</p>{/if}
</div>

<style>
  .box { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px 18px; display: grid; gap: 12px; max-width: 640px; }
  .who { display: flex; align-items: center; gap: 12px; }
  strong { font-weight: 500; display: block; }
  small { color: var(--muted); font-size: 12px; }
  p { font-size: 13px; line-height: 1.5; }
  .muted { color: var(--muted); }
  .warn, .error { color: var(--warn); }
  .actions { display: flex; gap: 12px; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; }
  button:disabled { opacity: .5; cursor: default; }
</style>
