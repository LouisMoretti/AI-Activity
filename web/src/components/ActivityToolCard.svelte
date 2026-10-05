<script lang="ts">
  import { clock } from "../lib/clock.svelte.ts";
  import { fmtAgo, fmtCompact, plural, RECENT_SEC } from "../lib/format.ts";
  import { TOOL_META, type ActivityToolVM, type SessionVM, type ToolKey } from "../lib/view-model.ts";
  import SessionValue from "./SessionValue.svelte";
  import ToolHeader from "./ToolHeader.svelte";

  const SHOWN = 3;
  let { tool, vm }: { tool: ToolKey; vm: ActivityToolVM } = $props();
  const callNoun = $derived(TOOL_META[tool].callNoun ?? "API call");

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

  // provider/model: the provider is dimmed so the model reads first (a model
  // without a provider shows whole).
  function modelOf(s: SessionVM) {
    const m = s.model;
    if (!m) return { provider: "", name: "model not reported" };
    const i = m.indexOf("/");
    return i < 0 ? { provider: "", name: m } : { provider: m.slice(0, i + 1), name: m.slice(i + 1) };
  }
</script>

<!-- The card of a tool without quota windows: what is going on now (today on
     the left, active conversations, else the last one, on the right). -->
<article class="card" class:empty={!last}>
  <section class="today">
    <ToolHeader {tool} note={vm.available === false ? "Unavailable" : last ? "" : "No usage yet"} />
    {#if last}
      <div class="label">Today</div>
      {#if vm.today.calls === 0}
        <div class="unused">Not used yet today</div>
      {:else}
        <div class="value">{fmtCompact(vm.today.tokens)} <small>tokens</small></div>
        <div class="meta">{plural(vm.today.sessions, "conversation")} · {plural(vm.today.calls, callNoun)}</div>
        {#if vm.today.models}
          <div class="meta">{plural(vm.today.models, "model")}{#if vm.today.providers !== null} · {plural(vm.today.providers, "provider")}{/if}</div>
        {/if}
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
            <span class="who">
              {#if active.length}<i class="dot recent" aria-hidden="true"></i>{/if}
              <span class="model"><i>{m.provider}</i>{m.name}</span>
            </span>
            <span class="meta">{plural(s.calls, callNoun)} · {fmtCompact(s.tokens)} tokens{#if s.value.usd !== null}&nbsp;·&nbsp;{/if}<SessionValue value={s.value} unpriced={s.unpriced} /></span>
          </div>
        {/each}
        {#if more > 0}<div class="meta more">+{more} more</div>{/if}
      </div>
    </section>
  {/if}
</article>

<style>
  .card { border: 1px solid var(--line); background: var(--surface); border-radius: var(--radius); padding: 22px; display: grid; grid-template-columns: minmax(170px, .8fr) minmax(0, 2fr); }
  .card.empty { grid-template-columns: 1fr; }
  .card.empty .today { padding-right: 0; }
  section { min-width: 0; }
  .today { padding-right: 24px; }
  .today .label { margin: 22px 0 8px; }
  .conversations { padding-left: 28px; border-left: 1px solid var(--line); }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-bottom: 14px; min-height: 31px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
  .status { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .value { font-size: 22px; font-weight: 550; font-variant-numeric: tabular-nums; line-height: 1.1; margin-bottom: 6px; }
  .unused { color: var(--muted); font-size: 13px; margin-bottom: 6px; }
  small { color: var(--muted); font-size: 12px; font-weight: 400; }
  .rows { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  /* The model is never cut: the figures move to their own line when both
     do not fit, and a name longer than the row wraps (issue #284). */
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; min-width: 0; }
  .who { display: flex; align-items: flex-start; gap: 10px; min-width: 0; font-family: var(--mono); font-size: 13px; }
  .who .dot { margin-top: calc(.5lh - 3px); }
  .model { min-width: 0; overflow-wrap: anywhere; }
  .model i { font-style: normal; color: var(--faint); }
  .row .meta { margin-left: auto; display: inline-flex; align-items: center; white-space: nowrap; }
  .meta { color: var(--muted); font-size: 12px; }
  .today .meta + .meta { margin-top: 4px; }
  @container (max-width: 560px) {
    .card { grid-template-columns: 1fr; }
    .today { padding-right: 0; }
    .conversations { padding-left: 0; border-left: 0; border-top: 1px solid var(--line); padding-top: 18px; margin-top: 18px; }
  }
  /* Narrow: the figures always under the model, left-aligned, and free to
     wrap (large figures). */
  @container (max-width: 420px) {
    .status { margin-left: 0; }
    .row .meta { flex-basis: 100%; margin-left: 0; flex-wrap: wrap; white-space: normal; }
    .row:has(.who .dot) .meta { padding-left: 16px; }
  }
  @media (max-width: 720px) {
    .card { grid-template-columns: 1fr; }
    .today { padding-right: 0; }
    .conversations { padding-left: 0; border-left: 0; border-top: 1px solid var(--line); padding-top: 18px; margin-top: 18px; }
  }
</style>
