<script lang="ts">
  import { fmtCompact } from "../lib/format.ts";
  import { toolName, type ShareRow } from "../lib/view-model.ts";

  let { title, rows, kind, percent = true }: {
    title: string;
    rows: ShareRow[];
    kind: "tool" | "model";
    percent?: boolean; // off when rows can overlap (a session can use several models)
  } = $props();
  const total = $derived(rows.reduce((a, r) => a + r.value, 0));
</script>

<div class="block">
  <div class="title">{title}</div>
  {#each rows as r (r.name)}
    <div class="row">
      <span class="name" class:mono={kind === "model"}>{kind === "tool" ? toolName(r.name) : r.name}</span>
      <span class="num">{fmtCompact(r.value)}{#if percent && total}<small> · {Math.round((r.value / total) * 100)} %</small>{/if}</span>
    </div>
  {:else}
    <div class="row muted">Nothing yet</div>
  {/each}
</div>

<style>
  .block + :global(.block) { margin-top: 12px; }
  .title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin-bottom: 6px; }
  .row { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; padding: 2px 0; }
  .name { color: var(--muted); }
  .mono { font-family: var(--mono); font-size: 11px; }
  small { color: var(--faint); font-size: 11px; }
</style>
