// The content script (built as one IIFE: content scripts cannot be ES
// modules). It runs in https pages, http://localhost and http://127.0.0.1,
// in the top page and in frames; the service worker and Coffer decide
// whether a frame gets anything (the same site as its page only).
import type { ContentMessage, ContentRequest } from "../lib/fill";
import { unb64 } from "../lib/protocol";
import type { SaveRequest } from "../lib/save";
import { Filler } from "./filler";
import { Saver } from "./saver";

const send = (req: ContentRequest | SaveRequest) => chrome.runtime.sendMessage<unknown>(req);

let fontAsked = false;
/** Switzer from the extension, for the menu and the bar (the page's own fonts stay as they are). Once per page. */
async function loadFont() {
  if (fontAsked) return;
  fontAsked = true;
  try {
    const data = await send({ type: "coffer:font" });
    if (typeof data !== "string" || !data) return;
    const face = new FontFace("Coffer Switzer", unb64(data), { weight: "100 900", style: "normal" });
    document.fonts.add(await face.load());
  } catch {
    /* Segoe UI shows instead */
  }
}

const top = window === window.top;
/** A frame whose top page has this frame's origin (reading the top's address throws for another origin). */
function sameOriginTop(): boolean {
  try {
    return !top && window.top?.location.origin === location.origin;
  } catch {
    return false;
  }
}

const filler = new Filler({ doc: document, send, onShow: () => void loadFont() });
filler.start();
// Save (M5): one overlay with the menu, so one host element per page.
const saver = new Saver({ doc: document, send, overlay: filler.overlay, top, sameOriginTop: sameOriginTop(), onShow: () => void loadFont() });
saver.start();
saver.loaded();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const m = message as ContentMessage;
  if (m?.type === "coffer:where") {
    // The service worker asks the top page where it is, for a frame's fill.
    if (top) sendResponse(location.href);
    return false;
  }
  if (m?.type === "coffer:command" && m.command === "fill-login") void filler.shortcut();
  // A frame's sign-in settled: the top page asks for the bar.
  if (m?.type === "coffer:show" && top) void saver.check();
  return false;
});
