// Which inputs of a page are sign-in fields (SPEC 3.13). The content script
// shows the Coffer button only in these, and fills only these: a visible
// username or email box and a visible password box. A search box, a sign-up
// form (two new passwords) and a hidden decoy field are never sign-in fields.

/** The size and place of an element (getBoundingClientRect; a fake one in tests). */
export interface Measure {
  rect(el: Element): { left: number; top: number; right: number; bottom: number; width: number; height: number };
}

export const realMeasure: Measure = { rect: (el) => el.getBoundingClientRect() };

/** A field smaller than this (a 1 px "visually hidden" trap) is not visible. */
const MIN_SIZE = 8;

const TEXT_TYPES = new Set(["text", "email", "tel", ""]);
const USER_WORDS = /user|login|logon|e-?mail|account|identifier|signin|sign-in|member|customer|kunde|handle|benutzer|utilisateur|usuario/i;
const SEARCH_WORDS = /search|query|suche|recherche|buscar/i;
const SIGN_IN_WORDS = /sign ?in|log ?in|log ?on|anmelden|connexion|iniciar|next|continue|weiter|suivant|password|passwort/i;
const NOT_SIGN_IN_WORDS = /subscribe|newsletter|sign ?up|register|join|create|search|coupon|promo/i;

function isInput(el: unknown): el is HTMLInputElement {
  return !!el && typeof el === "object" && (el as Element).nodeType === 1 && (el as Element).tagName === "INPUT";
}

function tokens(el: HTMLInputElement): string[] {
  return (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/** The element's own words: name, id, placeholder, aria-label and its label's text. */
function words(el: HTMLInputElement): string {
  const label = el.labels?.length ? Array.from(el.labels, (l) => l.textContent ?? "").join(" ") : "";
  return [el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), label].filter(Boolean).join(" ");
}

/** Visible: shown, not transparent, not hidden from assistive tech, big enough, on the page. */
export function isVisible(el: Element, m: Measure = realMeasure): boolean {
  if (isInput(el) && (el.type === "hidden" || el.hidden)) return false;
  const view = el.ownerDocument.defaultView;
  for (let n: Element | null = el; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
    if (n.getAttribute("aria-hidden") === "true" || (n as HTMLElement).hidden) return false;
    const cs = view?.getComputedStyle(n);
    if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || cs.opacity === "0")) return false;
  }
  const r = m.rect(el);
  if (r.width < MIN_SIZE || r.height < MIN_SIZE) return false;
  // Pushed off the page (left: -9999px), where no one can see what goes in.
  const scrollY = view?.scrollY ?? 0;
  const scrollX = view?.scrollX ?? 0;
  return r.right + scrollX > 0 && r.bottom + scrollY > 0;
}

/** A field a person can type into now. */
function usable(el: HTMLInputElement, m: Measure): boolean {
  return !el.disabled && !el.readOnly && isVisible(el, m);
}

function isPassword(el: HTMLInputElement): boolean {
  return el.type === "password";
}

function isTextLike(el: HTMLInputElement): boolean {
  return TEXT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase()) || TEXT_TYPES.has(el.type);
}

/** A search box: type search, a search landmark, or a name such as "q" or "search". */
export function isSearch(el: HTMLInputElement): boolean {
  if (el.type === "search" || el.getAttribute("role") === "searchbox") return true;
  if (el.closest('[role="search"], search')) return true;
  if (el.name === "q" || el.id === "q") return true;
  if (tokens(el).includes("username") || tokens(el).includes("email")) return false;
  return SEARCH_WORDS.test(words(el));
}

/** The part of the page a field's sign-in form is in: its form, else the document. */
function scopeOf(el: HTMLInputElement): ParentNode {
  return el.form ?? (el.getRootNode() as Document | ShadowRoot);
}

function inputsIn(scope: ParentNode, m: Measure): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll("input")).filter((i) => usable(i, m));
}

