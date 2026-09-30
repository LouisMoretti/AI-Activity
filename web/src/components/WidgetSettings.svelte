<script lang="ts">
  import { onMount } from "svelte";
  import { WIDGETS, type Widget } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";

  const labels: Record<Widget, string> = {
    "today-by-tool": "Today by tool",
    "today-by-hour": "Today by hour",
    "best-day": "Best day",
    leaderboard: "Leaderboard · 7 days",
  };
  let selected = $state<Widget[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let notice = $state("");
  let error = $state("");

  onMount(() => {
    void api.ownWidgets().then((r) => { selected = r.widgets; }).catch(() => {
      error = "Could not load your widgets.";
    }).finally(() => { loading = false; });
  });

  function toggle(widget: Widget): void {
    selected = selected.includes(widget) ? selected.filter((w) => w !== widget) : [...selected, widget];
    notice = "";
  }
  function move(index: number, direction: -1 | 1): void {
    const next = [...selected];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    selected = next;
    notice = "";
  }
  async function save(): Promise<void> {
    saving = true;
    error = "";
    try {
      selected = (await api.saveWidgets(selected)).widgets;
      notice = "Saved. Your public profile now uses this order.";
    } catch { error = "Could not save your widgets. Try again."; }
    finally { saving = false; }
  }
</script>

<div class="editor">
  <p>Choose the extra cards on your public profile. The first appears beside OpenCode; the rest follow below.</p>
  {#if loading}<p role="status">Loading widgets…</p>{:else}
    <div class="choices">
      {#each WIDGETS as widget}
        <label><input type="checkbox" checked={selected.includes(widget)} onchange={() => toggle(widget)} /> {labels[widget]}</label>
      {/each}
    </div>
    {#if selected.length}
      <ol>
        {#each selected as widget, i (widget)}
          <li><span>{labels[widget]}</span><button type="button" aria-label="Move {labels[widget]} up" disabled={i === 0} onclick={() => move(i, -1)}>↑</button><button type="button" aria-label="Move {labels[widget]} down" disabled={i === selected.length - 1} onclick={() => move(i, 1)}>↓</button></li>
        {/each}
      </ol>
    {/if}
    <button class="save" type="button" disabled={saving} onclick={save}>{saving ? "Saving…" : "Save widgets"}</button>
  {/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
</div>

<style>
  .editor { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 22px; font-size: 13px; }
  p { margin: 0 0 16px; color: var(--muted); }
  .choices { display: flex; flex-wrap: wrap; gap: 12px 22px; }
  label { display: inline-flex; align-items: center; gap: 5px; }
  ol { margin: 18px 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  li { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
  li span { flex: 1; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 5px 10px; color: var(--text); }
  button:disabled { opacity: .45; cursor: default; }
  .save { margin-top: 16px; background: var(--accent); color: var(--bg); border: 0; }
  .error { color: var(--warn); }
</style>
