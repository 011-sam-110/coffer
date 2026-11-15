// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PopupState } from "../lib/state";
import { pollMs } from "../lib/state";
import { copyFor, render } from "./view";

function draw(state: PopupState) {
  const root = document.createElement("main");
  const actions = { connect: vi.fn(), cancel: vi.fn(), unlock: vi.fn(), disconnect: vi.fn(), retry: vi.fn() };
  render(root, state, actions);
  const title = root.querySelector("h1")?.textContent;
  const buttons = [...root.querySelectorAll("button")].map((b) => b.textContent);
  return { root, actions, title, buttons };
}

describe("the toolbar popup", () => {
  it("Not connected: a Connect button", () => {
    const v = draw({ kind: "notConnected" });
    expect(v.title).toBe("Not connected");
    expect(v.buttons).toEqual(["Connect"]);
    v.root.querySelector("button")?.click();
    expect(v.actions.connect).toHaveBeenCalledOnce();
    expect(v.root.querySelector('[role="alert"]')).toBeNull();
  });

  it("After Connect: the same four words and Click Allow in Coffer", () => {
    const v = draw({ kind: "pairing", words: ["maple", "river", "otter", "lamp"] });
    expect(v.title).toBe("Click Allow in Coffer");
    expect(v.root.querySelector("[data-words]")?.textContent).toBe("maple · river · otter · lamp");
    expect(v.buttons).toEqual(["Cancel"]);
    expect(draw({ kind: "pairing", words: null }).title).toBe("Asking Coffer");
  });

  it("Connected, Coffer locked, Coffer not running", () => {
    const c = draw({ kind: "connected", version: "0.3.0" });
    expect([c.title, c.root.querySelector(".text")?.textContent]).toEqual(["Connected", "Coffer 0.3.0 fills and saves logins in this browser."]);
    const l = draw({ kind: "locked", version: "0.3.0" });
    expect([l.title, l.buttons]).toEqual(["Coffer is locked", ["Unlock Coffer"]]);
    l.root.querySelector("button")?.click();
    expect(l.actions.unlock).toHaveBeenCalledOnce();
    const n = draw({ kind: "notRunning" });
    expect([n.title, n.buttons]).toEqual(["Coffer is not running", ["Try again"]]);
    expect(draw({ kind: "notInstalled" }).title).toBe("Coffer is not set up");
  });

  it("shows why the last Connect failed, as text only", () => {
    const v = draw({ kind: "notConnected", message: "<b>You clicked Deny in Coffer.</b>" });
    const alert = v.root.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("<b>You clicked Deny in Coffer.</b>");
    expect(alert?.querySelector("b")).toBeNull();
  });

  it("asks again only while the state can change by itself", () => {
    expect(pollMs({ kind: "pairing", words: null })).toBeLessThan(1000);
    expect(pollMs({ kind: "connected", version: "1" })).toBe(1500);
    expect(pollMs({ kind: "locked", version: "1" })).toBe(1500);
    expect(pollMs({ kind: "notRunning" })).toBeNull();
    expect(pollMs({ kind: "notConnected" })).toBeNull();
    expect(copyFor({ kind: "checking" }).buttons).toEqual([]);
  });
});
