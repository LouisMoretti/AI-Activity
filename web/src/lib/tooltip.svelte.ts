// A hover / focus / tap tooltip (issue #284), shared by the stat popovers
// (StatCard) and the API-value explanations (SessionValue).
//
// - Opens on mouse hover, keyboard focus, or a tap (which pins it open until
//   a tap elsewhere, a second tap or leaving with Tab).
// - Escape closes it without moving focus, and it stays closed until a fresh
//   interaction: the pointer entering again, focus coming back, or a click.
// - Placed inside the viewport: shifted sideways by `dx` (CSS `--dx`) to keep
//   a margin from both edges, shown above its trigger (`above`) when it would
//   leave the bottom of the window and fits above, and capped in height
//   (`maxHeight`, CSS `--max-h`, scrolling inside) when it fits on neither side.

const MARGIN = 8; // px kept between the tooltip and the window's edges
const GAP = 8; // px between the trigger and the tooltip (the CSS offset)

export class Tooltip {
  #hover = $state(false);
  #focus = $state(false);
  #pinned = $state(false);
  #dismissed = $state(false);
  /** Whether it was open when the pointer went down (a tap's focus opens it first). */
  #openAtPress: boolean | null = null;
  #root: HTMLElement | null = null;
  #applied = 0;

  /** Sideways shift, in px, that keeps the tooltip inside the viewport. */
  dx = $state(0);
  /** Shown above the trigger rather than below. */
  above = $state(false);
  /** Height cap (px, CSS `--max-h`) when it fits on neither side; null: none. */
  maxHeight = $state<number | null>(null);
  readonly open = $derived(!this.#dismissed && (this.#hover || this.#focus || this.#pinned));

  /** Event handlers for the element wrapping the trigger and the tooltip. */
  readonly wrap = {
    onpointerenter: (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return; // touch "hover" sticks: taps pin instead
      this.#dismissed = false;
      this.#hover = true;
    },
    onpointerleave: (e: PointerEvent) => {
      if (e.pointerType === "mouse") this.#hover = false;
    },
    onfocusin: () => {
      if (this.#focus) return;
      this.#focus = true;
      this.#dismissed = false;
    },
    onfocusout: (e: FocusEvent) => {
      if (this.#root?.contains(e.relatedTarget as Node | null)) return;
      this.#focus = false;
      this.#pinned = false;
    },
  };

  /** Event handlers for the trigger button: a click or tap toggles it. */
  readonly trigger = {
    onpointerdown: () => {
      this.#openAtPress = this.open;
    },
    onclick: () => {
      const wasOpen = this.#openAtPress ?? this.open;
      this.#openAtPress = null;
      this.#pinned = !wasOpen;
      this.#dismissed = wasOpen;
    },
  };

  /** Attachment for the wrapping element: closes on Escape or a tap outside. */
  readonly root = (el: HTMLElement) => {
    this.#root = el;
    $effect(() => {
      if (!this.open) return;
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        this.#dismissed = true;
        this.#pinned = false;
      };
      // A tap or click outside closes it; a swipe (to scroll) does not.
      let start: { x: number; y: number } | null = null;
      const down = (e: PointerEvent) => {
        start = el.contains(e.target as Node) ? null : { x: e.clientX, y: e.clientY };
      };
      const up = (e: PointerEvent) => {
        if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return;
        start = null;
        this.#pinned = false;
        if (e.pointerType !== "mouse") this.#dismissed = true;
      };
      document.addEventListener("keydown", key);
      document.addEventListener("pointerdown", down, true);
      document.addEventListener("pointerup", up, true);
      return () => {
        document.removeEventListener("keydown", key);
        document.removeEventListener("pointerdown", down, true);
        document.removeEventListener("pointerup", up, true);
      };
    });
    return () => { this.#root = null; };
  };

  /** Attachment for the tooltip itself: keeps it inside the viewport while open. */
  readonly tip = (el: HTMLElement) => {
    $effect(() => {
      if (!this.open) return;
      const place = () => this.#place(el);
      place();
      // Once more after the first placement shows: a height cap can add a
      // scrollbar, which widens a tooltip sized to its content.
      const frame = requestAnimationFrame(place);
      addEventListener("resize", place);
      addEventListener("scroll", place, { passive: true, capture: true });
      return () => {
        cancelAnimationFrame(frame);
        removeEventListener("resize", place);
        removeEventListener("scroll", place, { capture: true });
      };
    });
  };

  #place(el: HTMLElement) {
    if (!this.#root) return;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const tip = el.getBoundingClientRect();
    const anchor = this.#root.getBoundingClientRect();
    // The tooltip's box without the shift applied now (hidden, it keeps its
    // layout, so it can be measured before it shows).
    const left = tip.left - this.#applied;
    let dx = 0;
    if (left + tip.width > vw - MARGIN) dx = vw - MARGIN - (left + tip.width);
    if (left + dx < MARGIN) dx = MARGIN - left;
    this.#applied = dx;
    this.dx = this.#applied;
    // Its full height, even while a max-height clamps it.
    const height = el.scrollHeight + el.offsetHeight - el.clientHeight;
    const below = vh - MARGIN - anchor.bottom - GAP;
    const above = anchor.top - GAP - MARGIN;
    // Below when it fits there, else above when it fits there, else on the
    // roomier side, scrolling within the room it has.
    this.above = height > below && (height <= above || above > below);
    const room = Math.floor(this.above ? above : below);
    this.maxHeight = height > room ? Math.max(room, 80) : null;
  }
}
