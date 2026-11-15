// The service worker's half of save: a sent login is held in memory for its
// tab only, 2 minutes at most; the bar asks Coffer `find_login` with the
// form's address and the next page's; Save, Update and Never run only the
// action Coffer offered, with the values the worker holds.
import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "./client";
import type { Sender } from "./fill";
import { actionFor, answerSave, type Clock, doneLine, HOLD_MS, Holds, pendingFor, type SaveDesk, type SaveRequest } from "./save";

type Call = { name: string; args: Record<string, unknown> };

function fakeClock() {
  let t = 1_000_000;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock & { advance(ms: number): void } = {
    now: () => t,
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { at: t + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id) {
      timers.delete(id as unknown as number);
    },
    advance(ms) {
      t += ms;
      for (const [id, x] of [...timers]) {
        if (x.at <= t) {
          timers.delete(id);
          x.fn();
        }
      }
    },
  };
  return clock;
}

function fakeDesk(opts: { paired?: boolean; top?: unknown; reply?: (c: Call) => unknown } = {}) {
  const calls: Call[] = [];
  const desk: SaveDesk & { calls: Call[]; forgot: number; shown: number[] } = {
    calls,
    forgot: 0,
    shown: [],
    async call<T>(name: string, args?: unknown): Promise<T> {
      const c = { name, args: (args ?? {}) as Record<string, unknown> };
      calls.push(c);
      const r = opts.reply?.(c);
      if (r instanceof Error) throw r;
      return r as T;
    },
    paired: async () => opts.paired ?? true,
    async forget() {
      desk.forgot++;
    },
    close() {},
    topUrl: vi.fn(async () => opts.top ?? null),
    async showTop(tabId) {
      desk.shown.push(tabId);
    },
  };
  return desk;
}

const top = (url: string, tab = 7): Sender => ({ url, frameId: 0, tab: { id: tab } });
const frame = (url: string, tab = 7): Sender => ({ url, frameId: 4, tab: { id: tab } });
const FORM = "https://northwind-shop.test/sign-in";
const NEXT = "https://northwind-shop.test/account";
const PW = "Shop-pass-4417";

/** A Coffer that knows nothing of the login (offer Save), or what `found` says. */
function coffer(found: Record<string, unknown> = { match: "none", offer: "save", site: "northwind-shop.test" }) {
  return (c: Call) => {
    switch (c.name) {
      case "find_login":
        return found;
      case "save_login":
        return { id: "new1", title: "northwind-shop.test" };
      case "update_password":
        return { id: c.args.id };
      case "never_for_site":
        return { site: "northwind-shop.test" };
      default:
        return {};
    }
  };
}

async function send(desk: SaveDesk, holds: Holds, sender: Sender, m: SaveRequest) {
  return answerSave(desk, holds, sender, m);
}

