// @vitest-environment jsdom
// The content script's half of save, on fixture pages: which actions count as
// a sign-in sent, that only a typed password goes to the worker, the one-page
// app case, identifier-first pages, and the bar's click rules.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveRequest, SaveResult, SaveView } from "../lib/save";
import { MASK } from "./bar";
import { Overlay, PICK_DELAY_MS } from "./menu";
import { LOCKED_POLL_MS, Saver, sendsSignIn, WATCH_EVERY_MS } from "./saver";
import { fakeMeasure } from "./testMeasure";

const PW = "Shop-pass-4417";
let clock = 0;
let sent: SaveRequest[] = [];
let current: Saver | null = null;
/** Events a page script made (not a person): `isTrusted` is false for them. */
let fake = new WeakSet<Event>();

function setup(html: string, opts: { top?: boolean; sameOriginTop?: boolean; pending?: SaveView | null; result?: SaveResult } = {}) {
  document.body.innerHTML = html;
  for (const f of Array.from(document.forms)) f.addEventListener("submit", (e) => e.preventDefault());
  sent = [];
  let pending: SaveView | null = opts.pending === undefined ? { kind: "save", site: "northwind-shop.test", username: "alex@example.com" } : opts.pending;
  const send = vi.fn(async (req: SaveRequest) => {
    sent.push(req);
    if (req.type === "coffer:pending") return pending;
    if (req.type === "coffer:save") return opts.result ?? { ok: true, done: req.action === "save" ? "saved" : req.action === "update" ? "updated" : req.action === "never" ? "never" : req.action === "unlock" ? "unlock" : "dismissed", title: "northwind-shop.test" };
    return true;
  });
  const overlay = new Overlay(document, () => clock);
  const saver = new Saver({ doc: document, send, overlay, top: opts.top ?? true, sameOriginTop: opts.sameOriginTop, measure: fakeMeasure, trusted: (e) => !fake.has(e), now: () => clock });
  current?.stop();
  current = saver;
  saver.start();
  const $ = (sel: string) => document.querySelector(sel) as HTMLInputElement;
  /** A person types into a field: the value, then a real input event. */
  const type = (sel: string, value: string) => {
    const el = $(sel);
    el.value = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: value }));
  };
  /** A page script sets a field (and may fire an input event of its own). */
  const script = (sel: string, value: string) => {
    const el = $(sel);
    el.value = value;
    const e = new InputEvent("input", { bubbles: true, composed: true });
    fake.add(e);
    el.dispatchEvent(e);
  };
  const press = (sel: string, key = "Enter", untrusted = false) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
    if (untrusted) fake.add(e);
    $(sel).dispatchEvent(e);
  };
  const click = (el: Element, untrusted = false) => {
    const e = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    if (untrusted) fake.add(e);
    el.dispatchEvent(e);
  };
  const barButton = (action: string) => overlay.root.querySelector(`[data-action="${action}"]`) as HTMLButtonElement;
  return { saver, overlay, send, $, type, script, press, click, barButton, setPending: (v: SaveView | null) => (pending = v) };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const kinds = () => sent.map((r) => r.type);
const submittedMsgs = () => sent.filter((r) => r.type === "coffer:submitted");

const SIGN_IN = `<form id="f" action="/session"><input id="u" type="email" autocomplete="username"><input id="p" type="password" autocomplete="current-password"><input id="decoy" type="password" style="left:-9999px"><button id="go">Sign in</button><button id="eye" type="button">Show password</button></form>`;

beforeEach(() => {
  clock = 1000;
  fake = new WeakSet();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  current?.stop();
  current = null;
  document.documentElement.querySelectorAll("coffer-fill").forEach((h) => h.remove());
  vi.useRealTimers();
});

