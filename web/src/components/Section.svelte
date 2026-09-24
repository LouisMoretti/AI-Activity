<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, subtitle = "", actions, footnote = "", children }: {
    title: string;
    subtitle?: string;
    actions?: Snippet;
    footnote?: string;
    children: Snippet;
  } = $props();
</script>

<section>
  <header>
    <h2>{title}</h2>
    {#if actions}{@render actions()}{:else if subtitle}<span class="muted">{subtitle}</span>{/if}
  </header>
  {@render children()}
  {#if footnote}<p class="footnote">{footnote}</p>{/if}
</section>

<style>
  section { margin-top: 36px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  h2 { font-size: 14px; font-weight: 600; }
  .footnote { color: var(--muted); font-size: 12px; margin-top: 12px; }
</style>