describe("holding a sent login", () => {
  it("keeps it for its tab only, and drops it after 2 minutes", async () => {
    const clock = fakeClock();
    const holds = new Holds(clock);
    const desk = fakeDesk({ reply: coffer() });
    expect(await send(desk, holds, top(FORM), { type: "coffer:submitted", username: "alex@example.com", password: PW })).toBe(true);
    expect(holds.size).toBe(1);
    // Another tab has nothing.
    expect(await pendingFor(desk, holds, top(NEXT, 8))).toBeNull();
    clock.advance(HOLD_MS - 1);
    expect(holds.get(7)?.username).toBe("alex@example.com");
    clock.advance(1);
    expect(holds.size).toBe(0);
    expect(await pendingFor(desk, holds, top(NEXT))).toBeNull();
    expect(desk.calls).toEqual([]);
  });

  it("drops it when the tab closes, and the next sign-in in the tab replaces it", async () => {
    const holds = new Holds(fakeClock());
    const desk = fakeDesk({ reply: coffer() });
    await send(desk, holds, top(FORM), { type: "coffer:submitted", username: "a", password: "one" });
    await send(desk, holds, top(FORM), { type: "coffer:submitted", username: "b", password: "two" });
    expect(holds.get(7)?.username).toBe("b");
    holds.dropTab(7);
    expect(holds.size).toBe(0);
    expect(await pendingFor(desk, holds, top(NEXT))).toBeNull();
  });

  it("http pages give nothing, except localhost; nor does a frame of another origin", async () => {
    const holds = new Holds(fakeClock());
    for (const url of ["http://northwind-shop.test/sign-in", "http://192.168.1.10/login", "file:///C:/x.html"]) {
      expect(await send(fakeDesk(), holds, top(url), { type: "coffer:submitted", username: "a", password: "p" }), url).toBe(false);
    }
    expect(await send(fakeDesk(), holds, top("http://localhost:3000/login"), { type: "coffer:submitted", username: "a", password: "p" })).toBe(true);
    holds.dropTab(7);
    // northwind-shop.test inside evil.test: nothing kept.
    expect(await send(fakeDesk({ top: "https://evil.test/" }), holds, frame(FORM), { type: "coffer:submitted", username: "a", password: "p" })).toBe(false);
    // Even accounts. inside www. of the same site: only the top page's origin keeps a login.
    expect(await send(fakeDesk({ top: "https://www.northwind-shop.test/" }), holds, frame("https://accounts.northwind-shop.test/f"), { type: "coffer:submitted", username: "a", password: "p" })).toBe(false);
    expect(holds.size).toBe(0);
    expect(await send(fakeDesk({ top: "https://northwind-shop.test/" }), holds, frame("https://northwind-shop.test/f"), { type: "coffer:submitted", username: "a", password: "p" })).toBe(true);
    // No password, no tab: nothing.
    expect(await send(fakeDesk(), holds, top(FORM, 9), { type: "coffer:submitted", username: "a", password: "" })).toBe(false);
    expect(await send(fakeDesk(), holds, { url: FORM, frameId: 0 }, { type: "coffer:submitted", username: "a", password: "p" })).toBe(false);
  });

  it("identifier-first: the username of page 1 goes with the password of page 2 (same origin, 2 minutes)", async () => {
    const clock = fakeClock();
    const holds = new Holds(clock);
    const desk = fakeDesk({ reply: coffer() });
    expect(await send(desk, holds, top("https://northwind-shop.test/identifier"), { type: "coffer:identifier", username: " alex@example.com " })).toBe(true);
    await send(desk, holds, top("https://northwind-shop.test/password"), { type: "coffer:submitted", username: "", password: PW });
    expect(holds.get(7)?.username).toBe("alex@example.com");
    expect(await pendingFor(desk, holds, top(NEXT))).toEqual({ kind: "save", site: "northwind-shop.test", username: "alex@example.com" });
    expect(desk.calls[0].args).toMatchObject({ username: "alex@example.com", password: PW });
    // Another origin, or after 2 minutes: the username is not taken.
    await send(desk, holds, top("https://northwind-shop.test/identifier"), { type: "coffer:identifier", username: "alex@example.com" });
    await send(desk, holds, top("https://evil.test/password"), { type: "coffer:submitted", username: "", password: "p" });
    expect(holds.get(7)?.username).toBe("");
    clock.advance(HOLD_MS);
    await send(desk, holds, top("https://northwind-shop.test/password"), { type: "coffer:submitted", username: "", password: "p" });
    expect(holds.get(7)?.username).toBe("");
    // A username typed on page 2 wins.
    await send(desk, holds, top("https://northwind-shop.test/identifier"), { type: "coffer:identifier", username: "alex@example.com" });
    await send(desk, holds, top("https://northwind-shop.test/password"), { type: "coffer:submitted", username: "bob", password: "p" });
    expect(holds.get(7)?.username).toBe("bob");
  });
});

