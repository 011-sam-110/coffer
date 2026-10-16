// View preferences that only change how this window looks (not vault data, not
// Settings). They live in this PC's WebView storage; a missing or blocked store
// falls back to the default.
import { useCallback, useSyncExternalStore } from "react";

export type ListDensity = "comfortable" | "compact";

const KEY = "coffer.listDensity";
const EVENT = "coffer:prefs";

function read(): ListDensity {
  try {
    return localStorage.getItem(KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** The item list's row density: comfortable (two lines, 52 px) or compact (one line, 30 px). */
export function useListDensity(): [ListDensity, (d: ListDensity) => void] {
  // read() returns a string, so the snapshot is stable between changes.
  const density = useSyncExternalStore(subscribe, read, () => "comfortable" as ListDensity);
  const set = useCallback((d: ListDensity) => {
    try {
      localStorage.setItem(KEY, d);
    } catch {
      /* stays at the default */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [density, set];
}
