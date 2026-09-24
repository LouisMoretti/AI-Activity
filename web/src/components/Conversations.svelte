<script lang="ts">
  import { clock } from "../lib/clock.svelte.ts";
  import { fmtAgo, fmtCompact, fmtPct, plural, RECENT_SEC } from "../lib/format.ts";
  import { TOOL_META, type SessionVM } from "../lib/view-model.ts";
  import Meter from "./Meter.svelte";

  let { sessions, total, onmore }: { sessions: SessionVM[]; total: number; onmore: () => void } = $props();
</script>

<div class="list">
  {#each sessions as s (s.tool + s.id)}
    <article class="session">
      <div class="name">
        <span class="icon {s.tool}" aria-hidden="true">{TOOL_META[s.tool].icon}</span>
        <div>
          <strong>{TOOL_META[s.tool].name} · <span class="mono">{s.id.slice(0, 8)}</span></strong>
          <small><span class="model">{s.model ?? "model not reported"}</span> · {plural(s.calls, "API call")}</small>
        </div>
      </div>
      <div class="side">
        <div class="line">
          <span class="num tokens">{fmtCompact(s.tokens)} tokens</span>
          <span class="when"><i class="dot" class:recent={clock.now - s.lastActive < RECENT_SEC}></i>{fmtAgo(s.lastActive, clock.now)}</span>
        </div>
        {#if s.context}
          <Meter pct={s.context.pct} label="Context used" tone={s.tool === "claude-code" ? "claude" : "accent"} />
          <div class="ctx">Context {fmtPct(s.context.pct)} %{s.context.size ? ` of ${fmtCompact(s.context.size)}` : ""}</div>
        {/if}
      </div>
    </article>
  {:else}
    <article class="session empty">
      <strong>No conversations recorded yet</strong>
      <small>Activity from a connected device will appear here.</small>
    </article>
  {/each}
</div>
{#if sessions.length < total}
  <button class="more" onclick={onmore}>Show more · {total - sessions.length} older</button>
{/if}

<style>
  .list { border: 1px solid var(--line); border-radius: var(--radius); padding: 0 20px; }
  .session { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 16px 0; }
  .session + .session { border-top: 1px solid var(--line); }
  .empty { flex-direction: column; align-items: flex-start; gap: 2px; }
  .name { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .icon { font-size: 18px; width: 20px; text-align: center; color: var(--muted); }
  .icon.claude-code { color: var(--claude); }
  .icon.codex { color: var(--codex); }
  .icon.opencode { color: var(--opencode); }
  strong { font-size: 14px; font-weight: 500; display: block; }
  small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
  .model { font-family: var(--mono); font-size: 11px; }
  .side { width: 260px; flex-shrink: 0; display: grid; gap: 7px; }
  .line { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; }
  .tokens { color: var(--text); }
  .when { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); white-space: nowrap; }
  .ctx { font-size: 11px; color: var(--faint); }
  .side :global(.track) { height: 4px; }
  .more { display: block; margin: 12px auto 0; padding: 7px 14px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }
  .more:hover { background: var(--surface-2); }
  @media (max-width: 720px) {
    .session { flex-direction: column; align-items: stretch; gap: 10px; }
    .side { width: 100%; }
  }
</style>
