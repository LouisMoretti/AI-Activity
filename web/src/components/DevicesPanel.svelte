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
  let setupRequest = 0;
  let copiedAction = $state<"key" | Platform | "prompt" | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let fallback = $state<{ label: string; text: string } | null>(null);
  let prompt = $derived(setup ? setupPrompt(setup.key, location.origin) : "");

  async function openSetup(d: Device) {
    if (setup?.id === d.id) {
      ++setupRequest;
      loadingSetup = null;
      return;
    }
    error = "";
    const request = ++setupRequest;
    loadingSetup = d.id;
    try {
      const { key } = await api.deviceKey(d.id);
      if (request !== setupRequest) return;
      clearTimeout(copyTimer);
      setup = { id: d.id, name: d.name, key };
      fallback = null;
      copiedAction = null;
    } catch (err) {
      if (request !== setupRequest) return;
      error = (err as Error).message;
      void refresh();
    } finally {
      if (request === setupRequest) loadingSetup = null;
    }
  }

  function closeSetup() {
    ++setupRequest;
    loadingSetup = null;
    clearTimeout(copyTimer);
    setup = null;
    fallback = null;
    copiedAction = null;
  }

  async function copySetup(what: "key" | Platform | "prompt") {
    if (!setup) return;
    const current = setup;
    const text = what === "key" ? current.key
      : what === "prompt" ? prompt : installCommand(current.key, what);
    fallback = null;
    try {
      await navigator.clipboard.writeText(text);
      if (setup?.id !== current.id) return;
      error = "";
      clearTimeout(copyTimer);
      copiedAction = what;
      copyTimer = setTimeout(() => { copiedAction = null; }, 2000);
    } catch {
      if (setup?.id !== current.id) return;
      clearTimeout(copyTimer);
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
      ++setupRequest;
      loadingSetup = null;
      clearTimeout(copyTimer);
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
      if (loadingSetup === d.id) {
        ++setupRequest;
        loadingSetup = null;
      }
      if (setup?.id === d.id) closeSetup();
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
        <button type="button" class="setup-close" aria-label="Close setup" title="Close setup" onclick={closeSetup}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 5 19 19M19 5 5 19"/></svg>
        </button>
      </div>
      <p>Run the command for this device's operating system, or ask your AI to run it and explain the result. The installer finds the tools on that device.</p>
      <div class="setup-actions">
        <button type="button" class="ai-copy" class:copy-success={copiedAction === "prompt"} onclick={() => copySetup("prompt")}
          aria-label="Copy AI setup prompt to clipboard">
          <svg class="ai-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <defs><linearGradient id="setup-ai-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--ai-blue)"/><stop offset="1" stop-color="var(--ai-violet)"/></linearGradient></defs>
            <path d="M12 2.5c.65 5.45 1.65 6.45 7.1 7.1-5.45.65-6.45 1.65-7.1 7.1-.65-5.45-1.65-6.45-7.1-7.1 5.45-.65 6.45-1.65 7.1-7.1Z" fill="url(#setup-ai-gradient)"/>
            <circle cx="19.5" cy="18.5" r="1.5" fill="url(#setup-ai-gradient)"/>
          </svg>
          <span>Copy AI setup prompt</span>
        </button>
        <button type="button" class="copy-action" class:copy-success={copiedAction === "unix"} onclick={() => copySetup("unix")}>
          <span>Copy Linux/macOS command</span>
        </button>
        <button type="button" class="copy-action" class:copy-success={copiedAction === "windows"} onclick={() => copySetup("windows")}>
          <span>Copy Windows command</span>
        </button>
      </div>
      <span class="copy-feedback" aria-live="polite" aria-atomic="true">{copiedAction === "prompt" ? "AI setup prompt ready to paste." : copiedAction === "unix" ? "Linux/macOS command ready to paste." : copiedAction === "windows" ? "Windows command ready to paste." : ""}</span>
      <p class="key-note">The AI prompt includes this device's ingestion key. Sharing the prompt with an AI service shares that key.</p>
      <details>
        <summary>Review AI prompt</summary>
        <textarea class="mono" readonly value={prompt} aria-label="Full AI setup prompt"></textarea>
      </details>
      <div class="key-block">
        <span class="key-label">Device key</span>
        <div class="key-code-block">
          <pre><code class="mono">{setup.key}</code></pre>
          <button type="button" class="key-copy" class:copy-success={copiedAction === "key"}
            aria-label="Copy device key to clipboard" onclick={() => copySetup("key")}>
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/></svg>
            Copy
          </button>
        </div>
        <span class="copy-feedback key-copy-feedback" class:active={copiedAction === "key"} aria-live="polite" aria-atomic="true">{copiedAction === "key" ? "Device key ready to paste." : ""}</span>
      </div>
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
                {@const old = `${c.version ? `v${c.version}` : "a version from before versions"} last posted ${fmtAgo(c.seen_at, Date.now() / 1000)}`}
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
  .danger { color: var(--danger); border-color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .danger:hover { background: color-mix(in srgb, var(--danger) 18%, transparent); }
  .setup { margin: 12px 0 6px; padding: 12px 14px; border: 1px solid var(--line); background: var(--surface-2); border-radius: var(--radius-sm); }
  .setup-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  .setup-close { display: grid; place-items: center; flex: none; width: 32px; height: 32px; padding: 0; border: 0; background: none; }
  .setup-close:hover { background: var(--raised); }
  .setup-close svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
  .setup p { font-size: 13px; }
  .setup-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 4px; }
  .setup-actions button, .copy-action { display: inline-flex; align-items: center; justify-content: center; gap: 8px; white-space: nowrap; }
  .copy-action { color: var(--text); border-color: var(--line); background: none; }
  .ai-copy { border: 1px solid transparent; color: var(--text); background: linear-gradient(var(--surface-2), var(--surface-2)) padding-box, linear-gradient(120deg, var(--ai-blue), var(--ai-violet)) border-box; }
  .ai-copy:hover { background: linear-gradient(var(--raised), var(--raised)) padding-box, linear-gradient(120deg, var(--ai-blue), var(--ai-violet)) border-box; box-shadow: 0 0 15px color-mix(in srgb, var(--ai-violet) 18%, transparent); }
  .ai-mark { width: 18px; height: 18px; flex: none; }
  .copy-success, .copy-success:hover, .ai-copy.copy-success, .ai-copy.copy-success:hover { color: var(--ok); border-color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, var(--surface-2)); box-shadow: none; }
  .copy-feedback { display: block; min-height: 18px; color: var(--ok); font-size: 12px; }
  .key-copy-feedback { min-height: 0; }
  .key-copy-feedback.active { margin-top: 4px; }
  .key-note { color: var(--warn); }
  details { margin-top: 10px; font-size: 13px; }
  summary { cursor: pointer; }
  .key-block { margin-top: 14px; }
  .key-label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 12px; }
  .key-code-block { position: relative; min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg); }
  .key-code-block pre { margin: 0; padding: 13px 86px 13px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .key-code-block code { color: var(--text); }
  .key-copy { position: absolute; top: 7px; right: 7px; display: inline-flex; align-items: center; gap: 5px; padding: 4px 7px; color: var(--text); border-color: var(--line); background: var(--surface-2); font-size: 12px; }
  .copy-action:hover:not(.copy-success), .key-copy:hover:not(.copy-success) { border-color: var(--faint); background: var(--raised); }
  .key-copy.copy-success, .key-copy.copy-success:hover { color: var(--ok); border-color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, var(--surface-2)); }
  .key-copy svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  textarea { display: block; width: 100%; min-height: 220px; margin-top: 8px; padding: 10px; resize: vertical; overflow-wrap: anywhere; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text); font-family: var(--mono); font-size: 12px; }
  .fallback-label { display: block; margin-top: 12px; font-size: 13px; }
  #setup-fallback { min-height: 85px; }
  .error { color: var(--warn); margin-top: 8px; font-size: 13px; }
  .outdated { color: var(--warn); margin-top: 4px; font-size: 12px; }
</style>
