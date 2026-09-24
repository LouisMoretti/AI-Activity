<script lang="ts">
  import type { StatVM } from "../lib/view-model.ts";

  let { stats }: { stats: StatVM[] } = $props();
</script>

<section class="stats" aria-label="Activity statistics">
  {#each stats as s (s.label)}
    <div class="stat"><strong class="tabular">{s.value}</strong><span>{s.label}</span></div>
  {/each}
</section>

<style>
  .stats { display: grid; grid-template-columns: repeat(5, 1fr); border: 1px solid var(--line); border-radius: 15px; padding: 20px 0; }
  .stat { text-align: center; padding: 0 8px; border-right: 1px solid var(--line); }
  .stat:last-child { border: 0; }
  strong { display: block; font-size: 17px; font-weight: 550; }
  span { display: block; color: var(--muted); margin-top: 3px; font-size: 13px; }
  @media (max-width: 720px) {
    .stats { grid-template-columns: repeat(2, 1fr); gap: 18px 0; }
    .stat:nth-child(2n) { border: 0; }
  }
</style>