function before(a: Node, b: Node): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** The password box of a scope: the only one, or the current-password one of several (a change form). */
function passwordIn(fields: HTMLInputElement[]): HTMLInputElement | null {
  const pws = fields.filter(isPassword);
  // One box is the sign-in password, whatever its autocomplete says (sites often mark it "new-password").
  if (pws.length === 1) return pws[0];
  return pws.find((p) => tokens(p).includes("current-password")) ?? null;
}

/** The username box that goes with a password box: the last text box before it (not a search box). */
function usernameBefore(fields: HTMLInputElement[], password: HTMLInputElement): HTMLInputElement | null {
  const texts = fields.filter((f) => isTextLike(f) && !isSearch(f) && before(f, password));
  return texts.find((f) => tokens(f).includes("username")) ?? texts[texts.length - 1] ?? null;
}

/** The form, or the nearest container, reads as a sign-in (a "Next" or "Sign in" button), not a newsletter. */
function readsAsSignIn(el: HTMLInputElement): boolean {
  const form = el.form;
  const text = [form?.getAttribute("action"), form?.id, form?.className, form?.getAttribute("name")]
    .concat(Array.from((form ?? el.ownerDocument).querySelectorAll('button, input[type="submit"], [role="button"]'), (b) => (b as HTMLInputElement).value || b.textContent || ""))
    .filter(Boolean)
    .join(" ");
  return SIGN_IN_WORDS.test(text) && !NOT_SIGN_IN_WORDS.test(text);
}

export type FieldKind = "username" | "password";

/** The sign-in fields of a form: either can be missing (identifier-first, password-only). */
export interface LoginFields {
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
}

/**
 * What a focused input is: a username or email box, a password box, or
 * nothing (null). Only visible, enabled fields count.
 */
export function fieldKind(el: unknown, m: Measure = realMeasure): FieldKind | null {
  if (!isInput(el) || !usable(el, m)) return null;
  const fields = inputsIn(scopeOf(el), m);
  if (isPassword(el)) {
    // A sign-up or change form has two or more password boxes: only its current-password box is a sign-in field.
    return passwordIn(fields) === el ? "password" : null;
  }
  if (!isTextLike(el) || isSearch(el)) return null;
  const password = passwordIn(fields);
  if (password) return usernameBefore(fields, password) === el ? "username" : null;
  // No password box: an identifier-first page (the email first, the password on the next page).
  const t = tokens(el);
  if (t.includes("username")) return "username";
  const userish = el.type === "email" || t.includes("email") || USER_WORDS.test(words(el));
  const texts = fields.filter((f) => isTextLike(f) && !isSearch(f));
  return userish && texts.length <= 2 && readsAsSignIn(el) ? "username" : null;
}

/** The sign-in fields that go with a focused sign-in field. */
export function loginFields(el: HTMLInputElement, m: Measure = realMeasure): LoginFields {
  const kind = fieldKind(el, m);
  if (!kind) return { username: null, password: null };
  const fields = inputsIn(scopeOf(el), m);
  if (kind === "password") return { username: usernameBefore(fields, el), password: el };
  const password = passwordIn(fields);
  return { username: el, password: password && before(el, password) ? password : null };
}

/** The first sign-in form of a document (Ctrl+Shift+L with no sign-in field focused). */
export function firstLoginFields(doc: Document | ShadowRoot, m: Measure = realMeasure): LoginFields | null {
  for (const i of Array.from(doc.querySelectorAll("input"))) {
    if (fieldKind(i, m)) {
      const f = loginFields(i, m);
      if (f.username || f.password) return f;
    }
  }
  return null;
}

/** The input an event really hit, through open shadow roots. */
export function eventInput(e: Event): HTMLInputElement | null {
  const first = e.composedPath?.()[0] ?? e.target;
  return isInput(first) ? first : null;
}

/** The focused element of a document, through open shadow roots. */
export function deepActive(doc: Document): Element | null {
  let a: Element | null = doc.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}
