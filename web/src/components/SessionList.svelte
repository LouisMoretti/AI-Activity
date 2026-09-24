<script lang="ts">
  import { TOOL_META, type SessionVM } from "../lib/view-model.ts";
  import Meter from "./Meter.svelte";

  let { sessions }: { sessions: SessionVM[] } = $props();
</script>

<div class="list">
  {#each sessions as s, i (i)}
    <article class="session">
      <div class="name">
        <span class="icon" aria-hidden="true">{TOOL_META[s.tool].icon}</span>
        <div><strong>{s.title}</strong><small>{s.subtitle}</small></div>
      </div>
      <div class="meter">
        <div class="value">
          <span>{s.tokensLabel}</span>
          {#if s.context}<strong class="tabular">{Math.round((s.context.used / s.context.max) * 100)} %</strong>{/if}
        </div>
        {#if s.context}
          <Meter pct={(s.context.used / s.context.max) * 100} label="Context of {s.title}" tone={s.tool === "claude-code" ? "claude" : "accent"} />
        {/if}
      </div>
    </article>
  {:else}
    <article class="session">
      <div class="name"><div><strong>No sessions recorded yet</strong><small>Real activity from a connected device will appear here.</small></div></div>
    </article>
  {/each}
</div>

<style>
  .list { border: 1px solid var(--line); border-radius: var(--radius); padding: 0 20px; }
  .session { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 18px 0; }
  .session + .session { border-top: 1px solid var(--line); }
  .name { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .icon { color: var(--claude); font-size: 18px; }
  strong { font-size: 14px; font-weight: 500; display: block; }
  small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
  .meter { width: 240px; flex-shrink: 0; }
  .value { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 7px; color: var(--muted); }
  .value strong { color: var(--text); font-size: 12px; }
  @media (max-width: 720px) {
    .session { flex-direction: column; align-items: flex-start; gap: 12px; }
    .meter { width: 100%; }
  }
</style>
