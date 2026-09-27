<script lang="ts">
  import { onMount } from "svelte";
  import type { Device } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { copyPending, installCommand } from "../lib/clipboard.ts";
  import { TOOL_META, type ToolKey } from "../lib/view-model.ts";

  // The owner's tools that never sent anything, and the one command that
  // installs their collectors on a device (README.md, "One-command install").
  let { missing, onsettings }: { missing: ToolKey[]; onsettings: () => void } = $props();

  const WHAT: Record<ToolKey, string> = {
    "claude-code": "Tokens, conversations, 5-hour and weekly limits",
    codex: "Tokens, conversations, 5-hour and weekly limits",
    opencode: "Tokens and conversations, any provider",
  };

  let devices = $state<Device[] | null>(null);
  let deviceId = $state<number | null>(null);
  let copied = $state(false);
  let error = $state("");
  const usable = $derived((devices ?? []).filter((d) => !d.revoked && d.has_key));

  onMount(async () => {
    try {
      devices = (await api.devices()).devices;
      deviceId = usable[0]?.id ?? null;
    } catch (e) {
      error = (e as Error).message;
    }
  });

  async function copy() {
    if (deviceId === null) return;
    error = "";
    try {
      await copyPending(api.deviceKey(deviceId).then((r) => installCommand(r.key)));
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      error = "Could not copy: use Copy install command in Settings → Devices.";
    }
  }
</script>

<article class="card">
  <div class="head"><span class="label">Add a tool</span></div>
  <ul>
    {#each missing as t (t)}
      <li>
        <span class="icon {t}" aria-hidden="true">{TOOL_META[t].icon}</span>
        <div><strong>{TOOL_META[t].name}</strong><small>{WHAT[t]}</small></div>
      </li>
    {/each}
  </ul>

  <p class="how">Run this on the machine, as the user who runs the tools (no sudo). It installs the collector of each tool it finds and keeps your existing settings.</p>
  <code class="mono">{installCommand("<device key>")}</code>

  {#if devices === null && !error}
    <p class="meta">Loading devices…</p>
  {:else if usable.length}
    <div class="row">
      {#if usable.length > 1}
        <select bind:value={deviceId} aria-label="Device">
          {#each usable as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
        </select>
      {/if}
      <button type="button" onclick={copy}>{copied ? "Copied" : usable.length > 1 ? "Copy with its key" : `Copy with the key of ${usable[0].name}`}</button>
    </div>
  {:else if devices}
    <div class="row">
      <span class="meta">It needs a device key first.</span>
      <button type="button" onclick={onsettings}>Create one in Settings</button>
    </div>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</article>

<style>
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; min-width: 0; }
  .head { display: flex; align-items: center; margin-bottom: 14px; min-height: 18px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  li { display: flex; align-items: center; gap: 11px; }
  .icon { flex-shrink: 0; width: 31px; height: 31px; display: grid; place-items: center; border-radius: 8px; font-size: 19px; background: var(--surface-2); }
  .icon.claude-code { background: color-mix(in srgb, var(--claude) 16%, var(--surface)); color: var(--claude); }
  .icon.codex { background: color-mix(in srgb, var(--codex) 14%, var(--surface)); color: var(--codex); }
  .icon.opencode { background: color-mix(in srgb, var(--opencode) 14%, var(--surface)); color: var(--opencode); }
  strong { display: block; font-weight: 550; font-size: 14px; }
  small { color: var(--muted); font-size: 12px; }
  .how { margin-top: 18px; color: var(--muted); font-size: 13px; line-height: 1.5; }
  code { display: block; margin-top: 10px; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 12px; color: var(--text); overflow-wrap: anywhere; }
  .row { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  .meta { color: var(--muted); font-size: 12px; margin-top: 12px; }
  .row .meta { margin-top: 0; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; font-size: 12px; }
  button:hover { border-color: var(--accent); }
  select { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 5px 8px; font: inherit; font-size: 12px; }
  .error { color: var(--warn); margin-top: 8px; font-size: 13px; }
</style>
