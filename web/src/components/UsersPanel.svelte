<script lang="ts">
  import { onMount } from "svelte";
  import type { AdminUser } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";

  let { selfId }: { selfId: number } = $props();

  let users = $state<AdminUser[] | null>(null);
  let error = $state("");
  let notice = $state("");
  let busy = $state(false);
  let username = $state("");
  let displayName = $state("");
  let password = $state("");
  let isAdmin = $state(false);
  /** Row whose password is being reset, and the new value. */
  let resetting = $state<number | null>(null);
  let resetValue = $state("");

  const fmtDate = (sec: number) =>
    new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  async function refresh() {
    try {
      users = (await api.users()).users;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  onMount(() => { void refresh(); });

  /** Run an action, then show its message and refresh the list. */
  async function act(fn: () => Promise<unknown>, done: string) {
    busy = true;
    error = notice = "";
    try {
      await fn();
      notice = done;
      await refresh();
      return true;
    } catch (e) {
      error = (e as Error).message;
      return false;
    } finally {
      busy = false;
    }
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    const u = username.trim();
    const ok = await act(
      () => api.createUser({ username: u, display_name: displayName.trim(), password, is_admin: isAdmin }),
      `Account "${u}" created. Share its password with them privately.`,
    );
    if (ok) {
      username = displayName = password = "";
      isAdmin = false;
    }
  }

  function toggle(u: AdminUser) {
    if (!u.disabled && !confirm(`Disable "${u.username}"? They are signed out and their devices stop being accepted.`)) return;
    void act(() => api.setUserDisabled(u.id, !u.disabled), u.disabled ? `"${u.username}" enabled.` : `"${u.username}" disabled.`);
  }

  async function reset(e: SubmitEvent, u: AdminUser) {
    e.preventDefault();
    if (await act(() => api.resetPassword(u.id, resetValue), `Password reset for "${u.username}"; they were signed out.`)) {
      resetting = null;
      resetValue = "";
    }
  }
</script>

<div class="panel">
  {#if users === null}
    <p class="muted">Loading accounts…</p>
  {:else}
    <ul>
      {#each users as u (u.id)}
        <li class:disabled={u.disabled}>
          <div class="who">
            <strong>{u.display_name}{u.id === selfId ? " (you)" : ""}</strong>
            <small>
              <span class="mono">@{u.username}</span>{u.is_admin ? " · admin" : ""}
              · {u.devices} device{u.devices === 1 ? "" : "s"} · since {fmtDate(u.created_at)}{u.disabled ? " · disabled" : ""}
            </small>
          </div>
          <div class="row-actions">
            {#if u.id !== selfId}
              <button type="button" disabled={busy} onclick={() => { resetting = resetting === u.id ? null : u.id; resetValue = ""; }}>
                Reset password
              </button>
              <button type="button" class:danger={!u.disabled} disabled={busy} onclick={() => toggle(u)}>
                {u.disabled ? "Enable" : "Disable"}
              </button>
            {/if}
          </div>
          {#if resetting === u.id}
            <form class="reset" onsubmit={(e) => reset(e, u)}>
              <input type="text" autocomplete="username" value={u.username} hidden readonly />
              <input type="password" autocomplete="new-password" minlength="8" required placeholder="New password" aria-label={`New password for ${u.username}`} bind:value={resetValue} />
              <button type="submit" disabled={busy}>Save</button>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <form class="create" onsubmit={create}>
    <input placeholder="Username" autocomplete="off" autocapitalize="none" spellcheck="false" required maxlength="32" pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]{1,31}"} aria-label="Username" bind:value={username} />
    <input placeholder="Display name (optional)" maxlength="60" aria-label="Display name" bind:value={displayName} />
    <input type="password" placeholder="Initial password" autocomplete="new-password" minlength="8" required aria-label="Initial password" bind:value={password} />
    <label class="check"><input type="checkbox" bind:checked={isAdmin} /> Admin</label>
    <button type="submit" disabled={busy}>Add account</button>
  </form>
  {#if notice}<p class="ok" role="status">{notice}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .panel { border: 1px solid var(--line); border-radius: var(--radius); padding: 6px 20px 18px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; justify-content: space-between; align-items: center; gap: 12px 16px; padding: 12px 0; flex-wrap: wrap; }
  li + li { border-top: 1px solid var(--line); }
  li.disabled strong { color: var(--muted); }
  .who { min-width: 0; }
  strong { font-weight: 500; display: block; }
  small { color: var(--muted); font-size: 12px; }
  .row-actions { display: flex; gap: 8px; }
  .reset { flex-basis: 100%; display: flex; gap: 8px; flex-wrap: wrap; }
  .create { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
  input:not([type="checkbox"]) { flex: 1; min-width: 150px; background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 6px 10px; font: inherit; }
  .check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; }
  button:disabled { opacity: .5; cursor: default; }
  .danger:hover { color: var(--warn); border-color: var(--warn); }
  .ok { color: var(--ok); margin-top: 8px; font-size: 13px; }
  .error { color: var(--warn); margin-top: 8px; font-size: 13px; }
</style>
