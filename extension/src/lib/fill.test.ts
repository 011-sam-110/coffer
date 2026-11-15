// The service worker's half of fill: the address comes from Chrome, http
// pages and other-site frames get nothing, and get_login runs only on a
// fill message (a pick or Ctrl+Shift+L in the content script).
import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "./client";
import { answer, type ContentRequest, type Desk, FILL_TIMEOUT_MS, fillableUrl, menuFor, placeOf, type Sender } from "./fill";

type Call = { name: string; args: unknown; timeoutMs?: number };

function fakeDesk(opts: { paired?: boolean; top?: unknown; reply?: (c: Call) => unknown } = {}) {
  const calls: Call[] = [];
  const desk: Desk & { calls: Call[]; forgot: number; closed: number } = {
    calls,
    forgot: 0,
    closed: 0,
    async call<T>(name: string, args?: unknown, timeoutMs?: number): Promise<T> {
      const c = { name, args, timeoutMs };
      calls.push(c);
      const r = opts.reply?.(c);
      if (r instanceof Error) throw r;
      return r as T;
    },
    paired: async () => opts.paired ?? true,
    async forget() {
      desk.forgot++;
    },
    close() {
      desk.closed++;
    },
    topUrl: vi.fn(async () => opts.top ?? null),
  };
  return desk;
}

const top = (url: string): Sender => ({ url, frameId: 0, tab: { id: 7 } });
const frame = (url: string): Sender => ({ url, frameId: 3, tab: { id: 7 } });
const logins = { site: "northwind-shop.test", logins: [{ id: "ns", title: "northwind-shop.test", username: "alex@example.com", hasTotp: true }] };

describe("pages and frames Coffer fills on", () => {
  it("https pages, and http only on localhost and 127.0.0.1", () => {
    for (const u of ["https://northwind-shop.test/sign-in", "http://localhost:3000/login", "http://127.0.0.1:8080/", "https://192.168.1.1/"]) expect(fillableUrl(u), u).toBe(true);
    for (const u of ["http://northwind-shop.test/", "http://192.168.1.1/", "http://app.localhost/", "file:///C:/x.html", "chrome://settings", "about:blank", "data:text/html,x", "javascript:alert(1)", "", undefined])
      expect(fillableUrl(u), String(u)).toBe(false);
  });

  it("the top page: its own address; a frame: its address and the top page's", async () => {
    expect(await placeOf(top("https://northwind-shop.test/"), async () => "x")).toEqual({ url: "https://northwind-shop.test/", sameOrigin: true });
    expect(await placeOf(frame("https://accounts.northwind-shop.test/f"), async () => "https://www.northwind-shop.test/")).toEqual({
      url: "https://accounts.northwind-shop.test/f",
      top: "https://www.northwind-shop.test/",
      sameOrigin: false,
    });
    expect((await placeOf(frame("https://northwind-shop.test/f"), async () => "https://northwind-shop.test/"))?.sameOrigin).toBe(true);
    // A frame in an http page, a top page that does not answer, no tab.
    expect(await placeOf(frame("https://northwind-shop.test/f"), async () => "http://evil.test/")).toBeNull();
    expect(await placeOf(frame("https://northwind-shop.test/f"), async () => Promise.reject(new Error("no content script")))).toBeNull();
    expect(await placeOf({ url: "https://northwind-shop.test/", frameId: 0 }, async () => "x")).toBeNull();
    expect(await placeOf(top("http://northwind-shop.test/"), async () => "x")).toBeNull();
  });
});

