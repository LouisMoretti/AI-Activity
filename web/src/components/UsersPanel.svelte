<script lang="ts">
  import { onMount } from "svelte";
  import type { AdminUser } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";

  let { selfId }: { selfId: number } = $props();

  let users = $state<AdminUser[] | null>(null);
  let error = $state("");
  let notice = $state("");
  let busy = $state(false);

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

  function toggleAdmin(u: AdminUser) {
    if (!u.is_admin && !confirm(`Make "${u.username}" an admin? They will manage every account, including yours.`)) return;
    void act(() => api.setUserAdmin(u.id, !u.is_admin),
      u.is_admin ? `"${u.username}" is no longer an admin.` : `"${u.username}" is now an admin.`);
  }

  function toggle(u: AdminUser) {
    if (!u.disabled && !confirm(`Disable "${u.username}"? They are signed out and their devices stop being accepted.`)) return;
    void act(() => api.setUserDisabled(u.id, !u.disabled), u.disabled ? `"${u.username}" enabled.` : `"${u.username}" disabled.`);
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
              · {u.devices} device{u.devices === 1 ? "" : "s"} · since {fmtDate(u.created_at)}{u.disabled ? " · disabled" : ""}{u.github_linked ? "" : " · not linked to GitHub"}
            </small>
          </div>
          <div class="row-actions">
            {#if u.id !== selfId}
              <button type="button" disabled={busy} onclick={() => toggleAdmin(u)}>
                {u.is_admin ? "Remove admin" : "Make admin"}
              </button>
              <button type="button" class:danger={!u.disabled} disabled={busy} onclick={() => toggle(u)}>
                {u.disabled ? "Enable" : "Disable"}
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

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
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; }
  button:disabled { opacity: .5; cursor: default; }
  .danger:hover { color: var(--warn); border-color: var(--warn); }
  .ok { color: var(--ok); margin-top: 8px; font-size: 13px; }
  .error { color: var(--warn); margin-top: 8px; font-size: 13px; }
</style>
