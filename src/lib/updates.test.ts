import { describe, expect, it } from "vitest";
import type { UpdateState } from "./contract";
import { autoUpdateHint, canCheck, updateBanner, updateLine } from "./updates";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const s = (o: Partial<UpdateState>): UpdateState => ({ phase: "idle", currentVersion: "0.3.0", version: null, checkedAt: null, error: null, ...o });

describe("update banner", () => {
  it("shows only for a ready or installing update", () => {
    expect(updateBanner(null, true)).toBeNull();
    expect(updateBanner(s({}), true)).toBeNull();
    expect(updateBanner(s({ phase: "downloading", version: "0.3.1" }), true)).toBeNull();
    expect(updateBanner(s({ phase: "off", error: "x" }), true)).toBeNull();
  });

  it("says when a ready update installs, with Restart now", () => {
    expect(updateBanner(s({ phase: "ready", version: "0.3.1" }), true)).toEqual({
      title: "Coffer 0.3.1 is ready.",
      detail: "It installs the next time Coffer locks.",
      restart: true,
    });
    // Setting off: it never installs by itself.
    expect(updateBanner(s({ phase: "ready", version: "0.3.1" }), false)).toMatchObject({ detail: "It installs when you click Restart now.", restart: true });
  });

  it("has no button while installing", () => {
    expect(updateBanner(s({ phase: "installing", version: "0.3.1" }), true)).toEqual({ title: "Installing Coffer 0.3.1.", detail: "Coffer restarts by itself, locked.", restart: false });
  });
});

describe("version line", () => {
  const checked = "2026-11-15T11:55:00Z";
  it("matches the mockup when an update is ready", () => {
    expect(updateLine(s({ phase: "ready", version: "0.3.1", checkedAt: checked }), NOW)).toBe("Version 0.3.1 is downloaded and its signature checked. Checked 5 minutes ago.");
  });

  it("covers each phase in one plain line", () => {
    expect(updateLine(null, NOW)).toBe("");
    expect(updateLine(s({ checkedAt: checked }), NOW)).toBe("Coffer is up to date. Checked 5 minutes ago.");
    expect(updateLine(s({}), NOW)).toBe("Coffer checks for a new version soon after it starts.");
    expect(updateLine(s({ phase: "checking" }), NOW)).toBe("Checking GitHub for a new version...");
    expect(updateLine(s({ phase: "downloading", version: "0.3.1" }), NOW)).toBe("Downloading Coffer 0.3.1 and checking its signature...");
    expect(updateLine(s({ phase: "installing", version: "0.3.1" }), NOW)).toBe("Installing Coffer 0.3.1.");
    expect(updateLine(s({ phase: "off", error: "This build does not update: it has no update signing key." }), NOW)).toBe(
      "This build does not update: it has no update signing key.",
    );
  });

  it("shows an error instead of the check time", () => {
    const offline = "Coffer could not reach GitHub to check for updates.";
    expect(updateLine(s({ error: offline }), NOW)).toBe(offline);
    expect(updateLine(s({ error: offline, checkedAt: "2026-11-15T09:00:00Z" }), NOW)).toBe(`${offline} Last check that worked: 3 hours ago.`);
    const refused = "Coffer 0.3.2 failed its signature check, so Coffer refused it.";
    expect(updateLine(s({ phase: "ready", version: "0.3.1", error: refused, checkedAt: checked }), NOW)).toBe(`Version 0.3.1 is downloaded and its signature checked. ${refused}`);
  });
});

describe("controls", () => {
  it("Check now runs only when nothing else is going on", () => {
    expect(canCheck(null)).toBe(false);
    expect(canCheck(s({}))).toBe(true);
    expect(canCheck(s({ phase: "ready", version: "0.3.1" }))).toBe(true);
    for (const phase of ["off", "checking", "downloading", "installing"] as const) expect(canCheck(s({ phase }))).toBe(false);
  });

  it("the switch says what off means", () => {
    expect(autoUpdateHint(true)).toContain("installs the next time Coffer locks");
    expect(autoUpdateHint(false)).toContain("only when you click Restart now");
  });
});
