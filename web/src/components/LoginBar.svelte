<script lang="ts">
  let { onlogin }: { onlogin: (username: string, password: string) => Promise<string | null> } = $props();
  let username = $state("");
  let password = $state("");
  let error = $state("");
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = (await onlogin(username.trim(), password)) ?? "";
    busy = false;
    if (!error) password = "";
  }
</script>

<form onsubmit={submit}>
  <span>Sign in to see your usage.</span>
  <input placeholder="Username" autocomplete="username" autocapitalize="none" spellcheck="false" required bind:value={username} aria-label="Username" />
  <input type="password" placeholder="Password" autocomplete="current-password" required bind:value={password} aria-label="Password" />
  <button type="submit" disabled={busy}>Sign in</button>
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</form>
<p class="hint">No account yet? Ask an admin for an invite link.</p>

<style>
  form { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border: 1px solid var(--line); background: var(--surface-2); border-radius: 9px; padding: 10px 14px; }
  .hint { color: var(--muted); font-size: 12px; margin: 8px 2px 18px; }
  input { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 6px 10px; font: inherit; min-width: 0; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 12px; color: var(--text); }
  button:disabled { opacity: .5; cursor: default; }
  .error { color: var(--warn); }
</style>
