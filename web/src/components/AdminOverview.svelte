<script lang="ts">
  import { onMount } from "svelte";
  import type { AdminOverview } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { clock } from "../lib/clock.svelte.ts";
  import { fmtAgo, fmtCompact } from "../lib/format.ts";

  let o = $state<AdminOverview | null>(null);
  let signupOpen = $state<boolean | null>(null);
  let error = $state("");
  let saving = $state(false);

  onMount(async () => {
    try {
      [o, signupOpen] = await Promise.all([api.adminOverview(), api.adminSettings().then((s) => s.signup_open)]);
    } catch (e) {
      error = (e as Error).message;
    }
  });

  async function toggle() {
    if (signupOpen === null) return;
    saving = true;
    error = "";
    try {
      signupOpen = (await api.setSignupOpen(!signupOpen)).signup_open;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
    }
  }

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
{#if signupOpen !== null}
  <div class="setting">
    <div>
      <strong>Account creation</strong>
      <small>{signupOpen
        ? "Anyone can create an account from the sign-in page."
        : "Closed: nobody can create an account from the site. Existing accounts still sign in."}</small>
    </div>
    <button type="button" role="switch" aria-checked={signupOpen} aria-label="Allow account creation" disabled={saving} onclick={toggle}>
      <span class="knob"></span>
    </button>
  </div>
{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}

<style>
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 12px; }
  .tile { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; display: grid; gap: 4px; }
  .tile small { font-size: 12px; color: var(--muted); }
  .tile strong { font-size: 20px; font-weight: 600; }
  .tile span { font-size: 12px; color: var(--faint); }
  .setting { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 16px; border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 20px; }
  .setting strong { display: block; font-weight: 500; }
  .setting small { font-size: 12px; color: var(--muted); }
  [role="switch"] { flex: none; width: 40px; height: 22px; border-radius: 999px; background: var(--track); border: 1px solid var(--line); position: relative; padding: 0; }
  [role="switch"][aria-checked="true"] { background: var(--accent); }
  [role="switch"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--text); transition: left .15s; }
  [aria-checked="true"] .knob { left: 20px; background: var(--bg); }
  @media (prefers-reduced-motion: reduce) { .knob { transition: none; } }
  .error { color: var(--warn); margin-top: 8px; font-size: 13px; }
</style>
