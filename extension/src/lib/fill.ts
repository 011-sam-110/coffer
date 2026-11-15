// Fill in the browser (SPEC 3.13, docs/BRIDGE.md section 6): what the content
// script asks the service worker, and the worker's half of the rules. The
// worker takes the page's address from Chrome (`sender.url`), never from the
// message, and asks Coffer; Coffer checks the address again.
import { asBridgeError } from "./client";

/** One login in the menu: a name and a username, never a password. */
export interface LoginRow {
  id: string;
  title: string;
  username: string;
  hasTotp: boolean;
}

/** What the menu shows. "off": no button at all (a page or frame Coffer does not fill). */
export type MenuState =
  | { kind: "logins"; site: string; logins: LoginRow[] }
  | { kind: "locked" }
  | { kind: "notConnected" }
  | { kind: "notRunning" }
  | { kind: "off" };

/** Content script -> service worker. No address: the worker reads it from Chrome. */
export type ContentRequest =
  | { type: "coffer:list" }
  | { type: "coffer:fill"; id: string }
  | { type: "coffer:totp"; id: string }
  | { type: "coffer:unlock" }
  | { type: "coffer:font" };

/** Service worker -> content script. */
export type ContentMessage = { type: "coffer:where" } | { type: "coffer:command"; command: "fill-login" };

export type FillAnswer = { ok: true; username: string; password: string; hasTotp: boolean } | { ok: false; code: string; message: string };
export type TotpAnswer = { ok: true; clearsInSeconds: number | null } | { ok: false; code: string; message: string };

/** https pages, and http on localhost and 127.0.0.1 (Coffer checks the same). */
export function fillableUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Who sent a content message, as Chrome reports it. */
export interface Sender {
  url?: string;
  frameId?: number;
  tab?: { id?: number };
}

/** Where a fill call comes from: the frame's own address, and the top page's when it is a frame. */
export interface Place {
  url: string;
  top?: string;
  /** The frame has the top page's origin (or is the top page). */
  sameOrigin: boolean;
}

/**
 * The frame's place, or null when Coffer does not fill there: an http page,
 * a frame whose top page is not a page Coffer fills on. `topUrl` asks the top
 * frame's content script for its address (Chrome routes it to frame 0).
 */
export async function placeOf(sender: Sender, topUrl: (tabId: number) => Promise<unknown>): Promise<Place | null> {
  const url = sender.url;
  if (!fillableUrl(url) || !url || sender.tab?.id === undefined || sender.frameId === undefined) return null;
  if (sender.frameId === 0) return { url, sameOrigin: true };
  const top = await topUrl(sender.tab.id).catch(() => null);
  if (typeof top !== "string" || !fillableUrl(top)) return null;
  return { url, top, sameOrigin: originOf(top) === originOf(url) };
}

/** What the desk needs from the service worker (a fake one in tests). */
export interface Desk {
  call<T>(name: string, args?: unknown, timeoutMs?: number): Promise<T>;
  paired(): Promise<boolean>;
  forget(): Promise<void>;
  close(): void;
  topUrl(tabId: number): Promise<unknown>;
}

/** Answer a content script. `message` is the content script's; only its type and id are read. */
export async function answer(desk: Desk, sender: Sender, message: ContentRequest): Promise<unknown> {
  switch (message.type) {
    case "coffer:list":
      return menuFor(desk, sender);
    case "coffer:fill":
      return fillFor(desk, sender, message.id);
    case "coffer:totp":
      return totpFor(desk, sender, message.id);
    case "coffer:unlock":
      // Only from a page Coffer fills on (the locked menu shows nowhere else).
      if (await placeOf(sender, desk.topUrl)) await desk.call("unlock").catch(() => undefined);
      return null;
    default:
      return null;
  }
}

function args(place: Place, extra: Record<string, unknown> = {}) {
  return place.top ? { ...extra, url: place.url, top: place.top } : { ...extra, url: place.url };
}

/** The menu for a sign-in field: the logins of the frame's site, or why there are none. */
export async function menuFor(desk: Desk, sender: Sender): Promise<MenuState> {
  const place = await placeOf(sender, desk.topUrl);
  if (!place) return { kind: "off" };
  // A frame of another origin is shown only after Coffer says it is the same site.
  const or = (s: MenuState): MenuState => (place.sameOrigin ? s : { kind: "off" });
  if (!(await desk.paired())) return or({ kind: "notConnected" });
  try {
    const r = await desk.call<{ site: string; logins: LoginRow[] }>("list_logins", args(place));
    const logins = (r.logins ?? []).map((l) => ({ id: String(l.id), title: String(l.title), username: String(l.username ?? ""), hasTotp: !!l.hasTotp }));
    return { kind: "logins", site: String(r.site ?? ""), logins };
  } catch (e) {
    const err = asBridgeError(e);
    switch (err.code) {
      case "locked":
        return { kind: "locked" };
      case "bad_request":
      case "cross_site":
        return { kind: "off" };
      case "not_paired":
      case "bad_mac":
        await desk.forget();
        return or({ kind: "notConnected" });
      default:
        desk.close();
        return or({ kind: "notRunning" });
    }
  }
}

/** A re-prompt login waits for the master password in Coffer: up to 2 minutes, and a little more. */
export const FILL_TIMEOUT_MS = 135_000;

/** The username and password of the login the user picked. */
export async function fillFor(desk: Desk, sender: Sender, id: unknown): Promise<FillAnswer> {
  if (typeof id !== "string" || !id) return { ok: false, code: "bad_request", message: "No login." };
  const place = await placeOf(sender, desk.topUrl);
  if (!place) return { ok: false, code: "off", message: "Coffer does not fill on this page." };
  try {
    const r = await desk.call<{ username: string; password: string; hasTotp: boolean }>("get_login", args(place, { id }), FILL_TIMEOUT_MS);
    return { ok: true, username: String(r.username ?? ""), password: String(r.password ?? ""), hasTotp: !!r.hasTotp };
  } catch (e) {
    const err = asBridgeError(e);
    return { ok: false, code: err.code, message: err.message };
  }
}

/** Put the login's one-time code on the clipboard (Coffer's clipboard rules). */
export async function totpFor(desk: Desk, sender: Sender, id: unknown): Promise<TotpAnswer> {
  if (typeof id !== "string" || !id) return { ok: false, code: "bad_request", message: "No login." };
  const place = await placeOf(sender, desk.topUrl);
  if (!place) return { ok: false, code: "off", message: "Coffer does not fill on this page." };
  try {
    const r = await desk.call<{ clearsInSeconds: number | null }>("copy_totp", args(place, { id }));
    return { ok: true, clearsInSeconds: r.clearsInSeconds ?? null };
  } catch (e) {
    const err = asBridgeError(e);
    return { ok: false, code: err.code, message: err.message };
  }
}

/** The words a failed fill shows in the page (one line). */
export function fillError(code: string): string {
  switch (code) {
    case "cancelled":
      return "Not filled: you clicked Cancel in Coffer.";
    case "timeout":
      return "Not filled: Coffer got no master password.";
    case "locked":
      return "Coffer is locked. Unlock it, then pick again.";
    case "busy":
      return "Coffer asks for your master password already.";
    case "no_match":
    case "not_found":
      return "That login is not for this site.";
    default:
      return "Coffer did not answer. Try again.";
  }
}
