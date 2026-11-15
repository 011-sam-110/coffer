// The service worker: owns the one Session with Coffer, answers the popup,
// and answers the content scripts (fill and save, docs/BRIDGE.md section 6).
import { asBridgeError, NativeLink, type Pairing, Session, type Status } from "./lib/client";
import { answer, type ContentMessage, type ContentRequest, type Desk } from "./lib/fill";
import { b64, browserKind, hostName, newerVersion, parseWordList } from "./lib/protocol";
import { answerSave, Holds, SAVE_TYPES, type SaveDesk, type SaveRequest } from "./lib/save";
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

/** The content scripts' way to Coffer. The page's address comes from Chrome (`sender.url`). */
const desk: Desk = {
  call: (name, args, timeoutMs) => session.call(name, args, timeoutMs),
  paired: async () => !!(await load()),
  forget: () => save(null),
  close: () => session.close(),
  // The top page's own content script says where it is (frame 0 only).
  topUrl: (tabId) => chrome.tabs.sendMessage(tabId, { type: "coffer:where" } satisfies ContentMessage, { frameId: 0 }),
};

/** Sent logins, in this worker's memory only (never chrome.storage): one per tab, 2 minutes at most. */
const holds = new Holds();
const saveDesk: SaveDesk = {
  ...desk,
  showTop: async (tabId) => {
    await chrome.tabs.sendMessage(tabId, { type: "coffer:show" } satisfies ContentMessage, { frameId: 0 });
  },
};
// A closed tab takes its held login with it.
chrome.tabs.onRemoved.addListener((tabId) => holds.dropTab(tabId));

let font: Promise<string | null> | null = null;
/** Switzer for the menu, as base64 (the page cannot fetch the extension's files: none are web accessible). */
function fontData(): Promise<string | null> {
  font ??= fetch(chrome.runtime.getURL("fonts/itf/switzer/fonts/Switzer-Variable.woff2"))
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((b) => (b ? b64(new Uint8Array(b)) : null))
    .catch(() => null);
  return font;
}

const FILL_TYPES = new Set<string>(["coffer:list", "coffer:fill", "coffer:totp", "coffer:unlock", "coffer:font"]);
const SAVE_SET = new Set<string>(SAVE_TYPES);
/** Every message a content script may send. */
const CONTENT_TYPES = new Set<string>([...FILL_TYPES, ...SAVE_SET]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const req = message as { type?: unknown };
  if (!req || typeof req !== "object" || typeof req.type !== "string") return false;
  if (sender.url?.startsWith(chrome.runtime.getURL(""))) {
    // This extension's own pages: the popup and the first-run page.
    if (!req.type.startsWith("coffer:") || CONTENT_TYPES.has(req.type)) return false;
    handle(req as PopupRequest).then(sendResponse, (e) => sendResponse({ kind: "notRunning", message: asBridgeError(e).message } satisfies PopupState));
    return true;
  }
  // A content script in a web page: the fill and save messages only.
  if (!sender.tab || !CONTENT_TYPES.has(req.type)) return false;
  const reply = req.type === "coffer:font" ? fontData() : SAVE_SET.has(req.type) ? answerSave(saveDesk, holds, sender, req as SaveRequest) : answer(desk, sender, req as ContentRequest);
  reply.then(sendResponse, () => sendResponse(null));
  return true;
});

// Ctrl+Shift+L: the frame with the focus fills the first login (filler.ts).
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "fill-login") return;
  const to = async (id: number | undefined) => {
    if (id !== undefined) await chrome.tabs.sendMessage(id, { type: "coffer:command", command: "fill-login" } satisfies ContentMessage).catch(() => undefined);
  };
  if (tab?.id !== undefined) void to(tab.id);
  else void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => to(tabs[0]?.id));
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
});

