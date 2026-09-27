<script lang="ts">
  let { setup = false, signupOpen, github, error: returned = null, onsignin }: {
    /** No account exists yet: the first one gives the setup code from the server log. */
    setup?: boolean;
    /** An admin allows new accounts. */
    signupOpen: boolean;
    /** Sign in with GitHub is set up on the server. */
    github: boolean;
    /** Why the last sign-in failed (back from GitHub), if it did. */
    error?: string | null;
    /** Leaves for GitHub; an error message if it could not start. */
    onsignin: (setupCode: string | null) => Promise<string | null>;
  } = $props();

  let setupCode = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);
  const shown = $derived(error ?? returned);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = await onsignin(setup ? setupCode : null);
    // On success the browser is leaving for GitHub: stay busy.
    if (error) busy = false;
  }
</script>

<!-- Back from GitHub's page, restored from the back/forward cache: the
     page never left, so the button works again. -->
<svelte:window onpageshow={(e) => { if (e.persisted) busy = false; }} />

<form class="card" onsubmit={submit}>
  <h2>{setup ? "Create the first account" : "Sign in"}</h2>
  {#if setup}
    <p class="muted">
      No account exists yet. The setup code is printed in the server log. This account becomes the admin.
      There is no data yet: once signed in, make a device key in Settings and run its install command on each
      machine; the collectors then send their local history.
    </p>
    <label>Setup code
      <input class="mono" placeholder="XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" required bind:value={setupCode} />
    </label>
  {:else}
    <p class="muted">
      Your username, name and picture come from GitHub. Your profile page is public: anyone with its link sees
      your usage, never your devices or settings.
    </p>
  {/if}
  {#if github}
    <button type="submit" class="github" disabled={busy}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
      {busy ? "Opening GitHub…" : "Sign in with GitHub"}
    </button>
  {:else}
    <p class="error" role="alert">
      Sign in with GitHub is not set up on this server: its admin sets GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.
    </p>
  {/if}
  {#if shown}<p class="error" role="alert">{shown}</p>{/if}
  {#if !setup && !signupOpen}<p class="muted">Account creation is closed: only existing accounts can sign in.</p>{/if}
</form>

<style>
  .card { max-width: 420px; margin: 24px auto 0; border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 22px 22px; display: grid; gap: 14px; }
  h2 { font-size: 16px; font-weight: 600; }
  p { font-size: 13px; line-height: 1.5; }
  label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
  input { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 7px 10px; font: inherit; font-size: 14px; }
  input.mono { font-family: var(--mono); letter-spacing: .05em; }
  .github { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px 14px; color: var(--text); background: var(--surface-2); }
  .github:hover:not(:disabled) { border-color: var(--text); }
  button:disabled { opacity: .5; cursor: default; }
  .error { color: var(--warn); }
  .muted { color: var(--muted); }
</style>
