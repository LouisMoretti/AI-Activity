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
  const RATIOS: { value: RowRatio; label: string; title: string }[] = [
    { value: "full", label: "Full", title: "One card on the whole row" },
    { value: "half", label: "½ + ½", title: "Two cards, half the row each" },
    { value: "wide-left", label: "⅔ + ⅓", title: "Two cards, a wide one then a narrow one" },
    { value: "wide-right", label: "⅓ + ⅔", title: "Two cards, a narrow one then a wide one" },
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
  let draft = $state<DraftRow[]>([]);
  /** The in-flight drag (dataTransfer only exposes its payload on drop): shows the end zones. */
  let dragging = $state<{ kind: "card"; row: number; card: number } | { kind: "row"; row: number } | null>(null);
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
  function setRatio(ri: number, ratio: RowRatio): void {
    const next = editable(draft);
    const row = next[ri];
    if (!row) return;
    if (ratio === "full" && row.panels.length === 2) {
      // The second card moves to its own full row below, nothing is lost.
      const [first, second] = row.panels;
      commit([...next.slice(0, ri), { ratio, panels: [first] }, { ratio: "full", panels: [second] }, ...next.slice(ri + 1)]);
    } else {
      row.ratio = ratio;
      commit(next);
    }
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
  function removeRow(ri: number): void {
    commit(editable(draft).filter((_, i) => i !== ri));
  }
  /** Insert a card before another (same or other row); full rows refuse a second card. */
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
    next[row].panels.splice(Math.min(at, next[row].panels.length), 0, card);
    commit(next);
  }
  /** Send a card to the end of another row, or to a new full row; full rows refuse it. */
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
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      swapCard(ri, ci, e.key === "ArrowRight" ? 1 : -1);
    } else {
      moveCardToRow(ri, ci, ri + (e.key === "ArrowDown" ? 1 : -1));
    }
  }
  function rowKeys(e: KeyboardEvent, ri: number): void {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    moveRow(ri, ri + (e.key === "ArrowDown" ? 1 : -1));
  }
  function dragData(e: DragEvent): { kind: "card"; row: number; card: number } | { kind: "row"; row: number } | null {
    try {
      const value: unknown = JSON.parse(e.dataTransfer?.getData("text/plain") ?? "");
      if (typeof value !== "object" || value === null) return null;
      const rec = value as Record<string, unknown>;
      if (rec.kind === "row" && typeof rec.row === "number") return { kind: "row", row: rec.row };
      if (rec.kind === "card" && typeof rec.row === "number" && typeof rec.card === "number") {
        return { kind: "card", row: rec.row, card: rec.card };
      }
    } catch { /* a drag from outside the dashboard: ignored */ }
    return null;
  }
  function startDrag(e: DragEvent, payload: NonNullable<typeof dragging>): void {
    e.dataTransfer?.setData("text/plain", JSON.stringify(payload));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    dragging = payload;
  }
  type DropPayload = { kind: "card"; row: number; card: number } | { kind: "row"; row: number };
  /**
   * A pointer-only drop zone (keyboard users get the grips and the Row
   * lists instead, so the bare div needs no ARIA role). `enabled` keeps
   * view mode inert; drops validate their payload before acting.
   */
  function dropzone(node: HTMLElement, opts: { kinds: DropPayload["kind"][]; enabled: boolean; ondrop: (d: DropPayload) => void }) {
    let current = opts;
    const over = (e: DragEvent) => {
      if (!current.enabled || !(e.dataTransfer?.types.includes("text/plain"))) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };
    const drop = (e: DragEvent) => {
      const d = dragData(e);
      if (!current.enabled || !d || !current.kinds.includes(d.kind)) { dragging = null; return; }
      e.preventDefault();
      e.stopPropagation();
      current.ondrop(d);
      dragging = null;
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
      <div class="row {row.ratio}"
        use:dropzone={{ kinds: ["row", "card"], enabled: editing && own, ondrop: (d) => {
          if (d.kind === "row") { if (d.row !== ri) moveRow(d.row, ri); }
          else moveCardToRow(d.row, d.card, ri);
        } }}>
        {#if editing && own}
          <div class="rowbar">
            <span class="grip" role="button" tabindex="0" title="Drag to reorder rows (arrow keys work too)"
              aria-label="Reorder row {ri + 1}" draggable="true"
              ondragstart={(e) => startDrag(e, { kind: "row", row: ri })} ondragend={() => dragging = null}
              onkeydown={(e) => rowKeys(e, ri)}>⠿</span>
            <span class="rowname">Row {ri + 1}</span>
            <div class="ratios" role="group" aria-label="Width of row {ri + 1}">
              {#each RATIOS as ratio}
                <button type="button" title={ratio.title} aria-pressed={row.ratio === ratio.value}
                  onclick={() => setRatio(ri, ratio.value)}>{ratio.label}</button>
              {/each}
            </div>
            <button type="button" class="remove" aria-label="Remove row {ri + 1}" title="Remove row" onclick={() => removeRow(ri)}>×</button>
          </div>
        {/if}
        <div class="cells">
          {#each row.panels as panel, ci (panelKey(panel))}
            {@const tool = isTool(panel.id) ? panel.id : null}
            {@const quota = tool ? quotaFor(tool) : null}
            <div class="cell"
              use:dropzone={{ kinds: ["card"], enabled: editing && own, ondrop: (d) => {
                if (d.kind === "card") moveCard(d.row, d.card, ri, ci);
              } }}>
              {#if editing && own}
                <div class="controls">
                  <span class="grip" role="button" tabindex="0" title="Drag to move (arrow keys work too)"
                    aria-label="Move {optionName(panel)}" draggable="true"
                    ondragstart={(e) => startDrag(e, { kind: "card", row: ri, card: ci })} ondragend={() => dragging = null}
                    onkeydown={(e) => cardKeys(e, ri, ci)}>⠿</span>
                  <strong>{optionName(panel)}</strong>
                  <label><span>Row</span><select aria-label="Move {optionName(panel)} to row"
                    value={ri} onchange={(e) => {
                      const value = e.currentTarget.value;
                      // The re-render shows the card's new row; reset here for a refused move.
                      e.currentTarget.value = String(ri);
                      if (value === "new") moveCardToRow(ri, ci, "new");
                      else if (Number(value) !== ri) moveCardToRow(ri, ci, Number(value));
                    }}>
                    {#each draft as _, n}<option value={n}>Row {n + 1}</option>{/each}
                    <option value="new">New row</option>
                  </select></label>
                  {#if tool && canSwitchView(tool)}
                    <label><span>View</span><select aria-label="View of {nameOf(tool)}" value={panel.view}
                      onchange={(e) => changeView(ri, ci, e.currentTarget.value as PanelView)}>
                      <option value="quota" disabled={usedKeys.has(`${panel.id}:quota`) && panel.view !== "quota"}>Quotas</option>
                      <option value="activity" disabled={usedKeys.has(`${panel.id}:activity`) && panel.view !== "activity"}>Details</option>
                    </select></label>
                  {/if}
                  <button type="button" class="remove" aria-label="Remove {optionName(panel)}" title="Remove panel" onclick={() => removeCard(ri, ci)}>×</button>
                </div>
              {/if}
              {#if tool}
                {#if panel.view === "quota" && quota && (tool !== "antigravity" || hasLiveWindow(quota, clock.now))}
                  <QuotaCard vm={quota} />
                {:else}
                  <ActivityToolCard {tool} vm={activityFor(tool)} />
                {/if}
              {:else}
                <ProfileWidget widget={panel.id as Widget} {vm} {hours} {rankInfo} />
              {/if}
            </div>
          {/each}
          {#if editing && own && split && row.panels.length < 2}
            <div class="slot"
              use:dropzone={{ kinds: ["card"], enabled: editing && own, ondrop: (d) => {
                if (d.kind === "card") moveCardToRow(d.row, d.card, ri);
              } }}>
              <label><span>Fill this half</span><select aria-label="Add a panel to row {ri + 1}" value=""
                onchange={(e) => { if (e.currentTarget.value) fillSlot(ri, JSON.parse(e.currentTarget.value) as { id: PanelId; view?: PanelView }); e.currentTarget.value = ""; }}>
                <option value="">+ Add a panel…</option>
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
    {#if editing && own && dragging?.kind === "row"}
      <div class="endzone"
        use:dropzone={{ kinds: ["row"], enabled: true, ondrop: (d) => { if (d.kind === "row") moveRow(d.row, draft.length); } }}>
        Drop here to move this row last
      </div>
    {/if}
    {#if editing && own && dragging?.kind === "card"}
      <div class="endzone"
        use:dropzone={{ kinds: ["card"], enabled: true, ondrop: (d) => { if (d.kind === "card") moveCardToRow(d.row, d.card, "new"); } }}>
        Drop here for a new row
      </div>
    {/if}
  </div>

  {#if own}
    <p class="howto">Drag cards (or move them with the Row list and arrow keys) to arrange your dashboard; pick a width per row. Add a tool: run a device's install command from <button type="button" onclick={ondevices}>Settings → Devices</button> on that machine (Linux, macOS or Windows).</p>
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
  .cells { display: grid; gap: 16px; grid-template-columns: 1fr; }
  .row.half .cells { grid-template-columns: 1fr 1fr; }
  .row.wide-left .cells { grid-template-columns: 2fr 1fr; }
  .row.wide-right .cells { grid-template-columns: 1fr 2fr; }
  .cell { min-width: 0; display: flex; flex-direction: column; }
  .cell:only-child { grid-column: 1 / -1; }
  .cell :global(article) { flex: 1; }
  .rowbar { display: flex; align-items: center; gap: 8px; padding: 7px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .rowname { font-size: 11px; color: var(--muted); }
  .ratios { display: flex; gap: 4px; margin-left: auto; }
  .ratios button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  .controls { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; padding: 7px; margin-bottom: 5px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .controls strong { flex: 1 1 auto; font-size: 11px; font-weight: 500; min-width: 0; }
  .controls label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 11px; }
  .controls button { padding: 3px 7px; }
  .grip { cursor: grab; color: var(--muted); padding: 3px 7px; border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 12px; user-select: none; }
  .grip:active { cursor: grabbing; }
  .grip:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
  .remove { margin-left: auto; }
  .rowbar .remove { margin-left: 0; }
  .slot { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 120px; border: 1px dashed var(--line); border-radius: var(--radius); color: var(--muted); font-size: 12px; padding: 12px; }
  .slot label { display: flex; align-items: center; gap: 6px; }
  .endzone { border: 1px dashed var(--accent); border-radius: var(--radius); color: var(--muted); font-size: 12px; text-align: center; padding: 14px; }
  .howto { margin-top: 16px; border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 16px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .howto button { padding: 0; border: 0; background: none; color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
  @media (max-width: 720px) { .row.half .cells, .row.wide-left .cells, .row.wide-right .cells { grid-template-columns: 1fr; } }
</style>
