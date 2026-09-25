<script lang="ts">
  import type { QuotaToolVM } from "../lib/view-model.ts";
  import QuotaWindow from "./QuotaWindow.svelte";
  import ToolHeader from "./ToolHeader.svelte";

  let { vm }: { vm: QuotaToolVM } = $props();
</script>

<article class="card">
  <ToolHeader tool="codex" updatedAt={vm.updatedAt} note={vm.updatedAt ? "" : "No snapshot yet"} />
  <div class="windows">
    {#each vm.windows as w (w.label)}<QuotaWindow {w} tone="codex" />{/each}
  </div>
</article>

<style>
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; }
  .windows { display: grid; gap: 22px; margin-top: 22px; }
</style>
