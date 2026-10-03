<script lang="ts">
  import { tick } from "svelte";
  import { PANEL_OPTIONS, TOOLS,
    type PanelId, type PanelView, type PanelRow, type ProfilePanel, type RowRatio, type Tool, type Widget } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { clock } from "../lib/clock.svelte.ts";
  import { hasLiveWindow, toolName, type DashboardVM } from "../lib/view-model.ts";
  import ActivityToolCard from "./ActivityToolCard.svelte";
  import ProfileWidget from "./ProfileWidget.svelte";
  import QuotaCard from "./QuotaCard.svelte";
  import Section from "./Section.svelte";

  let { vm, rows, own, onrowschange, ondevices }: {
    vm: DashboardVM; rows: PanelRow[]; own: boolean;
    onrowschange: (rows: PanelRow[]) => void; ondevices: () => void;
  } = $props();

  const labels: Record<Widget, string> = {
    "today-by-tool": "Today by tool", "today-by-hour": "Today by hour",
    "best-day": "Best day", leaderboard: "Leaderboard · 7 days",
  };
  const RATIOS: { ratio: RowRatio; label: string }[] = [
    { ratio: "half", label: "Equal widths" },
    { ratio: "wide-left", label: "Wider first card (⅔ · ⅓)" },
    { ratio: "wide-right", label: "Wider second card (⅓ · ⅔)" },
  ];
  const nameOf = (id: PanelId) => (TOOLS as readonly string[]).includes(id) ? toolName(id) : labels[id as Widget];
  const optionName = (option: { id: PanelId; view?: PanelView }) =>
    `${nameOf(option.id)}${canSwitchView(option.id) ? option.view === "activity" ? " · Details" : " · Quotas" : ""}`;
  const panelKey = (panel: { id: PanelId; view?: PanelView }) => `${panel.id}:${panel.view ?? ""}`;
  const isTool = (id: PanelId): id is Tool => (TOOLS as readonly string[]).includes(id);
  const canSwitchView = (id: PanelId) => ["claude-code", "codex", "antigravity"].includes(id);
  const quotaFor = (tool: Tool) => tool === "claude-code" ? vm.claude : tool === "codex" ? vm.codex : tool === "antigravity" ? vm.antigravity : null;
  const activityFor = (tool: Tool) => tool === "claude-code" ? vm.claudeActivity : tool === "codex" ? vm.codexActivity
    : tool === "cursor" ? vm.cursor : tool === "antigravity" ? vm.antigravityActivity : vm.opencode;

  /** A draft row: panels as a plain array while editing (emptied rows are dropped on commit). */
  interface DraftRow { ratio: RowRatio; panels: ProfilePanel[] }
  const editable = (rows: DraftRow[]): DraftRow[] => rows.map((r) => ({ ratio: r.ratio, panels: [...r.panels] }));

  let editing = $state(false);
  let adding = $state(false);
  let saving = $state(false);
  let error = $state("");
  /** What the last edit did, for screen readers (a polite live region). */
  let announcement = $state("");
  let draft = $state<DraftRow[]>([]);
  let root = $state<HTMLElement>();
  /** The card being dragged (drop targets that cannot take it refuse the drop). */
  let dragging = $state<{ row: number; card: number } | null>(null);
  const shown = $derived(editing && own ? draft : rows);
  const usedKeys = $derived(new Set(draft.flatMap((r) => r.panels.map(panelKey))));
  const available = $derived(PANEL_OPTIONS.filter((option) => !usedKeys.has(panelKey(option))));

  function edit(): void {
    draft = editable(rows);
    error = "";
    adding = false;
    dragging = null;
    announcement = "";
    editing = true;
  }
  function cancel(): void { editing = false; adding = false; error = ""; dragging = null; }
  /** Keep every non-empty row; rows are edited as plain arrays, the server takes tuples. */
  function commit(next: DraftRow[]): void {
    draft = next.filter((r) => r.panels.length > 0)
      .map((r) => ({ ratio: r.ratio, panels: r.panels.slice(0, 2) as PanelRow["panels"] }));
  }
  /** Where a card sits now, in words. */
  function place(key: string): string {
    const ri = draft.findIndex((r) => r.panels.some((p) => panelKey(p) === key));
    if (ri < 0) return "";
    const row = draft[ri];
    const side = row.panels.length === 2 ? (panelKey(row.panels[0]) === key ? ", left" : ", right") : "";
    return `row ${ri + 1} of ${draft.length}${side}`;
  }
  /**
   * Says what happened, then puts the focus back on the control that did it
   * (cards are rebuilt when they change rows), else on another control of
   * the same card, else on "+ Add panel".
   */
  async function after(message: string, focus: string, fallback?: string): Promise<void> {
    announcement = message;
    await tick();
    const find = (name: string) => root?.querySelector<HTMLElement>(`[data-focus="${CSS.escape(name)}"]:not(:disabled)`);
    (find(focus) ?? (fallback ? find(fallback) : null) ?? find("add"))?.focus();
  }
  function add(option: { id: PanelId; view?: PanelView }): void {
    commit([...editable(draft), { ratio: "full", panels: [{ ...option }] }]);
    adding = false;
    void after(`${optionName(option)} added, ${place(panelKey(option))}`, `${panelKey(option)}:up`, `${panelKey(option)}:remove`);
  }
  function fillSlot(ri: number, option: { id: PanelId; view?: PanelView }): void {
    const next = editable(draft);
    if (next[ri] && next[ri].panels.length < 2) next[ri].panels.push({ ...option });
    commit(next);
    void after(`${optionName(option)} added, ${place(panelKey(option))}`, `${panelKey(option)}:remove`);
  }
  function changeView(ri: number, ci: number, view: PanelView): void {
    const next = editable(draft);
    const panel = next[ri]?.panels[ci];
    if (!panel) return;
    next[ri].panels[ci] = { ...panel, view };
    commit(next);
    void after(`${nameOf(panel.id)} shows ${view === "quota" ? "quotas" : "details"}`, `${panel.id}:${view}:${view}`);
  }
  function removeCard(ri: number, ci: number): void {
    const panel = draft[ri]?.panels[ci];
    if (!panel) return;
    const next = editable(draft);
    next[ri].panels = next[ri].panels.filter((_, n) => n !== ci);
    commit(next);
    // The focus goes to the next card's remove button, else "+ Add panel".
    const neighbor = draft[ri]?.panels[ci] ?? draft[ri]?.panels[ci - 1] ?? draft[ri]?.panels[0] ?? draft[Math.min(ri, draft.length - 1)]?.panels[0];
    void after(`${optionName(panel)} removed`, neighbor ? `${panelKey(neighbor)}:remove` : "add");
  }
  /**
   * Up / down for a card. A card sharing its row leaves it for a row of its
   * own just above / below; a card alone joins the next row when it has
   * room, else the two rows swap. Every layout is reachable this way,
   * without dragging.
   */
  function moveCard(ri: number, ci: number, dir: -1 | 1): void {
    const card = draft[ri]?.panels[ci];
    if (!card) return;
    const key = panelKey(card);
    const next = editable(draft);
    const row = next[ri];
    if (row.panels.length === 2) {
      row.panels.splice(ci, 1);
      next.splice(dir < 0 ? ri : ri + 1, 0, { ratio: "full", panels: [card] });
      commit(next);
      void after(`${optionName(card)} moved to a row of its own, ${place(key)}`, `${key}:${dir < 0 ? "up" : "down"}`, `${key}:remove`);
      return;
    }
    const ti = ri + dir;
    const target = next[ti];
    if (!target) {
      void after(`${optionName(card)} is already in the ${dir < 0 ? "first" : "last"} row`, `${key}:${dir < 0 ? "up" : "down"}`);
      return;
    }
    if (target.panels.length < 2) {
      next.splice(ri, 1);
      if (target.ratio === "full") target.ratio = "half";
      if (dir < 0) target.panels.push(card); else target.panels.unshift(card);
      commit(next);
      void after(`${optionName(card)} now shares a row, ${place(key)}`, `${key}:${dir < 0 ? "up" : "down"}`, `${key}:remove`);
      return;
    }
    [next[ri], next[ti]] = [next[ti], next[ri]];
    commit(next);
    void after(`${optionName(card)} moved, ${place(key)}`, `${key}:${dir < 0 ? "up" : "down"}`, `${key}:remove`);
  }
  /** Swaps the two cards of a row. */
  function swapCards(ri: number): void {
    const row = draft[ri];
    if (!row || row.panels.length !== 2) return;
    const next = editable(draft);
    next[ri].panels.reverse();
    commit(next);
    const key = panelKey(row.panels[0]);
    void after(`${optionName(row.panels[0])} moved, ${place(key)}`, `${key}:swap`);
  }
  function moveRow(ri: number, dir: -1 | 1): void {
    const row = draft[ri];
    const ti = ri + dir;
    if (!row) return;
    const key = panelKey(row.panels[0]);
    const action = `row:${key}:${dir < 0 ? "up" : "down"}`;
    if (!draft[ti]) {
      void after(`Row ${ri + 1} is already the ${dir < 0 ? "first" : "last"}`, action);
      return;
    }
    const next = editable(draft);
    [next[ri], next[ti]] = [next[ti], next[ri]];
    commit(next);
    void after(`Row moved to position ${ti + 1} of ${draft.length}`, action, `row:${key}:${dir < 0 ? "down" : "up"}`);
  }
  function setRatio(ri: number, ratio: RowRatio): void {
    const next = editable(draft);
    if (!next[ri]) return;
    next[ri].ratio = ratio;
    commit(next);
    announcement = `Row ${ri + 1}: ${RATIOS.find((r) => r.ratio === ratio)?.label.toLowerCase()}`;
  }

  /** Drag and drop (pointer only: the buttons above do the same without it). */
  const fits = (ri: number) => dragging !== null && (dragging.row === ri || (draft[ri]?.panels.length ?? 2) < 2);
  /** Inserts the dragged card before another (or at the end of a row with room; a full-width row splits in half). */
  function dropCard(from: { row: number; card: number }, toR: number, toC: number | null): void {
    const card = draft[from.row]?.panels[from.card];
    if (!card || !draft[toR] || (from.row !== toR && draft[toR].panels.length >= 2)) return;
    const next = editable(draft);
    next[from.row].panels.splice(from.card, 1);
    let at = toC ?? next[toR].panels.length;
    if (from.row === toR && toC !== null && from.card < toC) at -= 1;
    next[toR].panels.splice(Math.min(at, next[toR].panels.length), 0, card);
    if (next[toR].panels.length === 2 && next[toR].ratio === "full") next[toR].ratio = "half";
    commit(next);
    announcement = `${optionName(card)} moved, ${place(panelKey(card))}`;
  }
  function dropNewRow(from: { row: number; card: number }): void {
    const card = draft[from.row]?.panels[from.card];
    if (!card) return;
    const next = editable(draft);
    next[from.row].panels.splice(from.card, 1);
    commit([...next, { ratio: "full", panels: [card] }]);
    announcement = `${optionName(card)} moved, ${place(panelKey(card))}`;
  }
  /** A card the pointer can pick up; a drag starting on its controls moves nothing. */
  function draggable(node: HTMLElement, at: { row: number; card: number }) {
    let current = at;
    const start = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("button,select,a,input,textarea")) {
        e.preventDefault();
        return;
      }
      e.dataTransfer?.setData("text/plain", JSON.stringify(current));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      dragging = current;
    };
    const end = () => { dragging = null; };
    node.draggable = true;
    node.addEventListener("dragstart", start);
    node.addEventListener("dragend", end);
    return {
      update: (next: typeof at) => { current = next; },
      destroy: () => { node.removeEventListener("dragstart", start); node.removeEventListener("dragend", end); },
    };
  }
  function dragData(e: DragEvent): { row: number; card: number } | null {
    try {
      const value: unknown = JSON.parse(e.dataTransfer?.getData("text/plain") ?? "");
      if (typeof value !== "object" || value === null) return null;
      const rec = value as Record<string, unknown>;
      if (typeof rec.row === "number" && typeof rec.card === "number") return { row: rec.row, card: rec.card };
    } catch { /* a drag from outside the dashboard: ignored */ }
    return null;
  }
  /**
   * A drop target. One that cannot take the dragged card (a full row) does
   * not accept it, so the browser shows the drop is refused. Drops validate
   * their payload before acting.
   */
  function dropzone(node: HTMLElement, opts: { accepts: () => boolean; ondrop: (d: { row: number; card: number }) => void }) {
    let current = opts;
    const over = (e: DragEvent) => {
      if (!current.accepts() || !(e.dataTransfer?.types.includes("text/plain"))) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };
    const drop = (e: DragEvent) => {
      const d = dragData(e);
      const ok = current.accepts();
      if (!ok || !d) return;
      dragging = null;
      e.preventDefault();
      e.stopPropagation();
      current.ondrop(d);
    };
    node.addEventListener("dragover", over);
    node.addEventListener("drop", drop);
    return {
      update: (next: typeof opts) => { current = next; },
      destroy: () => { node.removeEventListener("dragover", over); node.removeEventListener("drop", drop); },
    };
  }
  /** Snap a divider position to the predefined widths (bounds sit halfway between thirds and half). */
  function snapRatio(pct: number): RowRatio {
    return pct < 41.7 ? "wide-right" : pct < 58.4 ? "half" : "wide-left";
  }
  /** The bar between two cards: dragging it snaps the row live to half and thirds (the row's select does the same). */
  function resizer(node: HTMLElement, ri: number) {
    let row = ri;
    const down = (e: PointerEvent) => {
      e.preventDefault();
      node.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!e.buttons || !node.hasPointerCapture(e.pointerId)) return;
      const rect = node.parentElement?.getBoundingClientRect();
      if (!rect || !rect.width) return;
      const ratio = snapRatio(Math.min(85, Math.max(15, (e.clientX - rect.left) / rect.width * 100)));
      if (ratio !== draft[row]?.ratio) setRatio(row, ratio);
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    return {
      update: (next: number) => { row = next; },
      destroy: () => { node.removeEventListener("pointerdown", down); node.removeEventListener("pointermove", move); },
    };
  }
  async function save(): Promise<void> {
    saving = true;
    error = "";
    try {
      const result = await api.savePanels(draft.map((r) => ({ ratio: r.ratio, panels: [...r.panels] as PanelRow["panels"] })));
      onrowschange(result.rows);
      editing = false;
      adding = false;
      announcement = "Layout saved";
    } catch { error = "Could not save your dashboard. Try again."; }
    finally { saving = false; }
  }
