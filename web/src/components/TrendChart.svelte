<script lang="ts">
  let { values, labels, kind, demo, onhover }: {
    values: number[];
    /** One per value: what the readout shows for it (also its aria-label). */
    labels: string[];
    kind: "weekly" | "cumulative";
    demo: boolean;
    onhover: (i: number | null) => void;
  } = $props();

  const W = 760;
  const H = 110;
  const max = $derived(Math.max(1, ...values));
  const n = $derived(Math.max(1, values.length));
  const y = (v: number) => 103 - (v / max) * 95;
  // Points sit in the middle of their column, like the bars.
  const x = (i: number) => ((i + 0.5) / n) * W;
  const line = $derived(values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" "));

  // One tab stop for the whole chart (the last value, or the last one moved
  // to); left/right arrows move one value, Home/End to either end.
  let active = $state<number | null>(null);
  let focusIndex = $state<number | null>(null);
  const current = $derived(focusIndex !== null && focusIndex < values.length ? focusIndex : values.length - 1);
  let hits = $state<HTMLDivElement>();
  const STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };

  function show(i: number | null) {
    active = i;
    onhover(i);
  }

  function move(e: KeyboardEvent, i: number) {
    const step = STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.min(Math.max(i + step, 0), values.length - 1);
    focusIndex = next;
    hits?.querySelector<HTMLButtonElement>(`[data-i="${next}"]`)?.focus();
  }
</script>

<div class="chart" role="group" onmouseleave={() => show(null)}
  aria-label="{kind === 'weekly' ? 'Weekly' : 'Cumulative'} tokens, {demo ? 'demonstration' : 'measured'} data">
  <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 108H{W} M0 55H{W} M0 7H{W}" stroke="var(--line)" stroke-dasharray="3 5" fill="none" />
    {#if kind === "weekly"}
      {#each values as v, i (i)}
        <rect x={(i / n) * W + 2} y={y(v)} width={W / n - 4} height={(v / max) * 95} rx="2"
          fill={i === active ? "var(--heat-4)" : "var(--heat-3)"} />
      {/each}
    {:else if values.length}
      <path d="{line} L{x(values.length - 1)},108 L{x(0)},108 Z" fill="var(--accent)" opacity=".09" />
      <path d={line} stroke="var(--accent)" stroke-width="2" fill="none" vector-effect="non-scaling-stroke" />
    {/if}
  </svg>
  <!-- Round marks stay round: drawn in HTML over the stretched SVG. -->
  {#if kind === "cumulative" && active !== null && active < values.length}
    <i class="guide" style:left="{(x(active) / W) * 100}%"></i>
    <i class="dot" style:left="{(x(active) / W) * 100}%" style:top="{(y(values[active]) / H) * 100}%"></i>
  {/if}
  <div class="hits" bind:this={hits}>
    {#each values as _, i (i)}
      <button
        class="hit"
        aria-label={labels[i]}
        data-i={i}
        tabindex={i === current ? 0 : -1}
        onkeydown={(e) => move(e, i)}
        onmouseenter={() => show(i)}
        onfocus={() => { focusIndex = i; show(i); }}
        onblur={() => show(null)}
        onclick={() => show(i)}
      ></button>
    {/each}
  </div>
</div>

<style>
  /* Fills its container (the size of the daily calendar). */
  .chart { position: relative; width: 100%; height: 100%; }
  svg { display: block; width: 100%; height: 100%; }
  .hits { position: absolute; inset: 0; display: flex; }
  .hit { flex: 1; min-width: 0; padding: 0; border-radius: 2px; }
  .hit:focus-visible { outline-offset: -2px; }
  .guide, .dot { position: absolute; pointer-events: none; }
  .guide { top: 0; bottom: 0; border-left: 1px dashed var(--line); }
  .dot { width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg); }
</style>
