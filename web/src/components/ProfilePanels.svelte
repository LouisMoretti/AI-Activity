<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { PANEL_OPTIONS, TOOLS, ratioFor,
    type PanelId, type PanelView, type PanelRow, type ProfilePanel, type RowRatio, type Tool, type Widget } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { clock } from "../lib/clock.svelte.ts";
  import { hasLiveWindow, toolName, TOOL_META, type DashboardVM } from "../lib/view-model.ts";
  import ActivityToolCard from "./ActivityToolCard.svelte";
  import ProfileWidget from "./ProfileWidget.svelte";
  import QuotaCard from "./QuotaCard.svelte";
  import Section from "./Section.svelte";

  let { vm, sample, rows, own, onrowschange, ondevices }: {
    vm: DashboardVM;
    /** Fictional data the cards show while the owner edits (demo.ts): the final look, not their data. */
    sample: () => DashboardVM;
    rows: PanelRow[]; own: boolean;
    onrowschange: (rows: PanelRow[]) => void; ondevices: () => void;
  } = $props();

  const labels: Record<Widget, string> = {
    "today-by-tool": "Today by tool", "today-by-hour": "Today by hour",
    "best-day": "Best day", leaderboard: "Leaderboard · 7 days",
  };
  const isTool = (id: PanelId): id is Tool => (TOOLS as readonly string[]).includes(id);
  const canSwitchView = (id: PanelId) => ["claude-code", "codex", "antigravity"].includes(id);
  const nameOf = (id: PanelId) => isTool(id) ? toolName(id) : labels[id as Widget];
  const optionName = (option: { id: PanelId; view?: PanelView }) =>
    `${nameOf(option.id)}${canSwitchView(option.id) ? option.view === "activity" ? " · Details" : " · Quotas" : ""}`;
  const panelKey = (panel: { id: PanelId; view?: PanelView }) => `${panel.id}:${panel.view ?? ""}`;
  const fromKey = (key: string): ProfilePanel => {
    const [id, view] = key.split(":");
    return view ? { id: id as PanelId, view: view as PanelView } : { id: id as PanelId };
  };
  const quotaFor = (d: DashboardVM, tool: Tool) => tool === "claude-code" ? d.claude : tool === "codex" ? d.codex : tool === "antigravity" ? d.antigravity : null;
  const activityFor = (d: DashboardVM, tool: Tool) => tool === "claude-code" ? d.claudeActivity : tool === "codex" ? d.codexActivity
    : tool === "cursor" ? d.cursor : tool === "antigravity" ? d.antigravityActivity : d.opencode;

  /** An edited row: an id that survives moves (for the slide animation), its ratio and cards (keys). */
  interface DraftRow { id: number; ratio: RowRatio; keys: string[] }
  let nextId = 0;
  const toDraft = (list: PanelRow[]): DraftRow[] => list.map((r) => ({ id: nextId++, ratio: r.ratio, keys: r.panels.map(panelKey) }));
  const toRows = (list: DraftRow[]): PanelRow[] =>
    list.map((r) => ({ ratio: r.ratio, panels: r.keys.map(fromKey) as PanelRow["panels"] }));
  const clone = (list: DraftRow[]): DraftRow[] => list.map((r) => ({ ...r, keys: [...r.keys] }));
  /** Drops emptied rows and gives each row the ratio its card count takes. */
  const tidy = (list: DraftRow[]): DraftRow[] => list.filter((r) => r.keys.length > 0)
    .map((r) => ({ ...r, ratio: ratioFor(r.keys.length, r.ratio) }));

  /**
   * Where a dragged card goes, relative to the layout without it (`base`):
   * into a row with room (`row`), in place of a card of a full row, which
   * takes the dragged card's old place (`swap`), on a new row (`new`), or
   * off the dashboard (`remove`, back to the drawer).
   */
  type Placement =
    | { kind: "row"; row: number; index: number }
    | { kind: "swap"; row: number; index: number }
    | { kind: "new"; at: number }
    | { kind: "remove" };
  interface Drag {
    key: string;
    /** The layout when the drag started (Escape goes back to it). */
    origin: DraftRow[];
    /** Where the card was: its row id and position, null from the drawer. */
    from: { row: number; index: number } | null;
    placement: Placement;
    pointer: { id: number; dx: number; dy: number; x: number; y: number; width: number; height: number } | null;
  }

  let editing = $state(false);
  let saving = $state(false);
  let error = $state("");
  /** What the last step did, for screen readers (a polite live region). */
  let announcement = $state("");
  let draft = $state<DraftRow[]>([]);
  let drag = $state<Drag | null>(null);
  let overTray = $state(false);
  let preview = $state<DashboardVM | null>(null);
  let root = $state<HTMLElement>();
  let tray = $state<HTMLElement>();

  const edit = $derived(editing && own);
  const shown = $derived<DraftRow[]>(edit ? draft : toDraftStable(rows));
  const data = $derived(edit && preview ? preview : vm);
  const used = $derived(new Set(draft.flatMap((r) => r.keys)));
  const available = $derived(PANEL_OPTIONS.map(panelKey).filter((k) => !used.has(k)));

  // View mode: ids follow the index so nothing animates between refreshes.
  function toDraftStable(list: PanelRow[]): DraftRow[] {
    return list.map((r, i) => ({ id: -1 - i, ratio: r.ratio, keys: r.panels.map(panelKey) }));
  }

  function startEditing(): void {
    draft = toDraft(rows);
    preview = sample();
    error = "";
    announcement = "Editing the layout. Cards show sample data. Drag a card to move it, or focus it and press Space.";
    editing = true;
  }
  function cancel(): void {
    endDrag(false);
    editing = false;
    preview = null;
    error = "";
    announcement = "Layout changes discarded";
  }
  async function save(): Promise<void> {
    endDrag(true);
    saving = true;
    error = "";
    try {
      const result = await api.savePanels(toRows(draft));
      onrowschange(result.rows);
      editing = false;
      preview = null;
      announcement = "Layout saved";
    } catch { error = "Could not save your dashboard. Try again."; }
    finally { saving = false; }
  }

  /** Where a card sits in a layout: row index and position. */
  function locate(list: DraftRow[], key: string): { row: number; index: number } | null {
    for (let r = 0; r < list.length; r++) {
      const index = list[r].keys.indexOf(key);
      if (index >= 0) return { row: r, index };
    }
    return null;
  }
  /** The layout without the dragged card (its emptied row gone; ratios kept until the final tidy). */
  function baseOf(d: Drag): DraftRow[] {
    return d.origin.map((r) => ({ ...r, keys: r.keys.filter((k) => k !== d.key) })).filter((r) => r.keys.length > 0);
  }
  /** The layout a placement gives, from the drag's origin: pure, so every step can be undone. */
  function apply(d: Drag, p: Placement): DraftRow[] {
    const base = clone(baseOf(d));
    if (p.kind === "remove") return base;
    if (p.kind === "new") {
      base.splice(p.at, 0, { id: nextId++, ratio: "full", keys: [d.key] });
      return tidy(base);
    }
    const target = base[p.row];
    if (!target) return tidy(base);
    if (p.kind === "row") {
      target.keys.splice(p.index, 0, d.key);
      return tidy(base);
    }
    // Swap: the card hovered over leaves the full row for the dragged card's old place.
    const [displaced] = target.keys.splice(p.index, 1, d.key);
    const from = d.from && d.origin.find((r) => r.id === d.from!.row);
    const home = from ? base.findIndex((r) => r.id === from.id) : -1;
    if (home >= 0) base[home].keys.splice(d.from!.index, 0, displaced);
    else {
      // The dragged card was alone in its row: the displaced card takes that row.
      const at = from ? d.origin.indexOf(from) : base.length;
      const before = d.origin.slice(0, at).filter((r) => base.some((b) => b.id === r.id)).length;
      base.splice(before, 0, { id: nextId++, ratio: "full", keys: [displaced] });
    }
    return tidy(base);
  }
  const same = (a: Placement, b: Placement) => JSON.stringify(a) === JSON.stringify(b);

  function describe(d: Drag, p: Placement, list: DraftRow[]): string {
    const name = optionName(fromKey(d.key));
    if (p.kind === "remove") return `${name}: drop to remove it from the dashboard`;
    const at = locate(list, d.key);
    if (!at) return name;
    const row = list[at.row];
    const where = row.keys.length > 1 ? `, position ${at.index + 1} of ${row.keys.length}` : "";
    const swapped = p.kind === "swap" ? `, swapping with ${optionName(fromKey(baseOf(d)[p.row]?.keys[p.index] ?? d.key))}` : "";
    return `${name}: row ${at.row + 1} of ${list.length}${where}${swapped}`;
  }

  function place(p: Placement): void {
    if (!drag || same(drag.placement, p)) return;
    drag.placement = p;
    draft = apply(drag, p);
    overTray = p.kind === "remove";
    announcement = describe(drag, p, draft);
  }

  function beginDrag(key: string, pointer: Drag["pointer"]): void {
    const origin = clone(draft);
    const at = locate(origin, key);
    const d: Drag = {
      key, origin, pointer,
      from: at ? { row: origin[at.row].id, index: at.index } : null,
      placement: at ? { kind: "row", row: 0, index: 0 } : { kind: "remove" },
    };
    // The starting placement: where the card already is (or nowhere, from the drawer).
    if (at) {
      const base = baseOf(d);
      const kept = base.findIndex((r) => r.id === origin[at.row].id);
      d.placement = kept >= 0 ? { kind: "row", row: kept, index: at.index }
        : { kind: "new", at: origin.slice(0, at.row).filter((r) => base.some((b) => b.id === r.id)).length };
    }
    drag = d;
    changedAt = null;
    overTray = !at;
    announcement = `Picked up ${optionName(fromKey(key))}. ${pointer ? "" : "Arrow keys move it, Space drops it, Escape cancels."}`;
  }
  /** Ends a drag: keeps where the card is now, or (Escape) goes back to the layout before it. */
  function endDrag(keep: boolean): void {
    if (!drag) return;
    const d = drag;
    if (!keep) draft = clone(d.origin);
    drag = null;
    overTray = false;
    stopPointer();
    const name = optionName(fromKey(d.key));
    announcement = !keep ? `${name}: move cancelled`
      : d.placement.kind === "remove" ? (d.from ? `${name} removed` : `${name} not added`)
      : `${name} dropped, ${describe(d, d.placement, draft).split(": ")[1] ?? ""}`;
  }

  // ---- Pointer dragging (mouse at once past a few pixels, touch after a long press) ----

  const SLIDE_MS = 180;
  const LONG_PRESS_MS = 350;
  let pending: { key: string; id: number; x: number; y: number; el: HTMLElement; timer: number | null; touch: boolean } | null = null;
  /**
   * Hit tests wait for the cards to finish sliding, and for the pointer to
   * move after a change: a layout that shifts under a still pointer never
   * moves the card again (no flicker between two places).
   */
  let settleUntil = 0;
  let changedAt: { x: number; y: number } | null = null;
  let settleTimer: number | null = null;

  function pointerDown(e: PointerEvent, key: string): void {
    if (!edit || drag || e.button !== 0 || saving) return;
    const el = e.currentTarget as HTMLElement;
    const touch = e.pointerType !== "mouse";
    pending = { key, id: e.pointerId, x: e.clientX, y: e.clientY, el, touch, timer: null };
    if (touch) pending.timer = window.setTimeout(() => pending && lift(pending.x, pending.y), LONG_PRESS_MS);
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerCancel);
  }
  function lift(x: number, y: number): void {
    if (!pending) return;
    const rect = pending.el.getBoundingClientRect();
    // From the drawer, the floating preview is card-sized, held by its corner.
    const fromTray = pending.el.dataset.tray !== undefined;
    const width = fromTray ? Math.min(380, (root?.clientWidth ?? 760) / 2) : Math.min(rect.width, 560);
    beginDrag(pending.key, {
      id: pending.id, x, y, width, height: fromTray ? 240 : Math.min(rect.height, 360),
      dx: fromTray ? 28 : pending.x - rect.left, dy: fromTray ? 22 : pending.y - rect.top,
    });
    navigator.vibrate?.(10);
    // A touch drag follows the touch events (see the effect below), not the pointer.
    touchDrag = pending.touch;
    pending = null;
    scrollFrame = requestAnimationFrame(autoScroll);
  }
  /** Near the top or bottom of the window, the page scrolls (faster closer to the edge). */
  const EDGE = 70;
  let scrollFrame = 0;
  function autoScroll(): void {
    if (!drag?.pointer) return;
    const { x, y } = drag.pointer;
    // The drawer sticks to the bottom: the lower scroll zone sits just above it.
    const drawer = tray?.getBoundingClientRect();
    const bottom = drawer && drawer.top < innerHeight ? drawer.top : innerHeight;
    const overDrawer = drawer && inside(drawer, x, y, 0);
    const speed = overDrawer ? 0 : y < EDGE ? -(EDGE - y) / 3 : y > bottom - EDGE ? (y - bottom + EDGE) / 3 : 0;
    if (speed) {
      scrollBy(0, Math.max(-24, Math.min(24, speed)));
      hitTest();
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  }
  function pointerMove(e: PointerEvent): void {
    if (touchDrag) return;
    if (pending && e.pointerId === pending.id) {
      const moved = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
      if (pending.touch) {
        // Moving before the long press is a scroll: let it be.
        if (moved > 8) cancelPending();
        else { pending.x = e.clientX; pending.y = e.clientY; }
      } else if (moved > 4) lift(e.clientX, e.clientY);
      return;
    }
    if (!drag?.pointer || e.pointerId !== drag.pointer.id) return;
    drag.pointer.x = e.clientX;
    drag.pointer.y = e.clientY;
    hitTest();
  }
  function pointerUp(e: PointerEvent): void {
    if (pending && e.pointerId === pending.id) { cancelPending(); return; }
    // The card lands where the placeholder shows: no last-moment hit test.
    if (drag?.pointer && e.pointerId === drag.pointer.id) endDrag(true);
  }
  function pointerCancel(): void {
    cancelPending();
    if (drag?.pointer && !touchDrag) endDrag(false);
  }
  let touchDrag = false;
  /**
   * While editing, touch listeners stay on the window from before a touch
   * starts: the browser only lets a listener that was there at touchstart
   * stop the page from scrolling (one added later is treated as passive,
   * and a moving finger then scrolls and cancels its pointer).
   */
  $effect(() => {
    if (!edit) return;
    window.addEventListener("touchmove", touchMove, { passive: false });
    window.addEventListener("touchend", touchEnd);
    window.addEventListener("touchcancel", touchEnd);
    // No native drag (a logo, a selection) while editing: it would take a long press over.
    const noNativeDrag = (e: DragEvent) => {
      if ((e.target as Node | null) instanceof Node && root?.parentElement?.contains(e.target as Node)) e.preventDefault();
    };
    window.addEventListener("dragstart", noNativeDrag);
    return () => {
      window.removeEventListener("dragstart", noNativeDrag);
      window.removeEventListener("touchmove", touchMove);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", touchEnd);
    };
  });
  function touchMove(e: TouchEvent): void {
    if (!drag?.pointer || !touchDrag) return;
    e.preventDefault();
    const t = e.touches[0];
    if (!t) return;
    drag.pointer.x = t.clientX;
    drag.pointer.y = t.clientY;
    hitTest();
  }
  function touchEnd(e: TouchEvent): void {
    if (drag?.pointer && touchDrag) endDrag(e.type === "touchend");
  }
  function cancelPending(): void {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
    if (!drag) stopPointer();
  }
  function stopPointer(): void {
    window.removeEventListener("pointermove", pointerMove);
    window.removeEventListener("pointerup", pointerUp);
    window.removeEventListener("pointercancel", pointerCancel);
    touchDrag = false;
    cancelAnimationFrame(scrollFrame);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  }
  onDestroy(() => { cancelPending(); stopPointer(); });

  /**
   * The placement under the pointer. Over the drawer: remove. In the top
   * or bottom band of a row: a new row above or below it. Over a card: next
   * to it, on the side the pointer is on (or in its place, in a full row).
   * Over the placeholder or nothing: unchanged.
   */
  function hitTest(): void {
    if (!drag?.pointer || !root) return;
    const { x, y } = drag.pointer;
    // Page coordinates: scrolling moves the pointer over the layout too.
    if (changedAt && Math.hypot(x + scrollX - changedAt.x, y + scrollY - changedAt.y) < 8) return;
    const now = performance.now();
    if (now < settleUntil) {
      if (!settleTimer) settleTimer = window.setTimeout(() => { settleTimer = null; hitTest(); }, settleUntil - now);
      return;
    }
    const before = drag.placement;
    const p = placementAt(x, y);
    if (p) place(p);
    if (drag && !same(before, drag.placement)) {
      settleUntil = performance.now() + SLIDE_MS;
      changedAt = { x: x + scrollX, y: y + scrollY };
    }
  }
  function placementAt(x: number, y: number): Placement | null {
    if (!drag) return null;
    if (tray && inside(tray.getBoundingClientRect(), x, y, 0)) return drag.from ? { kind: "remove" } : null;
    const base = baseOf(drag);
    const rowEls = [...root!.querySelectorAll<HTMLElement>("[data-row]")];
    if (!rowEls.length) return { kind: "new", at: 0 };
    for (const rowEl of rowEls) {
      const rect = rowEl.getBoundingClientRect();
      if (y < rect.top - 9 || y > rect.bottom + 9) continue;
      const keys = (rowEl.dataset.keys ?? "").split(",").filter((k) => k && k !== drag!.key);
      // A row holding only the placeholder: already where the pointer is.
      if (!keys.length) return null;
      const index = base.findIndex((r) => r.keys.includes(keys[0]));
      if (index < 0) return null;
      const band = Math.min(48, rect.height * 0.22);
      if (y < rect.top + band) return { kind: "new", at: index };
      if (y > rect.bottom - band) return { kind: "new", at: index + 1 };
      return cardPlacement(rowEl, base, index, x);
    }
    const first = rowEls[0].getBoundingClientRect();
    if (y < first.top) return { kind: "new", at: 0 };
    // Just below the last row: a new row at the end (further down, nothing changes).
    const last = rowEls[rowEls.length - 1].getBoundingClientRect();
    if (y > last.bottom && y < last.bottom + 80) return { kind: "new", at: base.length };
    return null;
  }
  function cardPlacement(rowEl: HTMLElement, base: DraftRow[], row: number, x: number): Placement | null {
    if (!drag) return null;
    const cells = [...rowEl.querySelectorAll<HTMLElement>("[data-key]")];
    // The card under the pointer, else the nearest one.
    let hit: HTMLElement | null = null;
    let best = Infinity;
    for (const cell of cells) {
      const r = cell.getBoundingClientRect();
      const distance = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (distance < best) { best = distance; hit = cell; }
    }
    if (!hit || hit.dataset.key === drag.key) return null;
    const rect = hit.getBoundingClientRect();
    const index = base[row].keys.indexOf(hit.dataset.key!);
    if (index < 0) return null;
    if (base[row].keys.length >= 3) return drag.from ? { kind: "swap", row, index } : null;
    return { kind: "row", row, index: x < rect.left + rect.width / 2 ? index : index + 1 };
  }
  const inside = (r: DOMRect, x: number, y: number, pad: number) =>
    x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;

  // ---- Keyboard dragging (Space or Enter picks up, arrows move, Space drops, Escape cancels) ----

  /** Every placement in reading order, with the line it sits on (new-row slots between rows). */
  function placements(d: Drag): { p: Placement; line: number; index: number }[] {
    const base = baseOf(d);
    const list: { p: Placement; line: number; index: number }[] = [];
    base.forEach((row, r) => {
      list.push({ p: { kind: "new", at: r }, line: 2 * r, index: 0 });
      if (row.keys.length < 3) {
        for (let i = 0; i <= row.keys.length; i++) list.push({ p: { kind: "row", row: r, index: i }, line: 2 * r + 1, index: i });
      } else if (d.from) {
        row.keys.forEach((_, i) => list.push({ p: { kind: "swap", row: r, index: i }, line: 2 * r + 1, index: i }));
      }
    });
    list.push({ p: { kind: "new", at: base.length }, line: 2 * base.length, index: 0 });
    if (d.from) list.push({ p: { kind: "remove" }, line: 2 * base.length + 1, index: 0 });
    return list;
  }
  async function keyMove(dir: "left" | "right" | "up" | "down"): Promise<void> {
    if (!drag) return;
    const list = placements(drag);
    const at = Math.max(0, list.findIndex((o) => same(o.p, drag!.placement)));
    let next = at;
    if (dir === "left") next = Math.max(0, at - 1);
    else if (dir === "right") next = Math.min(list.length - 1, at + 1);
    else {
      const line = list[at].line + (dir === "down" ? 1 : -1);
      const options = list.filter((o) => o.line === line);
      const pick = options.find((o) => o.index === list[at].index) ?? options[options.length - 1];
      if (pick) next = list.indexOf(pick);
    }
    place(list[next].p);
    await refocus(drag.key);
  }
  async function refocus(key: string): Promise<void> {
    await tick();
    const target = root?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
      ?? tray?.querySelector<HTMLElement>(`[data-tray="${CSS.escape(key)}"]`);
    target?.focus();
  }
  async function keyDown(e: KeyboardEvent, key: string): Promise<void> {
    if (!edit) return;
    if (!drag) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        beginDrag(key, null);
        // From the drawer, the card first lands on a new row at the end.
        const held = drag as Drag | null;
        if (held && !held.from) place({ kind: "new", at: baseOf(held).length });
        await refocus(key);
      }
      return;
    }
    if (drag.pointer || drag.key !== key) return;
    const dirs: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    if (dirs[e.key]) { e.preventDefault(); await keyMove(dirs[e.key]); }
    else if (e.key === " " || e.key === "Enter") { e.preventDefault(); endDrag(true); await refocus(key); }
    else if (e.key === "Escape") { e.preventDefault(); endDrag(false); await refocus(key); }
    else if (e.key === "Tab") endDrag(true);
  }

  // ---- Widths of a two-card row: the bar between them snaps to half and thirds ----

  const SHARES: [RowRatio, number][] = [["wide-right", 100 / 3], ["half", 50], ["wide-left", 200 / 3]];
  const shareOf = (ratio: RowRatio) => SHARES.find(([r]) => r === ratio)?.[1] ?? 50;
  function setRatio(id: number, ratio: RowRatio): void {
    const row = draft.find((r) => r.id === id);
    if (!row || row.ratio === ratio) return;
    row.ratio = ratio;
    announcement = `First card takes ${ratio === "half" ? "half" : ratio === "wide-left" ? "two thirds" : "one third"} of the row`;
  }
  function resizer(node: HTMLElement, id: number) {
    let row = id;
    const down = (e: PointerEvent) => { e.preventDefault(); node.setPointerCapture(e.pointerId); };
    const move = (e: PointerEvent) => {
      if (!node.hasPointerCapture(e.pointerId)) return;
      const rect = node.parentElement?.getBoundingClientRect();
      if (!rect?.width) return;
      const pct = (e.clientX - rect.left) / rect.width * 100;
      setRatio(row, pct < 41.7 ? "wide-right" : pct < 58.4 ? "half" : "wide-left");
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    return {
      update: (next: number) => { row = next; },
      destroy: () => { node.removeEventListener("pointerdown", down); node.removeEventListener("pointermove", move); },
    };
  }
  function resizeKeys(e: KeyboardEvent, row: DraftRow): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const at = SHARES.findIndex(([r]) => r === row.ratio);
    const next = SHARES[Math.min(2, Math.max(0, (at < 0 ? 1 : at) + (e.key === "ArrowRight" ? 1 : -1)))];
    setRatio(row.id, next[0]);
  }

  /** Cards and rows slide to their new place (translation only: text never stretches). */
  function slide(node: Element, { from, to }: { from: DOMRect; to: DOMRect }) {
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const still = !dx && !dy || matchMedia("(prefers-reduced-motion: reduce)").matches;
    return { duration: still ? 0 : SLIDE_MS, easing: cubicOut, css: (_t: number, u: number) => `transform: translate(${u * dx}px, ${u * dy}px)` };
  }

  /** A card while editing: a focusable draggable (its content is inert, so nothing interactive is nested). */
  const draggableAttrs = (label: string, held: boolean) => ({
    role: "button", tabindex: 0, "aria-roledescription": "draggable card", "aria-label": label,
    "aria-describedby": "panel-drag-help", "aria-pressed": held,
  });

  const ghostPanel = $derived(drag?.pointer ? fromKey(drag.key) : null);
