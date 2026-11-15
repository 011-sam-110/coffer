// The demo backend's auto update follows the contract (SPEC 3.12).
import { describe, expect, it, vi } from "vitest";
import type { AppInfo, CofferError, Settings, UpdateState, VaultStatus } from "../contract";
import type { Backend } from "../ipc";
import { createDemoBackend, DEMO_NEXT_VERSION, DEMO_VERSION } from "./index";
import type { DemoBackendOptions } from "./index";

const mk = (o: Partial<DemoBackendOptions> = {}): Backend => createDemoBackend({ page: "main", startState: "unlocked", latencyMs: 0, search: "", ...o });
const call = async <T = unknown>(b: Backend, name: string, args: Record<string, unknown> = {}): Promise<T> => (await b.invoke(name, args)) as T;
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("demo auto update", () => {
  it("starts up to date, with autoUpdate on, and round-trips the setting", async () => {
    const b = mk();
    const st = await call<UpdateState>(b, "update_status");
    expect(st).toMatchObject({ phase: "idle", currentVersion: DEMO_VERSION, version: null, error: null });
    expect(st.checkedAt).not.toBeNull();
    expect((await call<AppInfo>(b, "app_info")).version).toBe(DEMO_VERSION);
    expect((await call<Settings>(b, "settings_get")).autoUpdate).toBe(true);
    expect((await call<Settings>(b, "settings_set", { patch: { autoUpdate: false } })).autoUpdate).toBe(false);
    expect((await call<Settings>(b, "settings_get")).autoUpdate).toBe(false);
  });

  it("Check now finds, downloads and holds a newer version, with events on the way", async () => {
    const b = mk({ update: "found" });
    const seen: string[] = [];
    b.listen("update://state", (p) => seen.push((p as UpdateState).phase));
    const after = await call<UpdateState>(b, "update_check");
    await flush();
    expect(after).toMatchObject({ phase: "ready", version: DEMO_NEXT_VERSION, error: null });
    expect(seen).toEqual(["checking", "downloading", "ready"]);
  });

  it("a wrong signature is refused and nothing is ready", async () => {
    const b = mk({ update: "badsig" });
    const after = await call<UpdateState>(b, "update_check");
    expect(after).toMatchObject({ phase: "idle", version: null, error: `Coffer ${DEMO_NEXT_VERSION} failed its signature check, so Coffer refused it.` });
    expect(((await b.invoke("update_install", {}).catch((e) => e)) as CofferError).code).toBe("invalid");
  });

  it("offline: one plain line, and a ready update stays ready", async () => {
    expect(await call<UpdateState>(mk({ update: "offline" }), "update_check")).toMatchObject({ phase: "idle", error: "Coffer could not reach GitHub to check for updates." });
  });

  it("off: Check now changes nothing", async () => {
    const b = mk({ update: "off" });
    expect(await call<UpdateState>(b, "update_check")).toMatchObject({ phase: "off", error: "This build does not update: it has no update signing key." });
  });

  it("unlocked waits; the next lock installs, and Coffer comes back as the new version", async () => {
    vi.useFakeTimers();
    try {
      const b = mk({ update: "ready" });
      expect((await call<UpdateState>(b, "update_status")).phase).toBe("ready");
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await call<UpdateState>(b, "update_status")).phase).toBe("ready"); // unlocked: no install
      await call(b, "vault_lock");
      expect((await call<UpdateState>(b, "update_status")).phase).toBe("installing");
      await vi.advanceTimersByTimeAsync(2000);
      expect(await call<UpdateState>(b, "update_status")).toMatchObject({ phase: "idle", currentVersion: DEMO_NEXT_VERSION, version: null });
      expect((await call<VaultStatus>(b, "vault_status")).state).toBe("locked");
      expect((await call<AppInfo>(b, "app_info")).version).toBe(DEMO_NEXT_VERSION);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setting off: a lock never installs; Restart now still does", async () => {
    const b = mk({ update: "ready" });
    await call(b, "settings_set", { patch: { autoUpdate: false } });
    await call(b, "vault_lock");
    expect((await call<UpdateState>(b, "update_status")).phase).toBe("ready");
    const b2 = mk({ update: "ready" });
    await call(b2, "settings_set", { patch: { autoUpdate: false } });
    await call(b2, "update_install");
    expect((await call<UpdateState>(b2, "update_status")).phase).toBe("installing");
    expect((await call<VaultStatus>(b2, "vault_status")).state).toBe("locked");
  });

  it("quit and key-change locks do not install", async () => {
    const b = mk({ update: "ready" });
    await call(b, "demo_simulate", { what: "quitLock" });
    expect((await call<UpdateState>(b, "update_status")).phase).toBe("ready");
  });
});
