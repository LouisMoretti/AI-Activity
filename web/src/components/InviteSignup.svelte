<script lang="ts">
  import { onMount } from "svelte";
  import { api, type NewAccount } from "../lib/api.ts";
  import NewAccountForm from "./NewAccountForm.svelte";

  let { token, oncreate, onsignin }: {
    token: string;
    oncreate: (a: NewAccount, setupCode: string | null) => Promise<string | null>;
    onsignin: () => void;
  } = $props();

  let check = $state<"checking" | "valid" | "invalid">("checking");
  let expires = $state<number | null>(null);

  onMount(async () => {
    try {
      const r = await api.inviteStatus(token);
      check = r.valid ? "valid" : "invalid";
      expires = r.expires_at;
    } catch {
      check = "invalid";
    }
  });

  const fmtDate = (sec: number) =>
    new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
</script>

{#if check === "valid"}
  <NewAccountForm
    title="Create your account"
    intro={`You were invited to AI Activity. This link works once${expires ? `, until ${fmtDate(expires)}` : ""}.`}
    submitLabel="Create account" {oncreate} />
{:else if check === "invalid"}
  <p class="notice">This invite link is invalid, already used or expired. Ask an admin for a new one.</p>
{/if}
<p class="switch"><button type="button" onclick={onsignin}>Already have an account? Sign in</button></p>

<style>
  .notice { max-width: 420px; margin: 24px auto 0; border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 20px; color: var(--muted); font-size: 13px; }
  .switch { text-align: center; margin-top: 14px; }
  .switch button { font-size: 13px; text-decoration: underline; text-underline-offset: 3px; }
</style>
