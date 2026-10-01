<script lang="ts">
  import { onMount } from "svelte";
  import type { Device } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { installCommand, type Platform } from "../lib/clipboard.ts";
  import { fmtAgo } from "../lib/format.ts";
  import { setupPrompt } from "../lib/setup-prompt.ts";
  import { TOOL_META } from "../lib/view-model.ts";

  let devices = $state<Device[] | null>(null);
  let name = $state("");
  let error = $state("");
  let busy = $state(false);
  // Only the open setup panel holds a key; device rows never receive it.
  let setup = $state<{ id: number; name: string; key: string } | null>(null);
  let loadingSetup = $state<number | null>(null);
  let copiedAction = $state<"key" | Platform | "prompt" | null>(null);
  let fallback = $state<{ label: string; text: string } | null>(null);
  let prompt = $derived(setup ? setupPrompt(setup.key, location.origin) : "");

  async function openSetup(d: Device) {
    error = "";
    setup = null;
    fallback = null;
    copiedAction = null;
    loadingSetup = d.id;
    try {
      const { key } = await api.deviceKey(d.id);
      if (loadingSetup === d.id) setup = { id: d.id, name: d.name, key };
    } catch (err) {
      error = (err as Error).message;
      void refresh();
    } finally {
      if (loadingSetup === d.id) loadingSetup = null;
    }
  }

  async function copySetup(what: "key" | Platform | "prompt") {
    if (!setup) return;
    const text = what === "key" ? setup.key
      : what === "prompt" ? prompt : installCommand(setup.key, what);
    fallback = null;
    try {
      await navigator.clipboard.writeText(text);
      copiedAction = what;
      setTimeout(() => { if (copiedAction === what) copiedAction = null; }, 2000);
    } catch {
      copiedAction = null;
      fallback = { label: what === "key" ? "Device key" : what === "prompt" ? "AI setup prompt" : "Install command", text };
      error = "Clipboard access failed. Select and copy the text shown below.";
    }
  }

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
      const device = await api.createDevice(n);
      setup = { id: device.id, name: n, key: device.key };
      copiedAction = null;
      fallback = null;
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
      if (setup?.id === d.id) setup = null;
      await api.revokeDevice(d.id);
      await refresh();
    } catch (err) {
      error = (err as Error).message;
    }
  }

</script>

<div class="panel">
  {#if setup}
    <section class="setup" aria-label="Set up {setup.name}">
      <div class="setup-heading">
        <strong>Set up {setup.name}</strong>
        <button type="button" onclick={() => (setup = null)}>Close</button>
      </div>
      <p>Run the command for this device's operating system, or ask your AI to run it and explain the result. The installer finds the tools on that device.</p>
      <div class="setup-actions">
        <button type="button" onclick={() => copySetup("unix")}>{copiedAction === "unix" ? "Copied" : "Copy Linux/macOS command"}</button>
        <button type="button" onclick={() => copySetup("windows")}>{copiedAction === "windows" ? "Copied" : "Copy Windows command"}</button>
        <button type="button" onclick={() => copySetup("prompt")}>{copiedAction === "prompt" ? "Copied" : "Copy AI setup prompt"}</button>
      </div>
      <p class="key-note">The AI prompt includes this device's ingestion key. Sharing the prompt with an AI service shares that key.</p>
      <details>
        <summary>Review AI prompt</summary>
        <textarea class="mono" readonly value={prompt} aria-label="Full AI setup prompt"></textarea>
      </details>
      <details>
        <summary>Device key</summary>
        <div class="key-row">
          <code class="mono">{setup.key}</code>
          <button type="button" onclick={() => copySetup("key")}>{copiedAction === "key" ? "Copied" : "Copy key"}</button>
        </div>
      </details>
      {#if fallback}
        <label class="fallback-label" for="setup-fallback">{fallback.label}</label>
        <textarea id="setup-fallback" class="mono" readonly value={fallback.text}></textarea>
      {/if}
    </section>
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
                <button type="button" disabled={loadingSetup === d.id} onclick={() => openSetup(d)}>{loadingSetup === d.id ? "Loading…" : "Set up"}</button>
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
  .setup { margin: 12px 0 6px; padding: 12px 14px; border: 1px solid var(--accent); background: var(--surface-2); border-radius: var(--radius-sm); }
  .setup-heading, .key-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .setup p { font-size: 13px; }
  .setup-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  .key-note { color: var(--warn); }
  details { margin-top: 10px; font-size: 13px; }
  summary { cursor: pointer; }
  .key-row { justify-content: flex-start; margin-top: 8px; }
  code { min-width: 0; overflow-wrap: anywhere; color: var(--text); }
  textarea { display: block; width: 100%; min-height: 220px; margin-top: 8px; padding: 10px; resize: vertical; overflow-wrap: anywhere; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text); font-family: var(--mono); font-size: 12px; }
  .fallback-label { display: block; margin-top: 12px; font-size: 13px; }
  #setup-fallback { min-height: 85px; }
  .error { color: var(--warn); margin-top: 8px; font-size: 13px; }
  .outdated { color: var(--warn); margin-top: 4px; font-size: 12px; }
</style>
