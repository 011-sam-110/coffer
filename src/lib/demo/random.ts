// Uniform randomness for the demo backend. Every draw comes from
// crypto.getRandomValues; randInt uses rejection sampling, so no value is more
// likely than another (no modulo bias).

const BUF = new Uint32Array(64);
let bufPos = BUF.length;

function nextU32(): number {
  if (bufPos >= BUF.length) {
    crypto.getRandomValues(BUF);
    bufPos = 0;
  }
  return BUF[bufPos++];
}

/** A uniform integer in [0, n). n must be 1..2^32. */
export function randInt(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError(`randInt: bad range ${n}`);
  if (n === 1) return 0;
  // Accept only draws below the largest multiple of n that fits in 2^32.
  const limit = Math.floor(0x100000000 / n) * n;
  for (;;) {
    const x = nextU32();
    if (x < limit) return x % n;
  }
}

/** One uniform character of `alphabet`. */
export function pick(alphabet: string): string {
  return alphabet[randInt(alphabet.length)];
}

/** Fisher-Yates shuffle in place with uniform swaps. */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A random version-4 UUID (no reliance on crypto.randomUUID). */
export function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A stable UUID-shaped id from a text seed (FNV-1a), so demo ids survive a reload. */
export function stableId(seed: string): string {
  const words: number[] = [];
  for (let k = 0; k < 4; k++) {
    let h = 0x811c9dc5 ^ (k * 0x9e3779b1);
    const s = `${k}:${seed}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    words.push(h >>> 0);
  }
  const h = words.map((w) => w.toString(16).padStart(8, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
