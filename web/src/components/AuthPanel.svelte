<script lang="ts">
  import type { NewAccount } from "../lib/api.ts";
  import NewAccountForm from "./NewAccountForm.svelte";
  import Segmented from "./Segmented.svelte";

  let { signupOpen, onlogin, oncreate }: {
    /** An admin allows creating accounts from here. */
    signupOpen: boolean;
    onlogin: (username: string, password: string) => Promise<string | null>;
    oncreate: (a: NewAccount, setupCode: string | null) => Promise<string | null>;
  } = $props();

  let tab = $state<"signin" | "signup">("signin");
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

<div class="card">
  <div class="head">
    <h2>{tab === "signin" ? "Welcome back" : "Create your account"}</h2>
    <Segmented label="Sign in or create an account" value={tab} onchange={(t) => (tab = t)}
      options={[{ value: "signin", label: "Sign in" }, { value: "signup", label: "Create account" }]} />
  </div>

  {#if tab === "signin"}
    <form onsubmit={submit}>
      <label>Username
        <input autocomplete="username" autocapitalize="none" spellcheck="false" required bind:value={username} />
      </label>
      <label>Password
        <input type="password" autocomplete="current-password" required bind:value={password} />
      </label>
      <button type="submit" disabled={busy}>Sign in</button>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </form>
  {:else if signupOpen}
    <NewAccountForm framed={false} submitLabel="Create account" {oncreate}
      intro="Your profile page is public: anyone with its link sees your usage, never your devices or settings." />
  {:else}
    <p class="muted">Sign-up is closed. Ask an admin for an invite link.</p>
  {/if}
</div>

<style>
  .card { max-width: 420px; margin: 24px auto 0; border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 22px 22px; display: grid; gap: 16px; }
  .head { display: grid; gap: 12px; }
  h2 { font-size: 16px; font-weight: 600; }
  form { display: grid; gap: 12px; }
  label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
  input { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 7px 10px; font: inherit; font-size: 14px; }
  button[type="submit"] { justify-self: start; border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 7px 14px; color: var(--text); background: var(--surface-2); }
  button:disabled { opacity: .5; cursor: default; }
  .error { color: var(--warn); font-size: 13px; }
</style>
