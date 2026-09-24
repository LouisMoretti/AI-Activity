<script lang="ts">
  import type { Account } from "../../../shared/types.ts";

  let { account, onlogout }: { account: Account; onlogout: () => void } = $props();
</script>

<div class="account">
  <span class="avatar" aria-hidden="true">{account.display_name.slice(0, 1).toUpperCase()}</span>
  <span class="name" title={`@${account.username}`}>{account.display_name}</span>
  <button type="button" onclick={onlogout}>Sign out</button>
</div>

<style>
  .account { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .avatar { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--raised); border: 1px solid var(--line); font-size: 12px; font-weight: 500; }
  .name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 4px 10px; font-size: 12px; color: var(--muted); }
  button:hover { color: var(--text); }
  @media (max-width: 720px) { .name { display: none; } }
</style>
