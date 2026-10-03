<script lang="ts">
  import type { ApiValue, Session } from "../../../shared/types.ts";
  import { fmtCompact, fmtUsd } from "../lib/format.ts";

  // A conversation's API-equivalent value, inline ("≈ $1.20"). Nothing when
  // none of its tokens is priced. An info icon explains the same caveats as
  // the API value stat (StatsRow) on hover or keyboard focus.
  let { value, unpriced }: { value: ApiValue; unpriced: Session["unpriced"] } = $props();
  const id = $props.id();
  const caveat = $derived(value.unpriced_tokens > 0 || value.lower_bound || value.current_rate_fallback);
</script>

{#if value.usd !== null}
  <span class="value">
    <span class="num" title="API-equivalent value (estimate)">{value.lower_bound ? "≥" : "≈"} {fmtUsd(value.usd)}</span>
    {#if caveat}
      <span class="explain">
        <button type="button" aria-label="About this API value" aria-describedby={id}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3" />
            <path d="M8 7.2v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <circle cx="8" cy="4.9" r=".9" fill="currentColor" />
          </svg>
        </button>
        <span class="tip" role="tooltip" {id}>
          <span>At retail API rates: an estimate, not what was paid.</span>
          {#if value.unpriced_tokens > 0}
            <span class="warn">Leaves out {fmtCompact(value.unpriced_tokens)} tokens:</span>
            {#each unpriced as item}
              <span class="reason"><span class="model">{item.model ?? "model not reported"}</span>: {item.reason} ({fmtCompact(item.tokens)})</span>
            {/each}
          {/if}
          {#if value.lower_bound}
            <span class="warn">At least: some cache writes have no recorded duration and use the cheaper 5-minute rate.</span>
          {/if}
          {#if value.current_rate_fallback}
            <span class="warn">Some usage predates its model's oldest published rate and uses that rate.</span>
          {/if}
          {#if value.unverified}
            <span>Includes community rates (LiteLLM's price list).</span>
          {/if}
        </span>
      </span>
    {/if}
  </span>
{/if}

<style>
  .value { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .num { color: var(--text); }
  .explain { position: relative; display: inline-flex; }
  button { display: inline-flex; padding: 0; color: var(--faint); cursor: help; }
  button:hover, button:focus-visible { color: var(--text); }
  .tip {
    position: absolute; z-index: 20; top: calc(100% + 8px); right: -6px;
    width: max-content; max-width: min(300px, calc(100vw - 32px)); padding: 10px 12px;
    background: var(--raised); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 8px 24px #0007;
    color: var(--muted); font-size: 12px; line-height: 1.45; white-space: normal; text-align: left;
    opacity: 0; visibility: hidden; transition: opacity .12s ease;
  }
  .tip > span { display: block; }
  .tip > span + span { margin-top: 4px; }
  .warn { color: var(--warn); }
  .reason { padding-left: 8px; }
  .model { font-family: var(--mono); font-size: 11px; }
  .explain:hover .tip, .explain:focus-within .tip { opacity: 1; visibility: visible; }
</style>
