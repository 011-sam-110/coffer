// Save in the browser (SPEC 3.13, docs/BRIDGE.md section 6): the service
// worker's half. When a sign-in form is sent, the content script hands the
// username and password to the worker, which keeps them in its memory for
// that tab only (never in chrome.storage), for at most 2 minutes. On the next
// page of that tab (or when a one-page app settles), the top page asks for
// the bar: the worker asks Coffer `find_login` and answers with what the bar
// shows. The password never goes back to a page. Save, Update and Never run
// only on the content script's message after a real click, and only the
// action Coffer offered.
import { asBridgeError } from "./client";
import { type Desk, fillableUrl, placeOf, type Sender } from "./fill";

/** How long the worker keeps a sent login: 2 minutes. */
export const HOLD_MS = 120_000;

/** What the Save bar shows. Never a password. */
export type SaveView =
  | { kind: "save"; site: string; username: string }
  | { kind: "update"; title: string; username: string }
  | { kind: "locked" }
  /** After "Unlock Coffer to save": saved without asking again. */
  | { kind: "saved"; title: string };

export type SaveAction = "save" | "update" | "never" | "dismiss" | "unlock";

export type SaveResult = { ok: true; done: "saved" | "updated" | "never" | "dismissed" | "unlock"; title?: string } | { ok: false; code: string; message: string };

/** Content script -> service worker, for save. No address: the worker reads it from Chrome. */
export type SaveRequest =
  | { type: "coffer:submitted"; username: string; password: string }
  | { type: "coffer:identifier"; username: string }
  | { type: "coffer:settled" }
  | { type: "coffer:pending" }
  | { type: "coffer:save"; action: SaveAction };

export const SAVE_TYPES = ["coffer:submitted", "coffer:identifier", "coffer:settled", "coffer:pending", "coffer:save"] as const;

/** One sent login, in the worker's memory. */
interface Held {
  username: string;
  password: string;
  /** The address of the frame the form was in, from Chrome. */
  url: string;
  at: number;
  /** What Coffer offered for it (the only action a click can run). */
  offer: { kind: "save" } | { kind: "update"; id: string; title: string } | null;
  /** The user clicked "Unlock Coffer to save": save after the unlock without asking again. */
  afterUnlock: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** A username sent alone (page 1 of an identifier-first sign-in). */
interface Identifier {
  username: string;
  origin: string;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(t: ReturnType<typeof setTimeout>): void;
}

const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The sent logins, one per tab, in memory only. Each one goes after 2
 * minutes, when the tab closes, after Save, Update, Never or ×, and when the
 * next sign-in in the tab replaces it.
 */
export class Holds {
  private readonly tabs = new Map<number, Held>();
  private readonly ids = new Map<number, Identifier>();

  constructor(private readonly clock: Clock = realClock) {}

  hold(tabId: number, h: { username: string; password: string; url: string }) {
    this.drop(tabId);
    const timer = this.clock.setTimeout(() => this.drop(tabId), HOLD_MS);
    this.tabs.set(tabId, { ...h, at: this.clock.now(), offer: null, afterUnlock: false, timer });
  }

  identifier(tabId: number, username: string, origin: string) {
    const old = this.ids.get(tabId);
    if (old) this.clock.clearTimeout(old.timer);
    const timer = this.clock.setTimeout(() => this.ids.delete(tabId), HOLD_MS);
    this.ids.set(tabId, { username, origin, at: this.clock.now(), timer });
  }

  /** The username of page 1, for a password-only page 2 of the same origin within 2 minutes. */
  takeIdentifier(tabId: number, origin: string): string | null {
    const id = this.ids.get(tabId);
    if (!id || id.origin !== origin || this.clock.now() - id.at >= HOLD_MS) return null;
    return id.username;
  }

  get(tabId: number): Held | null {
    const h = this.tabs.get(tabId);
    if (!h) return null;
    if (this.clock.now() - h.at >= HOLD_MS) {
      this.drop(tabId);
      return null;
    }
    return h;
  }

  drop(tabId: number) {
    const h = this.tabs.get(tabId);
    if (!h) return;
    this.clock.clearTimeout(h.timer);
    h.password = "";
    this.tabs.delete(tabId);
  }

  /** The tab closed: everything of it goes. */
  dropTab(tabId: number) {
    this.drop(tabId);
    const id = this.ids.get(tabId);
    if (id) this.clock.clearTimeout(id.timer);
    this.ids.delete(tabId);
  }

  /** How many tabs hold a login (tests). */
  get size(): number {
    return this.tabs.size;
  }
}

/** What the save desk needs besides the fill desk: tell the top page to ask for the bar. */
export interface SaveDesk extends Desk {
  /** Tell frame 0 of the tab to ask for the bar (a frame's sign-in settled). */
  showTop(tabId: number): Promise<void>;
}

/** Answer a save message from a content script. */
export async function answerSave(desk: SaveDesk, holds: Holds, sender: Sender, message: SaveRequest): Promise<unknown> {
  switch (message.type) {
    case "coffer:submitted":
      return submitted(desk, holds, sender, message.username, message.password);
    case "coffer:identifier":
      return identifier(desk, holds, sender, message.username);
    case "coffer:settled": {
      const tabId = sender.tab?.id;
      if (tabId !== undefined && sender.frameId !== 0 && holds.get(tabId)) await desk.showTop(tabId).catch(() => undefined);
      return null;
    }
    case "coffer:pending":
      return pendingFor(desk, holds, sender);
    case "coffer:save":
      return actionFor(desk, holds, sender, message.action);
    default:
      return null;
  }
}

/**
 * Where a sign-in may be kept from: a page Coffer fills on (https, or http on
 * localhost), in the top page or a frame of the top page's origin. A frame of
 * another origin gives nothing.
 */
async function sourceOf(desk: Desk, sender: Sender): Promise<string | null> {
  const place = await placeOf(sender, desk.topUrl);
  return place && place.sameOrigin ? place.url : null;
}

async function submitted(desk: Desk, holds: Holds, sender: Sender, username: unknown, password: unknown): Promise<boolean> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || typeof password !== "string" || !password) return false;
  const url = await sourceOf(desk, sender);
  if (!url) return false;
  let user = typeof username === "string" ? username.trim() : "";
  // Identifier-first: the username came on the page before, on the same origin.
  if (!user) user = holds.takeIdentifier(tabId, originOf(url) ?? "") ?? "";
  holds.hold(tabId, { username: user, password, url });
  return true;
}

