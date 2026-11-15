import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  b64,
  bridgeKey,
  browserKind,
  confirmOf,
  hex,
  hostName,
  newerVersion,
  newKeyPair,
  parseWordList,
  sharedSecret,
  signBody,
  signedRequest,
  transcript,
  unb64,
  unhex,
  verifyBody,
  wordsOf,
} from "./protocol";

const words = parseWordList(
  readFileSync(join(import.meta.dirname, "../../../crates/coffer-core/data/eff_large_wordlist.txt"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.split("\t")[1] ?? "")
    .join("\n"),
);

// The same vector as src-tauri/src/bridge/pairing.rs (known_answers_match_the_extension);
// the expected values were computed with Node's crypto module, a third implementation.
const ext = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const coffer = Uint8Array.from({ length: 32 }, (_, i) => i + 33);
const client = Uint8Array.from({ length: 16 }, (_, i) => i + 0xa0);
const shared = new Uint8Array(32).fill(0x55);

describe("pairing", () => {
  it("matches Coffer's known answers", async () => {
    const t = await transcript(ext, coffer, client);
    expect(hex(t)).toBe("403f25b566c39a84e4c3854b9350fbafba43c0d561c2bb00c5889edfa26471bc");
    expect(wordsOf(t, words)).toEqual(["encroach", "avenging", "grinning", "handmade"]);
    const key = await bridgeKey(shared, t);
    expect(hex(key)).toBe("4e38f02533065b48ddcf1b2b370d7ba7e41ef03ae5d4054ad797f0b6f1fbb04f");
    expect(await confirmOf(key, t)).toBe("368XgU0cfrNmG0yZBWDV1pR6ThLa9tNy2R/O6BzIlO0=");
  });

  it("gives both X25519 sides the same secret, words and key", async () => {
    const a = await newKeyPair();
    const b = await newKeyPair();
    expect(a.pub).toHaveLength(32);
    const sa = await sharedSecret(a.privateKey, b.pub);
    const sb = await sharedSecret(b.privateKey, a.pub);
    expect(hex(sa)).toBe(hex(sb));
    const t = await transcript(a.pub, b.pub, client);
    expect(wordsOf(t, words)).toHaveLength(4);
    expect(hex(await bridgeKey(sa, t))).toBe(hex(await bridgeKey(sb, t)));
    // Another key on one side: other words.
    const c = await newKeyPair();
    expect(wordsOf(await transcript(c.pub, b.pub, client), words)).not.toEqual(wordsOf(t, words));
  });

  it("refuses a word list that is not the EFF large list", () => {
    expect(() => wordsOf(new Uint8Array(32), ["a", "b"])).toThrow();
    expect(words).toHaveLength(7776);
  });
});

describe("signed messages", () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i);
  const id = hex(client);

  it("matches Coffer's MAC for a request", async () => {
    const t = await transcript(ext, coffer, client);
    const k = await bridgeKey(shared, t);
    const body = JSON.stringify({ call: "status", args: {}, nonce: "AAECAwQFBgcICQoLDA0ODw==", seq: 1 });
    expect(await signBody(k, "req", id, body)).toBe("kAiI6NZ4lvAsuc9DDp/yfDHJ21vYloEXGZY5k4wlQbA=");
    const env = await signedRequest(k, id, 7, "status", {}, "AAECAwQFBgcICQoLDA0ODw==", 1);
    expect(env).toEqual({ id: 7, client: id, body, mac: "kAiI6NZ4lvAsuc9DDp/yfDHJ21vYloEXGZY5k4wlQbA=" });
  });

  it("accepts the right MAC and refuses a wrong key, a changed body, the other label or junk", async () => {
    const body = '{"seq":3,"nonce":"x","ok":true,"result":{"locked":false}}';
    const mac = await signBody(key, "res", id, body);
    expect(await verifyBody(key, "res", id, body, mac)).toBe(true);
    expect(await verifyBody(new Uint8Array(32), "res", id, body, mac)).toBe(false);
    expect(await verifyBody(key, "res", id, body.replace("false", "true"), mac)).toBe(false);
    expect(await verifyBody(key, "req", id, body, mac)).toBe(false);
    expect(await verifyBody(key, "res", "f".repeat(32), body, mac)).toBe(false);
    expect(await verifyBody(key, "res", id, body, "not base64!")).toBe(false);
    expect(await verifyBody(key, "res", id, body, "")).toBe(false);
  });
});

describe("helpers", () => {
  it("round-trips base64 and hex", () => {
    const bytes = Uint8Array.from([0, 1, 254, 255, 128]);
    expect(Array.from(unb64(b64(bytes)))).toEqual(Array.from(bytes));
    expect(Array.from(unhex(hex(bytes)))).toEqual(Array.from(bytes));
    expect(() => unhex("ABCD")).toThrow();
  });

  it("compares versions", () => {
    expect(newerVersion("0.4.0", "0.3.0")).toBe(true);
    expect(newerVersion("0.3.10", "0.3.9")).toBe(true);
    expect(newerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(newerVersion("0.3.0", "0.3.0")).toBe(false);
    expect(newerVersion("0.2.9", "0.3.0")).toBe(false);
  });

  it("names the browser from its brands", () => {
    expect(browserKind([{ brand: "Not)A;Brand" }, { brand: "Chromium" }, { brand: "Google Chrome" }])).toBe("chrome");
    expect(browserKind([{ brand: "Chromium" }, { brand: "Microsoft Edge" }])).toBe("edge");
    expect(browserKind([{ brand: "Chromium" }])).toBe("chromium");
    expect(browserKind(undefined)).toBe("other");
  });

  it("reads host.json, or falls back to Coffer's host", () => {
    expect(hostName({ host: "dev.sampo.coffer.qa3" })).toBe("dev.sampo.coffer.qa3");
    expect(hostName({ host: "Bad Name" })).toBe("dev.sampo.coffer");
    expect(hostName(null)).toBe("dev.sampo.coffer");
  });
});
