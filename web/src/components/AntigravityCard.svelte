<script lang="ts">
  import type { QuotaToolVM } from "../lib/view-model.ts";
  import QuotaWindow from "./QuotaWindow.svelte";
  import ToolHeader from "./ToolHeader.svelte";

  let { vm }: { vm: QuotaToolVM } = $props();
</script>

<article class="card">
  <ToolHeader tool="antigravity" updatedAt={vm.updatedAt} note={vm.updatedAt ? "" : "No snapshot yet"} />
  <div class="pools">
    {#each [vm.windows.slice(0, 2), vm.windows.slice(2)] as windows}
      <div class="windows">
        {#each windows as w (w.label)}<QuotaWindow {w} tone="antigravity" />{/each}
      </div>
    {/each}
  </div>
</article>

<style>
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; }
  .pools { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px; margin-top: 22px; }
  .pools::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; background: var(--line); pointer-events: none; }
  .windows { display: grid; gap: 22px; }
  @media (max-width: 640px) {
    .pools { grid-template-columns: 1fr; }
    .pools::before { display: none; }
  }
</style>
