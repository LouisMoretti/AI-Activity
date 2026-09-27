<script lang="ts">
  import type { Account } from "../../../shared/types.ts";
  import Avatar from "./Avatar.svelte";

  let { account }: { account: Account } = $props();
</script>

<div class="box">
  <div class="who">
    <Avatar name={account.display_name} url={account.avatar_url} size={40} />
    <div>
      <strong>{account.display_name}</strong>
      <small><span class="mono">@{account.username}</span>{account.is_admin ? " · admin" : ""}</small>
    </div>
  </div>
  {#if account.github_linked}
    <p class="muted">
      You sign in with GitHub. Your username, name and picture follow your GitHub profile: they are updated each
      time you sign in.
    </p>
  {:else}
    <p class="warn">
      This account was made before sign-in with GitHub and is not linked to a GitHub account yet: once this
      session ends, you cannot sign in. Ask the server's admin to link it
      (<span class="mono">npm run user -- link {account.username} &lt;your GitHub login&gt;</span>); your username
      then becomes your GitHub login.
    </p>
  {/if}
</div>

<style>
  .box { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px 18px; display: grid; gap: 12px; max-width: 640px; }
  .who { display: flex; align-items: center; gap: 12px; }
  strong { font-weight: 500; display: block; }
  small { color: var(--muted); font-size: 12px; }
  p { font-size: 13px; line-height: 1.5; }
  .muted { color: var(--muted); }
  .warn { color: var(--warn); }
</style>
