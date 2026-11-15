// The content script's controller (SPEC 3.13): a focus on a sign-in field
// asks the service worker for the menu; nothing fills until a pick in the
// menu (a real click or Enter, on a menu that is on screen) or Ctrl+Shift+L.
// It never sends the page's address: the worker reads it from Chrome.
import { type ContentRequest, type FillAnswer, fillError, type LoginRow, type MenuState, type TotpAnswer } from "../lib/fill";
import { deepActive, eventInput, fieldKind, firstLoginFields, type LoginFields, loginFields, type Measure, realMeasure } from "./fields";
import { fillLogin } from "./fill";
import { type MenuView, Overlay } from "./menu";

export interface FillerEnv {
  doc: Document;
  send: (req: ContentRequest) => Promise<unknown>;
  measure?: Measure;
  /** A real person's event (`isTrusted`). Tests swap it. */
  trusted?: (e: Event) => boolean;
  now?: () => number;
  /** The overlay shows for the first time on this page (load the font). */
  onShow?: () => void;
}

/** While Coffer is locked and the menu is open, ask again this often (the user unlocks in Coffer). */
const LOCKED_POLL_MS = 1500;
/** Show "Enter your master password in Coffer" when a fill takes longer than this. */
const WAITING_AFTER_MS = 300;

export class Filler {
  readonly overlay: Overlay;
  private input: HTMLInputElement | null = null;
  private state: MenuState | null = null;
  private selected = 0;
  private busy = false;
  private shownOnce = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly measure: Measure;
  private readonly trusted: (e: Event) => boolean;

  constructor(private readonly env: FillerEnv) {
    this.measure = env.measure ?? realMeasure;
    this.trusted = env.trusted ?? ((e) => e.isTrusted);
    this.overlay = new Overlay(env.doc, env.now);
    this.overlay.button.addEventListener("click", (e) => this.toggle(e));
  }

  private readonly onFocus = (e: Event) => void this.focused(e);
  private readonly onBlur = (e: Event) => this.blurred(e as FocusEvent);
  private readonly onKey = (e: Event) => this.key(e as KeyboardEvent);
  private readonly onInput = (e: Event) => this.typed(e);
  private readonly onMove = () => this.reposition();

  /** Listen on the page (capture: before the page's own handlers). */
  start() {
    const doc = this.env.doc;
    doc.addEventListener("focusin", this.onFocus, true);
    doc.addEventListener("focusout", this.onBlur, true);
    doc.addEventListener("keydown", this.onKey, true);
    doc.addEventListener("input", this.onInput, true);
    doc.defaultView?.addEventListener("scroll", this.onMove, { capture: true, passive: true });
    doc.defaultView?.addEventListener("resize", this.onMove, { passive: true });
    // A field that has the focus already (autofocus).
    const active = deepActive(doc);
    if (active && fieldKind(active, this.measure)) void this.attach(active as HTMLInputElement);
  }

  /** Stop listening and take the overlay off the page. */
  stop() {
    const doc = this.env.doc;
    doc.removeEventListener("focusin", this.onFocus, true);
    doc.removeEventListener("focusout", this.onBlur, true);
    doc.removeEventListener("keydown", this.onKey, true);
    doc.removeEventListener("input", this.onInput, true);
    doc.defaultView?.removeEventListener("scroll", this.onMove, { capture: true });
    doc.defaultView?.removeEventListener("resize", this.onMove);
    this.detach();
    this.overlay.host.remove();
  }

  private async focused(e: Event) {
    const input = eventInput(e);
    if (!input || input === this.input) return;
    if (!fieldKind(input, this.measure)) {
      this.detach();
      return;
    }
    await this.attach(input);
  }

  /** A sign-in field got the focus: ask for the menu. Nothing fills here. */
  async attach(input: HTMLInputElement) {
    this.detach();
    this.input = input;
    const state = (await this.env.send({ type: "coffer:list" }).catch(() => null)) as MenuState | null;
    if (this.input !== input) return;
    if (!state || state.kind === "off") {
      this.detach();
      return;
    }
    this.state = state;
    this.selected = 0;
    this.showButton();
    const open = (state.kind === "logins" && state.logins.length > 0) || state.kind === "locked";
    if (open) this.open();
    this.reposition();
  }

