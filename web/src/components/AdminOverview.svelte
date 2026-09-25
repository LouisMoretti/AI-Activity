<script lang="ts">
  import { onMount } from "svelte";
  import type { AdminOverview } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { clock } from "../lib/clock.svelte.ts";
  import { fmtAgo, fmtCompact } from "../lib/format.ts";

  let o = $state<AdminOverview | null>(null);
  let error = $state("");

  onMount(async () => {
    try {
      o = await api.adminOverview();
    } catch (e) {
      error = (e as Error).message;
    }
  });

  const tiles = $derived(o ? [
    { label: "Accounts", value: String(o.accounts), note: o.disabled_accounts ? `${o.disabled_accounts} disabled` : "all enabled" },
    { label: "Devices", value: String(o.devices), note: "live ingestion keys" },
    { label: "Conversations", value: fmtCompact(o.sessions), note: `${fmtCompact(o.events)} API calls` },
    { label: "Last usage received", value: o.last_event_at ? fmtAgo(o.last_event_at, clock.now) : "Never", note: "any account" },
  ] : []);
</script>

{#if o}
  <div class="tiles">
    {#each tiles as t (t.label)}
      <div class="tile"><small>{t.label}</small><strong>{t.value}</strong><span>{t.note}</span></div>
    {/each}
  </div>
{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}

<style>
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 12px; }
  .tile { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; display: grid; gap: 4px; }
  .tile small { font-size: 12px; color: var(--muted); }
  .tile strong { font-size: 20px; font-weight: 600; }
  .tile span { font-size: 12px; color: var(--faint); }
  .error { color: var(--warn); margin-top: 8px; font-size: 13px; }
</style>
