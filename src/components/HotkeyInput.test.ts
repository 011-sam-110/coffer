import { describe, expect, it } from "vitest";
import { hotkeyClash } from "./HotkeyInput";

describe("hotkey clash warning", () => {
  it("warns when a hotkey takes Ctrl and one letter that apps use", () => {
    expect(hotkeyClash("Ctrl+P")).toBe("Ctrl+P is Print in most apps and Copy password in Quick Access. While Coffer holds it, no app gets it. Try Ctrl+Shift+Space.");
    expect(hotkeyClash("Ctrl+V")).toMatch(/^Ctrl\+V is Paste in most apps\./);
    expect(hotkeyClash("Ctrl+U")).toMatch(/^Ctrl\+U is Copy username in Quick Access\./);
    expect(hotkeyClash("Ctrl+K")).toMatch(/^Ctrl\+K is a shortcut in many apps\./);
  });
  it("says nothing for combos with a second modifier, or none set", () => {
    for (const ok of ["Ctrl+Shift+Space", "Ctrl+Alt+P", "Win+Alt+K", "Ctrl+Shift+L", "Ctrl+Space", null]) expect(hotkeyClash(ok)).toBeNull();
  });
});
