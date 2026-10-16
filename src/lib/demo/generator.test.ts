import { describe, expect, it } from "vitest";
import type { GeneratorOptions } from "../contract";
import { AMBIGUOUS, DEFAULT_OPTIONS, DIGITS, GeneratorError, LOWER, SYMBOLS, UPPER, effWords, generate, labelFor } from "./generator";
import { randInt } from "./random";

const opts = (o: Partial<GeneratorOptions>): GeneratorOptions => ({ ...DEFAULT_OPTIONS, ...o });
const count = (s: string, set: string) => [...s].filter((c) => set.includes(c)).length;

describe("generator: random", () => {
  it("makes the asked length, clamped to 8..128", () => {
    for (const length of [8, 20, 64, 128]) expect(generate(opts({ length })).value).toHaveLength(length);
    expect(generate(opts({ length: 3 })).value).toHaveLength(8);
    expect(generate(opts({ length: 500 })).value).toHaveLength(128);
  });

  it("puts every chosen set in at least once and nothing else", () => {
    for (let n = 0; n < 200; n++) {
      const v = generate(opts({ length: 8 })).value;
      expect(count(v, UPPER)).toBeGreaterThan(0);
      expect(count(v, LOWER)).toBeGreaterThan(0);
      expect(count(v, DIGITS)).toBeGreaterThan(0);
      expect(count(v, SYMBOLS)).toBeGreaterThan(0);
      expect(count(v, UPPER + LOWER + DIGITS + SYMBOLS)).toBe(8);
    }
    const lettersOnly = generate(opts({ digits: false, symbols: false, length: 40 })).value;
    expect(count(lettersOnly, DIGITS + SYMBOLS)).toBe(0);
  });

  it("meets minimum digits and symbols", () => {
    for (let n = 0; n < 100; n++) {
      const v = generate(opts({ length: 12, minDigits: 4, minSymbols: 3 })).value;
      expect(count(v, DIGITS)).toBeGreaterThanOrEqual(4);
      expect(count(v, SYMBOLS)).toBeGreaterThanOrEqual(3);
    }
  });

  it("avoids look-alike characters and the exclude list", () => {
    for (let n = 0; n < 100; n++) {
      const v = generate(opts({ length: 128, avoidAmbiguous: true, exclude: "xyz#" })).value;
      for (const c of AMBIGUOUS + "xyz#") expect(v).not.toContain(c);
    }
  });

  it("counts entropy as length * log2(pool)", () => {
    // 26 + 26 + 10 + 24 = 86 symbols
    expect(SYMBOLS).toHaveLength(24);
    const g = generate(opts({ length: 20 }));
    expect(g.entropyBits).toBeCloseTo(20 * Math.log2(86), 1);
    expect(g.label).toBe("excellent");
    // avoidAmbiguous drops 0 O 1 l I: pool 81
    expect(generate(opts({ length: 10, avoidAmbiguous: true })).entropyBits).toBeCloseTo(10 * Math.log2(81), 1);
    expect(generate(opts({ length: 8, upper: false, digits: false, symbols: false })).entropyBits).toBeCloseTo(8 * Math.log2(26), 1);
  });

  it("refuses options that cannot be met", () => {
    expect(() => generate(opts({ upper: false, lower: false, digits: false, symbols: false }))).toThrow(GeneratorError);
    expect(() => generate(opts({ upper: false, lower: false, symbols: false, exclude: DIGITS }))).toThrow(GeneratorError);
    expect(() => generate(opts({ length: 8, minDigits: 5, minSymbols: 5 }))).toThrow(GeneratorError);
  });
});

describe("generator: passphrase and PIN", () => {
  it("loads the 7,776-word EFF list", () => {
    const words = effWords();
    expect(words).toHaveLength(7776);
    expect(words[0]).toBe("abacus");
    expect(words[7775]).toBe("zoom");
  });

  it("makes the asked number of list words with the separator", () => {
    const list = new Set(effWords());
    for (const words of [3, 5, 20]) {
      const g = generate(opts({ mode: "passphrase", words, separator: "." }));
      const parts = g.value.split(".");
      expect(parts).toHaveLength(words);
      for (const p of parts) expect(list.has(p)).toBe(true);
      expect(g.entropyBits).toBeCloseTo(words * Math.log2(7776), 1);
    }
    expect(generate(opts({ mode: "passphrase", words: 1 })).value.split("-")).toHaveLength(3);
  });

  it("capitalises and adds one digit to one word", () => {
    for (let n = 0; n < 50; n++) {
      const g = generate(opts({ mode: "passphrase", words: 4, separator: " ", capitalize: true, includeNumber: true }));
      const parts = g.value.split(" ");
      expect(parts).toHaveLength(4);
      for (const p of parts) expect(p[0]).toMatch(/[A-Z]/);
      expect(count(g.value, DIGITS)).toBe(1);
      expect(parts.filter((p) => /\d$/.test(p))).toHaveLength(1);
      expect(g.entropyBits).toBeCloseTo(4 * Math.log2(7776) + Math.log2(10) + Math.log2(4), 1);
    }
  });

  it("makes PINs of 4..12 digits", () => {
    for (const length of [4, 6, 12]) {
      const g = generate(opts({ mode: "pin", length }));
      expect(g.value).toMatch(new RegExp(`^\\d{${length}}$`));
      expect(g.entropyBits).toBeCloseTo(length * Math.log2(10), 1);
    }
    expect(generate(opts({ mode: "pin", length: 20 })).value).toHaveLength(12);
    expect(generate(opts({ mode: "pin", length: 6 })).label).toBe("weak");
  });

  it("labels entropy by the SPEC bands", () => {
    expect([39.9, 40, 59.9, 60, 79.9, 80, 99.9, 100].map(labelFor)).toEqual(["weak", "fair", "fair", "good", "good", "strong", "strong", "excellent"]);
  });

  it("draws uniformly (rough check)", () => {
    const seen = new Array(7).fill(0);
    for (let n = 0; n < 7000; n++) seen[randInt(7)]++;
    for (const c of seen) expect(c).toBeGreaterThan(800);
    expect(() => randInt(0)).toThrow();
  });
});
