// The one door between the UI and the backend. In the Tauri app it uses
// invoke/listen; in a plain browser it loads the in-memory demo backend
// (src/lib/demo), and every screen then shows "DEMO DATA".
import type { Commands, CofferError, ErrorCode, Events, VaultState } from "./contract";

export type Args<K extends keyof Commands> = Commands[K][0];
export type Result<K extends keyof Commands> = Commands[K][1];

/** The shape both backends share. */
export interface Backend {
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (payload: unknown) => void): () => void;
}

export type PageKind = "main" | "quick";

export interface DemoOptions {
  page: PageKind;
  startState: VaultState;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** `?state=noVault|locked|unlocked|missing` picks the demo start state (default unlocked). */
export function demoStartState(search: string = typeof location === "undefined" ? "" : location.search): VaultState {
  const s = new URLSearchParams(search).get("state");
  return s === "noVault" || s === "locked" || s === "missing" || s === "unlocked" ? s : "unlocked";
}

export function currentPage(): PageKind {
  if (typeof location === "undefined") return "main";
  return /quick(\.html)?$/.test(location.pathname) ? "quick" : "main";
}

let backendPromise: Promise<Backend> | null = null;

function tauriBackend(): Promise<Backend> {
  return Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]).then(([core, event]) => ({
    invoke: (name, args) => core.invoke(name, args),
    listen: (name, handler) => {
      let stop: (() => void) | null = null;
      let cancelled = false;
      event
        .listen(name, (e) => handler(e.payload))
        .then((un) => {
          if (cancelled) un();
          else stop = un;
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  }));
}

function demoBackend(): Promise<Backend> {
  if (!__COFFER_DEMO__) return Promise.reject(new Error("This build has no demo backend; run it inside Coffer."));
  return import("./demo").then((m) => m.createDemoBackend({ page: currentPage(), startState: demoStartState() }));
}

export function backend(): Promise<Backend> {
  if (!backendPromise) backendPromise = isTauri() ? tauriBackend() : demoBackend();
  return backendPromise;
}

/** Test hook: use a given backend (for example a fresh demo backend). */
export function setBackend(b: Backend | null): void {
  backendPromise = b ? Promise.resolve(b) : null;
}

const CODES: ErrorCode[] = [
  "badCredentials",
  "needsSecretKey",
  "badSecretKey",
  "vaultMissing",
  "tampered",
  "corrupt",
  "kdfTooWeak",
  "locked",
  "notFound",
  "conflict",
  "repromptRequired",
  "weakPassword",
  "unsupportedFormat",
  "io",
  "invalid",
  "helloUnavailable",
  "helloFailed",
  "network",
];

/** Turn anything a backend throws into a CofferError. */
export function toCofferError(e: unknown): CofferError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const code = String((e as { code: unknown }).code) as ErrorCode;
    return { code: CODES.includes(code) ? code : "io", message: String((e as { message: unknown }).message) };
  }
  if (typeof e === "string") return { code: "io", message: e };
  if (e instanceof Error) return { code: "io", message: e.message };
  return { code: "io", message: "Something went wrong." };
}

export function isCofferError(e: unknown): e is CofferError {
  return !!e && typeof e === "object" && "code" in e && "message" in e;
}

type NoArgs<K extends keyof Commands> = Args<K> extends Record<string, never> ? true : false;

/** Call one command. Rejects with a CofferError. */
export async function call<K extends keyof Commands>(
  name: K,
  ...args: NoArgs<K> extends true ? [] | [Args<K>] : [Args<K>]
): Promise<Result<K>> {
  const b = await backend();
  try {
    return (await b.invoke(name, (args[0] ?? {}) as Record<string, unknown>)) as Result<K>;
  } catch (e) {
    throw toCofferError(e);
  }
}

/** Listen to one event. Returns the function that stops listening. */
export function on<E extends keyof Events>(event: E, handler: (payload: Events[E]) => void): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  backend().then((b) => {
    if (stopped) return;
    stop = b.listen(event, (p) => handler(p as Events[E]));
  });
  return () => {
    stopped = true;
    stop?.();
  };
}
