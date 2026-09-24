<script lang="ts">
  import type { Snippet } from "svelte";

  let { title, subtitle = "", actions, children }: {
    title: string;
    subtitle?: string;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<section>
  <header>
    <h2>{title}</h2>
    {#if actions}{@render actions()}{:else if subtitle}<span class="muted">{subtitle}</span>{/if}
  </header>
  {@render children()}
</section>

<style>
  section { margin-top: 40px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  h2 { font-size: 14px; font-weight: 600; }
</style>