  private showButton() {
    if (!this.shownOnce) {
      this.shownOnce = true;
      this.env.onShow?.();
    }
    this.overlay.showButton();
  }

  private detach() {
    this.stopPoll();
    this.input = null;
    this.state = null;
    this.overlay.hide();
  }

  private blurred(e: FocusEvent) {
    if (!this.input || eventInput(e) !== this.input) return;
    // The window lost the focus (the user went to Coffer): keep the menu.
    if (!this.env.doc.hasFocus() || this.busy) return;
    setTimeout(() => {
      if (this.input && deepActive(this.env.doc) !== this.input && this.env.doc.hasFocus() && !this.busy) this.detach();
    }, 0);
  }

  private view(): MenuView | null {
    const s = this.state;
    return s && s.kind !== "off" ? s : null;
  }

  private open() {
    const view = this.view();
    if (!view) return;
    this.overlay.openMenu(view, this.selected, { pick: (l, e) => this.picked(l, e), unlock: (e) => this.unlock(e) });
    this.reposition();
    if (view.kind === "locked") this.startPoll();
    else this.stopPoll();
  }

  private close() {
    this.stopPoll();
    this.overlay.closeMenu();
  }

  private toggle(e: Event) {
    if (!this.trusted(e) || !this.input) return;
    if (this.overlay.menuOpen) this.close();
    else this.open();
  }

  private logins(): LoginRow[] {
    return this.state?.kind === "logins" ? this.state.logins : [];
  }

  private key(e: KeyboardEvent) {
    if (this.shortcutKey(e)) return;
    if (!this.input || eventInput(e) !== this.input || this.busy) return;
    const open = this.overlay.menuOpen;
    const rows = this.logins();
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (!open) {
          if (e.key === "ArrowDown" && this.view()) {
            e.preventDefault();
            this.open();
          }
          return;
        }
        if (!rows.length) return;
        e.preventDefault();
        this.selected = (this.selected + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
        this.open();
        return;
      }
      case "Enter": {
        if (!open || !rows.length) return;
        // A pick, only from a real key press on a menu that is on screen.
        if (!this.trusted(e) || !this.overlay.pickable()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.fill(rows[this.selected] ?? rows[0], this.input);
        return;
      }
      case "Escape":
        if (open) {
          e.preventDefault();
          this.close();
        }
        return;
    }
  }

  /** The user types: the menu steps aside. */
  private typed(e: Event) {
    if (this.input && eventInput(e) === this.input && this.trusted(e) && !this.busy && this.overlay.menuOpen) this.close();
  }

  private picked(login: LoginRow, e: Event) {
    if (!this.input || this.busy || !this.trusted(e) || !this.overlay.pickable()) return;
    void this.fill(login, this.input);
  }

  private unlock(e: Event) {
    if (!this.trusted(e)) return;
    void this.env.send({ type: "coffer:unlock" }).catch(() => undefined);
  }

