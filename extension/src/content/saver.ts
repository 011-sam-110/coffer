// Save in the browser (SPEC 3.13, M5): the content script's half. It sees a
// sign-in sent (the form's submit, Enter in a sign-in field, a click on the
// form's button, also with no <form>), hands the username and password to the
// service worker once, and forgets them. On the next page (or when a one-page
// app takes the password field away), the top page asks the worker for the
// Save bar. Save, Update, Never and Unlock run only on a real click
// (`isTrusted`) on a bar that has been on screen 400 ms, as M4's menu.
//
// The password must be one a person typed or pasted (a real `input` event set
// the value it has now). A value a page script put in a field gives nothing,
// and so does a field that changes without a sign-in sent.
import type { SaveAction, SaveRequest, SaveResult, SaveView } from "../lib/save";
import { doneLine } from "../lib/save";
import type { BarView } from "./bar";
import { eventInput, fieldKind, isSearch, isVisible, type Measure, realMeasure } from "./fields";
import type { Overlay } from "./menu";

export interface SaverEnv {
  doc: Document;
  send: (req: SaveRequest) => Promise<unknown>;
  overlay: Overlay;
  /** This frame is the top page: only the top page shows the bar. */
  top: boolean;
  /** A frame whose top page has its origin (a frame of another origin keeps nothing). */
  sameOriginTop?: boolean;
  measure?: Measure;
  /** A real person's event (`isTrusted`). Tests swap it. */
  trusted?: (e: Event) => boolean;
  now?: () => number;
  /** The overlay shows for the first time on this page (load the font). */
  onShow?: () => void;
}

/** A submit event counts within this time of a real key press or click (a page's own script cannot send one alone). */
export const GESTURE_MS = 3000;
/** After a sign-in is sent, watch this long for the password field to go away (a one-page app). */
export const WATCH_MS = 120_000;
export const WATCH_EVERY_MS = 400;
/** While the bar says "Unlock Coffer to save", ask again this often. */
export const LOCKED_POLL_MS = 1500;
/** A result line stays this long. */
export const DONE_MS = 4000;
/** The click on a form's button and the form's submit are one sign-in: the same values within this time go once. */
const ONCE_MS = 1000;

const TEXT_TYPES = new Set(["text", "email", "tel", ""]);
/** Words of a button that sends a sign-in. */
const SEND_WORDS = /sign ?in|log ?in|log ?on|anmelden|connexion|iniciar|next|continue|weiter|suivant|submit|sign ?up|register|create|join|enter|go\b/i;
/** Words of a button that never sends one (it shows the password, or leaves the form). */
const NOT_SEND_WORDS = /show|hide|forgot|reset|help|cancel|back|close|google|apple|facebook|microsoft|github|passkey/i;

function isInput(el: unknown): el is HTMLInputElement {
  return !!el && typeof el === "object" && (el as Element).nodeType === 1 && (el as Element).tagName === "INPUT";
}

