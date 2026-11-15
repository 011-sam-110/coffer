// What the toolbar popup shows, and what it asks the service worker.

export type PopupState =
  | { kind: "checking" }
  | { kind: "notConnected"; message?: string }
  | { kind: "pairing"; words: string[] | null }
  | { kind: "connected"; version: string }
  | { kind: "locked"; version: string }
  | { kind: "notRunning"; message?: string }
  | { kind: "notInstalled"; message?: string };

export type PopupRequest =
  | { type: "coffer:state" }
  | { type: "coffer:connect" }
  | { type: "coffer:cancel" }
  | { type: "coffer:unlock" }
  | { type: "coffer:disconnect" };

/** States in which the popup asks again every so often. */
export function pollMs(state: PopupState): number | null {
  switch (state.kind) {
    case "pairing":
      return 400;
    case "connected":
    case "locked":
      return 1500;
    default:
      return null;
  }
}
