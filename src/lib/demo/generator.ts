// Password generator (SPEC 5): random, passphrase (EFF large word list) and PIN.
// Every choice uses randInt (crypto.getRandomValues + rejection sampling).
//
// Entropy is counted in the generator's own space:
// - random:     length * log2(pool size). This is an upper bound: the rule
//               "each chosen set at least once" removes a small part of the space.
// - passphrase: words * log2(7776), plus log2(10) for the digit and
//               log2(words) for the word that gets it when includeNumber is on.
// - pin:        length * log2(10).
import type { Generated, GeneratorOptions } from "../contract";
import wordlistRaw from "./eff_large_wordlist.txt?raw";
import { pick, randInt, shuffle } from "./random";

export const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const LOWER = "abcdefghijklmnopqrstuvwxyz";
export const DIGITS = "0123456789";
export const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?/";
export const AMBIGUOUS = "0O1lI|";

export const DEFAULT_OPTIONS: GeneratorOptions = {
  mode: "random",
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  minDigits: 1,
  minSymbols: 1,
  avoidAmbiguous: false,
  exclude: "",
  words: 5,
  separator: "-",
  capitalize: false,
  includeNumber: false,
};

let words: string[] | null = null;

/** The 7,776 words of the EFF large word list (CC BY 3.0 US). */
export function effWords(): string[] {
  if (!words) {
    words = wordlistRaw
      .split("\n")
      .map((line) => line.trim().split("\t")[1])
      .filter((w): w is string => !!w);
  }
  return words;
}

export class GeneratorError extends Error {}

const clamp = (n: number, lo: number, hi: number, dflt: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;

export function labelFor(bits: number): Generated["label"] {
  if (bits < 40) return "weak";
  if (bits < 60) return "fair";
  if (bits < 80) return "good";
  if (bits < 100) return "strong";
  return "excellent";
}

const result = (value: string, bits: number): Generated => ({
  value,
  entropyBits: Math.round(bits * 10) / 10,
  label: labelFor(bits),
});

function randomPassword(o: GeneratorOptions): Generated {
  const length = clamp(o.length, 8, 128, 20);
  const drop = new Set((o.avoidAmbiguous ? AMBIGUOUS : "") + (o.exclude ?? ""));
  const filter = (set: string) => [...set].filter((c) => !drop.has(c)).join("");
  const sets: Array<{ chars: string; min: number }> = [];
  if (o.upper) sets.push({ chars: filter(UPPER), min: 1 });
  if (o.lower) sets.push({ chars: filter(LOWER), min: 1 });
  if (o.digits) sets.push({ chars: filter(DIGITS), min: Math.max(1, clamp(o.minDigits, 0, 9, 1)) });
  if (o.symbols) sets.push({ chars: filter(SYMBOLS), min: Math.max(1, clamp(o.minSymbols, 0, 9, 1)) });
  if (sets.length === 0) throw new GeneratorError("Choose at least one set of characters.");
  const usable = sets.filter((s) => s.chars.length > 0);
  if (usable.length === 0) throw new GeneratorError("The exclude list removes every character.");
  const required = usable.reduce((n, s) => n + s.min, 0);
  if (required > length) throw new GeneratorError("The password is too short for the minimum digits and symbols.");
  const pool = usable.map((s) => s.chars).join("");
  const chars: string[] = [];
  for (const s of usable) for (let i = 0; i < s.min; i++) chars.push(pick(s.chars));
  while (chars.length < length) chars.push(pick(pool));
  return result(shuffle(chars).join(""), length * Math.log2(pool.length));
}

function passphrase(o: GeneratorOptions): Generated {
  const list = effWords();
  const count = clamp(o.words, 3, 20, 5);
  const chosen: string[] = [];
  for (let i = 0; i < count; i++) {
    const w = list[randInt(list.length)];
    chosen.push(o.capitalize ? w[0].toUpperCase() + w.slice(1) : w);
  }
  let bits = count * Math.log2(list.length);
  if (o.includeNumber) {
    const at = randInt(count);
    chosen[at] += DIGITS[randInt(10)];
    bits += Math.log2(10) + Math.log2(count);
  }
  return result(chosen.join(o.separator ?? "-"), bits);
}

function pin(o: GeneratorOptions): Generated {
  const length = clamp(o.length, 4, 12, 6);
  let value = "";
  for (let i = 0; i < length; i++) value += DIGITS[randInt(10)];
  return result(value, length * Math.log2(10));
}

/** Generate one value. Throws GeneratorError for options that cannot be met. */
export function generate(options: Partial<GeneratorOptions>): Generated {
  const o: GeneratorOptions = { ...DEFAULT_OPTIONS, ...options };
  if (o.mode === "passphrase") return passphrase(o);
  if (o.mode === "pin") return pin(o);
  return randomPassword(o);
}
