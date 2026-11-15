// The service worker: owns the one Session with Coffer and answers the
// popup. Content scripts (M4, M5) will call Coffer through it too.
import { asBridgeError, NativeLink, type Pairing, Session, type Status } from "./lib/client";
import { browserKind, hostName, newerVersion, parseWordList } from "./lib/protocol";
import type { PopupRequest, PopupState } from "./lib/state";

const STORE_KEY = "pairing";
const RELOADED_KEY = "reloadedFor";
const version = chrome.runtime.getManifest().version;

let host: Promise<string> | null = null;
/** host.json: the native host name the installer wrote (a QA copy has its own). */
function hostOf(): Promise<string> {
  host ??= fetch(chrome.runtime.getURL("host.json"))
    .then((r) => r.json())
    .then(hostName, () => hostName(null));
  return host;
}

let words: Promise<string[]> | null = null;
function wordList(): Promise<string[]> {
  words ??= fetch(chrome.runtime.getURL("words.txt"))
    .then((r) => r.text())
    .then(parseWordList);
  return words;
}

async function load(): Promise<Pairing | null> {
  const got = await chrome.storage.local.get(STORE_KEY);
  const p = got[STORE_KEY] as Pairing | undefined;
  return p && typeof p.client === "string" && typeof p.key === "string" ? p : null;
}

async function save(p: Pairing | null): Promise<void> {
  if (p) await chrome.storage.local.set({ [STORE_KEY]: p });
  else await chrome.storage.local.remove(STORE_KEY);
}

const session = new Session({
  open: async () => new NativeLink(await hostOf()),
  browser: browserKind(navigator.userAgentData?.brands),
  version,
  load,
  save,
  words: wordList,
});

/** The Connect in progress: the words once Coffer sent its key. */
let pairing: { words: string[] | null } | null = null;
/** One line for the next "Not connected" (Deny, timeout). */
let note: string | undefined;

function takeNote(): string | undefined {
  const n = note;
  note = undefined;
  return n;
}

/** Coffer is newer than this extension: the installer replaced the files, so load them (once per version). */
async function reloadIfOlder(cofferVersion: string): Promise<void> {
  if (!newerVersion(cofferVersion, version)) return;
  const got = await chrome.storage.local.get(RELOADED_KEY);
  if (got[RELOADED_KEY] === cofferVersion) return;
  await chrome.storage.local.set({ [RELOADED_KEY]: cofferVersion });
  chrome.runtime.reload();
}

async function refresh(): Promise<PopupState> {
  if (pairing) return { kind: "pairing", words: pairing.words };
  try {
    const hello = await session.connect();
    await reloadIfOlder(hello.version);
    if (!(await load())) return { kind: "notConnected", message: takeNote() };
    const status = await session.call<Status>("status");
    return status.locked ? { kind: "locked", version: status.version } : { kind: "connected", version: status.version };
  } catch (e) {
    const err = asBridgeError(e);
    switch (err.code) {
      case "not_paired":
      case "bad_mac":
        // Coffer no longer has this browser's key (Disconnect in Settings): forget ours too.
        await save(null);
        return { kind: "notConnected", message: "Coffer no longer knows this browser. Connect it again." };
      case "not_installed":
        session.close();
        return { kind: "notInstalled", message: err.message };
      default:
        // not_running, wrong_server, a closed port: close it, so the next try starts a new bridge.
        session.close();
        return { kind: "notRunning", message: err.code === "wrong_server" ? err.message : undefined };
    }
  }
}

function startPairing() {
  if (pairing) return;
  const current: { words: string[] | null } = { words: null };
  pairing = current;
  session
    .pair((w) => (current.words = w))
    .then(
      () => {
        note = undefined;
      },
      (e) => {
        const err = asBridgeError(e);
        note = err.code === "closed" ? undefined : err.code === "not_running" ? "Coffer is not running." : err.message;
      },
    )
    .finally(() => {
      if (pairing === current) pairing = null;
    });
}

async function handle(req: PopupRequest): Promise<PopupState> {
  switch (req.type) {
    case "coffer:state":
      return refresh();
    case "coffer:connect": {
      startPairing();
      // Give Coffer a moment to send its key, so the first answer can show the words.
      for (let i = 0; i < 20 && pairing && !pairing.words; i++) await new Promise((r) => setTimeout(r, 100));
      return refresh();
    }
    case "coffer:cancel":
      // Closing the port closes Coffer's prompt; nothing is stored.
      pairing = null;
      session.close();
      return refresh();
    case "coffer:unlock":
      await session.call<Status>("unlock").catch(() => undefined);
      return refresh();
    case "coffer:disconnect":
      await session.call("disconnect").catch(() => undefined);
      await save(null);
      return refresh();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages (not a content script in a web page).
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  const req = message as PopupRequest;
  if (!req || typeof req !== "object" || typeof req.type !== "string" || !req.type.startsWith("coffer:")) return false;
  handle(req).then(sendResponse, (e) => sendResponse({ kind: "notRunning", message: asBridgeError(e).message } satisfies PopupState));
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
});

