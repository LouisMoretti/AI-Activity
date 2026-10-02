<script lang="ts">
  // Bars (one series), with an optional line over them (a second series on
  // its own scale). Hover, focus or tap a column for its readout.
  let { bars, line = null, labels, summary, label }: {
    bars: number[];
    line?: number[] | null;
    /** One per column: the readout for it (also its aria-label). */
    labels: string[];
    /** Readout while no column is active. */
    summary: string;
    /** What the chart shows, for screen readers. */
    label: string;
  } = $props();

  const W = 600;
  const H = 120;
  const n = $derived(Math.max(1, bars.length));
  const yOf = (v: number, max: number) => 114 - (v / Math.max(1, max)) * 104;
  const barMax = $derived(Math.max(1, ...bars));
  const lineMax = $derived(Math.max(1, ...(line ?? [])));
  const x = (i: number) => ((i + 0.5) / n) * W;
  const path = $derived(line ? line.map((v, i) => `${i ? "L" : "M"}${x(i)},${yOf(v, lineMax)}`).join(" ") : "");

  let active = $state<number | null>(null);
  let focusIndex = $state<number | null>(null);
  const current = $derived(focusIndex !== null && focusIndex < bars.length ? focusIndex : bars.length - 1);
  let hits = $state<HTMLDivElement>();
  const STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };

  function move(e: KeyboardEvent, i: number) {
    const step = STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.min(Math.max(i + step, 0), bars.length - 1);
    focusIndex = next;
    hits?.querySelector<HTMLButtonElement>(`[data-i="${next}"]`)?.focus();
  }
</script>

<p class="readout" aria-live="polite">{active !== null && active < labels.length ? labels[active] : summary}</p>
<div class="chart" role="group" aria-label={label} onmouseleave={() => (active = null)}>
  <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 116H{W} M0 62H{W} M0 10H{W}" stroke="var(--line)" stroke-dasharray="3 5" fill="none" />
    {#each bars as v, i (i)}
      <rect x={(i / n) * W + 1.5} y={yOf(v, barMax)} width={Math.max(1, W / n - 3)} height={114 - yOf(v, barMax)} rx="2"
        fill={i === active ? "var(--heat-4)" : "var(--heat-3)"} />
    {/each}
    {#if path}
      <path d={path} stroke="var(--ai-violet)" stroke-width="2" fill="none" vector-effect="non-scaling-stroke" />
    {/if}
  </svg>
  <div class="hits" bind:this={hits}>
    {#each bars as _, i (i)}
      <button
        class="hit"
        aria-label={labels[i]}
        data-i={i}
        tabindex={i === current ? 0 : -1}
        onkeydown={(e) => move(e, i)}
        onmouseenter={() => (active = i)}
        onfocus={() => { focusIndex = i; active = i; }}
        onblur={() => (active = null)}
        onclick={() => (active = i)}
      ></button>
    {/each}
  </div>
</div>

<style>
  .readout { margin: 0 0 8px; font-size: 12px; color: var(--muted); min-height: 1.5em; }
  .chart { position: relative; width: 100%; height: 120px; }
  svg { display: block; width: 100%; height: 100%; }
  .hits { position: absolute; inset: 0; display: flex; }
  .hit { flex: 1; min-width: 0; padding: 0; border: 0; background: none; border-radius: 2px; }
  .hit:focus-visible { outline-offset: -2px; }
</style>
