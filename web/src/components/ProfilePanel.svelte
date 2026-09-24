<script lang="ts">
  import { untrack } from "svelte";
  import type { Account } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";

  let { account, onchange }: { account: Account; onchange: () => void } = $props();

  // Seeded once from the account; the field is then the user's to edit.
  let name = $state(untrack(() => (account.display_name === account.username ? "" : account.display_name)));
  let nameMsg = $state<{ ok: boolean; text: string } | null>(null);
  let current = $state("");
  let next = $state("");
  let repeat = $state("");
  let pwMsg = $state<{ ok: boolean; text: string } | null>(null);
  let busy = $state(false);

  async function saveName(e: SubmitEvent) {
    e.preventDefault();
    try {
      await api.updateProfile(name);
      nameMsg = { ok: true, text: "Saved." };
      onchange();
    } catch (err) {
      nameMsg = { ok: false, text: (err as Error).message };
    }
  }

  async function savePassword(e: SubmitEvent) {
    e.preventDefault();
    if (next !== repeat) {
      pwMsg = { ok: false, text: "The new passwords do not match." };
      return;
    }
    busy = true;
    try {
      await api.changePassword(current, next);
      pwMsg = { ok: true, text: "Password changed. Other browsers were signed out." };
      current = next = repeat = "";
    } catch (err) {
      pwMsg = { ok: false, text: (err as Error).message };
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid">
  <form onsubmit={saveName}>
    <h3>Profile</h3>
    <p class="muted">Signed in as <span class="mono">@{account.username}</span>{account.is_admin ? " · admin" : ""}</p>
    <label>Display name
      <input maxlength="60" placeholder={account.username} bind:value={name} />
    </label>
    <div class="actions">
      <button type="submit">Save</button>
      {#if nameMsg}<span class:ok={nameMsg.ok} class:error={!nameMsg.ok} role="status">{nameMsg.text}</span>{/if}
    </div>
  </form>

  <form onsubmit={savePassword}>
    <h3>Password</h3>
    <!-- Lets password managers pair the new password with this account. -->
    <input type="text" autocomplete="username" value={account.username} hidden readonly />
    <label>Current password
      <input type="password" autocomplete="current-password" required bind:value={current} />
    </label>
    <label>New password
      <input type="password" autocomplete="new-password" minlength="8" required bind:value={next} />
    </label>
    <label>Repeat new password
      <input type="password" autocomplete="new-password" minlength="8" required bind:value={repeat} />
    </label>
    <div class="actions">
      <button type="submit" disabled={busy}>Change password</button>
      {#if pwMsg}<span class:ok={pwMsg.ok} class:error={!pwMsg.ok} role="status">{pwMsg.text}</span>{/if}
    </div>
  </form>
</div>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 16px; align-items: start; }
  form { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px 18px; display: grid; gap: 12px; align-content: start; }
  h3 { font-size: 14px; font-weight: 500; }
  label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
  input { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 6px 10px; font: inherit; font-size: 14px; }
  .actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; }
  button:disabled { opacity: .5; cursor: default; }
  .ok { color: var(--ok); font-size: 13px; }
  .error { color: var(--warn); font-size: 13px; }
</style>
