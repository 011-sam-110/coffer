// The demo backend's browser bridge follows the contract (SPEC 3.13).
import { describe, expect, it } from "vitest";
import type { BridgeInfo, CofferError, Settings } from "../contract";
import type { Backend } from "../ipc";
import { createDemoBackend, DEMO_EXTENSION_FOLDER, DEMO_MASTER_PASSWORD, DEMO_PAIR_WORDS } from "./index";
import type { DemoBackendOptions } from "./index";

const mk = (o: Partial<DemoBackendOptions> = {}): Backend => createDemoBackend({ page: "main", startState: "unlocked", latencyMs: 0, search: "", ...o });
const call = async <T = unknown>(b: Backend, name: string, args: Record<string, unknown> = {}): Promise<T> => (await b.invoke(name, args)) as T;
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("demo browser bridge", () => {
  it("starts with Chrome connected and the extension folder", async () => {
    const info = await call<BridgeInfo>(mk(), "bridge_info");
    expect(info.browsers.map((b) => [b.browser, b.name])).toEqual([["chrome", "Chrome"]]);
    expect(info).toMatchObject({ extensionFolder: DEMO_EXTENSION_FOLDER, extensionFound: true, pending: null, reprompt: null });
    expect((await call<BridgeInfo>(mk({ bridge: "none" }), "bridge_info")).browsers).toEqual([]);
  });

  it("the Connect prompt: Allow adds the browser, Deny adds nothing, both close it with an event", async () => {
    const b = mk({ bridge: "pair" });
    const seen: BridgeInfo[] = [];
    b.listen("bridge://changed", (p) => seen.push(p as BridgeInfo));
    let info = await call<BridgeInfo>(b, "bridge_info");
    expect(info.pending?.words).toEqual(DEMO_PAIR_WORDS);
    info = await call<BridgeInfo>(b, "bridge_pair_answer", { pairId: info.pending!.pairId, allow: false });
    expect([info.pending, info.browsers.length]).toEqual([null, 0]);
    const gone = (await b.invoke("bridge_pair_answer", { pairId: "x", allow: true }).catch((e) => e)) as CofferError;
    expect(gone.code).toBe("notFound");

    expect(await call(b, "demo_simulate", { what: "pairRequest" })).toBe(true);
    info = await call<BridgeInfo>(b, "bridge_info");
    info = await call<BridgeInfo>(b, "bridge_pair_answer", { pairId: info.pending!.pairId, allow: true });
    expect(info.browsers.map((x) => x.name)).toEqual(["Chrome"]);
    await flush();
    expect(seen.at(-1)?.browsers).toHaveLength(1);
  });

  it("Disconnect removes a browser; Copy folder copies the path; the offers are settings", async () => {
    const b = mk();
    const id = (await call<BridgeInfo>(b, "bridge_info")).browsers[0].id;
    expect((await call<BridgeInfo>(b, "bridge_disconnect", { id })).browsers).toEqual([]);
    expect(((await b.invoke("bridge_disconnect", { id }).catch((e) => e)) as CofferError).code).toBe("notFound");
    await call(b, "bridge_copy_folder");
    expect(await call(b, "demo_clipboard")).toBe(DEMO_EXTENSION_FOLDER);
    const s = await call<Settings>(b, "settings_get");
    expect([s.offerSaveLogins, s.offerUpdatePasswords]).toEqual([true, true]);
    expect((await call<Settings>(b, "settings_set", { patch: { offerSaveLogins: false } })).offerSaveLogins).toBe(false);
  });

  it("a fill's master-password question: a wrong password keeps it open, the right one or Cancel closes it", async () => {
    const b = mk({ bridge: "reprompt" });
    let info = await call<BridgeInfo>(b, "bridge_info");
    expect(info.reprompt).toMatchObject({ name: "Chrome", title: "Northwind (work)", site: "northwind-shop.example" });
    const requestId = info.reprompt!.requestId;
    const wrong = (await b.invoke("bridge_reprompt_answer", { requestId, password: "nope" }).catch((e) => e)) as CofferError;
    expect(wrong.code).toBe("badCredentials");
    expect((await call<BridgeInfo>(b, "bridge_info")).reprompt?.requestId).toBe(requestId);
    info = await call<BridgeInfo>(b, "bridge_reprompt_answer", { requestId, password: DEMO_MASTER_PASSWORD });
    expect(info.reprompt).toBeNull();
    const gone = (await b.invoke("bridge_reprompt_answer", { requestId, password: null }).catch((e) => e)) as CofferError;
    expect(gone.code).toBe("notFound");
    const c = mk({ bridge: "reprompt" });
    expect((await call<BridgeInfo>(c, "bridge_reprompt_answer", { requestId, password: null })).reprompt).toBeNull();
  });
});
