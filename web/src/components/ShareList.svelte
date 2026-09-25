<script lang="ts">
  import { fmtCompact } from "../lib/format.ts";
  import { toolName, type ShareRow } from "../lib/view-model.ts";

  let { title, rows, kind, percent = true, max = 8 }: {
    title: string;
    rows: ShareRow[];
    kind: "tool" | "model";
    percent?: boolean; // off when rows can overlap (a session can use several models)
    max?: number; // rows shown; the rest are summed into one "others" row
  } = $props();
  const total = $derived(rows.reduce((a, r) => a + r.value, 0));
  const shown = $derived(rows.length > max ? rows.slice(0, max - 1) : rows);
  const rest = $derived(rows.slice(shown.length));
  const restValue = $derived(rest.reduce((a, r) => a + r.value, 0));
  const label = (name: string) => (kind === "tool" ? toolName(name) : name);
  // provider/model (OpenCode): the provider is dimmed so the model reads first.
  const split = (name: string) => {
    const i = kind === "model" ? name.indexOf("/") : -1;
    return i < 0 ? { provider: "", model: name } : { provider: name.slice(0, i + 1), model: name.slice(i + 1) };
  };
</script>

{#snippet num(value: number)}
  <span class="num">{fmtCompact(value)}{#if percent && total}<small> · {Math.round((value / total) * 100)} %</small>{/if}</span>
{/snippet}

<div class="block">
  <div class="title">{title}</div>
  {#each shown as r (r.name)}
    {@const n = split(label(r.name))}
    <div class="row">
      <span class="name" class:mono={kind === "model"} title={label(r.name)}>{#if n.provider}<i>{n.provider}</i>{/if}{n.model}</span>
      {@render num(r.value)}
    </div>
  {:else}
    <div class="row muted">Nothing yet</div>
  {/each}
  {#if rest.length}
    <div class="row">
      <span class="name" title={rest.map((r) => label(r.name)).join(", ")}>{rest.length} others</span>
      {@render num(restValue)}
    </div>
  {/if}
</div>

<style>
  .block + :global(.block) { margin-top: 12px; }
  .title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin-bottom: 6px; }
  .row { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; padding: 2px 0; }
  .name { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name i { font-style: normal; color: var(--faint); }
  .num { flex-shrink: 0; white-space: nowrap; }
  .mono { font-family: var(--mono); font-size: 11px; }
  small { color: var(--faint); font-size: 11px; }
</style>
