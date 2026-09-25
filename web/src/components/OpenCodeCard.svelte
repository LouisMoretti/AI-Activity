<script lang="ts">
  import { clock } from "../lib/clock.svelte.ts";
  import { fmtAgo, fmtCompact, plural, RECENT_SEC } from "../lib/format.ts";
  import type { OpenCodeVM, SessionVM } from "../lib/view-model.ts";
  import ToolHeader from "./ToolHeader.svelte";

  const SHOWN = 3;
  let { vm }: { vm: OpenCodeVM } = $props();

  // Active: a reply in the last few minutes (the green dot's rule). Listed by
  // session id (creation order), not by latest reply, so parallel
  // conversations on different models keep their place between refreshes.
  const active = $derived(
    vm.recent.filter((s) => clock.now - s.lastActive < RECENT_SEC).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
  const last = $derived(vm.recent[0] ?? null);
  const rows = $derived(active.length ? active.slice(0, SHOWN) : last ? [last] : []);
  const more = $derived(active.length - rows.length);
  const activeLabel = $derived(
    active.length >= vm.recent.length && vm.recent.length >= 10 ? `${active.length}+ active conversations` : plural(active.length, "active conversation"),
  );

  // provider/model: the provider is dimmed so the model reads first.
  function modelOf(s: SessionVM) {
    const m = s.model;
    if (!m) return { provider: "", name: "model not reported" };
    const i = m.indexOf("/");
    return i < 0 ? { provider: "", name: m } : { provider: m.slice(0, i + 1), name: m.slice(i + 1) };
  }
</script>

<!-- OpenCode has no 5-hour / weekly quota of its own: its card shows what is
     going on now (active conversations, today) instead of quota windows. -->
<article class="card">
  <section class="today">
    <ToolHeader tool="opencode" note={last ? "" : "No usage yet"} />
    {#if last}
      <div class="label">Today</div>
      <div class="value">{fmtCompact(vm.today.tokens)}<small> tokens</small></div>
      <div class="meta">{plural(vm.today.sessions, "conversation")} · {plural(vm.today.calls, "call")}</div>
      {#if vm.today.models}
        <div class="meta">{plural(vm.today.models, "model")} · {plural(vm.today.providers, "provider")}</div>
      {/if}
    {/if}
  </section>
  {#if last}
    <section class="conversations">
      <div class="head">
        <span class="label">{active.length ? activeLabel : "Last conversation"}</span>
        <span class="status"><i class="dot" class:recent={clock.now - last.lastActive < RECENT_SEC}></i>Updated {fmtAgo(last.lastActive, clock.now)}</span>
      </div>
      <div class="rows">
        {#each rows as s (s.id)}
          {@const m = modelOf(s)}
          <div class="row">
            {#if active.length}<i class="dot recent" aria-hidden="true"></i>{/if}
            <span class="model" title={s.model ?? ""}><i>{m.provider}</i>{m.name}</span>
            <span class="meta">{plural(s.calls, "call")} · {fmtCompact(s.tokens)} tokens</span>
          </div>
        {/each}
        {#if more > 0}<div class="meta more">+{more} more</div>{/if}
      </div>
    </section>
  {/if}
</article>

<style>
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; display: grid; grid-template-columns: minmax(170px, .8fr) minmax(0, 2fr); }
  section { min-width: 0; }
  .today { padding-right: 24px; }
  .today .label { margin: 22px 0 8px; }
  .conversations { padding-left: 28px; border-left: 1px solid var(--line); }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; min-height: 31px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
  .status { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .value { font-size: 22px; font-weight: 550; font-variant-numeric: tabular-nums; line-height: 1.1; margin-bottom: 6px; }
  small { color: var(--muted); font-size: 12px; font-weight: 400; }
  .rows { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .row { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .model { font-family: var(--mono); font-size: 13px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model i { font-style: normal; color: var(--faint); }
  .row .meta { margin-left: auto; flex-shrink: 0; white-space: nowrap; }
  .meta { color: var(--muted); font-size: 12px; }
  .today .meta + .meta { margin-top: 4px; }
  @media (max-width: 720px) {
    .card { grid-template-columns: 1fr; }
    .today { padding-right: 0; }
    .conversations { padding-left: 0; border-left: 0; border-top: 1px solid var(--line); padding-top: 18px; margin-top: 18px; }
  }
</style>
