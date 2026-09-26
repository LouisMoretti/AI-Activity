<script lang="ts">
  import { fmtCompact, fmtShare } from "../lib/format.ts";
  import { toolName, type FigureVM } from "../lib/view-model.ts";

  // Today's tokens split by tool, one bar each in the tool's colour.
  let { today }: { today: FigureVM } = $props();
  const COLOR: Record<string, string> = { "claude-code": "var(--claude)", codex: "var(--codex)", opencode: "var(--opencode)", antigravity: "var(--antigravity)" };
  const total = $derived(today.value ?? 0);
  const share = (v: number) => (total ? (v / total) * 100 : 0);
</script>

<article class="card">
  <div class="head"><span class="label">Today by tool</span><span class="meta">{fmtCompact(total)}</span></div>
  <div class="rows">
    {#each today.byTool as t (t.name)}
      <div>
        <div class="line"><span>{toolName(t.name)}</span><span class="meta">{fmtCompact(t.value)} · {fmtShare(t.value, total)}</span></div>
        <div class="track"><i style:width="{share(t.value)}%" style:background={COLOR[t.name] ?? "var(--accent)"}></i></div>
      </div>
    {:else}
      <div class="meta">Nothing yet today</div>
    {/each}
  </div>
</article>

<style>
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; min-width: 0; }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; min-height: 18px; }
  .head .meta { margin-left: auto; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
  .meta { color: var(--muted); font-size: 12px; }
  .rows { display: grid; gap: 12px; }
  .line { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; margin-bottom: 5px; }
  .track { height: 6px; background: var(--track); border-radius: 10px; overflow: hidden; }
  .track i { display: block; height: 100%; border-radius: 10px; }
</style>
