<script lang="ts">
  import type { CostCardVM } from "../lib/view-model.ts";

  let { cards }: { cards: CostCardVM[] } = $props();
</script>

<div class="panel">
  {#each cards as c (c.label)}
    <div class="col">
      <span class="label">{c.label}</span>
      {#if c.value === null}
        <p class="value empty">{c.label === "API-rate estimate" ? "Unavailable" : "None recorded"}</p>
      {:else}
        <p class="value num">{c.value}</p>
      {/if}
      <small>{c.note}</small>
    </div>
  {/each}
</div>

<style>
  .panel { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 20px 0; }
  .col { padding: 2px 22px; }
  .col + .col { border-left: 1px solid var(--line); }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint); font-weight: 500; }
  .value { font-size: 19px; margin: 6px 0 4px; }
  .empty { color: var(--muted); font-size: 17px; }
  small { display: block; color: var(--muted); font-size: 12px; max-width: 34ch; }
  @media (max-width: 720px) {
    .panel { grid-template-columns: 1fr; gap: 16px; padding: 18px 0; }
    .col + .col { border-left: 0; border-top: 1px solid var(--line); padding-top: 16px; }
  }
</style>
