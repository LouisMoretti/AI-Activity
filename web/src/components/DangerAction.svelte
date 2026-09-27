<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import type { ConfirmDelete } from "../lib/confirm-delete.svelte.ts";

  let { title, flow, username, actionLabel, confirmLabel, success, children }: {
    title: string;
    flow: ConfirmDelete<T>;
    username: string;
    /** Opens the confirmation form, e.g. "Delete activity…". */
    actionLabel: string;
    /** The final, destructive button. */
    confirmLabel: string;
    /** What to say once done (nothing when the page moves on by itself). */
    success?: (result: T) => string;
    /** What goes and what stays, shown before anything is asked. */
    children: Snippet;
  } = $props();

  function submit(e: SubmitEvent) {
    e.preventDefault();
    void flow.confirm();
  }
</script>

<div class="box">
  <div class="text">
    <h3>{title}</h3>
    <p class="muted">{@render children()}</p>
  </div>

  {#if flow.step === "closed" || flow.step === "done"}
    <div class="actions">
      <button type="button" class="danger" onclick={() => flow.open()}>{actionLabel}</button>
      {#if flow.step === "done" && flow.result !== null && success}
        <span class="ok" role="status">{success(flow.result)}</span>
      {/if}
    </div>
  {:else}
    <form onsubmit={submit}>
      <input type="text" autocomplete="username" value={username} hidden readonly />
      <label>Password
        <input type="password" autocomplete="current-password" required bind:value={flow.password} />
      </label>
      <label>Type <span class="mono">{flow.expected}</span> to confirm
        <input autocomplete="off" spellcheck="false" required bind:value={flow.phrase} />
      </label>
      <div class="actions">
        <button type="submit" class="danger strong" disabled={!flow.ready || flow.step === "busy"}>
          {flow.step === "busy" ? "Deleting…" : confirmLabel}
        </button>
        <button type="button" disabled={flow.step === "busy"} onclick={() => flow.cancel()}>Cancel</button>
        {#if flow.error}<span class="error" role="alert">{flow.error}</span>{/if}
      </div>
    </form>
  {/if}
</div>

<style>
  .box { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px 18px; display: grid; gap: 12px; }
  h3 { font-size: 14px; font-weight: 500; }
  .text { display: grid; gap: 6px; }
  .text p { font-size: 13px; max-width: 70ch; }
  form { display: grid; gap: 12px; max-width: 420px; }
  label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
  input { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 6px 10px; font: inherit; font-size: 14px; }
  .actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; }
  button:disabled { opacity: .5; cursor: default; }
  .danger:hover:not(:disabled) { color: var(--danger); border-color: var(--danger); }
  .danger.strong:not(:disabled) { color: var(--danger); border-color: var(--danger); }
  .ok { color: var(--ok); font-size: 13px; }
  .error { color: var(--warn); font-size: 13px; }
</style>
