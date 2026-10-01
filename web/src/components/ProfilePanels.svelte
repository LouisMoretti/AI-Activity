<script lang="ts">
  import { PANEL_OPTIONS, TOOLS, type HoursResponse, type RankResponse,
    type PanelId, type PanelView, type PanelRow, type ProfilePanel, type RowRatio, type Tool, type Widget } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { clock } from "../lib/clock.svelte.ts";
  import { hasLiveWindow, toolName, type DashboardVM } from "../lib/view-model.ts";
  import ActivityToolCard from "./ActivityToolCard.svelte";
  import ProfileWidget from "./ProfileWidget.svelte";
  import QuotaCard from "./QuotaCard.svelte";
  import Section from "./Section.svelte";

  let { vm, rows, own, hours, rankInfo, onrowschange, ondevices }: {
    vm: DashboardVM; rows: PanelRow[]; own: boolean;
    hours: HoursResponse | null; rankInfo: RankResponse | null;
    onrowschange: (rows: PanelRow[]) => void; ondevices: () => void;
  } = $props();

  const labels: Record<Widget, string> = {
    "today-by-tool": "Today by tool", "today-by-hour": "Today by hour",
    "best-day": "Best day", leaderboard: "Leaderboard · 7 days",
  };
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
  let draft = $state<DraftRow[]>([]);
  /** A card drag in progress (shows the new-row zone at the end). */
  let dragging = $state<{ row: number; card: number } | null>(null);
  const shown = $derived(editing && own ? draft : rows);
  const usedKeys = $derived(new Set(draft.flatMap((r) => r.panels.map(panelKey))));
  const available = $derived(PANEL_OPTIONS.filter((option) => !usedKeys.has(panelKey(option))));

  function edit(): void {
    draft = editable(rows);
    error = "";
    adding = false;
    dragging = null;
    editing = true;
  }
  function cancel(): void { editing = false; adding = false; error = ""; dragging = null; }
  /** Keep every non-empty row; rows are edited as plain arrays, the server takes tuples. */
  function commit(next: DraftRow[]): void {
    draft = next.filter((r) => r.panels.length > 0)
      .map((r) => ({ ratio: r.ratio, panels: r.panels.slice(0, 2) as PanelRow["panels"] }));
  }
  function add(option: { id: PanelId; view?: PanelView }): void {
    commit([...editable(draft), { ratio: "full", panels: [{ ...option }] }]);
    adding = false;
  }
  function fillSlot(ri: number, option: { id: PanelId; view?: PanelView }): void {
    const next = editable(draft);
    if (next[ri] && next[ri].panels.length < 2) next[ri].panels.push({ ...option });
    commit(next);
  }
  function changeView(ri: number, ci: number, view: PanelView): void {
    const next = editable(draft);
    if (next[ri]?.panels[ci]) next[ri].panels[ci] = { ...next[ri].panels[ci], view };
    commit(next);
  }
  function removeCard(ri: number, ci: number): void {
    const next = editable(draft);
    if (next[ri]) next[ri].panels = next[ri].panels.filter((_, n) => n !== ci);
    commit(next);
  }
  /** Insert a card before another (same or other row); a full row splits in half for the guest. */
  function moveCard(fromR: number, fromC: number, toR: number, toC: number): void {
    const card = draft[fromR]?.panels[fromC];
    const target = draft[toR];
    if (!card || !target || toC < 0 || (fromR === toR && fromC === toC)) return;
    if (fromR !== toR && target.panels.length >= 2) return;
    const next = editable(draft);
    next[fromR].panels.splice(fromC, 1);
    let row = toR;
    let at = toC;
    if (next[fromR].panels.length === 0) {
      next.splice(fromR, 1);
      if (fromR < toR) row = toR - 1;
    } else if (fromR === toR && fromC < toC) {
      at = toC - 1;
    }
    if (next[row].panels.length >= 2) return;
    if (next[row].ratio === "full") next[row].ratio = "half";
    next[row].panels.splice(Math.min(at, next[row].panels.length), 0, card);
    commit(next);
  }
  /** Send a card to the end of another row, or to a new full row; a full row splits in half for the guest. */
  function moveCardToRow(fromR: number, fromC: number, to: number | "new"): void {
    const card = draft[fromR]?.panels[fromC];
    if (!card || to === fromR) return;
    if (to === "new") {
      const next = editable(draft);
      next[fromR].panels.splice(fromC, 1);
      commit([...next, { ratio: "full", panels: [card] }]);
      return;
    }
    const target = draft[to];
    if (!target || target.panels.length >= 2) return;
    const next = editable(draft);
    next[fromR].panels.splice(fromC, 1);
    let row = to;
    if (next[fromR].panels.length === 0) {
      next.splice(fromR, 1);
      if (fromR < to) row = to - 1;
    }
    if (next[row].panels.length >= 2) return;
    if (next[row].ratio === "full") next[row].ratio = "half";
    next[row].panels.push(card);
    commit(next);
  }
  function moveRow(fromR: number, toR: number): void {
    if (fromR === toR || !draft[fromR] || (!draft[toR] && toR !== draft.length) || toR < 0) return;
    const next = editable(draft);
    const [row] = next.splice(fromR, 1);
    next.splice(Math.min(toR, next.length), 0, row);
    commit(next);
  }
  /** Left/right arrows swap a card with its neighbour within a row. */
  function swapCard(ri: number, ci: number, direction: -1 | 1): void {
    const row = draft[ri];
    if (!row || !row.panels[ci + direction]) return;
    const next = editable(draft);
    const panels = next[ri].panels;
    [panels[ci], panels[ci + direction]] = [panels[ci + direction], panels[ci]];
    commit(next);
  }
  function cardKeys(e: KeyboardEvent, ri: number, ci: number): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (!e.altKey) swapCard(ri, ci, dir);
    } else if (e.altKey) {
      moveRow(ri, ri + dir);
    } else {
      moveCardToRow(ri, ci, ri + dir);
    }
  }
  /** A drag starting on the card's own controls (remove, view switch) moves nothing. */
  function cardDragStart(e: DragEvent, ri: number, ci: number): void {
    if ((e.target as HTMLElement | null)?.closest?.("button,select,a,input,textarea")) {
      e.preventDefault();
      return;
    }
    startDrag(e, { row: ri, card: ci });
  }
  /** Snap a divider position to the predefined widths (bounds sit halfway between thirds and half). */
  function snapRatio(pct: number): RowRatio {
    return pct < 41.7 ? "wide-right" : pct < 58.4 ? "half" : "wide-left";
  }
  const ratioShare = (ratio: RowRatio): number => ratio === "wide-left" ? 67 : ratio === "wide-right" ? 33 : 50;
  function dividerDown(e: PointerEvent): void {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  /** The row snaps live between the predefined widths while dragging; release changes nothing more. */
  function dividerMove(e: PointerEvent, ri: number): void {
    if (!e.buttons || !(editing && own)) return;
    const cells = (e.currentTarget as HTMLElement).parentElement;
    const rect = cells?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    const ratio = snapRatio(Math.min(85, Math.max(15, (e.clientX - rect.left) / rect.width * 100)));
    if (ratio === draft[ri]?.ratio) return;
    const next = editable(draft);
    if (next[ri]) next[ri].ratio = ratio;
    commit(next);
  }
  function dividerKeys(e: KeyboardEvent, ri: number): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const order: RowRatio[] = ["wide-right", "half", "wide-left"];
    const at = order.indexOf(draft[ri]?.ratio ?? "half");
    const ratio = order[Math.min(2, Math.max(0, at + (e.key === "ArrowRight" ? 1 : -1)))];
    const next = editable(draft);
    if (next[ri]) next[ri].ratio = ratio;
    commit(next);
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
  function startDrag(e: DragEvent, payload: NonNullable<typeof dragging>): void {
    e.dataTransfer?.setData("text/plain", JSON.stringify(payload));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    dragging = payload;
  }
  /**
   * A pointer-only drop zone (keyboard users get the card grips instead, so
   * the bare div needs no ARIA role). `enabled` keeps view mode inert; drops
   * validate their payload before acting.
   */
  function dropzone(node: HTMLElement, opts: { enabled: boolean; ondrop: (d: { row: number; card: number }) => void }) {
    let current = opts;
    const over = (e: DragEvent) => {
      if (!current.enabled || !(e.dataTransfer?.types.includes("text/plain"))) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };
    const drop = (e: DragEvent) => {
      const d = dragData(e);
      dragging = null;
      if (!current.enabled || !d) return;
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
  async function save(): Promise<void> {
    saving = true;
    error = "";
    try {
      const result = await api.savePanels(draft.map((r) => ({ ratio: r.ratio, panels: [...r.panels] as PanelRow["panels"] })));
      onrowschange(result.rows);
      editing = false;
      adding = false;
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
    <ProfileWidget widget={panel.id as Widget} {vm} {hours} {rankInfo} />
  {/if}
{/snippet}

<Section title="Dashboard panels" subtitle="Your chosen tools and usage cards">
  {#snippet actions()}
    {#if own}
      <div class="actions">
        {#if editing}
          <button type="button" onclick={() => adding = !adding} aria-expanded={adding}>+ Add panel</button>
          <button type="button" onclick={cancel} disabled={saving}>Cancel</button>
          <button type="button" class="primary" onclick={save} disabled={saving}>{saving ? "Saving…" : "Save layout"}</button>
        {:else}
          <button type="button" onclick={edit}>Edit layout</button>
        {/if}
      </div>
    {/if}
  {/snippet}

  {#if editing && own && adding}
    <div class="picker" aria-label="Available panels">
      {#each available as option (panelKey(option))}
        <button type="button" onclick={() => add(option)}>+ {optionName(option)}</button>
      {:else}<span>All panels are already shown.</span>{/each}
    </div>
  {/if}
  {#if editing && own && error}<p class="error" role="alert">{error}</p>{/if}

  <div class="rows" class:editing={editing && own}>
    {#each shown as row, ri (ri)}
      {@const split = row.ratio !== "full"}
      {@const pair = editing && own && split && row.panels.length === 2}
      <div class="row {row.ratio}"
        use:dropzone={{ enabled: editing && own, ondrop: (d) => moveCardToRow(d.row, d.card, ri) }}>
        <div class="cells">
          {#each row.panels as panel, ci (panelKey(panel))}
            {@const tool = isTool(panel.id) ? panel.id : null}
            {#if editing && own}
              <div class="cell editable" role="button" tabindex="0" draggable="true"
                aria-label="Move {optionName(panel)}: drag it, or press arrow keys (Alt moves the whole row)"
                ondragstart={(e) => cardDragStart(e, ri, ci)} ondragend={() => dragging = null}
                onkeydown={(e) => cardKeys(e, ri, ci)}
                use:dropzone={{ enabled: true, ondrop: (d) => moveCard(d.row, d.card, ri, ci) }}>
                <div class="overlay">
                  {#if tool && canSwitchView(tool)}
                    <div class="views" role="group" aria-label="View of {nameOf(tool)}">
                      <button type="button" aria-pressed={panel.view === "quota"}
                        disabled={usedKeys.has(`${panel.id}:quota`) && panel.view !== "quota"}
                        onclick={() => changeView(ri, ci, "quota")}>Quotas</button>
                      <button type="button" aria-pressed={panel.view === "activity"}
                        disabled={usedKeys.has(`${panel.id}:activity`) && panel.view !== "activity"}
                        onclick={() => changeView(ri, ci, "activity")}>Details</button>
                    </div>
                  {/if}
                  <button type="button" class="remove" aria-label="Remove {optionName(panel)}" title="Remove panel"
                    onclick={() => removeCard(ri, ci)}>×</button>
                </div>
                {@render cellBody(panel)}
              </div>
            {:else}
              <div class="cell">{@render cellBody(panel)}</div>
            {/if}
          {/each}
          {#if pair}
            {@const share = ratioShare(row.ratio)}
            <div class="divider" role="slider" aria-orientation="vertical" tabindex="0"
              aria-valuemin={33} aria-valuemax={67} aria-valuenow={share}
              aria-label="Resize row {ri + 1}" aria-valuetext="First card takes {share === 50 ? "half" : share < 50 ? "one third" : "two thirds"} of the row"
              title="Drag to resize (it snaps to half and thirds; arrow keys work too)"
              onpointerdown={dividerDown} onpointermove={(e) => dividerMove(e, ri)}
              onkeydown={(e) => dividerKeys(e, ri)}></div>
          {/if}
          {#if editing && own && split && row.panels.length < 2}
            <div class="slot"
              use:dropzone={{ enabled: true, ondrop: (d) => moveCardToRow(d.row, d.card, ri) }}>
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
      <div class="endzone"
        use:dropzone={{ enabled: true, ondrop: (d) => moveCardToRow(d.row, d.card, "new") }}>
        Drop here for a new row
      </div>
    {/if}
  </div>

  {#if own}
    <p class="howto">Drag a card by itself (arrow keys work too; Alt moves the whole row) — dropping it next to another shares the row. Drag the thin bar between two cards to resize them; it snaps live to half and thirds. Add a tool: run a device's install command from <button type="button" onclick={ondevices}>Settings → Devices</button> on that machine (Linux, macOS or Windows).</p>
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
  .cell.editable:hover { outline: 1px dashed var(--line); outline-offset: -1px; }
  .cell.editable:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .overlay { position: absolute; top: 8px; right: 8px; z-index: 2; display: flex; gap: 4px; opacity: 0; transition: opacity .12s; }
  .cell.editable:hover .overlay, .cell.editable:focus-within .overlay { opacity: 1; }
  .overlay button { padding: 3px 8px; font-size: 11px; }
  .views { display: flex; gap: 4px; }
  .views button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  .remove { margin-left: auto; }
  .divider { position: absolute; top: 0; bottom: 0; left: var(--split); width: 17px; transform: translateX(-50%); z-index: 3; cursor: col-resize; touch-action: none; border-radius: 6px; }
  .divider::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; background: var(--line); border-radius: 1px; }
  .divider::after { content: "⠿"; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 5px 4px; font-size: 9px; line-height: 1; color: var(--muted); }
  .divider:hover::before, .divider:focus-visible::before { background: var(--accent); }
  .divider:hover::after, .divider:focus-visible::after { color: var(--accent); border-color: var(--accent); }
  .divider:focus-visible { outline: none; }
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
