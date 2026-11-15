// The service worker as it runs, with a fake `chrome` and a fake Coffer
// behind the native port: a sent login lives in the worker's memory only.
// Nothing of it reaches chrome.storage, and a closed tab drops it.
import { beforeAll, describe, expect, it } from "vitest";
import { b64, signBody, verifyBody } from "./lib/protocol";

type Msg = Record<string, unknown>;
type Listener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => boolean | void;

const PW = "Shop-pass-4417";
const KEY = crypto.getRandomValues(new Uint8Array(32));
const CLIENT = "0123456789abcdef0123456789abcdef";
const NONCE = b64(crypto.getRandomValues(new Uint8Array(16)));

/** Every storage call the worker makes, as JSON. */
const storageLog: string[] = [];
const store: Record<string, unknown> = { pairing: { client: CLIENT, key: b64(KEY), browser: "chrome", pairedAt: "2026-11-15T12:00:00Z" } };
/** The calls Coffer got (names and args). */
const cofferCalls: Array<{ call: string; args: Msg }> = [];
let onMessage: Listener | null = null;
let onRemoved: ((tabId: number) => void) | null = null;

/** A Coffer on the other end of the native port: it checks the MAC and answers find_login and save_login. */
function fakePort() {
  const listeners: Array<(m: unknown) => void> = [];
  return {
    name: "native",
    onMessage: { addListener: (cb: (m: unknown) => void) => listeners.push(cb) },
    onDisconnect: { addListener: () => undefined },
    disconnect: () => undefined,
    postMessage(m: Msg) {
      void (async () => {
        let reply: Msg;
        if (m.call === "hello") reply = { id: m.id, ok: true, result: { protocol: 1, version: "0.4.0", paired: true, locked: false, nonce: NONCE } };
        else {
          const body = String(m.body);
          expect(await verifyBody(KEY, "req", CLIENT, body, String(m.mac))).toBe(true);
          const b = JSON.parse(body) as { call: string; args: Msg; seq: number; nonce: string };
          cofferCalls.push({ call: b.call, args: b.args });
          const result = b.call === "find_login" ? { match: "none", offer: "save", site: "northwind-shop.test" } : b.call === "save_login" ? { id: "new1", title: "northwind-shop.test" } : {};
          const text = JSON.stringify({ seq: b.seq, nonce: b.nonce, ok: true, result });
          reply = { id: m.id, body: text, mac: await signBody(KEY, "res", CLIENT, text) };
        }
        for (const l of listeners) l(reply);
      })();
    },
  };
}

beforeAll(async () => {
  const area = {
    get: async (k?: string | string[] | null) => {
      storageLog.push(JSON.stringify(["get", k]));
      return typeof k === "string" ? { [k]: store[k] } : { ...store };
    },
    set: async (items: Record<string, unknown>) => {
      storageLog.push(JSON.stringify(["set", items]));
      Object.assign(store, items);
    },
    remove: async (k: string | string[]) => {
      storageLog.push(JSON.stringify(["remove", k]));
      for (const x of [k].flat()) delete store[x];
    },
  };
  const g = globalThis as unknown as Msg;
  g.chrome = {
    runtime: {
      id: "jdnmjnanpckdfdhfclpkcbgimdjbeglj",
      lastError: undefined,
      getManifest: () => ({ version: "0.4.0", name: "Coffer" }),
      getURL: (p: string) => `chrome-extension://jdnmjnanpckdfdhfclpkcbgimdjbeglj/${p}`,
      connectNative: () => fakePort(),
      reload: () => undefined,
      onMessage: { addListener: (cb: Listener) => (onMessage = cb) },
      onInstalled: { addListener: () => undefined },
    },
    // Only `local` exists here: a write to `session` (or anything else) would throw.
    storage: { local: area },
    tabs: {
      create: async () => undefined,
      query: async () => [],
      sendMessage: async () => undefined,
      onRemoved: { addListener: (cb: (tabId: number) => void) => (onRemoved = cb) },
    },
    commands: { onCommand: { addListener: () => undefined } },
  };
  g.fetch = async (url: string) => ({ ok: true, json: async () => ({ host: "dev.sampo.coffer.qa5" }), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0), url });
  await import("./background");
});

/** A content script's message, as Chrome delivers it. */
function send(req: Msg, url: string, tab = 7, frameId = 0): Promise<unknown> {
  return new Promise((resolve) => {
    const async = onMessage?.(req, { id: "jdnmjnanpckdfdhfclpkcbgimdjbeglj", url, frameId, tab: { id: tab } }, resolve);
    if (async !== true) resolve(undefined);
  });
}

describe("the service worker holds a sent login in memory only", () => {
  it("submit, the bar, Save: Coffer gets the login; chrome.storage never sees the password", async () => {
    expect(await send({ type: "coffer:submitted", username: "alex@example.com", password: PW }, "https://northwind-shop.test/sign-in")).toBe(true);
    expect(await send({ type: "coffer:pending" }, "https://northwind-shop.test/account")).toEqual({ kind: "save", site: "northwind-shop.test", username: "alex@example.com" });
    expect(await send({ type: "coffer:save", action: "save" }, "https://northwind-shop.test/account")).toEqual({ ok: true, done: "saved", title: "northwind-shop.test" });
    expect(cofferCalls.map((c) => c.call)).toEqual(["find_login", "save_login"]);
    expect(cofferCalls[1].args).toEqual({ url: "https://northwind-shop.test/sign-in", top: "https://northwind-shop.test/account", username: "alex@example.com", password: PW });
    expect(storageLog.length).toBeGreaterThan(0);
    expect(storageLog.some((l) => l.startsWith('["set"'))).toBe(false);
    expect(storageLog.join("\n")).not.toContain(PW);
    expect(JSON.stringify(store)).not.toContain(PW);
  });

  it("a closed tab drops its held login", async () => {
    await send({ type: "coffer:submitted", username: "alex@example.com", password: PW }, "https://northwind-shop.test/sign-in", 9);
    onRemoved?.(9);
    expect(await send({ type: "coffer:pending" }, "https://northwind-shop.test/account", 9)).toBeNull();
    expect(JSON.stringify(store)).not.toContain(PW);
  });

  it("a web page's message of another kind, or one from a page of another extension, gets nothing", async () => {
    expect(await send({ type: "coffer:pairing" }, "https://northwind-shop.test/")).toBeUndefined();
    const other = await new Promise((resolve) => {
      const r = onMessage?.({ type: "coffer:pending" }, { id: "another-extension", url: "https://northwind-shop.test/", frameId: 0, tab: { id: 7 } }, resolve);
      if (r !== true) resolve(undefined);
    });
    expect(other).toBeUndefined();
  });
});
