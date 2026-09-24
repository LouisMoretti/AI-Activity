<script lang="ts">
  import { api } from "../lib/api.ts";
  import { TOOL_META, type ToolKey } from "../lib/view-model.ts";

  let { onadded }: { onadded: () => void } = $props();

  const tools = Object.keys(TOOL_META) as ToolKey[];
  let tool = $state<ToolKey>("claude-code");
  let plan = $state("");
  let amount = $state("");
  let currency = $state("USD");
  let start = $state("");
  let end = $state("");
  let note = $state("");
  let error = $state("");
  let saved = $state("");
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    saved = "";
    try {
      await api.addSubscription({
        tool,
        plan_name: plan.trim(),
        amount: Number(amount),
        currency: currency.trim().toUpperCase(),
        period_start: start || null,
        period_end: end || null,
        note: note.trim() || null,
      });
      saved = `${plan.trim()} saved.`;
      plan = amount = start = end = note = "";
      onadded();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={submit}>
  <p class="muted">Record what you actually paid, promotions and currency included.</p>
  <div class="grid">
    <label>Tool
      <select bind:value={tool}>
        {#each tools as t (t)}<option value={t}>{TOOL_META[t].name}</option>{/each}
      </select>
    </label>
    <label>Plan<input required maxlength="80" placeholder="Max" bind:value={plan} /></label>
    <label>Amount<input required type="number" min="0" step="0.01" inputmode="decimal" bind:value={amount} /></label>
    <!-- pattern is a JS string: a bare {3} would be parsed as a Svelte expression. -->
    <label>Currency<input required maxlength="3" pattern={"[A-Za-z]{3}"} bind:value={currency} /></label>
    <label>From<input type="date" bind:value={start} /></label>
    <label>To<input type="date" min={start || undefined} bind:value={end} /></label>
    <label class="wide">Note<input maxlength="500" placeholder="e.g. first month at 50 %" bind:value={note} /></label>
  </div>
  <div class="actions">
    <button type="submit" disabled={busy}>Add subscription</button>
    {#if saved}<span class="ok" role="status">{saved}</span>{/if}
    {#if error}<span class="error" role="alert">{error}</span>{/if}
  </div>
</form>

<style>
  form { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px 18px; margin-top: 16px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 12px; }
  .wide { grid-column: span 2; }
  label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
  input, select { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 6px 10px; font: inherit; font-size: 14px; color-scheme: dark; }
  .actions { display: flex; align-items: center; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; }
  button:disabled { opacity: .5; cursor: default; }
  .ok { color: var(--ok); font-size: 13px; }
  .error { color: var(--warn); font-size: 13px; }
  @media (max-width: 720px) {
    .grid { grid-template-columns: repeat(2, 1fr); }
  }
</style>
