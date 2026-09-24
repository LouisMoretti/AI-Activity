<script lang="ts">
  import type { Snippet } from "svelte";

  // Shows its detail in a popover on hover or keyboard focus (tap on touch).
  let { label, value, detail }: { label: string; value: string; detail: Snippet } = $props();
  const id = $props.id();
</script>

<div class="stat">
  <button type="button" class="trigger" aria-describedby={id}>
    <strong class="num">{value}</strong>
    <span>{label}</span>
  </button>
  <div class="pop" role="tooltip" {id}>{@render detail()}</div>
</div>

<style>
  .stat { position: relative; }
  .trigger { display: block; width: 100%; text-align: center; padding: 4px 8px; border-radius: 8px; color: inherit; cursor: default; }
  strong { display: block; font-size: 19px; font-weight: 500; letter-spacing: -.02em; }
  span { display: block; color: var(--muted); font-size: 13px; margin-top: 2px; }
  .pop {
    position: absolute; z-index: 10; top: calc(100% + 10px); left: 50%; translate: -50% 0;
    width: max-content; min-width: 200px; max-width: 280px; text-align: left;
    background: var(--raised); border: 1px solid var(--line); border-radius: 10px;
    padding: 12px 14px; box-shadow: 0 8px 24px #0007;
    opacity: 0; visibility: hidden; transition: opacity .12s ease;
  }
  .stat:hover .pop, .stat:focus-within .pop { opacity: 1; visibility: visible; }
</style>
