<script lang="ts">
  import { onMount } from "svelte";
  import type { Device } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { copyPending, installCommand, type Platform } from "../lib/clipboard.ts";
  import { fmtAgo } from "../lib/format.ts";
  import { TOOL_META } from "../lib/view-model.ts";

  let devices = $state<Device[] | null>(null);
  let name = $state("");
  let error = $state("");
  let busy = $state(false);
  // Shown right after creation (or when copying failed); the list never holds keys.
  let created = $state<{ name: string; key: string } | null>(null);
  let copied = $state(false);
  // Row and button just copied, for the "Copied" feedback.
  let copiedId = $state.raw<{ id: number; what: "key" | Platform } | null>(null);

  // `?? []`: a client newer than the server (mid-deploy) still renders.
  const collectors = (d: Device) => d.collectors ?? [];

  const fmtDate = (sec: number) =>
    new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  async function refresh() {
    try {
      devices = (await api.devices()).devices;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  onMount(() => { void refresh(); });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    busy = true;
    error = "";
    try {
      created = { name: n, key: (await api.createDevice(n)).key };
      copied = false;
      name = "";
      await refresh();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function revoke(d: Device) {
    if (!confirm(`Revoke "${d.name}"? Its collector will stop being accepted.`)) return;
    error = "";
    try {
      await api.revokeDevice(d.id);
      await refresh();
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      copied = true;
    } catch {
      copied = false;
    }
  }

  // The key is fetched on click, one at a time: copied alone, or inside
  // the device's install command for its platform.
  async function copyKey(d: Device, what: "key" | Platform) {
    error = "";
    const key = api.deviceKey(d.id).then((r) => r.key);
    const text = what === "key" ? key : key.then((k) => installCommand(k, what));
    try {
      await copyPending(text);
      const mark = { id: d.id, what };
      copiedId = mark;
      setTimeout(() => { if (copiedId === mark) copiedId = null; }, 2000);
    } catch {
      // No clipboard access: show the key so it can be copied by hand.
      try {
        created = { name: d.name, key: await key };
        copied = false;
      } catch (keyErr) {
        // The key request itself failed (e.g. revoked in another tab): show
        // its error, not the clipboard's, and drop the stale button.
        error = (keyErr as Error).message;
        void refresh();
      }
    }
  }
</script>

<div class="panel">
  {#if created}
    <div class="key" role="status">
      <p>Key for <strong>{created.name}</strong>. Store it on that machine; <em>Copy key</em> gives it back later.</p>
      <div class="row">
        <code class="mono">{created.key}</code>
        <button type="button" onclick={copy}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" onclick={() => (created = null)}>Done</button>
      </div>
      <p>Or run this on that machine to install the collectors of the tools it has. Linux or macOS:</p>
      <div class="row"><code class="mono">{installCommand(created.key, "unix")}</code></div>
      <p>Windows (PowerShell):</p>
      <div class="row"><code class="mono">{installCommand(created.key, "windows")}</code></div>
    </div>
  {/if}

  {#if devices === null}
    <p class="muted">Loading devices…</p>
  {:else}
    <ul>
      {#each devices as d (d.id)}
        <li class:revoked={d.revoked}>
          <div>
            <strong>{d.name}</strong>
            <small><span class="mono">{d.key_prefix}…</span> · added {fmtDate(d.created_at)}{#if !d.revoked}{#each collectors(d).filter((c) => !c.outdated) as c (c.tool)}{" · "}{TOOL_META[c.tool].name} v{c.version}{/each}{/if}</small>
            {#if !d.revoked}
              {#each collectors(d).filter((c) => c.outdated) as c (c.tool)}
                {@const old = `${c.version ? `v${c.version}` : "a version from before versions"}, posted ${fmtAgo(c.seen_at, Date.now() / 1000)}`}
                <p class="outdated">
                  {#if c.newest >= c.latest}
                    An old {TOOL_META[c.tool].name} collector still posts from this device ({old}; latest v{c.latest}).
                    Run the install command again, and remove any other copy of it.
                  {:else}
                    {TOOL_META[c.tool].name} collector outdated ({old}; latest v{c.latest}).
                    Run this device's install command again to update it.
                  {/if}
                </p>
              {/each}
            {/if}
          </div>
          {#if d.revoked}
            <span class="muted">Revoked</span>
          {:else}
            <div class="actions">
              {#if d.has_key}
                <button type="button" onclick={() => copyKey(d, "unix")}>{copiedId?.id === d.id && copiedId.what === "unix" ? "Copied" : "Copy install (Linux/macOS)"}</button>
                <button type="button" onclick={() => copyKey(d, "windows")}>{copiedId?.id === d.id && copiedId.what === "windows" ? "Copied" : "Copy install (Windows)"}</button>
                <button type="button" onclick={() => copyKey(d, "key")}>{copiedId?.id === d.id && copiedId.what === "key" ? "Copied" : "Copy key"}</button>
              {/if}
              <button type="button" class="danger" onclick={() => revoke(d)}>Revoke</button>
            </div>
          {/if}
        </li>
      {:else}
        <li class="muted">No devices yet. Create one key per machine: it serves every tool on it.</li>
      {/each}
    </ul>
  {/if}

  <form onsubmit={create}>
    <input placeholder="Device name, e.g. laptop" maxlength="80" bind:value={name} aria-label="Device name" />
    <button type="submit" disabled={busy || !name.trim()}>Create key</button>
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .panel { border: 1px solid var(--line); border-radius: var(--radius); padding: 6px 20px 18px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 12px 0; }
  li + li { border-top: 1px solid var(--line); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  li.revoked strong { color: var(--muted); }
  strong { font-weight: 500; display: block; }
  small { color: var(--muted); font-size: 12px; }
  form { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  input { flex: 1; min-width: 180px; background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 6px 10px; font: inherit; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; }
  button:disabled { opacity: .5; cursor: default; }
  .danger:hover { color: var(--warn); border-color: var(--warn); }
  /* Accent, not the --demo-* palette: this is a real key, never demo data. */
  .key { margin: 12px 0 6px; padding: 12px 14px; border: 1px solid var(--accent); background: var(--surface-2); border-radius: var(--radius-sm); }
  .key strong { display: inline; }
  .key p { font-size: 13px; color: var(--text); }
  .key .row + p { margin-top: 12px; }
  .key .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  code { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--text); }
  .error { color: var(--warn); margin-top: 8px; font-size: 13px; }
  .outdated { color: var(--warn); margin-top: 4px; font-size: 12px; }
</style>