describe("the bar on the next page", () => {
  async function held(found?: Record<string, unknown>, opts: { top?: unknown } = {}) {
    const holds = new Holds(fakeClock());
    const desk = fakeDesk({ reply: coffer(found), ...opts });
    await send(desk, holds, top(FORM), { type: "coffer:submitted", username: "alex@example.com", password: PW });
    return { holds, desk };
  }

  it("a new login: the Save bar with the site and the username, never the password", async () => {
    const { holds, desk } = await held();
    const view = await pendingFor(desk, holds, top(NEXT));
    expect(view).toEqual({ kind: "save", site: "northwind-shop.test", username: "alex@example.com" });
    expect(JSON.stringify(view)).not.toContain(PW);
    // Coffer gets the form's address and the next page's: it checks they are one site.
    expect(desk.calls).toEqual([{ name: "find_login", args: { url: FORM, top: NEXT, username: "alex@example.com", password: PW } }]);
    // It shows again on the next page until a click (a sign-in can pass through a redirect page).
    expect((await pendingFor(desk, holds, top(NEXT)))?.kind).toBe("save");
  });

  it("a known username with another password: the Update bar naming the login", async () => {
    const { holds, desk } = await held({ match: "changed", offer: "update", id: "ns", title: "Northwind Shop", site: "northwind-shop.test" });
    expect(await pendingFor(desk, holds, top(NEXT))).toEqual({ kind: "update", title: "Northwind Shop", username: "alex@example.com" });
  });

  it("the same password, the never list, or the offers turned off: nothing, and the login is dropped", async () => {
    for (const found of [
      { match: "same", offer: null, id: "ns", title: "x" },
      { match: "never", offer: null },
      { match: "none", offer: null },
      { match: "changed", offer: null, id: "ns", title: "x" },
    ]) {
      const { holds, desk } = await held(found);
      expect(await pendingFor(desk, holds, top(NEXT)), JSON.stringify(found)).toBeNull();
      expect(holds.size).toBe(0);
    }
  });

  it("only on the same site as the form: Coffer's cross_site gives no bar (the login stays held)", async () => {
    const { holds, desk } = await held(undefined);
    const crossDesk = fakeDesk({ reply: () => new BridgeError("cross_site", "x") });
    expect(await pendingFor(crossDesk, holds, top("https://evil.test/"))).toBeNull();
    expect(crossDesk.calls[0].args).toMatchObject({ url: FORM, top: "https://evil.test/" });
    expect(holds.size).toBe(1);
    expect((await pendingFor(desk, holds, top(NEXT)))?.kind).toBe("save");
  });

  it("only the top page shows it, only on https (or localhost), and only when connected", async () => {
    const { holds, desk } = await held();
    expect(await pendingFor(desk, holds, frame(NEXT))).toBeNull();
    expect(await pendingFor(desk, holds, top("http://northwind-shop.test/account"))).toBeNull();
    expect(await pendingFor(fakeDesk({ paired: false }), holds, top(NEXT))).toBeNull();
    expect(desk.calls).toEqual([]);
  });

  it("locked: the bar says to unlock; Unlock, then the next ask saves without asking again", async () => {
    const holds = new Holds(fakeClock());
    let locked = true;
    const desk = fakeDesk({ reply: (c) => (locked && c.name !== "unlock" ? new BridgeError("locked", "Coffer is locked.") : coffer()(c)) });
    await send(desk, holds, top(FORM), { type: "coffer:submitted", username: "alex@example.com", password: PW });
    expect(await pendingFor(desk, holds, top(NEXT))).toEqual({ kind: "locked" });
    expect(await actionFor(desk, holds, top(NEXT), "unlock")).toEqual({ ok: true, done: "unlock" });
    expect(desk.calls.at(-1)?.name).toBe("unlock");
    expect(await pendingFor(desk, holds, top(NEXT))).toEqual({ kind: "locked" });
    locked = false;
    expect(await pendingFor(desk, holds, top(NEXT))).toEqual({ kind: "saved", title: "northwind-shop.test" });
    expect(desk.calls.slice(-2).map((c) => c.name)).toEqual(["find_login", "save_login"]);
    expect(holds.size).toBe(0);
  });

  it("locked, and the user unlocks Coffer without the bar's button: the Save bar asks first", async () => {
    const holds = new Holds(fakeClock());
    let locked = true;
    const desk = fakeDesk({ reply: (c) => (locked ? new BridgeError("locked", "x") : coffer()(c)) });
    await send(desk, holds, top(FORM), { type: "coffer:submitted", username: "alex@example.com", password: PW });
    expect((await pendingFor(desk, holds, top(NEXT)))?.kind).toBe("locked");
    locked = false;
    expect((await pendingFor(desk, holds, top(NEXT)))?.kind).toBe("save");
    expect(desk.calls.some((c) => c.name === "save_login")).toBe(false);
  });

  it("a frame's sign-in settled: the worker tells the top page to ask", async () => {
    const holds = new Holds(fakeClock());
    const desk = fakeDesk({ top: "https://northwind-shop.test/", reply: coffer() });
    await send(desk, holds, frame("https://northwind-shop.test/f"), { type: "coffer:settled" });
    expect(desk.shown).toEqual([]);
    await send(desk, holds, frame("https://northwind-shop.test/f"), { type: "coffer:submitted", username: "a", password: "p" });
    await send(desk, holds, frame("https://northwind-shop.test/f"), { type: "coffer:settled" });
    expect(desk.shown).toEqual([7]);
  });
});