  /**
   * Ctrl+Shift+L pressed in the page. Chrome gives the key to the extension's
   * command when it can, and then the page never sees it. Where Chrome keeps
   * Ctrl+Shift+L for itself (it does not assign it to the command), the page
   * gets the key, and the content script fills from here. Only a real key
   * press on a page with a sign-in form; other pages keep the key.
   */
  private shortcutKey(e: KeyboardEvent): boolean {
    if (e.code !== "KeyL" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return false;
    if (!this.trusted(e) || e.repeat) return true;
    const fields = this.shortcutFields();
    if (!fields) return true;
    e.preventDefault();
    e.stopImmediatePropagation();
    void this.shortcut(fields);
    return true;
  }

  /** The sign-in form Ctrl+Shift+L fills: the focused one, else the page's first. */
  private shortcutFields(): LoginFields | null {
    const doc = this.env.doc;
    const active = deepActive(doc);
    if (active && (active.tagName === "IFRAME" || active.tagName === "FRAME")) return null;
    const fields = active && fieldKind(active, this.measure) ? loginFields(active as HTMLInputElement, this.measure) : firstLoginFields(doc, this.measure);
    return fields && (fields.username || fields.password) ? fields : null;
  }

  /**
   * Ctrl+Shift+L: fill the first login into the focused sign-in form (or the
   * page's first sign-in form). Only the frame that has the focus acts.
   */
  async shortcut(given?: LoginFields) {
    const doc = this.env.doc;
    if (this.busy || (!given && !doc.hasFocus())) return;
    const fields = given ?? this.shortcutFields();
    const anchor = fields?.username ?? fields?.password;
    if (!fields || !anchor) return;
    if (anchor !== this.input) {
      this.input = anchor;
      this.state = (await this.env.send({ type: "coffer:list" }).catch(() => null)) as MenuState | null;
      if (this.input !== anchor) return;
    } else {
      this.state = ((await this.env.send({ type: "coffer:list" }).catch(() => null)) as MenuState | null) ?? this.state;
    }
    const s = this.state;
    if (!s || s.kind === "off") return this.detach();
    this.showButton();
    if (s.kind === "logins" && s.logins.length) {
      await this.fill(s.logins[0], anchor, fields);
      return;
    }
    this.selected = 0;
    this.open();
  }

  /** Ask Coffer for the picked login and fill it. The only path to get_login. */
  private async fill(login: LoginRow, input: HTMLInputElement, given?: LoginFields) {
    if (this.busy) return;
    this.busy = true;
    const waiting = setTimeout(() => {
      this.overlay.openMenu({ kind: "waiting", title: login.title }, 0, { pick: () => undefined, unlock: () => undefined });
      this.reposition();
    }, WAITING_AFTER_MS);
    let answer: FillAnswer;
    try {
      answer = ((await this.env.send({ type: "coffer:fill", id: login.id }).catch(() => null)) as FillAnswer | null) ?? { ok: false, code: "io", message: "" };
    } finally {
      clearTimeout(waiting);
      this.busy = false;
    }
    this.stopPoll();
    this.reposition();
    if (!answer.ok) {
      this.overlay.showNote(fillError(answer.code));
      return;
    }
    // The fields now, not the ones at focus time: a page may have swapped them meanwhile.
    const fields = given ?? loginFields(input, this.measure);
    const done = fillLogin(fields, answer, this.measure);
    const hasTotp = answer.hasTotp;
    answer = { ok: false, code: "", message: "" };
    this.overlay.closeMenu();
    if (!done.length) {
      this.overlay.showNote("Coffer found no field to fill here.");
      return;
    }
    if (!hasTotp) return;
    const t = (await this.env.send({ type: "coffer:totp", id: login.id }).catch(() => null)) as TotpAnswer | null;
    if (t?.ok) {
      this.reposition();
      this.overlay.showNote("One-time code copied");
    }
  }

  private startPoll() {
    if (this.poll) return;
    let left = Math.ceil(120_000 / LOCKED_POLL_MS);
    this.poll = setInterval(async () => {
      if (!this.input || !this.overlay.menuOpen || --left <= 0) return this.stopPoll();
      const input = this.input;
      const state = (await this.env.send({ type: "coffer:list" }).catch(() => null)) as MenuState | null;
      if (this.input !== input || !state || state.kind === "locked") return;
      if (state.kind === "off") return this.detach();
      this.state = state;
      this.selected = 0;
      this.open();
    }, LOCKED_POLL_MS);
  }

  private stopPoll() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** Follow the field when the page scrolls or resizes; a field that went away takes the button with it. */
  reposition() {
    const input = this.input;
    if (!input) return;
    if (!input.isConnected) {
      if (!this.busy) this.detach();
      return;
    }
    const r = this.measure.rect(input);
    this.overlay.place(r, this.env.doc.defaultView?.innerHeight ?? 800);
  }
}
