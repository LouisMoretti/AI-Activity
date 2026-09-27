<script lang="ts">
  // The fill takes the tool colour from an inherited `--tool` (accent otherwise).
  let { pct, label }: { pct: number | null; label: string } = $props();
  const clamped = $derived(pct === null ? 0 : Math.max(0, Math.min(100, Math.round(pct))));
</script>

{#if pct === null}
  <div class="track" aria-hidden="true"></div>
{:else}
  <div class="track" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={clamped}>
    <div class="fill" style:width="{clamped}%" style:--fill-pct="{clamped}%"></div>
  </div>
{/if}

<style>
  .track { height: 6px; background: var(--track); border-radius: 10px; overflow: hidden; }
  .fill {
    height: 100%; border-radius: 10px;
    background: var(--tool-meter-start, var(--tool, var(--accent)));
    background: color-mix(in srgb, var(--tool-meter-start, var(--tool, var(--accent))), var(--tool-meter-limit, var(--accent-meter-limit)) var(--fill-pct));
  }
</style>
