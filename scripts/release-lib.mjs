// Shared parts of scripts/make-update-key.mjs and scripts/release.mjs:
// a hidden password prompt, the Tauri CLI, the config, and a minisign check
// of an update signature (the same check Coffer's updater makes).
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = "011-sam-110/coffer";
export const TAURI_CONF = join(root, "src-tauri", "tauri.conf.json");
/** The value in tauri.conf.json until Sam makes the key (src-tauri/src/updates.rs PUBKEY_PLACEHOLDER). */
export const PUBKEY_PLACEHOLDER = "NOT-SET-run-scripts-make-update-key-mjs-then-paste-coffer-updater-key-pub-here";

/** `%USERPROFILE%\.tauri\coffer-updater.key`; `COFFER_UPDATE_KEY` moves it (tests only). */
export function keyPath() {
  return process.env.COFFER_UPDATE_KEY || join(process.env.USERPROFILE || homedir(), ".tauri", "coffer-updater.key");
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Read a line from the terminal with no echo. Refuses when stdin is not a terminal. */
export function promptHidden(question) {
  return new Promise((resolvePrompt, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("Run this in a terminal: it asks for the password in a hidden prompt."));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = [];
    const done = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolvePrompt(value.join(""));
      value = [];
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Cancelled."));
        if (ch === "\u001b") return; // an arrow or function key: drop the rest of its sequence
        if (ch === "\u007f" || ch === "\b") {
          value.pop();
          continue;
        }
        if (ch < " ") continue;
        value.push(ch);
      }
    };
    stdin.on("data", onData);
  });
}

/** The Tauri CLI as a child process, its output captured (never printed: it can hold the password). */
export function tauriCli(args, env = {}) {
  const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (!existsSync(cli)) fail("The Tauri CLI is missing. Run pnpm install first.");
  const childEnv = { ...process.env, ...env };
  // A key in the environment would override the file the script names.
  delete childEnv.TAURI_SIGNING_PRIVATE_KEY;
  if (!("TAURI_SIGNING_PRIVATE_KEY_PASSWORD" in env)) delete childEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env: childEnv, encoding: "utf8", windowsHide: true });
}

/** Remove every copy of `secret` from text before it is shown. */
export function redact(text, secret) {
  return secret ? String(text ?? "").split(secret).join("***") : String(text ?? "");
}

/** RFC 7396 merge patch, as Tauri applies `TAURI_CONFIG`. */
export function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/** tauri.conf.json with `TAURI_CONFIG` applied: the config `tauri build` uses. */
export function loadConfig() {
  let conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  if (process.env.TAURI_CONFIG) conf = mergePatch(conf, JSON.parse(process.env.TAURI_CONFIG));
  return conf;
}

/** A minisign public key as `tauri signer generate` writes it (base64 of two lines). */
export function parsePublicKey(text) {
  const key = String(text ?? "").trim();
  if (!key || key === PUBKEY_PLACEHOLDER) return null;
  let lines;
  try {
    lines = Buffer.from(key, "base64").toString("utf8").split(/\r?\n/);
  } catch {
    return null;
  }
  if (!lines[0]?.startsWith("untrusted comment:") || !lines[1]) return null;
  const raw = Buffer.from(lines[1].trim(), "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") return null;
  return { keyId: raw.subarray(2, 10), publicKey: raw.subarray(10, 42) };
}

/** Why the config's pubkey is not ready for a release, or null when it matches the key pair's .pub file. */
export function pubkeyProblem(conf, pubPath) {
  const configured = conf?.plugins?.updater?.pubkey;
  if (!configured || configured === PUBKEY_PLACEHOLDER) return "plugins.updater.pubkey in src-tauri/tauri.conf.json is still the placeholder. Sam runs node scripts/make-update-key.mjs, then the public key goes there.";
  if (!parsePublicKey(configured)) return "plugins.updater.pubkey in src-tauri/tauri.conf.json is not a minisign public key.";
  if (!existsSync(pubPath)) return `There is no public key file at ${pubPath}.`;
  if (readFileSync(pubPath, "utf8").trim() !== String(configured).trim()) return `plugins.updater.pubkey does not match ${pubPath}. Coffer would refuse every update signed with that key.`;
  return null;
}

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Check a Tauri update signature (the base64 text of a .sig file) for `bytes`
 * against a public key (the base64 text of a .pub file). Returns the trusted
 * comment, or throws with the reason.
 */
export function verifySignature(bytes, signatureB64, pubkeyB64) {
  const pub = parsePublicKey(pubkeyB64);
  if (!pub) throw new Error("not a public key");
  const lines = Buffer.from(String(signatureB64).trim(), "base64").toString("utf8").split(/\r?\n/);
  if (!lines[0]?.startsWith("untrusted comment:") || !lines[2]?.startsWith("trusted comment: ")) throw new Error("not a minisign signature");
  const sig = Buffer.from(lines[1].trim(), "base64");
  const global = Buffer.from(String(lines[3] ?? "").trim(), "base64");
  if (sig.length !== 74 || global.length !== 64) throw new Error("bad signature length");
  const alg = sig.subarray(0, 2).toString("latin1");
  if (!sig.subarray(2, 10).equals(pub.keyId)) throw new Error("signed with another key");
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub.publicKey]), format: "der", type: "spki" });
  const message = alg === "ED" ? createHash("blake2b512").update(bytes).digest() : alg === "Ed" ? Buffer.from(bytes) : null;
  if (!message) throw new Error(`unknown signature algorithm ${alg}`);
  if (!verify(null, message, key, sig.subarray(10, 74))) throw new Error("the signature does not match the file");
  const trusted = lines[2].slice("trusted comment: ".length);
  if (!verify(null, Buffer.concat([sig.subarray(10, 74), Buffer.from(trusted, "utf8")]), key, global)) throw new Error("the trusted comment was changed");
  return trusted;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
