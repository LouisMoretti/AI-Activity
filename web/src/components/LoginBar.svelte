<script lang="ts">
  let { onlogin }: { onlogin: (password: string) => Promise<boolean> } = $props();
  let password = $state("");
  let error = $state("");

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = (await onlogin(password)) ? "" : "Wrong password.";
  }
</script>

<form onsubmit={submit}>
  <span>Viewer login required.</span>
  <input type="password" placeholder="Viewer password" autocomplete="current-password" bind:value={password} />
  <button type="submit">Sign in</button>
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</form>

<style>
  form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border: 1px solid var(--line); background: var(--surface-2); border-radius: 9px; padding: 10px 14px; margin-bottom: 18px; }
  input { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 6px 10px; font: inherit; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; color: var(--text); }
  .error { color: var(--warn); }
</style>
