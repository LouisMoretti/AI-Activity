<script lang="ts">
  import { fmtCompact, fmtShare } from "../lib/format.ts";
  import { toolName, type ShareRow } from "../lib/view-model.ts";

  let { title, rows, kind, of = null, max = 8 }: {
    title: string;
    rows: ShareRow[];
    kind: "tool" | "model";
    of?: number | null; // share denominator when rows overlap (a session can use several models); else their sum
    max?: number; // rows shown; the rest are summed into one "others" row
  } = $props();
  const total = $derived(of ?? rows.reduce((a, r) => a + r.value, 0));
  // Largest share first; the "others" row always stays last.
  const sorted = $derived([...rows].sort((a, b) => b.value - a.value));
  const shown = $derived(sorted.length > max ? sorted.slice(0, max - 1) : sorted);
  const rest = $derived(sorted.slice(shown.length));
  const restValue = $derived(rest.reduce((a, r) => a + r.value, 0));
  const pct = (value: number) => fmtShare(value, total);
  const label = (name: string) => (kind === "tool" ? toolName(name) : name);
  // provider/model (OpenCode): the provider is dimmed so the model reads first.
  const split = (name: string) => {
    const i = kind === "model" ? name.indexOf("/") : -1;
    return i < 0 ? { provider: "", model: name } : { provider: name.slice(0, i + 1), model: name.slice(i + 1) };
  };
</script>

{#snippet num(value: number, share = true)}
  <span class="num">{fmtCompact(value)}</span>
  {#if share && total}
    <span class="pct">{pct(value)}</span>
  {:else}
    <span class="pct" title={share ? undefined : "No share: rows overlap"}>—</span>
  {/if}
{/snippet}

<div class="block">
  <div class="title">{title}</div>
  <div class="rows">
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
      <!-- Overlapping rows (of set): their sum counts a session once per model, so no share. -->
      {@render num(restValue, of === null)}
    </div>
  {/if}
  </div>
</div>

<style>
  .block + :global(.block) { margin-top: 12px; }
  .title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin-bottom: 6px; }
  /* Name, tokens and share in columns: the numbers line up without padding. */
  .rows { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; column-gap: 12px; row-gap: 4px; font-size: 12px; }
  .row { display: contents; }
  .row.muted { display: block; grid-column: 1 / -1; color: var(--muted); }
  .name { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name i { font-style: normal; color: var(--faint); }
  .num, .pct { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .pct { color: var(--faint); font-size: 11px; }
  .mono { font-family: var(--mono); font-size: 11px; }
</style>
