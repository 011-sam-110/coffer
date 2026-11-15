// The release scripts' checks (SPEC 3.12), with a throwaway key pair made in
// a temp folder by the real `tauri signer` (never Sam's key).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBKEY_PLACEHOLDER, mergePatch, parsePublicKey, pubkeyProblem, redact, root, tauriCli, verifySignature } from "./release-lib.mjs";

const PW = "throwaway-test-password-1";
let dir;
let pub;
let otherPub;
const file = () => join(dir, "Coffer_9.9.9_x64-setup.exe");

function makeKey(out, password) {
  const r = spawnSync(process.execPath, [join(root, "scripts", "make-update-key.mjs"), "--out", out], {
    env: { ...process.env, COFFER_UPDATE_KEY_PASSWORD: password },
    encoding: "utf8",
  });
  return r;
}

function sign(path, keyFile, password, version = "9.9.9") {
  return tauriCli(["signer", "sign", "--private-key-path", keyFile, "--app-version", version, path], { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "coffer-release-test-"));
  const made = makeKey(join(dir, "k.key"), PW);
  expect(made.status).toBe(0);
  // It prints the public key path and the next step, never the password.
  expect(made.stdout).toContain(`Public key: ${join(dir, "k.key.pub")}`);
  expect(made.stdout + made.stderr).not.toContain(PW);
  pub = readFileSync(join(dir, "k.key.pub"), "utf8").trim();
  expect(makeKey(join(dir, "other.key"), PW).status).toBe(0);
  otherPub = readFileSync(join(dir, "other.key.pub"), "utf8").trim();
  writeFileSync(file(), Buffer.from("MZ pretend installer bytes"));
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("make-update-key", () => {
  it("refuses to overwrite a key", () => {
    const again = makeKey(join(dir, "k.key"), PW);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("A key is already at");
  });

  // The real key's password is typed into the Tauri CLI's own hidden prompt,
  // never passed on a command line. With no terminal there is no prompt: refuse.
  it("refuses the real (prompted) path without a terminal", () => {
    const env = { ...process.env };
    delete env.COFFER_UPDATE_KEY_PASSWORD;
    const r = spawnSync(process.execPath, [join(root, "scripts", "make-update-key.mjs"), "--out", join(dir, "prompted.key")], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Run this in a terminal");
    expect(existsSync(join(dir, "prompted.key"))).toBe(false);
  });
});

describe("public key checks", () => {
  it("the placeholder and junk are not keys", () => {
    expect(parsePublicKey(PUBKEY_PLACEHOLDER)).toBeNull();
    expect(parsePublicKey("")).toBeNull();
    expect(parsePublicKey("bm90IGEga2V5")).toBeNull();
    expect(parsePublicKey(pub)?.publicKey.length).toBe(32);
  });

  it("release.mjs build refuses unless the config key matches the .pub file", () => {
    const pubPath = join(dir, "k.key.pub");
    expect(pubkeyProblem({ plugins: { updater: { pubkey: PUBKEY_PLACEHOLDER } } }, pubPath)).toContain("still the placeholder");
    expect(pubkeyProblem({ plugins: { updater: { pubkey: "junk" } } }, pubPath)).toContain("not a minisign public key");
    expect(pubkeyProblem({ plugins: { updater: { pubkey: otherPub } } }, pubPath)).toContain("does not match");
    expect(pubkeyProblem({ plugins: { updater: { pubkey: pub } } }, join(dir, "missing.pub"))).toContain("no public key file");
    expect(pubkeyProblem({ plugins: { updater: { pubkey: pub } } }, pubPath)).toBeNull();
  });
});

describe("signatures", () => {
  it("a signature made with the key and its password checks out and names the version", () => {
    const r = sign(file(), join(dir, "k.key"), PW);
    expect(r.status).toBe(0);
    const sig = readFileSync(`${file()}.sig`, "utf8");
    expect(verifySignature(readFileSync(file()), sig, pub)).toContain("9.9.9");
  });

  it("refuses changed bytes, another key, and a wrong password", () => {
    expect(sign(file(), join(dir, "k.key"), PW).status).toBe(0);
    const sig = readFileSync(`${file()}.sig`, "utf8");
    expect(() => verifySignature(Buffer.from("MZ pretend installer byteZ"), sig, pub)).toThrow("does not match");
    expect(() => verifySignature(readFileSync(file()), sig, otherPub)).toThrow("another key");
    const wrong = sign(file(), join(dir, "k.key"), "not-the-password-at-all");
    expect(wrong.status).not.toBe(0);
    expect(redact(wrong.stderr + wrong.stdout, "not-the-password-at-all")).not.toContain("not-the-password-at-all");
  });
});

describe("helpers", () => {
  it("applies TAURI_CONFIG as a merge patch", () => {
    const conf = { version: "0.3.0", plugins: { updater: { pubkey: "a", endpoints: ["x"] } }, bundle: { active: true } };
    expect(mergePatch(conf, { version: "0.3.1", plugins: { updater: { pubkey: "b" } }, bundle: null })).toEqual({ version: "0.3.1", plugins: { updater: { pubkey: "b", endpoints: ["x"] } } });
  });

  it("redacts every copy of a secret", () => {
    expect(redact("pw=abc then abc", "abc")).toBe("pw=*** then ***");
    expect(redact("nothing", "")).toBe("nothing");
  });
});
