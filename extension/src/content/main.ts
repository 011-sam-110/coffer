// The content script (built as one IIFE: content scripts cannot be ES
// modules). It runs in https pages, http://localhost and http://127.0.0.1,
// in the top page and in frames; the service worker and Coffer decide
// whether a frame gets anything (the same site as its page only).
import type { ContentMessage, ContentRequest } from "../lib/fill";
import { unb64 } from "../lib/protocol";
import { Filler } from "./filler";

const send = (req: ContentRequest) => chrome.runtime.sendMessage<unknown>(req);

/** Switzer from the extension, for the menu (the page's own fonts stay as they are). */
async function loadFont() {
  try {
    const data = await send({ type: "coffer:font" });
    if (typeof data !== "string" || !data) return;
    const face = new FontFace("Coffer Switzer", unb64(data), { weight: "100 900", style: "normal" });
    document.fonts.add(await face.load());
  } catch {
    /* Segoe UI shows instead */
  }
}

const filler = new Filler({ doc: document, send, onShow: () => void loadFont() });
filler.start();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const m = message as ContentMessage;
  if (m?.type === "coffer:where") {
    // The service worker asks the top page where it is, for a frame's fill.
    if (window === window.top) sendResponse(location.href);
    return false;
  }
  if (m?.type === "coffer:command" && m.command === "fill-login") void filler.shortcut();
  return false;
});