</script>

{#snippet cellBody(panel: ProfilePanel)}
  {@const tool = isTool(panel.id) ? panel.id : null}
  {@const quota = tool ? quotaFor(tool) : null}
  {#if tool}
    {#if panel.view === "quota" && quota && (tool !== "antigravity" || hasLiveWindow(quota, clock.now))}
      <QuotaCard vm={quota} />
    {:else}
      <ActivityToolCard {tool} vm={activityFor(tool)} />
    {/if}
  {:else}
    <ProfileWidget widget={panel.id as Widget} {vm} />
  {/if}
{/snippet}

<Section title="Dashboard panels" subtitle="Your chosen tools and usage cards">
  {#snippet actions()}
    {#if own}
      <div class="actions">
        {#if editing}
          <button type="button" data-focus="add" onclick={() => adding = !adding} aria-expanded={adding}>+ Add panel</button>
          <button type="button" onclick={cancel} disabled={saving}>Cancel</button>
          <button type="button" class="primary" onclick={save} disabled={saving}>{saving ? "Saving…" : "Save layout"}</button>
        {:else}
          <button type="button" onclick={edit}>Edit layout</button>
        {/if}
      </div>
    {/if}
  {/snippet}

  {#if own}<p class="sr-only" aria-live="polite">{announcement}</p>{/if}
  {#if editing && own && adding}
    <div class="picker" role="group" aria-label="Available panels">
      {#each available as option (panelKey(option))}
        <button type="button" onclick={() => add(option)}>+ {optionName(option)}</button>
      {:else}<span>All panels are already shown.</span>{/each}
    </div>
  {/if}
  {#if editing && own && error}<p class="error" role="alert">{error}</p>{/if}

  <div class="rows" class:editing={editing && own} bind:this={root}>
    {#each shown as row, ri (ri)}
      {@const split = row.ratio !== "full"}
      {@const pair = row.panels.length === 2}
      {@const first = panelKey(row.panels[0])}
      <div class="row {row.ratio}"
        use:dropzone={{ accepts: () => editing && own && fits(ri), ondrop: (d) => dropCard(d, ri, null) }}>
        {#if editing && own}
          <div class="rowbar" role="group" aria-label="Row {ri + 1} of {shown.length}">
            <span class="rowname">Row {ri + 1}</span>
            {#if pair}
              <label>Widths
                <select value={row.ratio} onchange={(e) => setRatio(ri, e.currentTarget.value as RowRatio)}>
                  {#each RATIOS as r (r.ratio)}<option value={r.ratio}>{r.label}</option>{/each}
                </select>
              </label>
            {/if}
            <button type="button" data-focus="row:{first}:up" aria-label="Move row {ri + 1} up" disabled={ri === 0}
              onclick={() => moveRow(ri, -1)}>Row ↑</button>
            <button type="button" data-focus="row:{first}:down" aria-label="Move row {ri + 1} down" disabled={ri === shown.length - 1}
              onclick={() => moveRow(ri, 1)}>Row ↓</button>
          </div>
        {/if}
        <div class="cells">
          {#each row.panels as panel, ci (panelKey(panel))}
            {@const tool = isTool(panel.id) ? panel.id : null}
            {@const key = panelKey(panel)}
            {@const name = optionName(panel)}
            {#if editing && own}
              <div class="cell editable" use:draggable={{ row: ri, card: ci }}
                use:dropzone={{ accepts: () => fits(ri), ondrop: (d) => dropCard(d, ri, ci) }}>
                <div class="cardbar" role="group" aria-label={name}>
                  <span class="grip" aria-hidden="true" title="Drag the card to move it">⠿</span>
                  {#if tool && canSwitchView(tool)}
                    <button type="button" data-focus="{tool}:quota:quota" aria-pressed={panel.view === "quota"}
                      disabled={usedKeys.has(`${tool}:quota`) && panel.view !== "quota"}
                      onclick={() => changeView(ri, ci, "quota")}>Quotas</button>
                    <button type="button" data-focus="{tool}:activity:activity" aria-pressed={panel.view === "activity"}
                      disabled={usedKeys.has(`${tool}:activity`) && panel.view !== "activity"}
                      onclick={() => changeView(ri, ci, "activity")}>Details</button>
                  {/if}
                  <span class="moves">
                    <button type="button" data-focus="{key}:up" aria-label="Move {name} up"
                      title={pair ? "To a row of its own, above" : "Up: shares the row above when it has room"}
                      onclick={() => moveCard(ri, ci, -1)}>↑</button>
                    <button type="button" data-focus="{key}:down" aria-label="Move {name} down"
                      title={pair ? "To a row of its own, below" : "Down: shares the row below when it has room"}
                      onclick={() => moveCard(ri, ci, 1)}>↓</button>
                    {#if pair}
                      <button type="button" data-focus="{key}:swap" aria-label="Move {name} {ci === 0 ? "right" : "left"}"
                        title="Swap the two cards" onclick={() => swapCards(ri)}>{ci === 0 ? "→" : "←"}</button>
                    {/if}
                    <button type="button" class="remove" data-focus="{key}:remove" aria-label="Remove {name}" title="Remove panel"
                      onclick={() => removeCard(ri, ci)}>×</button>
                  </span>
                </div>
                {@render cellBody(panel)}
              </div>
            {:else}
              <div class="cell">{@render cellBody(panel)}</div>
            {/if}
          {/each}
          {#if editing && own && pair}
            <div class="divider" aria-hidden="true" title="Drag to resize (it snaps to half and thirds)" use:resizer={ri}></div>
          {/if}
          {#if editing && own && split && !pair}
            <div class="slot">
              <label><span>Add a card here</span><select aria-label="Add a card to row {ri + 1}" value=""
                onchange={(e) => { if (e.currentTarget.value) fillSlot(ri, JSON.parse(e.currentTarget.value) as { id: PanelId; view?: PanelView }); e.currentTarget.value = ""; }}>
                <option value="">+ Add a card…</option>
                {#each available as option (panelKey(option))}
                  <option value={JSON.stringify(option)}>{optionName(option)}</option>
                {/each}
              </select></label>
              <span>or drag a card here</span>
            </div>
          {/if}
        </div>
      </div>
    {:else}
      <p class="empty">No panels selected.{#if own} {editing ? "Use + Add panel to choose one." : "Use Edit layout to add one."}{/if}</p>
    {/each}
    {#if editing && own && dragging}
      <div class="endzone" use:dropzone={{ accepts: () => true, ondrop: dropNewRow }}>
        Drop here for a new row
      </div>
    {/if}
  </div>

  {#if own}
    <p class="howto">{#if editing}Move a card with its arrows, or drag it; a card moved up or down shares the next row when it has room. Set a row's widths with its select, or drag the bar between its two cards.{" "}{/if}Add a tool: run a device's install command from <button type="button" onclick={ondevices}>Settings → Devices</button> on that machine (Linux, macOS or Windows).</p>
  {/if}
</Section>

<style>
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  button, select { border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text); background: var(--surface); padding: 6px 9px; font-size: 12px; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .4; cursor: default; }
  .primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .picker { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px; margin-bottom: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
  .picker span, .empty { color: var(--muted); font-size: 13px; }
  .error { color: var(--warn); font-size: 13px; margin-bottom: 12px; }
  .rows { display: flex; flex-direction: column; gap: 16px; }
  .row { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  /* Every grid child is placed explicitly, so nothing can ever land squeezed in the divider's track. */
  /* The grid holds exactly the cards (one column each); the divider floats
     dead-center in the gap between them with zero footprint, so it never
     pushes them. A gap g shifts the gap's middle by ±g/6 off the bare
     fractions (half cancels out exactly). */
  .cells { position: relative; display: grid; gap: 16px; grid-template-columns: 1fr; }
  .row.half .cells { grid-template-columns: 1fr 1fr; --split: 50%; }
  .row.wide-left .cells { grid-template-columns: 2fr 1fr; --split: calc(66.6667% - 2.6667px); }
  .row.wide-right .cells { grid-template-columns: 1fr 2fr; --split: calc(33.3333% + 2.6667px); }
  .cell { min-width: 0; display: flex; flex-direction: column; }
  .cell:only-child { grid-column: 1 / -1; }
  .cell :global(article) { flex: 1; }
  .cell.editable { position: relative; cursor: grab; border-radius: var(--radius); }
  .cell.editable:active { cursor: grabbing; }
  .cell.editable:hover { outline: 1px dashed var(--line); outline-offset: 2px; }
  .cardbar, .rowbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 6px; }
  .cardbar button, .rowbar button, .rowbar select { padding: 3px 8px; font-size: 11px; }
  .cardbar button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  .grip { color: var(--muted); font-size: 12px; padding: 0 4px; }
  .moves { display: flex; gap: 4px; margin-left: auto; }
  .rowname { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-right: auto; }
  .rowbar label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .divider { position: absolute; top: 0; bottom: 0; left: var(--split); width: 17px; transform: translateX(-50%); z-index: 3; cursor: col-resize; touch-action: none; border-radius: 6px; }
  .divider::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; background: var(--line); border-radius: 1px; }
  .divider::after { content: "⠿"; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 5px 4px; font-size: 9px; line-height: 1; color: var(--muted); }
  .divider:hover::before { background: var(--accent); }
  .divider:hover::after { color: var(--accent); border-color: var(--accent); }
  .slot { grid-column: 2; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 120px; border: 1px dashed var(--line); border-radius: var(--radius); color: var(--muted); font-size: 12px; padding: 12px; }
  .slot label { display: flex; align-items: center; gap: 6px; }
  .endzone { border: 1px dashed var(--accent); border-radius: var(--radius); color: var(--muted); font-size: 12px; text-align: center; padding: 14px; }
  .howto { margin-top: 16px; border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 16px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .howto button { padding: 0; border: 0; background: none; color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
  @media (max-width: 720px) {
    .row.half .cells, .row.wide-left .cells, .row.wide-right .cells { grid-template-columns: 1fr; }
    .slot { grid-column: auto; }
    .divider { display: none; }
  }
</style>
