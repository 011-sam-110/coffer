// The Coffer button in a sign-in field, its menu, the one-line note and the
// Save bar (M5), in one host element with a CLOSED shadow root: the page
// cannot read the names in the menu or restyle it. The host sits in the top
// layer (a manual popover), above the page. Text goes in with textContent only.
import { monogramHue, monogramLetters } from "../../../src/lib/format";
import type { LoginRow, MenuState } from "../lib/fill";
import { type BarActions, type BarView, drawBar } from "./bar";
import { CSS, HOST_STYLE } from "./styles";

/** What the menu shows: a MenuState, or "waiting" while Coffer asks for the master password. */
export type MenuView = Exclude<MenuState, { kind: "off" }> | { kind: "waiting"; title: string };

export interface MenuActions {
  pick(login: LoginRow, e: Event): void;
  unlock(e: Event): void;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "Coffer · 2 logins for this site" */
export function headLine(n: number): string {
  return `Coffer · ${n} ${n === 1 ? "login" : "logins"} for this site`;
}

/** Draw the menu for a view. `selected`: the row Enter fills. */
export function drawMenu(menu: HTMLElement, view: MenuView, selected: number, actions: MenuActions): void {
  const doc = menu.ownerDocument;
  menu.replaceChildren();
  menu.setAttribute("data-state", view.kind);
  const head = (text: string, key?: string) => {
    const h = el(doc, "div", "cf-head");
    h.append(el(doc, "span", "", text));
    if (key) h.append(el(doc, "span", "cf-k", key));
    menu.append(h);
  };
  const line = (text: string) => menu.append(el(doc, "div", "cf-line", text));
  switch (view.kind) {
    case "logins": {
      if (!view.logins.length) {
        head("Coffer");
        line(`No logins for ${view.site || "this site"}.`);
        return;
      }
      head(headLine(view.logins.length), "Ctrl+Shift+L");
      const list = el(doc, "div", "cf-list");
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "Logins for this site");
      view.logins.forEach((l, i) => {
        const row = el(doc, "div", "cf-item");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(i === selected));
        row.dataset.id = l.id;
        const hue = monogramHue(l.title);
        const av = el(doc, "span", "cf-av", monogramLetters(l.title));
        av.style.background = `oklch(0.33 0.06 ${hue})`;
        av.style.color = `oklch(0.9 0.07 ${hue})`;
        const txt = el(doc, "span", "");
        txt.append(el(doc, "span", "cf-t", l.title), el(doc, "span", "cf-s", l.username));
        row.append(av, txt, i === selected ? el(doc, "span", "cf-k", "Enter") : el(doc, "span", ""));
        row.addEventListener("click", (e) => actions.pick(l, e));
        list.append(row);
      });
      menu.append(list);
      menu.append(el(doc, "div", "cf-foot", "Fills username and password. Nothing fills until you pick."));
      return;
    }
    case "locked": {
      head("Coffer is locked");
      const b = el(doc, "button", "cf-act", "Unlock Coffer");
      b.type = "button";
      b.tabIndex = -1;
      b.addEventListener("click", (e) => actions.unlock(e));
      menu.append(b);
      return;
    }
    case "notConnected":
      head("Coffer");
      line("Connect Coffer from the toolbar button.");
      return;
    case "notRunning":
      head("Coffer");
      line("Coffer is not running. Start Coffer, then click here again.");
      return;
    case "waiting":
      head("Coffer");
      line(`Enter your master password in Coffer to fill ${view.title}.`);
      return;
  }
}

/** How long the menu must be on screen, fully visible, before a pick counts (a page cannot rush a click). */
export const PICK_DELAY_MS = 400;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** IntersectionObserver v2 entries carry isVisible (trackVisibility). */
type VisibilityEntry = IntersectionObserverEntry & { isVisible?: boolean };

/**
 * Since when an element (the menu, the bar) is on screen, and, where the
 * browser can tell (IntersectionObserver v2), fully visible.
 */
class OnScreen {
  private shownAt = 0;
  /** Since when it is fully visible (null: not now), or undefined: unknown. */
  private visibleSince: number | null | undefined = undefined;
  private observer: IntersectionObserver | null = null;

