// @vitest-environment jsdom
// The content script's controller: a focus asks for the menu only; nothing
// fills without a real pick on a menu that is on screen, or the shortcut.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentRequest, MenuState } from "../lib/fill";
import { fakeMeasure } from "./testMeasure";
import { Filler } from "./filler";
import { PICK_DELAY_MS } from "./menu";

const LOGINS: MenuState = {
  kind: "logins",
  site: "northwind-shop.test",
  logins: [
    { id: "ns", title: "northwind-shop.test", username: "alex@example.com", hasTotp: true },
    { id: "nw", title: "Northwind (work)", username: "alex.morgan@work.example", hasTotp: false },
  ],
};

let clock = 0;
let sent: ContentRequest[] = [];
let current: Filler | null = null;

function setup(opts: { state?: MenuState; trusted?: boolean; html?: string } = {}) {
  document.body.innerHTML =
    opts.html ??
    `<form id="f"><input id="search" type="search" name="q"><input id="u" type="email" autocomplete="username"><input id="p" type="password"><button>Sign in</button></form>`;
  sent = [];
  const send = vi.fn(async (req: ContentRequest) => {
    sent.push(req);
    switch (req.type) {
      case "coffer:list":
        return opts.state ?? LOGINS;
      case "coffer:fill":
        return { ok: true, username: req.id === "ns" ? "alex@example.com" : "alex.morgan@work.example", password: `pw-${req.id}`, hasTotp: req.id === "ns" };
      case "coffer:totp":
        return { ok: true, clearsInSeconds: 90 };
      default:
        return null;
    }
  });
  const filler = new Filler({ doc: document, send, measure: fakeMeasure, trusted: () => opts.trusted ?? true, now: () => clock });
  current?.stop();
  current = filler;
  filler.start();
  const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
  const root = filler.overlay.root;
  const rows = () => Array.from(root.querySelectorAll(".cf-item")) as HTMLElement[];
  const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true }));
  return { filler, send, $, root, rows, key };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const kinds = () => sent.map((r) => r.type);

beforeEach(() => {
  clock = 1000;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});
