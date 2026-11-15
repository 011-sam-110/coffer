import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeError, type Link, type Pairing, Session } from "./client";
import { b64, bridgeKey, confirmOf, hex, newKeyPair, parseWordList, sharedSecret, signBody, transcript, unb64, verifyBody, wordsOf } from "./protocol";

const words = parseWordList(
  readFileSync(join(import.meta.dirname, "../../../crates/coffer-core/data/eff_large_wordlist.txt"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.split("\t")[1] ?? "")
    .join("\n"),
);

type Msg = Record<string, unknown>;

/** A Coffer that follows docs/BRIDGE.md, in memory. */
class FakeCoffer implements Link {
  closed = false;
  nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  lastSeq = 0;
  locked = false;
  answer: "allow" | "deny" = "allow";
  tamper = false;
  words: string[] = [];
  key: Uint8Array<ArrayBuffer> | null = null;
  client = "";
  private nextId = 1;

  async request(build: (id: number) => Msg | Promise<Msg>): Promise<Msg> {
    const msg = await build(this.nextId++);
    return this.handle(msg);
  }
  close() {
    this.closed = true;
  }

  private async handle(m: Msg): Promise<Msg> {
    const id = m.id;
    if (typeof m.mac === "string") return this.signed(m);
    const args = (m.args ?? {}) as Msg;
    if (m.call === "hello") return { id, ok: true, result: { protocol: 1, version: "0.3.0", paired: !!this.key && args.client === this.client, locked: this.locked, nonce: this.nonce } };
    if (m.call === "pair") {
      const ours = await newKeyPair();
      const ext = unb64(String(args.pub));
      const clientBytes = crypto.getRandomValues(new Uint8Array(16));
      this.client = hex(clientBytes);
      const t = await transcript(ext, ours.pub, clientBytes);
      this.words = wordsOf(t, words);
      this.pendingKey = await bridgeKey(await sharedSecret(ours.privateKey, ext), t);
      this.pendingConfirm = await confirmOf(this.pendingKey, t);
      return { id, ok: true, result: { pairId: "p1", pub: b64(ours.pub), client: this.client } };
    }
    if (m.call === "pair_result") {
      if (this.answer === "deny") return { id, error: "denied", message: "You clicked Deny in Coffer." };
      this.key = this.pendingKey;
      return { id, ok: true, result: { paired: true, confirm: this.pendingConfirm } };
    }
    return { id, error: "bad_mac", message: "This call needs a MAC." };
  }
  private pendingKey: Uint8Array<ArrayBuffer> | null = null;
  private pendingConfirm = "";

  private async signed(m: Msg): Promise<Msg> {
    const id = m.id;
    if (!this.key || m.client !== this.client) return { id, error: "not_paired", message: "Connect again." };
    const body = String(m.body);
    if (!(await verifyBody(this.key, "req", this.client, body, String(m.mac)))) return { id, error: "bad_mac", message: "wrong MAC" };
    const b = JSON.parse(body) as { call: string; nonce: string; seq: number };
    if (b.nonce !== this.nonce || b.seq <= this.lastSeq) return { id, error: "replay", message: "replay" };
    this.lastSeq = b.seq;
    const answer =
      b.call === "status"
        ? { seq: b.seq, nonce: b.nonce, ok: true, result: { version: "0.3.0", locked: this.locked, offerSave: true, offerUpdate: true } }
        : this.locked
          ? { seq: b.seq, nonce: b.nonce, error: "locked", message: "Coffer is locked." }
          : { seq: b.seq, nonce: b.nonce, error: "unknown_call", message: "no" };
    const text = JSON.stringify(answer);
    const mac = await signBody(this.key, "res", this.client, text);
    return { id, body: this.tamper ? text.replace('"locked":false', '"locked":true') : text, mac };
  }
}

function setup() {
  const coffer = new FakeCoffer();
  let stored: Pairing | null = null;
  const session = new Session({
    open: async () => coffer,
    browser: "chrome",
    version: "0.3.0",
    load: async () => stored,
    save: async (p) => {
      stored = p;
    },
    words: async () => words,
  });
  return { coffer, session, stored: () => stored };
}

describe("Session", () => {
  it("connects: shows Coffer's four words, keeps the key, then signs calls", async () => {
    const { coffer, session, stored } = setup();
    let shown: string[] = [];
    await session.pair((w) => (shown = w));
    expect(shown).toHaveLength(4);
    expect(shown).toEqual(coffer.words);
    expect(stored()?.client).toBe(coffer.client);
    expect(stored()?.key).toBe(b64(coffer.key!));
    const status = await session.call<{ locked: boolean }>("status");
    expect(status.locked).toBe(false);
    // Each call takes the next number: Coffer saw 1, then 2.
    await session.call("status");
    expect(coffer.lastSeq).toBe(2);
  });

  it("stores nothing after Deny", async () => {
    const { coffer, session, stored } = setup();
    coffer.answer = "deny";
    await expect(session.pair(() => undefined)).rejects.toMatchObject({ code: "denied" });
    expect(stored()).toBeNull();
  });

  it("refuses an answer whose MAC does not check out", async () => {
    const { coffer, session } = setup();
    await session.pair(() => undefined);
    coffer.tamper = true;
    await expect(session.call("status")).rejects.toMatchObject({ code: "bad_mac" });
  });

  it("passes Coffer's errors on: locked, and not paired", async () => {
    const { coffer, session } = setup();
    await expect(session.call("status")).rejects.toMatchObject({ code: "not_paired" });
    await session.pair(() => undefined);
    coffer.locked = true;
    await expect(session.call("list_logins", { site: "example.com" })).rejects.toBeInstanceOf(BridgeError);
    await expect(session.call("list_logins", { site: "example.com" })).rejects.toMatchObject({ code: "locked" });
    coffer.key = null;
    await expect(session.call("status")).rejects.toMatchObject({ code: "not_paired" });
  });
});
