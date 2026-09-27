<script lang="ts">
  import { DELETE_ACTIVITY_PHRASE } from "../../../shared/types.ts";
  import { DeleteActivity } from "../lib/delete-activity.svelte.ts";
  import { fmtNum } from "../lib/format.ts";

  let { username, ondeleted }: { username: string; ondeleted: () => void } = $props();

  const flow = new DeleteActivity(() => ondeleted());

  function submit(e: SubmitEvent) {
    e.preventDefault();
    void flow.confirm();
  }
</script>

<div class="box">
  <div class="text">
    <h3>Delete activity</h3>
    <p class="muted">
      Permanently deletes every token count, conversation, calendar day and quota measured for your
      account, on every device. Your account, profile, devices and keys stay. Anything your collectors
      measured up to now is refused if they send it again; new activity keeps being recorded.
    </p>
  </div>

  {#if flow.step === "closed" || flow.step === "done"}
    <div class="actions">
      <button type="button" class="danger" onclick={() => flow.open()}>Delete activity…</button>
      {#if flow.step === "done" && flow.deleted}
        <span class="ok" role="status">
          Deleted {fmtNum(flow.deleted.events)} API calls and {fmtNum(flow.deleted.quotas)} quota measurements.
        </span>
      {/if}
    </div>
  {:else}
    <form onsubmit={submit}>
      <input type="text" autocomplete="username" value={username} hidden readonly />
      <label>Password
        <input type="password" autocomplete="current-password" required bind:value={flow.password} />
      </label>
      <label>Type <span class="mono">{DELETE_ACTIVITY_PHRASE}</span> to confirm
        <input autocomplete="off" spellcheck="false" required bind:value={flow.phrase} />
      </label>
      <div class="actions">
        <button type="submit" class="danger strong" disabled={!flow.ready || flow.step === "busy"}>
          {flow.step === "busy" ? "Deleting…" : "Delete all my activity"}
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