  constructor(
    doc: Document,
    private readonly now: () => number,
  ) {
    const IO = doc.defaultView?.IntersectionObserver;
    if (!IO) return;
    try {
      this.observer = new IO(
        (entries) => {
          const e = entries[entries.length - 1] as VisibilityEntry;
          if (e.isVisible === undefined) return;
          this.visibleSince = e.isVisible ? (this.visibleSince ?? this.now()) : null;
        },
        { threshold: [1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
      );
    } catch {
      this.observer = null;
    }
  }

  start(el: Element) {
    this.shownAt = this.now();
    this.visibleSince = undefined;
    this.observer?.disconnect();
    this.observer?.observe(el);
  }

  stop() {
    this.observer?.disconnect();
    this.visibleSince = undefined;
  }

  /** On screen for PICK_DELAY_MS, and not covered, faded or moved in that time where the browser can tell. */
  ready(): boolean {
    const t = this.now();
    if (t - this.shownAt < PICK_DELAY_MS) return false;
    if (this.visibleSince === null) return false;
    if (this.visibleSince !== undefined && t - this.visibleSince < PICK_DELAY_MS) return false;
    return true;
  }
}

export class Overlay {
  readonly host: HTMLElement;
  /** The closed shadow root. Only this script holds it; the page gets null from host.shadowRoot. */
  readonly root: ShadowRoot;
  readonly button: HTMLButtonElement;
  readonly menu: HTMLElement;
  readonly note: HTMLElement;
  /** The Save bar (M5): top right of the window. */
  readonly bar: HTMLElement;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly menuSeen: OnScreen;
  private readonly barSeen: OnScreen;

  constructor(
    private readonly doc: Document,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.host = doc.createElement("coffer-fill");
    this.host.setAttribute("style", HOST_STYLE);
    this.root = this.host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = CSS;
    this.button = el(doc, "button", "cf cf-btn", "C");
    this.button.type = "button";
    this.button.tabIndex = -1;
    this.button.setAttribute("aria-label", "Coffer: logins for this site");
    this.button.hidden = true;
    this.menu = el(doc, "div", "cf cf-menu");
    this.menu.hidden = true;
    this.note = el(doc, "div", "cf cf-note");
    this.note.setAttribute("role", "status");
    this.note.hidden = true;
    this.bar = el(doc, "div", "cf cf-bar");
    this.bar.setAttribute("role", "dialog");
    this.bar.hidden = true;
    this.root.append(style, this.button, this.menu, this.note, this.bar);
    // A press on the overlay keeps the focus in the page's field.
    this.root.addEventListener("mousedown", (e) => e.preventDefault(), true);
    this.menuSeen = new OnScreen(doc, this.now);
    this.barSeen = new OnScreen(doc, this.now);
  }

  private mount() {
    const top = this.doc.documentElement;
    if (this.host.parentNode !== top) top.append(this.host);
    try {
      if (!this.host.matches(":popover-open")) {
        this.host.setAttribute("popover", "manual");
        this.host.showPopover();
      }
    } catch {
      /* no popover support: the z-index still holds */
    }
  }

  /** Put the button at the right edge inside the field, and the menu and note under it. */
  place(r: Rect, viewHeight: number) {
    const size = 24;
    this.button.style.left = `${Math.round(r.right - size - 8)}px`;
    this.button.style.top = `${Math.round(r.top + (r.height - size) / 2)}px`;
    const width = Math.min(420, Math.max(r.width, 280));
    this.menu.style.left = `${Math.round(r.left)}px`;
    this.menu.style.width = `${Math.round(width)}px`;
    const below = r.bottom + 6;
    const menuH = this.menu.hidden ? 0 : this.menu.offsetHeight;
    if (menuH && below + menuH > viewHeight && r.top - 6 - menuH > 0) {
      this.menu.style.top = `${Math.round(r.top - 6 - menuH)}px`;
    } else {
      this.menu.style.top = `${Math.round(below)}px`;
    }
    // The note hangs from the field's right end, clear of the labels on the left.
    this.note.style.left = `${Math.round(r.right)}px`;
    this.note.style.top = `${Math.round(below)}px`;
  }

  showButton() {
    this.mount();
    this.button.hidden = false;
  }

  get menuOpen(): boolean {
    return !this.menu.hidden;
  }

  openMenu(view: MenuView, selected: number, actions: MenuActions) {
    this.mount();
    const wasOpen = !this.menu.hidden;
    drawMenu(this.menu, view, selected, actions);
    this.menu.hidden = false;
    this.note.hidden = true;
    if (!wasOpen) this.menuSeen.start(this.menu);
  }

  closeMenu() {
    this.menu.hidden = true;
    this.menuSeen.stop();
  }

  /**
   * A pick counts only when the menu has been on screen for PICK_DELAY_MS
   * and, where the browser can tell (IntersectionObserver v2), nothing
   * covered it, faded it or moved it in that time.
   */
  pickable(): boolean {
    return !this.menu.hidden && this.menuSeen.ready();
  }

  /** Show the Save bar (or change what it shows). Its click rules start when it first shows. */
  openBar(view: BarView, actions: BarActions) {
    this.mount();
    const wasOpen = !this.bar.hidden;
    drawBar(this.bar, view, actions);
    this.bar.hidden = false;
    if (!wasOpen) this.barSeen.start(this.bar);
  }

  closeBar() {
    this.bar.hidden = true;
    this.bar.replaceChildren();
    this.barSeen.stop();
  }

  get barOpen(): boolean {
    return !this.bar.hidden;
  }

  /** A click in the bar counts only when the bar has been on screen and visible for PICK_DELAY_MS, as in the menu. */
  barPickable(): boolean {
    return !this.bar.hidden && this.barSeen.ready();
  }

  showNote(text: string, ms = 4000) {
    this.mount();
    this.closeMenu();
    this.note.textContent = text;
    this.note.hidden = false;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => (this.note.hidden = true), ms);
  }

  hide() {
    this.closeMenu();
    this.button.hidden = true;
  }

  /** The button and menu, but not the note: a note stays its few seconds. */
  get shown(): boolean {
    return !this.button.hidden || !this.menu.hidden;
  }
}
