<script lang="ts">
  // Keep the tool colour at normal usage, then use shared warning colours.
  let { pct, label }: { pct: number | null; label: string } = $props();
  const clamped = $derived(pct === null ? 0 : Math.max(0, Math.min(100, Math.round(pct))));
</script>

{#if pct === null}
  <div class="track" aria-hidden="true"></div>
{:else}
  <div class="track" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={clamped}>
    <div class="fill" class:warning={clamped >= 70 && clamped < 90}
      class:danger={clamped >= 90} style:width="{clamped}%"></div>
  </div>
{/if}

<style>
  .track { height: 6px; background: var(--track); border-radius: 10px; overflow: hidden; }
  .fill { height: 100%; border-radius: 10px; background: var(--tool, var(--accent)); }
  .fill.warning { background: var(--warn); }
  .fill.danger { background: var(--danger); }
</style>
