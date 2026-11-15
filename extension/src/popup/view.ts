// The toolbar popup, drawn from a PopupState. Plain DOM with textContent
// only: no HTML from Coffer or a page ever goes into it.
import type { PopupState } from "../lib/state";

export interface PopupActions {
  connect(): void;
  cancel(): void;
  unlock(): void;
  disconnect(): void;
  retry(): void;
}

interface Button {
  label: string;
  run: keyof PopupActions;
  kind: "primary" | "secondary" | "quiet";
}

export interface PopupCopy {
  title: string;
  text: string;
  words?: string;
  message?: string;
  buttons: Button[];
}

/** The words and buttons of each state. */
export function copyFor(state: PopupState): PopupCopy {
  switch (state.kind) {
    case "checking":
      return { title: "Looking for Coffer", text: "One moment.", buttons: [] };
    case "notConnected":
      return {
        title: "Not connected",
        text: "Connect this browser to Coffer to fill and save your logins.",
        message: state.message,
        buttons: [{ label: "Connect", run: "connect", kind: "primary" }],
      };
    case "pairing":
      return state.words
        ? {
            title: "Click Allow in Coffer",
            text: "Coffer shows four words. Check that they are the same as these:",
            words: state.words.join(" · "),
            buttons: [{ label: "Cancel", run: "cancel", kind: "secondary" }],
          }
        : { title: "Asking Coffer", text: "Coffer opens its Connect prompt.", buttons: [{ label: "Cancel", run: "cancel", kind: "secondary" }] };
    case "connected":
      return {
        title: "Connected",
        text: `Coffer ${state.version} fills and saves logins in this browser.`,
        buttons: [{ label: "Disconnect", run: "disconnect", kind: "quiet" }],
      };
    case "locked":
      return { title: "Coffer is locked", text: "Unlock Coffer to fill your logins.", buttons: [{ label: "Unlock Coffer", run: "unlock", kind: "primary" }] };
    case "notRunning":
      return {
        title: "Coffer is not running",
        text: "Start Coffer from the Start menu, then try again.",
        message: state.message,
        buttons: [{ label: "Try again", run: "retry", kind: "secondary" }],
      };
    case "notInstalled":
      return {
        title: "Coffer is not set up",
        text: "This browser cannot reach Coffer. Install Coffer, then reload this extension.",
        message: state.message,
        buttons: [{ label: "Try again", run: "retry", kind: "secondary" }],
      };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Replace the contents of `root` with the state's view. */
export function render(root: HTMLElement, state: PopupState, actions: PopupActions): void {
  const doc = root.ownerDocument;
  const copy = copyFor(state);
  const body = el(doc, "section", "body");
  body.dataset.state = state.kind;
  body.append(el(doc, "h1", "title", copy.title), el(doc, "p", "text", copy.text));
  if (copy.words) {
    // Two words a line (the popup is 320 px wide). The hidden " · " keeps textContent one line of four.
    const parts = copy.words.split(" · ");
    const w = el(doc, "p", "words");
    w.dataset.words = "";
    w.append(el(doc, "span", "pair", parts.slice(0, 2).join(" · ")), el(doc, "span", "sep", " · "), el(doc, "span", "pair", parts.slice(2).join(" · ")));
    body.append(w);
  }
  if (copy.message) {
    const m = el(doc, "p", "message", copy.message);
    m.setAttribute("role", "alert");
    body.append(m);
  }
  if (copy.buttons.length) {
    const row = el(doc, "div", "actions");
    for (const b of copy.buttons) {
      const btn = el(doc, "button", `btn ${b.kind}`, b.label);
      btn.type = "button";
      btn.addEventListener("click", () => actions[b.run]());
      row.append(btn);
    }
    body.append(row);
  }
  root.replaceChildren(body);
}
