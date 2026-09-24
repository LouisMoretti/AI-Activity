<script lang="ts">
  import type { BillingCardVM } from "../lib/view-model.ts";

  let { cards }: { cards: BillingCardVM[] } = $props();
</script>

<div class="grid">
  {#each cards as c (c.title)}
    <article>
      <h3>{c.title}</h3>
      <p class="tabular">{c.value}</p>
      <small>{c.note}</small>
    </article>
  {/each}
</div>

<style>
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  article { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; }
  h3 { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
  p { font-size: 17px; margin-bottom: 8px; }
  small { color: var(--muted); font-size: 12px; white-space: pre-line; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
</style>
