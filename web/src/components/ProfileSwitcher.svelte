<script lang="ts">
  import type { Profile } from "../../../shared/types.ts";

  let { profiles, current, self, onchange }: {
    profiles: Profile[];
    /** Username shown now. */
    current: string;
    /** The viewer's username, listed first as "You". */
    self: string;
    onchange: (username: string) => void;
  } = $props();

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const others = $derived(profiles.filter((p) => !same(p.username, self)));
</script>

<label class="switcher">
  <span class="sr">Profile</span>
  <select value={profiles.find((p) => same(p.username, current))?.username ?? self}
    onchange={(e) => onchange(e.currentTarget.value)}>
    <option value={self}>Your profile</option>
    {#if others.length}
      <optgroup label="Other profiles">
        {#each others as p (p.username)}<option value={p.username}>{p.display_name} (@{p.username})</option>{/each}
      </optgroup>
    {/if}
  </select>
</label>

<style>
  .switcher { display: flex; min-width: 0; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  select { background: var(--surface-2); border: 1px solid var(--line); color: var(--text); border-radius: var(--radius-sm); padding: 5px 8px; font: inherit; font-size: 13px; color-scheme: dark; max-width: 200px; }
</style>
