<script lang="ts">
  import { onMount } from "svelte";
  import type { AdminPricing } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { clock } from "../lib/clock.svelte.ts";
  import { fmtAgo, fmtCompact, plural } from "../lib/format.ts";
  import { toolName } from "../lib/view-model.ts";

  // Where API-equivalent values come from, and the models still unpriced:
  // what to add to shared/pricing.json next (a rate or an alias).
  let p = $state<AdminPricing | null>(null);
  let error = $state("");

  onMount(async () => {
    try {
      p = await api.adminPricing();
    } catch (e) {
      error = (e as Error).message;
    }
  });

  const litellmNote = $derived.by(() => {
    const l = p?.litellm;
    if (!l) return "";
    if (!l.url) return "Off (LITELLM_PRICES_URL is empty): only the priority file prices usage.";
    const when = l.fetched_at ? `downloaded ${fmtAgo(l.fetched_at, clock.now)}` : "not downloaded yet";
    return `${fmtCompact(l.models)} priced models, ${when}${l.error ? `; last download failed: ${l.error}` : ""}.`;
  });
</script>

{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if p}
  <div class="sources">
    <div class="source">
      <strong>Priority file</strong>
      <small><code>shared/pricing.json</code>, rates of {p.pricing_version}: {plural(p.priority.prices, "verified rate")},
        {p.priority.aliases} {p.priority.aliases === 1 ? "alias" : "aliases"}. Checked first.</small>
    </div>
    <div class="source">
      <strong>LiteLLM price list</strong>
      <small class:warn={p.litellm.error}>{litellmNote} Used for models the priority file lacks, shown as unverified.</small>
    </div>
  </div>

  <h3>Unpriced models</h3>
  {#if p.unpriced.length}
    <p class="hint">
      Their tokens count as "partial", never $0. To price one, add its rate (with an official source) or an alias to
      another model's price in <code>shared/pricing.json</code>.
    </p>
    <div class="table" role="table" aria-label="Unpriced models">
      <div class="row head" role="row">
        <span role="columnheader">Model</span><span role="columnheader">Why</span>
        <span role="columnheader" class="num">Tokens</span><span role="columnheader" class="num">Accounts</span>
        <span role="columnheader" class="num">Last seen</span>
      </div>
      {#each p.unpriced as m (`${m.tool}/${m.model}/${m.reason}`)}
        <div class="row" role="row">
          <span role="cell"><small>{toolName(m.tool)}</small> <code>{m.model ?? "(none)"}</code></span>
          <span role="cell" class="reason">{m.reason}</span>
          <span role="cell" class="num">{fmtCompact(m.tokens)}</span>
          <span role="cell" class="num">{m.accounts}</span>
          <span role="cell" class="num">{fmtAgo(m.last_seen, clock.now)}</span>
        </div>
      {/each}
    </div>
  {:else}
    <p class="hint">Every model used on this server has a rate.</p>
  {/if}
{/if}

<style>
  .sources { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; }
  .source { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; display: grid; gap: 4px; }
  .source strong { font-weight: 500; }
  .source small, .hint { font-size: 12px; color: var(--muted); }
  .warn { color: var(--warn) !important; }
  h3 { font-size: 13px; font-weight: 500; margin: 20px 0 6px; }
  .hint { margin-bottom: 10px; }
  code { font-family: var(--mono); font-size: 11px; }
  .table { border: 1px solid var(--line); border-radius: var(--radius); padding: 4px 16px; }
  .row { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1.4fr) 70px 70px 90px; gap: 12px; align-items: center; padding: 8px 0; font-size: 12px; }
  .row + .row { border-top: 1px solid var(--line); }
  .row.head { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row small { color: var(--muted); }
  .reason { color: var(--muted); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .error { color: var(--warn); font-size: 13px; }
  @media (max-width: 640px) {
    .row { grid-template-columns: minmax(0, 1fr) 70px; }
    .row .reason, .row span:nth-child(4), .row span:nth-child(5) { display: none; }
  }
</style>
