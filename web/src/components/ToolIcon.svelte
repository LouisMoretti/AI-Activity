<script lang="ts">
  import { TOOL_META, type ToolKey } from "../lib/view-model.ts";

  let { tool, size = 24 }: { tool: ToolKey; size?: number } = $props();
</script>

<img class="mark" src={TOOL_META[tool].logo} width={size} height={size} alt="" aria-hidden="true" />

<style>
  .mark { display: block; object-fit: contain; }
</style>
