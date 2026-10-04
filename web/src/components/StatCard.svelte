<script lang="ts">
  import type { Snippet } from "svelte";
  import { Tooltip } from "../lib/tooltip.svelte.ts";

  // Shows its detail in a popover on hover or keyboard focus (tap on touch);
  // Escape closes it, and it stays inside the viewport (Tooltip).
  let { label, value, detail }: { label: string; value: string; detail: Snippet } = $props();
  const id = $props.id();
  const tip = new Tooltip();
</script>

<div class="stat" class:open={tip.open} {@attach tip.root} {...tip.wrap}>
  <button type="button" class="trigger" {...tip.trigger} aria-describedby={id}>
    <strong class="num">{value}</strong>
    <span>{label}</span>
  </button>
  <div class="pop" class:above={tip.above} role="tooltip" {id} style:--dx="{tip.dx}px" style:--max-h={tip.maxHeight === null ? null : `${tip.maxHeight}px`} {@attach tip.tip}>{@render detail()}</div>
</div>

<style>
  .stat { position: relative; }
  .trigger { display: block; width: 100%; text-align: center; padding: 4px 8px; border-radius: 8px; color: inherit; cursor: default; }
  strong { display: block; font-size: 19px; font-weight: 500; letter-spacing: -.02em; }
  span { display: block; color: var(--muted); font-size: 13px; margin-top: 2px; }
  .pop {
    max-height: var(--max-h, none); overflow-y: auto; overscroll-behavior: contain;
    position: absolute; z-index: 10; top: calc(100% + 10px); left: 50%; translate: calc(var(--dx, 0px) - 50%) 0;
    width: max-content; min-width: 200px; max-width: min(360px, calc(100vw - 32px)); text-align: left;
    background: var(--raised); border: 1px solid var(--line); border-radius: 10px;
    padding: 12px 14px; box-shadow: 0 8px 24px #0007;
    opacity: 0; visibility: hidden; transition: opacity .12s ease;
  }
  .pop.above { top: auto; bottom: calc(100% + 10px); }
  .open .pop { opacity: 1; visibility: visible; }
</style>
