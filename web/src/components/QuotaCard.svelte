<script lang="ts">
  import { TOOL_META, type QuotaToolVM } from "../lib/view-model.ts";
  import QuotaWindow from "./QuotaWindow.svelte";
  import ToolHeader from "./ToolHeader.svelte";

  // A tool with quota windows (Claude Code, Codex, Antigravity): one column
  // per quota pool, each with its own windows, never summed.
  let { vm }: { vm: QuotaToolVM } = $props();
</script>

<article class="card" style:--tool={TOOL_META[vm.tool].color}>
  <ToolHeader tool={vm.tool} updatedAt={vm.updatedAt} note={vm.updatedAt ? "" : "No snapshot yet"} />
  <div class="pools" class:split={vm.pools.length > 1}>
    {#each vm.pools as pool, i (pool.label ?? i)}
      <div class="windows">
        {#if pool.label}<h4>{pool.label}</h4>{/if}
        {#each pool.windows as w (w.label)}<QuotaWindow {w} />{/each}
      </div>
    {/each}
  </div>
</article>

<style>
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; }
  .pools { display: grid; gap: 32px; margin-top: 22px; }
  .pools.split { grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }
  .windows { position: relative; display: grid; gap: 22px; align-content: start; }
  /* A rule between pools, in the middle of the gap. */
  .split .windows + .windows::before { content: ""; position: absolute; top: 0; bottom: 0; left: -16px; width: 1px; background: var(--line); }
  h4 { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin-bottom: -10px; }
  @container (max-width: 560px) {
    .pools.split { grid-auto-flow: row; }
    .split .windows + .windows::before { display: none; }
  }
  @media (max-width: 720px) {
    .pools.split { grid-auto-flow: row; }
    .split .windows + .windows::before { display: none; }
  }
</style>