describe("the bar's actions", () => {
  async function offered(found?: Record<string, unknown>) {
    const holds = new Holds(fakeClock());
    const desk = fakeDesk({ reply: coffer(found) });
    await send(desk, holds, top(FORM), { type: "coffer:submitted", username: "alex@example.com", password: PW });
    await pendingFor(desk, holds, top(NEXT));
    return { holds, desk };
  }

  it("Save sends the held values once; the login is then dropped", async () => {
    const { holds, desk } = await offered();
    const r = await send(desk, holds, top(NEXT), { type: "coffer:save", action: "save" });
    expect(r).toEqual({ ok: true, done: "saved", title: "northwind-shop.test" });
    expect(desk.calls.at(-1)).toEqual({ name: "save_login", args: { url: FORM, top: NEXT, username: "alex@example.com", password: PW } });
    expect(holds.size).toBe(0);
    expect(await send(desk, holds, top(NEXT), { type: "coffer:save", action: "save" })).toMatchObject({ ok: false, code: "gone" });
    expect(doneLine(r as never)).toBe("Saved in Coffer as northwind-shop.test.");
  });

  it("Update goes to the login Coffer named, whatever the message says", async () => {
    const { holds, desk } = await offered({ match: "changed", offer: "update", id: "ns", title: "Northwind Shop", site: "northwind-shop.test" });
    const sneaky = { type: "coffer:save", action: "update", id: "bank", password: "x" } as unknown as SaveRequest;
    expect(await send(desk, holds, top(NEXT), sneaky)).toEqual({ ok: true, done: "updated", title: "Northwind Shop" });
    expect(desk.calls.at(-1)).toEqual({ name: "update_password", args: { url: FORM, top: NEXT, id: "ns", password: PW } });
  });

  it("only the action Coffer offered: no Update on a Save bar, no Save on an Update bar", async () => {
    const a = await offered();
    expect(await actionFor(a.desk, a.holds, top(NEXT), "update")).toMatchObject({ ok: false, code: "not_offered" });
    const b = await offered({ match: "changed", offer: "update", id: "ns", title: "N" });
    expect(await actionFor(b.desk, b.holds, top(NEXT), "save")).toMatchObject({ ok: false, code: "not_offered" });
    expect([...a.desk.calls, ...b.desk.calls].map((c) => c.name)).toEqual(["find_login", "find_login"]);
  });

  it("Never for this site and ×: Coffer keeps the site, or nothing happens; the login is dropped either way", async () => {
    const a = await offered();
    expect(await actionFor(a.desk, a.holds, top(NEXT), "never")).toEqual({ ok: true, done: "never" });
    expect(a.desk.calls.at(-1)).toEqual({ name: "never_for_site", args: { url: FORM, top: NEXT } });
    expect(a.holds.size).toBe(0);
    const b = await offered();
    expect(await actionFor(b.desk, b.holds, top(NEXT), "dismiss")).toEqual({ ok: true, done: "dismissed" });
    expect(b.desk.calls.map((c) => c.name)).toEqual(["find_login"]);
    expect(b.holds.size).toBe(0);
  });

  it("from a frame, an http page or another tab: refused", async () => {
    const { holds, desk } = await offered();
    expect(await actionFor(desk, holds, frame(NEXT), "save")).toMatchObject({ ok: false });
    expect(await actionFor(desk, holds, top("http://northwind-shop.test/"), "save")).toMatchObject({ ok: false });
    expect(await actionFor(desk, holds, top(NEXT, 8), "save")).toMatchObject({ ok: false, code: "gone" });
    expect(desk.calls.map((c) => c.name)).toEqual(["find_login"]);
  });
});
