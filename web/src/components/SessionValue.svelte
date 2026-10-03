<script lang="ts">
  import type { ApiValue, Session } from "../../../shared/types.ts";
  import { fmtNum, fmtUsd } from "../lib/format.ts";

  let { value, unpriced }: { value: ApiValue; unpriced: Session["unpriced"] } = $props();
  const id = $props.id();
  const warning = $derived(value.usd === null || value.unpriced_tokens > 0 || value.lower_bound ||
    value.current_rate_fallback || value.unverified);
</script>

<div class="value">
  <span>API value (estimate)</span>
  <span class="right">
    <strong>{value.usd === null ? "—" : `${value.lower_bound ? "≥" : "≈"} ${fmtUsd(value.usd)}`}</strong>
    {#if warning}
      <span class="explain">
        <button type="button" aria-label="Why this API value needs attention" aria-describedby={id}>!</button>
        <span class="tip" role="tooltip" {id}>
          {#if value.usd === null}
            <span>No API value can be calculated for this conversation.</span>
          {:else}
            <span>Estimated at retail API rates, not the amount paid.</span>
          {/if}
          {#if value.unpriced_tokens > 0}
            <span>{fmtNum(value.unpriced_tokens)} {value.unpriced_tokens === 1 ? "token" : "tokens"} left out:</span>
            {#each unpriced as item}
              <span class="reason">{item.model ?? "Model not reported"}: {item.reason} ({fmtNum(item.tokens)} tokens).</span>
            {/each}
          {:else if value.usd === null}
            <span>No measured tokens have a price.</span>
          {/if}
          {#if value.lower_bound}
            <span>Some cache writes have no recorded duration, so they use the cheaper 5-minute rate.</span>
          {/if}
          {#if value.current_rate_fallback}
            <span>Some usage predates its model's oldest known rate and uses that rate.</span>
          {/if}
          {#if value.unverified}
            <span>Some rates come from the community catalog and have not been verified against the provider's official prices.</span>
          {/if}
        </span>
      </span>
    {/if}
  </span>
</div>

<style>
  .value { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; }
  .right { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  strong { color: var(--text); font-weight: 500; }
  .explain { position: relative; display: inline-flex; }
  button { width: 16px; height: 16px; border: 1px solid var(--warn); border-radius: 50%; color: var(--warn); font-size: 11px; font-weight: 700; line-height: 1; cursor: help; }
  .tip { position: absolute; z-index: 20; top: calc(100% + 6px); right: 0; width: max-content; max-width: min(320px, calc(100vw - 48px)); max-height: 240px; overflow: auto; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--raised); color: var(--text); box-shadow: 0 8px 24px #0007; white-space: normal; font-size: 12px; line-height: 1.4; visibility: hidden; opacity: 0; transition: opacity .12s ease; }
  .tip > span { display: block; }
  .tip > span + span { margin-top: 6px; }
  .reason { color: var(--muted); }
  .explain:hover .tip, .explain:focus-within .tip { visibility: visible; opacity: 1; }
</style>