</script>

{#snippet card(panel: ProfilePanel, d: DashboardVM)}
  {@const tool = isTool(panel.id) ? panel.id : null}
  {@const quota = tool ? quotaFor(d, tool) : null}
  {#if tool}
    {#if panel.view === "quota" && quota && (tool !== "antigravity" || hasLiveWindow(quota, clock.now))}
      <QuotaCard vm={quota} />
    {:else}
      <ActivityToolCard {tool} vm={activityFor(d, tool)} />
    {/if}
  {:else}
    <ProfileWidget widget={panel.id as Widget} vm={d} />
  {/if}
{/snippet}

<Section title="Dashboard panels" subtitle="Your chosen tools and usage cards">
  {#snippet actions()}
    {#if own}
      <div class="actions">
        {#if edit}
          <span class="sample">Sample data</span>
          <button type="button" onclick={cancel} disabled={saving}>Cancel</button>
          <button type="button" class="primary" onclick={save} disabled={saving}>{saving ? "Saving…" : "Save layout"}</button>
        {:else}
          <button type="button" onclick={startEditing}>Edit layout</button>
        {/if}
      </div>
    {/if}
  {/snippet}

  {#if own}
    <p class="sr-only" aria-live="polite">{announcement}</p>
    <p class="sr-only" id="panel-drag-help">Press Space to pick up the card. Arrow keys move it, Space drops it, Escape cancels.</p>
  {/if}
  {#if edit && error}<p class="error" role="alert">{error}</p>{/if}

  <div class="rows" class:editing={edit} class:dragging={drag?.pointer} bind:this={root}>
    {#each shown as row (row.id)}
      <div class="row {row.ratio}" data-row data-keys={row.keys.join(",")} animate:slide>
        <div class="cells">
          {#each row.keys as key (key)}
            {@const panel = fromKey(key)}
            {@const held = edit && drag?.key === key}
            <div class="cell" class:editable={edit} class:placeholder={held && drag?.pointer} class:lifted={held && !drag?.pointer}
              data-key={key} {...(edit ? draggableAttrs(optionName(panel), held) : {})}
              onpointerdown={(e) => pointerDown(e, key)} onkeydown={(e) => keyDown(e, key)}
              oncontextmenu={(e) => { if (edit) e.preventDefault(); }} animate:slide>
              {#if edit}<div class="body" inert>{@render card(panel, data)}</div>{:else}{@render card(panel, data)}{/if}
            </div>
          {/each}
          {#if edit && !drag && row.keys.length === 2}
            {@const share = shareOf(row.ratio)}
            <div class="divider" role="slider" aria-orientation="horizontal" tabindex="0"
              aria-label="Widths of row {shown.indexOf(row) + 1}" aria-valuemin={33} aria-valuemax={67} aria-valuenow={Math.round(share)}
              aria-valuetext="First card takes {row.ratio === "half" ? "half" : row.ratio === "wide-left" ? "two thirds" : "one third"} of the row"
              title="Drag to resize: it snaps to half and thirds"
              use:resizer={row.id} onkeydown={(e) => resizeKeys(e, row)}></div>
          {/if}
        </div>
      </div>
    {:else}
      <p class="empty">No panels selected.{#if own} {edit ? "Drag one from the drawer below." : "Use Edit layout to add one."}{/if}</p>
    {/each}
  </div>

  {#if edit}
    <div class="tray" class:removing={drag?.from && drag.pointer} class:over={overTray && drag?.from} bind:this={tray}
      role="group" aria-label="Available panels">
      {#if drag?.from && drag.pointer}
        <span class="drop">Drop here to remove</span>
      {:else}
        <span class="hint">{available.length ? "Drag a panel onto the dashboard" : "Every panel is on the dashboard"}</span>
        {#each available as key (key)}
          {@const panel = fromKey(key)}
          {@const tool = isTool(panel.id) ? panel.id : null}
          <div class="tile" class:lifted={drag?.key === key && !drag.pointer} data-tray={key} role="button" tabindex="0"
            aria-roledescription="draggable panel" aria-label="Add {optionName(panel)}" aria-describedby="panel-drag-help"
            onpointerdown={(e) => pointerDown(e, key)} onkeydown={(e) => keyDown(e, key)}
            oncontextmenu={(e) => e.preventDefault()}>
            {#if tool}<img src={TOOL_META[tool].logo} alt="" />{:else}<span class="glyph" aria-hidden="true">▦</span>{/if}
            <span>{optionName(panel)}</span>
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  {#if own}
    <p class="howto">{#if edit}Drag cards to arrange them: next to another card shares its row (up to three), above or below a row starts a new one. Drag the bar between two cards to resize them. Keyboard: focus a card, Space, arrow keys, Space.{" "}{/if}Add a tool: run a device's install command from <button type="button" class="link" onclick={ondevices}>Settings → Devices</button> on that machine (Linux, macOS or Windows).</p>
  {/if}
</Section>

{#if ghostPanel && drag?.pointer}
  <div class="ghost" aria-hidden="true" style:width="{drag.pointer.width}px" style:max-height="{drag.pointer.height}px"
    style:transform="translate({drag.pointer.x - drag.pointer.dx}px, {drag.pointer.y - drag.pointer.dy}px)">
    <div inert>{@render card(ghostPanel, data)}</div>
  </div>
{/if}

<style>
  .actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
  .actions button { border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text); background: var(--surface); padding: 6px 9px; font-size: 12px; }
  .actions button:hover:not(:disabled) { border-color: var(--accent); }
  .actions button:disabled { opacity: .4; cursor: default; }
  .primary { background: var(--accent) !important; color: var(--bg) !important; border-color: var(--accent) !important; }
  .sample { color: var(--muted); font-size: 11px; border: 1px solid var(--line); border-radius: 5px; padding: 2px 7px; }
  .error, .empty { font-size: 13px; }
  .error { color: var(--warn); margin-bottom: 12px; }
  .empty { color: var(--muted); }
  .rows { display: flex; flex-direction: column; gap: 16px; }
  .row { min-width: 0; }
  /* The grid holds exactly the cards; the bar floats in the gap between two, with no footprint.
     A gap g shifts the gap's middle by ±g/6 off the bare thirds. */
  .cells { position: relative; display: grid; gap: 16px; grid-template-columns: 1fr; }
  .row.half .cells { grid-template-columns: 1fr 1fr; --split: 50%; }
  .row.wide-left .cells { grid-template-columns: 2fr 1fr; --split: calc(66.6667% - 2.6667px); }
  .row.wide-right .cells { grid-template-columns: 1fr 2fr; --split: calc(33.3333% + 2.6667px); }
  .row.thirds .cells { grid-template-columns: 1fr 1fr 1fr; }
  .cell { min-width: 0; display: flex; flex-direction: column; container-type: inline-size; }
  .cell:only-child { grid-column: 1 / -1; }
  .cell :global(article) { flex: 1; }
  .body { flex: 1; display: flex; flex-direction: column; }
  .editable { position: relative; cursor: grab; border-radius: var(--radius); touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    transition: opacity .15s, box-shadow .15s; }
  .editable:hover { box-shadow: 0 0 0 1px var(--line); }
  /* No native drag of a logo or text from a long press: it would take the touch over. */
  .editable :global(*), .tile :global(*) { -webkit-user-drag: none; }
  .editable:focus-visible { outline: 1px solid var(--accent); outline-offset: 3px; }
  .dragging .editable { cursor: grabbing; }
  /* Where the held card lands: an empty box of its final size. */
  .placeholder { border: 1px dashed var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); box-shadow: none; }
  .placeholder .body { visibility: hidden; }
  /* Held from the keyboard: the card itself moves, lifted. */
  .lifted { box-shadow: 0 0 0 1px var(--accent), 0 12px 32px rgb(0 0 0 / .45); transform: scale(1.01); z-index: 2; }
  .divider { position: absolute; top: 0; bottom: 0; left: var(--split); width: 17px; transform: translateX(-50%); z-index: 3; cursor: col-resize; touch-action: none; border-radius: 6px; }
  .divider::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; margin-left: -1px; background: var(--line); border-radius: 1px; transition: background .15s; }
  .divider::after { content: "⠿"; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 5px 4px; font-size: 9px; line-height: 1; color: var(--muted); }
  .divider:hover::before, .divider:focus-visible::before { background: var(--accent); }
  .divider:hover::after, .divider:focus-visible::after { color: var(--accent); border-color: var(--accent); }
  .divider:focus-visible { outline: none; }
  /* Stuck to the bottom of the window while editing: always in reach to add or remove. */
  .tray { position: sticky; bottom: 12px; z-index: 5; background: var(--bg); margin-top: 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 58px; padding: 12px 14px;
    border: 1px dashed var(--line); border-radius: var(--radius); transition: border-color .15s, background .15s; }
  .tray.removing { justify-content: center; border-color: var(--warn); }
  .tray.over { background: color-mix(in srgb, var(--warn) 12%, transparent); }
  .hint, .drop { color: var(--muted); font-size: 12px; margin-right: 6px; }
  .tray.over .drop { color: var(--warn); }
  .tile { display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; font-size: 12px; background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--radius-sm); cursor: grab; touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  .tile:hover { border-color: var(--accent); }
  .tile:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .tile img { width: 16px; height: 16px; }
  .glyph { color: var(--muted); }
  .ghost { position: fixed; top: 0; left: 0; z-index: 50; pointer-events: none; overflow: hidden; border-radius: var(--radius);
    box-shadow: 0 0 0 1px var(--accent), 0 18px 48px rgb(0 0 0 / .5); opacity: .96; scale: 1.02; container-type: inline-size; }
  .ghost > div { display: flex; flex-direction: column; }
  .howto { margin-top: 16px; border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 16px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .link { padding: 0; border: 0; background: none; color: var(--text); text-decoration: underline; text-underline-offset: 2px; font-size: inherit; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  @media (max-width: 720px) {
    .row.half .cells, .row.wide-left .cells, .row.wide-right .cells, .row.thirds .cells { grid-template-columns: 1fr; }
    .divider { display: none; }
  }
</style>
