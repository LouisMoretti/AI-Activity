<script lang="ts" generics="T extends string">
  let { options, value, onchange, label, variant = "pill" }: {
    options: { value: T; label: string }[];
    value: T;
    onchange: (v: T) => void;
    label: string;
    variant?: "pill" | "tabs";
  } = $props();
</script>

<div class={variant} role="group" aria-label={label}>
  {#each options as o (o.value)}
    <button aria-pressed={o.value === value} onclick={() => onchange(o.value)}>{o.label}</button>
  {/each}
</div>

<style>
  .pill { display: flex; gap: 3px; padding: 4px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 9px; }
  .pill button { padding: 6px 12px; border-radius: var(--radius-sm); }
  .pill button[aria-pressed="true"] { color: var(--text); background: #333; }
  .tabs { display: flex; gap: 14px; }
  .tabs button { padding: 0 0 3px; font-size: 13px; border-bottom: 1px solid transparent; }
  .tabs button[aria-pressed="true"] { color: var(--text); border-color: #888; }
</style>
