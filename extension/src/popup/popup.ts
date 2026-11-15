// The toolbar popup: asks the service worker for the state, draws it, and
// asks again while it can change on its own (connected, locked, pairing).
import { pollMs, type PopupRequest, type PopupState } from "../lib/state";
import { render } from "./view";

const root = document.getElementById("app") as HTMLElement;
let state: PopupState = { kind: "checking" };
let timer: ReturnType<typeof setTimeout> | undefined;
let asking = false;

function draw() {
  render(root, state, {
    connect: () => ask({ type: "coffer:connect" }),
    cancel: () => ask({ type: "coffer:cancel" }),
    unlock: () => ask({ type: "coffer:unlock" }),
    disconnect: () => ask({ type: "coffer:disconnect" }),
    retry: () => {
      state = { kind: "checking" };
      draw();
      void ask({ type: "coffer:state" });
    },
  });
}

async function ask(req: PopupRequest) {
  clearTimeout(timer);
  asking = true;
  try {
    state = await chrome.runtime.sendMessage<PopupState>(req);
  } catch (e) {
    state = { kind: "notRunning", message: e instanceof Error ? e.message : String(e) };
  } finally {
    asking = false;
  }
  draw();
  const ms = pollMs(state);
  if (ms !== null) timer = setTimeout(() => !asking && void ask({ type: "coffer:state" }), ms);
}

draw();
void ask({ type: "coffer:state" });
