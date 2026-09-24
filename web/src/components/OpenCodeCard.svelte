<script lang="ts">
  import ToolHeader from "./ToolHeader.svelte";
</script>

<!-- OpenCode has no 5-hour / weekly quota of its own: it reports usage per
     provider and billing mode, so its card has a different shape. -->
<article class="card">
  <ToolHeader tool="opencode" note="Connector coming soon" />
  <p>Usage will be listed per provider and billing mode. There is no 5-hour or weekly limit unless the provider exposes one.</p>
</article>

<style>
  .card { grid-column: 1 / -1; border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 16px 22px; display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 24px; }
  p { color: var(--muted); font-size: 13px; opacity: .8; }
  @media (max-width: 720px) { .card { grid-template-columns: 1fr; gap: 12px; } }
</style>
