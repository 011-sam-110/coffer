// Password strength with the real zxcvbn-ts (English + common dictionaries).
import { zxcvbn, zxcvbnOptions } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as en from "@zxcvbn-ts/language-en";

let ready = false;

function init(): void {
  if (ready) return;
  zxcvbnOptions.setOptions({
    translations: en.translations,
    graphs: common.adjacencyGraphs,
    dictionary: { ...common.dictionary, ...en.dictionary },
  });
  ready = true;
}

export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  crackTime: string;
  warning: string | null;
}

const cache = new Map<string, Strength>();

/** zxcvbn score, the offline slow-hash crack time and the warning. Cached per input. */
export function strength(password: string, userInputs: string[] = []): Strength {
  const inputs = userInputs.map((s) => (s ?? "").trim()).filter(Boolean);
  const key = `${password}\u0000${inputs.join("\u0000")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  init();
  // SPEC 7: zxcvbn reads 100 characters at most.
  const r = zxcvbn(password.slice(0, 100), inputs);
  const out: Strength = {
    score: r.score,
    crackTime: r.crackTimesDisplay.offlineSlowHashing1e4PerSecond,
    warning: r.feedback.warning || null,
  };
  if (cache.size > 2000) cache.clear();
  cache.set(key, out);
  return out;
}
