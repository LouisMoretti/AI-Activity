<script lang="ts">
  import { TOOL_META, type QuotaCardVM } from "../lib/view-model.ts";
  import Meter from "./Meter.svelte";

  let { card }: { card: QuotaCardVM } = $props();
</script>

<article class="card {card.tool}">
  <div class="title">
    <span class="icon" aria-hidden="true">{TOOL_META[card.tool].icon}</span>
    <h3>{card.name}</h3>
    <span class="badge">{card.badge}</span>
  </div>
  {#each card.rows as r (r.label)}
    <div class="row">
      <div class="value"><span>{r.label}</span><strong class="tabular">{r.pct === null ? "Unavailable" : `${r.pct} %`}</strong></div>
      <Meter pct={r.pct} label={r.label} tone={card.tool === "claude-code" ? "claude" : "accent"} />
      <div class="reset">
        <span>{r.reset}</span>
        <span class:warn={r.pct !== null && r.pct >= 85}>
          {r.pct === null ? "not exposed by the provider" : `${Math.round((100 - r.pct) * 10) / 10} % remaining`}
        </span>
      </div>
    </div>
  {/each}
</article>

<style>
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; }
  .title { display: flex; align-items: center; gap: 11px; margin-bottom: 24px; }
  .icon { width: 31px; height: 31px; display: grid; place-items: center; background: #292d35; color: var(--accent); border-radius: 8px; font-size: 21px; }
  .claude-code .icon { background: #322923; color: var(--claude); }
  h3 { font-size: 16px; font-weight: 550; }
  .badge { margin-left: auto; color: var(--muted); border: 1px solid var(--line); border-radius: 5px; font-size: 12px; padding: 2px 7px; }
  .row + .row { margin-top: 24px; }
  .value { display: flex; justify-content: space-between; margin-bottom: 9px; }
  .value strong { font-weight: 500; }
  .reset { display: flex; justify-content: space-between; gap: 6px; font-size: 12px; color: var(--muted); margin-top: 8px; }
  .warn { color: var(--warn); }
</style>
