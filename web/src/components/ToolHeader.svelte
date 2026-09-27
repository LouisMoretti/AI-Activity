<script lang="ts">
  import { clock } from "../lib/clock.svelte.ts";
  import { fmtAgo, RECENT_SEC } from "../lib/format.ts";
  import { TOOL_META, type ToolKey } from "../lib/view-model.ts";

  // updatedAt: epoch seconds of the latest data; null + note → static badge.
  let { tool, updatedAt = null, note = "" }: { tool: ToolKey; updatedAt?: number | null; note?: string } = $props();
</script>

<div class="head">
  <span class="icon" style:--tool={TOOL_META[tool].color} aria-hidden="true">{TOOL_META[tool].icon}</span>
  <h3>{TOOL_META[tool].name}</h3>
  {#if updatedAt}
    <span class="status"><i class="dot" class:recent={clock.now - updatedAt < RECENT_SEC}></i>Updated {fmtAgo(updatedAt, clock.now)}</span>
  {:else if note}
    <span class="status badge">{note}</span>
  {/if}
</div>

<style>
  .head { display: flex; align-items: center; gap: 11px; }
  .icon { width: 31px; height: 31px; flex: 0 0 31px; display: grid; place-items: center; border-radius: 8px; font-size: 19px; background: color-mix(in srgb, var(--tool) 14%, var(--surface)); color: var(--tool); }
  h3 { font-size: 16px; font-weight: 550; }
  .status { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .badge { min-width: 0; display: block; overflow: hidden; text-overflow: ellipsis; border: 1px solid var(--line); border-radius: 5px; padding: 2px 7px; }
</style>