describe("a sign-in sent", () => {
  it("the form's submit, right after a real key press or click: the username and the typed password go to the worker once", async () => {
    const t = setup(SIGN_IN);
    t.type("#u", "alex@example.com");
    t.type("#p", PW);
    t.press("#p", "Tab");
    (document.getElementById("f") as HTMLFormElement).requestSubmit();
    await settle();
    expect(submittedMsgs()).toEqual([{ type: "coffer:submitted", username: "alex@example.com", password: PW }]);
  });

  it("a submit a page script makes alone (no key press or click for 3 s) gives nothing", async () => {
    const t = setup(SIGN_IN);
    t.type("#u", "alex@example.com");
    t.type("#p", PW);
    clock += 3001;
    (document.getElementById("f") as HTMLFormElement).requestSubmit();
    await settle();
    expect(kinds()).toEqual([]);
  });

  it("Enter in the password field, also with no <form>", async () => {
    const t = setup(`<div><input id="u" name="login"><input id="p" type="password"><span role="button" id="go">Log in</span></div>`);
    t.type("#u", "alex");
    t.type("#p", PW);
    t.press("#p");
    await settle();
    expect(submittedMsgs()).toEqual([{ type: "coffer:submitted", username: "alex", password: PW }]);
  });

  it("a click on the button of a sign-in with no <form>; not on a Show password or Forgot button, not an untrusted click", async () => {
    const t = setup(`<div><input id="u" type="email"><input id="p" type="password"><button id="eye">Show password</button><a id="forgot" role="button">Forgot password?</a><div role="button" id="go">Sign in</div></div>`);
    t.type("#u", "alex@example.com");
    t.type("#p", PW);
    t.click(t.$("#eye"));
    t.click(t.$("#forgot"));
    t.click(t.$("#go"), true);
    await settle();
    expect(kinds()).toEqual([]);
    t.click(t.$("#go"));
    await settle();
    expect(submittedMsgs()).toEqual([{ type: "coffer:submitted", username: "alex@example.com", password: PW }]);
  });

  it("which buttons send a sign-in", () => {
    document.body.innerHTML = `<form><button id="a">Go</button><button id="b" type="button">Next</button><input id="c" type="submit" value="Log in"><button id="d">Sign in with Google</button></form><div><button id="e">Continue</button><button id="f">Subscribe</button></div>`;
    const b = (id: string) => sendsSignIn(document.getElementById(id) as HTMLElement);
    expect([b("a"), b("b"), b("c"), b("d"), b("e"), b("f")]).toEqual([true, false, true, false, true, false]);
  });

  it("a password a page script put in the field gives nothing (also with its own input event); the hidden decoy is never read", async () => {
    const t = setup(SIGN_IN);
    t.type("#u", "alex@example.com");
    t.script("#p", "planted");
    t.click(t.$("#go"));
    await settle();
    expect(kinds()).toEqual([]);
    // The person types after the script: that counts. The decoy box with a planted value does not.
    t.type("#p", PW);
    t.script("#decoy", PW);
    t.click(t.$("#go"));
    await settle();
    expect(submittedMsgs()).toEqual([{ type: "coffer:submitted", username: "alex@example.com", password: PW }]);
  });

  it("a page that only changes a password field, with no sign-in sent, gives nothing", async () => {
    const t = setup(SIGN_IN);
    t.type("#u", "alex@example.com");
    t.type("#p", PW);
    t.$("#p").dispatchEvent(new Event("change", { bubbles: true }));
    t.$("#p").blur();
    t.press("#p", "a");
    t.click(t.$("#eye"));
    vi.advanceTimersByTime(10_000);
    await settle();
    expect(kinds()).toEqual([]);
    t.saver.loaded();
    await settle();
    expect(kinds()).toEqual([]);
  });

  it("a change form (current and new password differ) gives nothing; a sign-up (password and confirm) gives the new login", async () => {
    const t = setup(`<form id="f"><input id="u" type="email"><input id="a" type="password"><input id="b" type="password"><button>Go</button></form>`);
    t.type("#u", "alex@example.com");
    t.type("#a", "Old-1");
    t.type("#b", "New-2");
    t.click(document.querySelector("button")!);
    await settle();
    expect(kinds()).toEqual([]);
    t.type("#a", "New-2");
    t.click(document.querySelector("button")!);
    await settle();
    expect(submittedMsgs()).toEqual([{ type: "coffer:submitted", username: "alex@example.com", password: "New-2" }]);
  });

  it("a frame of another origin keeps nothing; a frame never asks for the bar", async () => {
    const t = setup(SIGN_IN, { top: false, sameOriginTop: false });
    t.type("#u", "alex@example.com");
    t.type("#p", PW);
    t.click(t.$("#go"));
    t.saver.loaded();
    await t.saver.check();
    await settle();
    expect(kinds()).toEqual([]);
  });
});

describe("the next page, and one-page apps", () => {
  it("the next page asks for the bar; a page that still has a sign-in form (a wrong password) does not", async () => {
    let t = setup(`<h1>Welcome back</h1>`);
    t.saver.loaded();
    await settle();
    expect(kinds()).toEqual(["coffer:pending"]);
    expect(t.overlay.barOpen).toBe(true);
    t = setup(SIGN_IN);
    t.saver.loaded();
    await settle();
    expect(kinds()).toEqual([]);
  });

  it("a one-page app: the bar comes when the password field goes away after the sign-in, not before", async () => {
    const t = setup(SIGN_IN);
    t.type("#u", "alex@example.com");
    t.type("#p", PW);
    t.click(t.$("#go"));
    await settle();
    vi.advanceTimersByTime(WATCH_EVERY_MS * 3);
    await settle();
    expect(kinds()).toEqual(["coffer:submitted"]);
    document.getElementById("f")!.remove();
    vi.advanceTimersByTime(WATCH_EVERY_MS);
    await settle();
    expect(kinds()).toEqual(["coffer:submitted", "coffer:pending"]);
    expect(t.overlay.barOpen).toBe(true);
  });

  it("a one-page app in a frame of the top's origin: the frame says it settled; the worker tells the top page", async () => {
    const t = setup(SIGN_IN, { top: false, sameOriginTop: true });
    t.type("#u", "alex@example.com");
    t.type("#p", PW);
    t.click(t.$("#go"));
    (t.$("#f") as unknown as HTMLElement).style.display = "none";
    vi.advanceTimersByTime(WATCH_EVERY_MS);
    await settle();
    expect(kinds()).toEqual(["coffer:submitted", "coffer:settled"]);
  });

  it("identifier-first, two pages: page 1 sends the username alone; page 2 the password", async () => {
    let t = setup(`<form><input id="u" type="email" autocomplete="username"><button>Next</button></form>`);
    t.type("#u", "alex@example.com");
    t.click(document.querySelector("button")!);
    await settle();
    expect(sent).toEqual([{ type: "coffer:identifier", username: "alex@example.com" }]);
    t = setup(`<form><p>alex@example.com</p><input id="p" type="password"><button>Sign in</button></form>`);
    t.saver.loaded();
    await settle();
    expect(kinds()).toEqual([], "page 2 has the password box: no bar yet");
    t.type("#p", PW);
    t.press("#p");
    await settle();
    expect(sent).toEqual([{ type: "coffer:submitted", username: "", password: PW }]);
  });

  it("page 2 with the username in a hidden box: that username goes with the password", async () => {
    const t = setup(`<form><input type="hidden" id="u" autocomplete="username" value="alex@example.com"><input id="p" type="password"><button>Sign in</button></form>`);
    t.type("#p", PW);
    t.click(document.querySelector("button")!);
    await settle();
    expect(submittedMsgs()).toEqual([{ type: "coffer:submitted", username: "alex@example.com", password: PW }]);
  });
});

