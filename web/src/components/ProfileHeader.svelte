<script lang="ts">
  import type { Profile } from "../../../shared/types.ts";

  let { profile, own }: { profile: Profile; own: boolean } = $props();
  let copied = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${location.origin}/u/${encodeURIComponent(profile.username)}`);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      copied = false;
    }
  }
</script>

<div class="profile">
  <span class="avatar" aria-hidden="true">{profile.display_name.slice(0, 1).toUpperCase()}</span>
  <div class="who">
    <h2>{profile.display_name}{own ? " (you)" : ""}</h2>
    <span class="mono">@{profile.username}</span>
  </div>
  <button type="button" onclick={copy} title="Anyone with this link can see this page, without an account">
    {copied ? "Link copied" : "Copy link"}
  </button>
</div>

<style>
  .profile { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--raised); border: 1px solid var(--line); font-size: 17px; font-weight: 500; }
  .who { min-width: 0; flex: 1; }
  h2 { font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
  .who .mono { color: var(--muted); font-size: 12px; }
  button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 5px 12px; font-size: 12px; color: var(--text); flex: none; }
  button:hover { background: var(--surface-2); }
</style>
