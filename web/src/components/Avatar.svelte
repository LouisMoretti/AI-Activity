<script lang="ts">
  // Profile picture from a link (hosts checked by the server), with the
  // initial as fallback while it is missing or fails to load.
  let { name, url, size }: { name: string; url: string | null; size: number } = $props();

  let failed = $state<string | null>(null);
</script>

<span class="avatar" aria-hidden="true" style:--size="{size}px">
  {#if url && failed !== url}
    <img src={url} alt="" referrerpolicy="no-referrer" loading="lazy" decoding="async" onerror={() => (failed = url)} />
  {:else}
    {name.slice(0, 1).toUpperCase()}
  {/if}
</span>

<style>
  .avatar { width: var(--size); height: var(--size); border-radius: 50%; display: grid; place-items: center; flex: none; overflow: hidden; background: var(--raised); border: 1px solid var(--line); font-size: calc(var(--size) * .42); font-weight: 500; }
  img { width: 100%; height: 100%; object-fit: cover; }
</style>
