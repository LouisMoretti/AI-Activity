<script lang="ts">
  let { pct, label, tone = "accent" }: { pct: number | null; label: string; tone?: "accent" | "claude" } = $props();
  const clamped = $derived(pct === null ? 0 : Math.max(0, Math.min(100, Math.round(pct))));
</script>

{#if pct === null}
  <div class="track" aria-hidden="true"></div>
{:else}
  <div class="track" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={clamped}>
    <div class="fill {tone}" class:high={clamped >= 85} style:width="{clamped}%"></div>
  </div>
{/if}

<style>
  .track { height: 6px; background: var(--track); border-radius: 10px; overflow: hidden; }
  .fill { height: 100%; border-radius: 10px; background: var(--accent); }
  .fill.claude { background: var(--claude); }
  .fill.high { background: var(--warn); }
</style>