function tokens(el: HTMLInputElement): string[] {
  return (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function before(a: Node, b: Node): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** The button-like element a click hit: a button, a submit or image input, or an element with role="button". */
function clickedButton(e: Event): HTMLElement | null {
  for (const n of e.composedPath()) {
    if (!(n instanceof Element)) continue;
    if (n.tagName === "BUTTON" || n.getAttribute("role") === "button") return n as HTMLElement;
    if (isInput(n) && ["submit", "image", "button"].includes(n.type)) return n;
    if (n.tagName === "FORM" || n.tagName === "BODY") return null;
  }
  return null;
}

/** A button that sends its sign-in form: a submit button of a form, or a "Sign in" or "Next" button with no form. */
export function sendsSignIn(b: HTMLElement): boolean {
  const text = [(b as HTMLInputElement).value, b.textContent, b.getAttribute("aria-label"), b.getAttribute("title")].filter(Boolean).join(" ");
  if (NOT_SEND_WORDS.test(text)) return false;
  const form = (b as HTMLButtonElement).form ?? null;
  const type = (b.getAttribute("type") ?? "").toLowerCase();
  if (form && (b.tagName === "BUTTON" || isInput(b))) return type === "" || type === "submit" || type === "image";
  return SEND_WORDS.test(text);
}

export class Saver {
  /** The value each field had at its last real input event. */
  private readonly typed = new WeakMap<HTMLInputElement, string>();
  private lastGesture = Number.NEGATIVE_INFINITY;
  /** The last message sent, to send one per sign-in. */
  private last: { req: SaveRequest; at: number } | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private shownOnce = false;
  private readonly measure: Measure;
  private readonly trusted: (e: Event) => boolean;
  private readonly now: () => number;

  constructor(private readonly env: SaverEnv) {
    this.measure = env.measure ?? realMeasure;
    this.trusted = env.trusted ?? ((e) => e.isTrusted);
    this.now = env.now ?? (() => Date.now());
  }

  private readonly onInput = (e: Event) => this.typedIn(e);
  private readonly onKey = (e: Event) => this.key(e as KeyboardEvent);
  private readonly onClick = (e: Event) => this.clicked(e);
  private readonly onSubmit = (e: Event) => this.submitted(e);

  /** Listen on the page (capture: before the page's own handlers can stop the event). */
  start() {
    const doc = this.env.doc;
    doc.addEventListener("input", this.onInput, true);
    doc.addEventListener("change", this.onInput, true);
    doc.addEventListener("keydown", this.onKey, true);
    doc.addEventListener("click", this.onClick, true);
    doc.addEventListener("submit", this.onSubmit, true);
  }

  stop() {
    const doc = this.env.doc;
    doc.removeEventListener("input", this.onInput, true);
    doc.removeEventListener("change", this.onInput, true);
    doc.removeEventListener("keydown", this.onKey, true);
    doc.removeEventListener("click", this.onClick, true);
    doc.removeEventListener("submit", this.onSubmit, true);
    this.stopWatch();
    this.stopPoll();
    if (this.doneTimer) clearTimeout(this.doneTimer);
  }

  /** The page loaded: the top page asks for the bar; a frame of the top's origin says it settled. */
  loaded() {
    if (this.env.top) void this.check();
    else if (this.env.sameOriginTop && !this.signInFormHere()) void this.env.send({ type: "coffer:settled" }).catch(() => undefined);
  }

  // ---------- seeing a sign-in sent ----------

  private typedIn(e: Event) {
    const input = eventInput(e);
    if (input && this.trusted(e)) this.typed.set(input, input.value);
  }

  private key(e: KeyboardEvent) {
    if (!this.trusted(e)) return;
    this.lastGesture = this.now();
    if (e.key !== "Enter" || e.isComposing) return;
    const input = eventInput(e);
    if (input && (input.type === "password" || fieldKind(input, this.measure))) this.captureIn(input.form ?? (input.getRootNode() as ParentNode));
  }

  private clicked(e: Event) {
    if (!this.trusted(e)) return;
    this.lastGesture = this.now();
    // A click in Coffer's own overlay is not the page's button.
    if (e.composedPath().includes(this.env.overlay.host)) return;
    const b = clickedButton(e);
    if (b && sendsSignIn(b)) this.captureIn((b as HTMLButtonElement).form ?? (b.getRootNode() as ParentNode));
  }

  private submitted(e: Event) {
    const form = e.composedPath()[0] ?? e.target;
    if (!(form instanceof Element) || form.tagName !== "FORM") return;
    // requestSubmit() from a page script also fires submit: it counts only right after a real key press or click.
    if (this.now() - this.lastGesture > GESTURE_MS) return;
    this.captureIn(form);
  }

  /**
   * A sign-in was sent from `scope` (its form, or the page): hand the
   * username and a typed password to the worker. A username alone (page 1
   * of an identifier-first sign-in) goes as the identifier.
   */
  captureIn(scope: ParentNode) {
    if (!this.env.top && !this.env.sameOriginTop) return;
    const inputs = Array.from(scope.querySelectorAll("input"));
    const filled = inputs.filter((i) => i.type === "password" && i.value !== "");
    if (!filled.length) {
      if (inputs.some((i) => i.type === "password" && isVisible(i, this.measure))) return;
      const user = inputs.find((i) => i.value.trim() && fieldKind(i, this.measure) === "username");
      if (user) this.once({ type: "coffer:identifier", username: user.value.trim() });
      return;
    }
    // Only a password a person typed: a page script's value gives nothing.
    const typed = filled.filter((p) => this.typed.get(p) === p.value);
    const values = new Set(typed.map((p) => p.value));
    // A change form (current and new password differ) gives no offer; a sign-up (password and confirm) does.
    if (values.size !== 1) return;
    const field = typed[0];
    const password = field.value;
    const username = this.usernameFor(inputs, field);
    this.once({ type: "coffer:submitted", username, password });
    this.watchField(field);
  }

  /** Send a sign-in to the worker, once: the button's click and the form's submit carry the same values. */
  private once(req: SaveRequest) {
    const t = this.now();
    const same = this.last && t - this.last.at < ONCE_MS && JSON.stringify(this.last.req) === JSON.stringify(req);
    const last = { req, at: t };
    this.last = last;
    // The content script keeps no password: the copy for this check goes after the second.
    setTimeout(() => {
      if (this.last === last) this.last = null;
    }, ONCE_MS);
    if (!same) void this.env.send(req).catch(() => undefined);
  }

  /** The username that goes with a password box: the text box before it, best marked first. */
  private usernameFor(inputs: HTMLInputElement[], password: HTMLInputElement): string {
    const candidates = inputs.filter((i) => i !== password && i.value.trim() && before(i, password) && !isSearch(i));
    const marked = candidates.find((i) => tokens(i).includes("username"));
    if (marked) return marked.value.trim();
    const texts = candidates.filter((i) => TEXT_TYPES.has((i.getAttribute("type") ?? "").toLowerCase()) && isVisible(i, this.measure));
    const email = texts.find((i) => i.type === "email" || tokens(i).includes("email"));
    return (email ?? texts[texts.length - 1])?.value.trim() ?? "";
  }

  /** A sign-in form is on the page now (its password box is visible): a wrong password, or page 2 of a two-page sign-in. */
  signInFormHere(): boolean {
    return Array.from(this.env.doc.querySelectorAll("input")).some((i) => i.type === "password" && fieldKind(i, this.measure) === "password");
  }

  /** A one-page app: when the password box goes away (removed or hidden), the sign-in settled. */
  private watchField(field: HTMLInputElement) {
    this.stopWatch();
    let left = Math.ceil(WATCH_MS / WATCH_EVERY_MS);
    this.watch = setInterval(() => {
      if (--left <= 0) return this.stopWatch();
      if (field.isConnected && isVisible(field, this.measure)) return;
      this.stopWatch();
      if (this.env.top) void this.check();
      else void this.env.send({ type: "coffer:settled" }).catch(() => undefined);
    }, WATCH_EVERY_MS);
  }

  private stopWatch() {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }

  // ---------- the bar ----------

  /** Ask the worker for the bar (the top page only, and not while a sign-in form is still here). */
  async check() {
    if (!this.env.top || this.busy || this.signInFormHere()) return;
    const view = (await this.env.send({ type: "coffer:pending" }).catch(() => null)) as SaveView | null;
    if (view) this.show(view);
  }

  private show(view: BarView) {
    if (!this.shownOnce) {
      this.shownOnce = true;
      this.env.onShow?.();
    }
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.env.overlay.openBar(view, { act: (a, e) => void this.act(a, e) });
    if (view.kind === "locked") this.startPoll();
    else this.stopPoll();
    if (view.kind === "saved" || view.kind === "done") this.doneTimer = setTimeout(() => this.close(), DONE_MS);
  }

  private close() {
    this.stopPoll();
    this.env.overlay.closeBar();
  }

  /** A click in the bar. Only a real one; Save, Update, Never and Unlock also need the bar on screen 400 ms. */
  async act(action: SaveAction, e: Event) {
    if (!this.trusted(e) || this.busy) return;
    if (action !== "dismiss" && !this.env.overlay.barPickable()) return;
    this.busy = true;
    let r: SaveResult;
    try {
      r = ((await this.env.send({ type: "coffer:save", action }).catch(() => null)) as SaveResult | null) ?? { ok: false, code: "io", message: "" };
    } finally {
      this.busy = false;
    }
    if (action === "dismiss") return this.close();
    if (action === "unlock") {
      // Coffer shows its unlock; the bar keeps asking, and saves once Coffer is open.
      this.startPoll();
      return;
    }
    if (!r.ok && r.code === "locked") return this.show({ kind: "locked" });
    const line = doneLine(r);
    if (line) this.show({ kind: "done", text: line });
    else this.close();
  }

  private startPoll() {
    if (this.poll) return;
    let left = Math.ceil(120_000 / LOCKED_POLL_MS);
    this.poll = setInterval(async () => {
      if (!this.env.overlay.barOpen || --left <= 0) return this.stopPoll();
      if (this.busy) return;
      const view = (await this.env.send({ type: "coffer:pending" }).catch(() => null)) as SaveView | null;
      if (!view) return this.close();
      if (view.kind !== "locked") this.show(view);
    }, LOCKED_POLL_MS);
  }

  private stopPoll() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }
}
