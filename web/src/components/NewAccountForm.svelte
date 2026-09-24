<script lang="ts">
  import type { NewAccount } from "../lib/api.ts";

  let { title = "", intro, withSetupCode = false, framed = true, submitLabel, oncreate }: {
    title?: string;
    intro: string;
    /** false inside another card (the sign-in page tabs). */
    framed?: boolean;
    /** First account: also ask for the one-time code from the server log. */
    withSetupCode?: boolean;
    submitLabel: string;
    oncreate: (a: NewAccount, setupCode: string | null) => Promise<string | null>;
  } = $props();

  let setupCode = $state("");
  let username = $state("");
  let displayName = $state("");
  let password = $state("");
  let repeat = $state("");
  let error = $state("");
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (password !== repeat) {
      error = "The passwords do not match.";
      return;
    }
    busy = true;
    error = (await oncreate(
      { username: username.trim(), display_name: displayName.trim(), password },
      withSetupCode ? setupCode : null,
    )) ?? "";
    busy = false;
  }
</script>

<form onsubmit={submit} class:framed>
  {#if title}<h2>{title}</h2>{/if}
  <p class="muted">{intro}</p>
  {#if withSetupCode}
    <label>Setup code
      <input class="mono" placeholder="XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" required bind:value={setupCode} />
    </label>
  {/if}
  <label>Username
    <input autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="32"
      pattern={"[A-Za-z0-9][A-Za-z0-9._\\-]{1,31}"} title="2-32 letters, digits, dots, dashes or underscores" bind:value={username} />
  </label>
  <label><span>Display name <span class="opt">(optional)</span></span>
    <input maxlength="60" autocomplete="name" bind:value={displayName} />
  </label>
  <label><span>Password <span class="opt">(8 characters or more)</span></span>
    <input type="password" autocomplete="new-password" minlength="8" required bind:value={password} />
  </label>
  <label>Repeat password
    <input type="password" autocomplete="new-password" minlength="8" required bind:value={repeat} />
  </label>
  <button type="submit" disabled={busy}>{submitLabel}</button>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</form>

<style>
  form { display: grid; gap: 12px; }
  form.framed { max-width: 420px; margin: 24px auto 0; border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 22px 22px; }
  h2 { font-size: 16px; font-weight: 600; }
  label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
  .opt { color: var(--faint); }
  input { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 7px 10px; font: inherit; font-size: 14px; }
  input.mono { font-family: var(--mono); letter-spacing: .05em; }
  button { justify-self: start; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 7px 14px; color: var(--text); background: var(--surface-2); }
  button:disabled { opacity: .5; cursor: default; }
  .error { color: var(--warn); font-size: 13px; }
</style>