afterEach(() => {
  current?.stop();
  current = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("focus on a sign-in field", () => {
  it("asks for the menu only, and shows names and usernames in a closed shadow root", async () => {
    const t = setup();
    t.$("u").focus();
    await settle();
    expect(kinds()).toEqual(["coffer:list"]);
    expect(t.filler.overlay.host.shadowRoot).toBeNull();
    expect(t.filler.overlay.button.hidden).toBe(false);
    expect(t.rows().map((r) => r.textContent)).toEqual(["NSnorthwind-shop.testalex@example.comEnter", "NWNorthwind (work)alex.morgan@work.example"]);
    expect(t.root.querySelector(".cf-head")?.textContent).toBe("Coffer · 2 logins for this siteCtrl+Shift+L");
    expect(t.root.querySelector(".cf-foot")?.textContent).toBe("Fills username and password. Nothing fills until you pick.");
    expect(t.$("u").value).toBe("");
    expect(t.$("p").value).toBe("");
  });

  it("puts a name into the menu as text, never as markup", async () => {
    const t = setup({ state: { kind: "logins", site: "s", logins: [{ id: "x", title: '<img src=x onerror="alert(1)">', username: "<b>u</b>", hasTotp: false }] } });
    t.$("u").focus();
    await settle();
    expect(t.root.querySelector("img, b")).toBeNull();
    expect(t.rows()[0].textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("a search box and a page with no sign-in fields get nothing, and Coffer is not asked", async () => {
    const t = setup();
    t.$("search").focus();
    await settle();
    expect(kinds()).toEqual([]);
    expect(t.filler.overlay.shown).toBe(false);
    const t2 = setup({ html: `<input id="q" name="q"><input id="city" name="city"><textarea id="t"></textarea>` });
    t2.$("q").focus();
    t2.$("city").focus();
    await settle();
    expect(kinds()).toEqual([]);
    expect(document.documentElement.querySelectorAll("coffer-fill").length).toBe(0);
  });

  it("off (a frame of another site, an http page): no button at all", async () => {
    const t = setup({ state: { kind: "off" } });
    t.$("p").focus();
    await settle();
    expect(kinds()).toEqual(["coffer:list"]);
    expect(t.filler.overlay.shown).toBe(false);
  });

  it("locked: Coffer is locked, Unlock Coffer", async () => {
    const t = setup({ state: { kind: "locked" } });
    t.$("u").focus();
    await settle();
    expect(t.root.querySelector(".cf-menu")?.textContent).toBe("Coffer is lockedUnlock Coffer");
    (t.root.querySelector(".cf-act") as HTMLButtonElement).click();
    await settle();
    expect(kinds()).toEqual(["coffer:list", "coffer:unlock"]);
  });

  it("not connected: the menu says to connect from the toolbar button (on a click of the Coffer button)", async () => {
    const t = setup({ state: { kind: "notConnected" } });
    t.$("u").focus();
    await settle();
    expect(t.filler.overlay.menuOpen).toBe(false);
    t.filler.overlay.button.click();
    expect(t.root.querySelector(".cf-line")?.textContent).toBe("Connect Coffer from the toolbar button.");
  });
});

describe("a pick", () => {
  it("an untrusted click or Enter (from the page's script) fills nothing", async () => {
    const t = setup({ trusted: false });
    t.$("u").focus();
    await settle();
    clock += PICK_DELAY_MS + 100;
    t.rows()[0].click();
    t.key(t.$("u"), "Enter");
    await settle();
    expect(kinds()).toEqual(["coffer:list"]);
    expect(t.$("p").value).toBe("");
  });

  it("a pick right after the menu shows does not count (a page cannot rush a click)", async () => {
    const t = setup();
    t.$("u").focus();
    await settle();
    clock += PICK_DELAY_MS - 50;
    t.rows()[1].click();
    await settle();
    expect(kinds()).toEqual(["coffer:list"]);
  });

  it("a click fills the username and password; the page's listeners see them", async () => {
    const t = setup();
    const seen: string[] = [];
    document.getElementById("f")!.addEventListener("input", (e) => seen.push(`${(e.target as HTMLInputElement).id}=${(e.target as HTMLInputElement).value}`));
    t.$("u").focus();
    await settle();
    clock += PICK_DELAY_MS + 100;
    t.rows()[1].click();
    await settle();
    expect(kinds()).toEqual(["coffer:list", "coffer:fill"]);
    expect(sent[1]).toEqual({ type: "coffer:fill", id: "nw" });
    expect([t.$("u").value, t.$("p").value]).toEqual(["alex.morgan@work.example", "pw-nw"]);
    expect(seen).toEqual(["u=alex.morgan@work.example", "p=pw-nw"]);
    expect(t.filler.overlay.menuOpen).toBe(false);
  });

  it("keyboard: Down moves, Enter fills (and does not send the form), Esc closes; a login with a code copies it", async () => {
    const t = setup();
    let submitted = 0;
    document.getElementById("f")!.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted++;
    });
    t.$("p").focus();
    await settle();
    clock += PICK_DELAY_MS + 100;
    t.key(t.$("p"), "ArrowDown");
    expect(t.rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    t.key(t.$("p"), "ArrowUp");
    expect(t.rows()[0].getAttribute("aria-selected")).toBe("true");
    t.key(t.$("p"), "Escape");
    expect(t.filler.overlay.menuOpen).toBe(false);
    t.key(t.$("p"), "ArrowDown");
    expect(t.filler.overlay.menuOpen).toBe(true);
    clock += PICK_DELAY_MS + 100;
    const notCancelled = t.key(t.$("p"), "Enter");
    await settle();
    expect(notCancelled).toBe(false);
    expect(submitted).toBe(0);
    expect(kinds()).toEqual(["coffer:list", "coffer:fill", "coffer:totp"]);
    expect([t.$("u").value, t.$("p").value]).toEqual(["alex@example.com", "pw-ns"]);
    expect(t.filler.overlay.note.textContent).toBe("One-time code copied");
    expect(t.filler.overlay.note.hidden).toBe(false);
  });

  it("typing in the field closes the menu", async () => {
    const t = setup();
    t.$("u").focus();
    await settle();
    t.$("u").dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: "a" }));
    expect(t.filler.overlay.menuOpen).toBe(false);
  });

  it("Coffer says no (Cancel in its master-password question): a one-line note, nothing filled", async () => {
    const t = setup();
    t.send.mockImplementation(async (req: ContentRequest) => {
      sent.push(req);
      return req.type === "coffer:list" ? LOGINS : { ok: false, code: "cancelled", message: "" };
    });
    t.$("u").focus();
    await settle();
    clock += PICK_DELAY_MS + 100;
    t.rows()[1].click();
    await settle();
    expect(t.$("p").value).toBe("");
    expect(t.filler.overlay.note.textContent).toBe("Not filled: you clicked Cancel in Coffer.");
  });
});

describe("Ctrl+Shift+L", () => {
  it("fills the first login into the focused form", async () => {
    const t = setup();
    t.$("p").focus();
    await settle();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await t.filler.shortcut();
    await settle();
    expect(kinds()).toEqual(["coffer:list", "coffer:list", "coffer:fill", "coffer:totp"]);
    expect([t.$("u").value, t.$("p").value]).toEqual(["alex@example.com", "pw-ns"]);
  });

  it("with no field focused, fills the page's sign-in form; a frame without the focus does nothing", async () => {
    const t = setup();
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await t.filler.shortcut();
    expect(kinds()).toEqual([]);
    focus.mockReturnValue(true);
    await t.filler.shortcut();
    await settle();
    expect(kinds()).toContain("coffer:fill");
    expect(t.$("p").value).toBe("pw-ns");
  });

  it("the key in the page (where Chrome keeps Ctrl+Shift+L for itself): fills, and keeps the key from the page", async () => {
    const t = setup();
    t.$("p").focus();
    await settle();
    let pageSaw = 0;
    document.addEventListener("keydown", () => pageSaw++);
    const press = () => t.$("p").dispatchEvent(new KeyboardEvent("keydown", { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true, bubbles: true, composed: true, cancelable: true }));
    expect(press()).toBe(false);
    await settle();
    expect(pageSaw).toBe(0);
    expect(t.$("p").value).toBe("pw-ns");
  });

  it("an untrusted Ctrl+Shift+L from the page's script fills nothing", async () => {
    const t = setup({ trusted: false });
    t.$("p").focus();
    await settle();
    t.$("p").dispatchEvent(new KeyboardEvent("keydown", { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true, bubbles: true, composed: true, cancelable: true }));
    await settle();
    expect(kinds()).toEqual(["coffer:list"]);
  });

  it("a page with no sign-in form: nothing, not even a list", async () => {
    const t = setup({ html: `<input id="q" name="q">` });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await t.filler.shortcut();
    expect(kinds()).toEqual([]);
  });
});