describe("the menu", () => {
  it("asks Coffer with the address Chrome reports, never one from the page", async () => {
    const desk = fakeDesk({ reply: () => logins });
    const sneaky = { type: "coffer:list", url: "https://bank.example/", site: "bank.example" } as unknown as ContentRequest;
    expect(await answer(desk, top("https://northwind-shop.test/sign-in"), sneaky)).toEqual({ kind: "logins", ...logins });
    expect(desk.calls).toEqual([{ name: "list_logins", args: { url: "https://northwind-shop.test/sign-in" }, timeoutMs: undefined }]);
  });

  it("names and usernames only, whatever else comes back", async () => {
    const desk = fakeDesk({ reply: () => ({ site: "s", logins: [{ id: 1, title: "T", username: "u", hasTotp: 0, password: "leak" }] }) });
    const m = await menuFor(desk, top("https://s.test/"));
    expect(m).toEqual({ kind: "logins", site: "s", logins: [{ id: "1", title: "T", username: "u", hasTotp: false }] });
  });

  it("an http page gets no button and Coffer is not asked", async () => {
    const desk = fakeDesk({ reply: () => logins });
    expect(await menuFor(desk, top("http://northwind-shop.test/"))).toEqual({ kind: "off" });
    expect(desk.calls).toEqual([]);
  });

  it("a frame sends the top page's address; Coffer's cross_site gives no button", async () => {
    const desk = fakeDesk({ top: "https://evil.test/", reply: () => new BridgeError("cross_site", "x") });
    expect(await menuFor(desk, frame("https://accounts.northwind-shop.test/login"))).toEqual({ kind: "off" });
    expect(desk.calls[0]).toMatchObject({ name: "list_logins", args: { url: "https://accounts.northwind-shop.test/login", top: "https://evil.test/" } });
  });

  it("a frame of another origin gets no Connect or Unlock line before Coffer says it is the same site", async () => {
    const notPaired = fakeDesk({ paired: false, top: "https://evil.test/" });
    expect(await menuFor(notPaired, frame("https://northwind-shop.test/f"))).toEqual({ kind: "off" });
    expect(await menuFor(fakeDesk({ paired: false }), top("https://northwind-shop.test/"))).toEqual({ kind: "notConnected" });
    // Locked: Coffer checks the page before the lock, so `locked` means the frame passed.
    const locked = fakeDesk({ top: "https://www.northwind-shop.test/", reply: () => new BridgeError("locked", "x") });
    expect(await menuFor(locked, frame("https://accounts.northwind-shop.test/f"))).toEqual({ kind: "locked" });
    const down = fakeDesk({ top: "https://evil.test/", reply: () => new BridgeError("not_running", "x") });
    expect(await menuFor(down, frame("https://northwind-shop.test/f"))).toEqual({ kind: "off" });
    expect(await menuFor(fakeDesk({ reply: () => new BridgeError("not_running", "x") }), top("https://northwind-shop.test/"))).toEqual({ kind: "notRunning" });
  });

  it("Coffer forgot this browser: the key goes, and the menu says Connect", async () => {
    const desk = fakeDesk({ reply: () => new BridgeError("not_paired", "x") });
    expect(await menuFor(desk, top("https://northwind-shop.test/"))).toEqual({ kind: "notConnected" });
    expect(desk.forgot).toBe(1);
  });
});

describe("the fill", () => {
  it("get_login runs only for a fill message, with the id and Chrome's address, and waits long enough for the master password", async () => {
    const desk = fakeDesk({ reply: (c) => (c.name === "get_login" ? { username: "alex@example.com", password: "pw", hasTotp: true } : logins) });
    await answer(desk, top("https://northwind-shop.test/"), { type: "coffer:list" });
    await answer(desk, top("https://northwind-shop.test/"), { type: "coffer:unlock" });
    expect(desk.calls.map((c) => c.name)).toEqual(["list_logins", "unlock"]);
    const r = await answer(desk, top("https://northwind-shop.test/x"), { type: "coffer:fill", id: "ns" });
    expect(r).toEqual({ ok: true, username: "alex@example.com", password: "pw", hasTotp: true });
    expect(desk.calls.at(-1)).toEqual({ name: "get_login", args: { id: "ns", url: "https://northwind-shop.test/x" }, timeoutMs: FILL_TIMEOUT_MS });
    expect(FILL_TIMEOUT_MS).toBeGreaterThan(120_000);
  });

  it("no fill on an http page or in a frame whose page is not https; no id, no call", async () => {
    const desk = fakeDesk({ top: "http://evil.test/" });
    await answer(desk, top("http://northwind-shop.test/"), { type: "coffer:unlock" });
    expect(await answer(desk, top("http://northwind-shop.test/"), { type: "coffer:fill", id: "ns" })).toMatchObject({ ok: false, code: "off" });
    expect(await answer(desk, frame("https://northwind-shop.test/f"), { type: "coffer:fill", id: "ns" })).toMatchObject({ ok: false, code: "off" });
    expect(await answer(desk, top("https://northwind-shop.test/"), { type: "coffer:fill" } as unknown as ContentRequest)).toMatchObject({ ok: false, code: "bad_request" });
    expect(desk.calls).toEqual([]);
  });

  it("Coffer's refusals come back as codes (Cancel in Coffer, another site's login)", async () => {
    const desk = fakeDesk({ reply: () => new BridgeError("cancelled", "You clicked Cancel in Coffer.") });
    expect(await answer(desk, top("https://northwind-shop.test/"), { type: "coffer:fill", id: "nw" })).toEqual({ ok: false, code: "cancelled", message: "You clicked Cancel in Coffer." });
  });

  it("the one-time code", async () => {
    const desk = fakeDesk({ reply: () => ({ clearsInSeconds: 90 }) });
    expect(await answer(desk, top("https://northwind-shop.test/"), { type: "coffer:totp", id: "ns" })).toEqual({ ok: true, clearsInSeconds: 90 });
    expect(desk.calls[0]).toMatchObject({ name: "copy_totp", args: { id: "ns", url: "https://northwind-shop.test/" } });
  });
});