async function identifier(desk: Desk, holds: Holds, sender: Sender, username: unknown): Promise<boolean> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || typeof username !== "string" || !username.trim()) return false;
  const url = await sourceOf(desk, sender);
  const origin = url && originOf(url);
  if (!origin) return false;
  holds.identifier(tabId, username.trim(), origin);
  return true;
}

/** The args that name the form's page and the page that shows the bar. */
function pageArgs(held: Held, top: string): { url: string; top?: string } {
  return top === held.url ? { url: held.url } : { url: held.url, top };
}

interface Found {
  match: "none" | "same" | "changed" | "never";
  offer: "save" | "update" | null;
  id?: string;
  title?: string;
  site?: string;
}

/**
 * The bar for the top page of a tab that holds a sent login, or null.
 * Coffer checks that this page is the same site as the form's page
 * (`cross_site` otherwise): the bar never shows on another site.
 */
export async function pendingFor(desk: Desk, holds: Holds, sender: Sender): Promise<SaveView | null> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !fillableUrl(sender.url) || !sender.url) return null;
  const held = holds.get(tabId);
  if (!held || !(await desk.paired())) return null;
  try {
    const r = await desk.call<Found>("find_login", { ...pageArgs(held, sender.url), username: held.username, password: held.password });
    if (r.match === "none" && r.offer === "save") {
      held.offer = { kind: "save" };
      if (held.afterUnlock) {
        // "Unlock Coffer to save" was the click: save now, do not ask again.
        const saved = await desk.call<{ id: string; title: string }>("save_login", { ...pageArgs(held, sender.url), username: held.username, password: held.password });
        holds.drop(tabId);
        return { kind: "saved", title: String(saved.title ?? r.site ?? "") };
      }
      return { kind: "save", site: String(r.site ?? ""), username: held.username };
    }
    if (r.match === "changed" && r.offer === "update" && r.id) {
      held.offer = { kind: "update", id: String(r.id), title: String(r.title ?? "") };
      return { kind: "update", title: String(r.title ?? ""), username: held.username };
    }
    // Known with this password, on the never list, or the offer is off.
    holds.drop(tabId);
    return null;
  } catch (e) {
    const err = asBridgeError(e);
    switch (err.code) {
      case "locked":
        return { kind: "locked" };
      case "not_paired":
      case "bad_mac":
        await desk.forget();
        return null;
      case "cross_site":
      case "bad_request":
        // Another site (or an http page) than the form's: no bar here. The login stays held for its 2 minutes.
        return null;
      default:
        desk.close();
        return null;
    }
  }
}

const GONE: SaveResult = { ok: false, code: "gone", message: "Coffer no longer holds this login. Sign in again to save it." };

/** Save, Update, Never, × or Unlock, from a real click in the bar of the top page. */
export async function actionFor(desk: Desk, holds: Holds, sender: Sender, action: unknown): Promise<SaveResult> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !fillableUrl(sender.url) || !sender.url) return { ok: false, code: "off", message: "No bar here." };
  const held = holds.get(tabId);
  if (!held) return GONE;
  const page = pageArgs(held, sender.url);
  try {
    switch (action) {
      case "save": {
        if (held.offer?.kind !== "save") return { ok: false, code: "not_offered", message: "Coffer did not offer to save this login." };
        const r = await desk.call<{ id: string; title: string }>("save_login", { ...page, username: held.username, password: held.password });
        holds.drop(tabId);
        return { ok: true, done: "saved", title: String(r.title ?? "") };
      }
      case "update": {
        const offer = held.offer;
        if (offer?.kind !== "update") return { ok: false, code: "not_offered", message: "Coffer did not offer to update a login." };
        await desk.call("update_password", { ...page, id: offer.id, password: held.password });
        holds.drop(tabId);
        return { ok: true, done: "updated", title: offer.title };
      }
      case "never":
        await desk.call("never_for_site", page);
        holds.drop(tabId);
        return { ok: true, done: "never" };
      case "dismiss":
        holds.drop(tabId);
        return { ok: true, done: "dismissed" };
      case "unlock":
        held.afterUnlock = true;
        await desk.call("unlock").catch(() => undefined);
        return { ok: true, done: "unlock" };
      default:
        return { ok: false, code: "bad_request", message: "No such action." };
    }
  } catch (e) {
    const err = asBridgeError(e);
    return { ok: false, code: err.code, message: err.message };
  }
}

/** The one line the bar shows after an action. */
export function doneLine(r: SaveResult): string | null {
  if (!r.ok) {
    switch (r.code) {
      case "locked":
        return "Coffer is locked. Unlock it, then try again.";
      case "gone":
        return r.message;
      default:
        return "Coffer did not save it. Try again.";
    }
  }
  switch (r.done) {
    case "saved":
      return `Saved in Coffer as ${r.title}.`;
    case "updated":
      return `Password updated in ${r.title}.`;
    case "never":
      return "Coffer will not offer to save on this site.";
    default:
      return null;
  }
}