describe("the Save bar", () => {
  async function shown(pending?: SaveView | null, result?: SaveResult) {
    const t = setup(`<h1>Welcome back</h1>`, { pending, result });
    t.saver.loaded();
    await settle();
    return t;
  }

  it("shows the name, the username and dots, in a closed shadow root; no password anywhere", async () => {
    const t = await shown();
    expect(t.overlay.host.shadowRoot).toBeNull();
    const text = t.overlay.bar.textContent;
    expect(text).toBe(`Save this login in Coffer?×Namenorthwind-shop.testUsernamealex@example.comPassword${MASK}Never for this siteSave`);
    expect(document.documentElement.outerHTML).not.toContain(PW);
  });

  it("Save needs a real click on a bar that has been on screen 400 ms", async () => {
    const t = await shown();
    t.click(t.barButton("save"), true);
    await settle();
    t.click(t.barButton("save"));
    await settle();
    expect(kinds()).toEqual(["coffer:pending"]);
    clock += PICK_DELAY_MS;
    t.click(t.barButton("save"));
    await settle();
    expect(sent.at(-1)).toEqual({ type: "coffer:save", action: "save" });
    expect(t.overlay.bar.textContent).toContain("Saved in Coffer as northwind-shop.test.");
  });

  it("Update bar: names the login; Update needs a real click too", async () => {
    const t = await shown({ kind: "update", title: "Northwind Shop", username: "alex@example.com" });
    expect(t.overlay.bar.getAttribute("data-state")).toBe("update");
    expect(t.overlay.bar.textContent).toContain("Update password?");
    expect(t.overlay.bar.textContent).toContain("Northwind Shop");
    clock += PICK_DELAY_MS;
    t.click(t.barButton("update"), true);
    await settle();
    expect(kinds()).toEqual(["coffer:pending"]);
    t.click(t.barButton("update"));
    await settle();
    expect(sent.at(-1)).toEqual({ type: "coffer:save", action: "update" });
  });

  it("Never for this site, and × (× closes at once)", async () => {
    let t = await shown();
    clock += PICK_DELAY_MS;
    t.click(t.barButton("never"));
    await settle();
    expect(sent.at(-1)).toEqual({ type: "coffer:save", action: "never" });
    expect(t.overlay.bar.textContent).toContain("Coffer will not offer to save on this site.");
    t = await shown();
    t.click(t.barButton("dismiss"));
    await settle();
    expect(sent.at(-1)).toEqual({ type: "coffer:save", action: "dismiss" });
    expect(t.overlay.barOpen).toBe(false);
  });

  it("locked: Unlock Coffer to save; after the unlock the bar says Saved, with no second click", async () => {
    const t = await shown({ kind: "locked" });
    expect(t.overlay.bar.textContent).toContain("Unlock Coffer to save");
    clock += PICK_DELAY_MS;
    t.click(t.barButton("unlock"));
    await settle();
    expect(sent.at(-1)).toEqual({ type: "coffer:save", action: "unlock" });
    vi.advanceTimersByTime(LOCKED_POLL_MS);
    await settle();
    expect(t.overlay.bar.getAttribute("data-state")).toBe("locked");
    t.setPending({ kind: "saved", title: "northwind-shop.test" });
    vi.advanceTimersByTime(LOCKED_POLL_MS);
    await settle();
    expect(t.overlay.bar.textContent).toContain("Saved in Coffer as northwind-shop.test.");
    expect(sent.filter((r) => r.type === "coffer:save").length).toBe(1);
  });

  it("a frame never shows the bar", async () => {
    const t = setup(`<h1>x</h1>`, { top: false, sameOriginTop: true });
    await t.saver.check();
    expect(kinds()).toEqual([]);
    expect(t.overlay.barOpen).toBe(false);
  });
});
