<script lang="ts">
  import type { ApiValue, ValueResponse } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { fmtNum } from "../lib/format.ts";
  import { toolName } from "../lib/view-model.ts";
  let { username }: { username: string } = $props();
  let enabled = $state(false);
  let data = $state<ValueResponse | null>(null);
  let error = $state("");
  const money = (n: number | null) => n === null ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 }).format(n);
  const coverage = (v: ApiValue) => v.total_events ? `${fmtNum(v.priced_events)} of ${fmtNum(v.total_events)} events priced · ${fmtNum(v.priced_tokens)} of ${fmtNum(v.total_tokens)} tokens covered` : "No recorded usage";
  async function load(name: string) {
    try { const result = await api.value(name); if (enabled && name === username) { data = result; error = ""; } }
    catch (e) { if (enabled && name === username) error = (e as Error).message; }
  }
  $effect(() => {
    if (!enabled) return;
    const name = username;
    data = null;
    void load(name);
    const id = setInterval(() => { if (!document.hidden && name === username) void load(name); }, 15000);
    return () => clearInterval(id);
  });
</script>

<section class="value" aria-label="API-equivalent value">
  <div class="head">
    <div><strong>API-equivalent value</strong><p>Optional estimate at published retail API rates, never actual spend or savings.</p></div>
    <button type="button" aria-expanded={enabled} onclick={() => (enabled = !enabled)}>{enabled ? "Hide estimate" : "Show estimate"}</button>
  </div>
  {#if enabled}
    {#if error}<p role="alert">Could not load estimate: {error}</p>{/if}
    {#if data}
      <div class="periods">
        {#each [{ label: "Today", value: data.today }, { label: "All time", value: data.total }] as item (item.label)}
          <div class="period">
            <span>{item.label}</span><strong>{money(item.value.usd)}{item.value.usd !== null && item.value.priced_events < item.value.total_events ? " (partial)" : ""}</strong>
            <small>{coverage(item.value)}</small>
            {#if item.value.fallback_events}<small>{item.value.fallback_events} event(s) priced with the current-rate fallback</small>{/if}
            {#if item.value.latest_received_at}<small>Latest data: {new Date(item.value.latest_received_at * 1000).toLocaleString()}</small>{/if}
            {#if item.value.by_tool.length}
              <details><summary>By tool and model</summary>
                <div class="columns">
                  <div><b>Tools</b>{#each item.value.by_tool as row}<span>{toolName(row.name)} <strong>{money(row.usd)}</strong></span>{/each}</div>
                  <div><b>Models</b>{#each item.value.by_model as row}<span>{row.name} <strong>{money(row.usd)}</strong></span>{/each}</div>
                </div>
              </details>
            {/if}
          </div>
        {/each}
      </div>
      <p class="fine">{data.note} Rate version {data.price_version}. Sources:
        {#each data.sources as source, i}<a href={source} target="_blank" rel="noopener noreferrer">{new URL(source).hostname}</a>{i < data.sources.length - 1 ? ", " : "."}{/each}
      </p>
    {/if}
  {/if}
</section>

<style>
  .value { margin-top: 24px; border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; font-size: 13px; }
  .head { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
  .head strong { font-size: 15px; }
  p { color: var(--muted); margin: 4px 0 0; line-height: 1.5; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 7px 10px; color: var(--text); white-space: nowrap; }
  .periods { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
  .period { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 12px; display: grid; gap: 4px; }
  .period > strong { font-size: 21px; }
  small { color: var(--muted); }
  details { margin-top: 8px; }
  summary { cursor: pointer; }
  .columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 10px; }
  .columns > div { display: grid; align-content: start; gap: 6px; min-width: 0; }
  .columns span { display: flex; justify-content: space-between; gap: 8px; overflow-wrap: anywhere; }
  .columns span strong { white-space: nowrap; }
  .fine { font-size: 11px; margin-top: 12px; }
  a { color: var(--text); }
  @media (max-width: 640px) { .periods, .columns { grid-template-columns: 1fr; } }
</style>
