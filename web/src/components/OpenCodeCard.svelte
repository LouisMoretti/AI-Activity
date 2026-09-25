<script lang="ts">
  import { fmtCompact } from "../lib/format.ts";
  import type { OpenCodeVM } from "../lib/view-model.ts";
  import ShareList from "./ShareList.svelte";
  import ToolHeader from "./ToolHeader.svelte";

  let { vm }: { vm: OpenCodeVM } = $props();
  const figures = $derived([
    { label: "All time", value: vm.tokens, unit: "tokens" },
    { label: "Today", value: vm.today, unit: "tokens" },
    { label: "Conversations", value: vm.sessions, unit: "" },
  ]);
</script>

<!-- OpenCode has no 5-hour / weekly quota of its own: it reports usage per
     provider, so its card lists that instead of quota windows. -->
<article class="card">
  <div class="side">
    <ToolHeader tool="opencode" note={vm.tokens === null ? "No usage yet" : ""} />
    <p>Limits: Unavailable. OpenCode reports no 5-hour or weekly window.</p>
  </div>
  <div class="figures">
    {#each figures as f (f.label)}
      <div class="figure">
        <div class="label">{f.label}</div>
        <div class="value">{f.value === null ? "—" : fmtCompact(f.value)}{#if f.unit && f.value !== null}<small> {f.unit}</small>{/if}</div>
      </div>
    {/each}
  </div>
  <div class="providers"><ShareList title="By provider" rows={vm.providers} kind="tool" /></div>
</article>

<style>
  .card { grid-column: 1 / -1; border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; display: grid; grid-template-columns: minmax(200px, 1fr) auto minmax(180px, 1fr); align-items: start; gap: 28px; }
  p { color: var(--muted); font-size: 12px; opacity: .8; margin-top: 14px; line-height: 1.5; }
  .figures { display: flex; gap: 28px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin-bottom: 6px; }
  .value { font-size: 20px; font-weight: 550; font-variant-numeric: tabular-nums; }
  small { color: var(--muted); font-size: 12px; font-weight: 400; }
  @media (max-width: 720px) {
    .card { grid-template-columns: 1fr; gap: 18px; }
    .figures { gap: 20px; flex-wrap: wrap; }
  }
</style>
