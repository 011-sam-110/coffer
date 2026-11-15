// The Save bar (SPEC 3.13, M5), drawn into the overlay's closed shadow root:
// "Save this login in Coffer?", "Update password?", "Unlock Coffer to save",
// and a one-line result. Text goes in with textContent only. The password is
// never here: the bar shows a fixed row of dots.
import type { SaveAction, SaveView } from "../lib/save";

/** What the bar shows: Coffer's offer, or one line after a click. */
export type BarView = SaveView | { kind: "done"; text: string };

export interface BarActions {
  act(action: SaveAction, e: Event): void;
}

/** The same dots for every password: the bar gives away no length. */
export const MASK = "•".repeat(12);

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Draw the bar for a view. */
export function drawBar(bar: HTMLElement, view: BarView, actions: BarActions): void {
  const doc = bar.ownerDocument;
  bar.replaceChildren();
  bar.setAttribute("data-state", view.kind);
  const button = (text: string, action: SaveAction, primary = false) => {
    const b = el(doc, "button", primary ? "cf-b cf-b-p" : "cf-b", text);
    b.type = "button";
    b.tabIndex = -1;
    b.dataset.action = action;
    b.addEventListener("click", (e) => actions.act(action, e));
    return b;
  };
  const head = (title: string) => {
    const h = el(doc, "div", "cf-bar-head");
    h.append(el(doc, "span", "cf-bar-title", title));
    const x = button("×", "dismiss");
    x.className = "cf-x";
    x.setAttribute("aria-label", "Close");
    h.append(x);
    bar.append(h);
    bar.setAttribute("aria-label", title);
  };
  const facts = (rows: Array<[string, string]>) => {
    const g = el(doc, "div", "cf-facts");
    for (const [k, v] of rows) g.append(el(doc, "span", "cf-fk", k), el(doc, "span", v ? "cf-fv" : "cf-fv cf-none", v || "No username"));
    bar.append(g);
  };
  const row = (...buttons: HTMLButtonElement[]) => {
    const r = el(doc, "div", "cf-row");
    r.append(...buttons);
    bar.append(r);
  };
  switch (view.kind) {
    case "save":
      head("Save this login in Coffer?");
      facts([
        ["Name", view.site],
        ["Username", view.username],
        ["Password", MASK],
      ]);
      row(button("Never for this site", "never"), button("Save", "save", true));
      return;
    case "update":
      head("Update password?");
      facts([
        ["Login", view.title],
        ["Username", view.username],
        ["Password", MASK],
      ]);
      bar.append(el(doc, "div", "cf-bar-line", "The old password stays in the login's history."));
      row(button("Update", "update", true));
      return;
    case "locked":
      head("Unlock Coffer to save");
      bar.append(el(doc, "div", "cf-bar-line", "Coffer is locked. Unlock it, and Coffer saves this login."));
      row(button("Unlock Coffer", "unlock", true));
      return;
    case "saved":
      head(`Saved in Coffer as ${view.title}.`);
      return;
    case "done":
      head(view.text);
      return;
  }
}
