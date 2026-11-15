#!/usr/bin/env node
// Make Coffer's update signing key pair. Sam runs this ONCE, in his own terminal:
//
//   node scripts/make-update-key.mjs
//
// It runs `tauri signer generate`, and the Tauri CLI asks for the password in
// its own hidden prompt (twice). The password never goes on a command line,
// where other programs could read it. The private key goes to
// %USERPROFILE%\.tauri\coffer-updater.key, locked with that password, and the
// public key next to it (.pub). Nothing goes into the repo. It refuses to
// overwrite a key that is there. It prints only the public key path and the
// next step: never the password, never the private key.
//
// Tests only: --out <path> writes the pair somewhere else, and
// COFFER_UPDATE_KEY_PASSWORD gives a THROWAWAY password with no prompt (it then
// goes on the command line, so never use it for the real key).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, keyPath, redact, tauriCli } from "./release-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function outPath() {
  const i = process.argv.indexOf("--out");
  if (i === -1) return keyPath();
  const p = process.argv[i + 1];
  if (!p) fail("--out needs a path.");
  return resolve(p);
}

const out = outPath();
const pub = `${out}.pub`;
if (existsSync(out) || existsSync(pub)) {
  fail(`A key is already at ${out}. Coffer keeps it: installed copies trust only that key. Nothing was made.`);
}
mkdirSync(dirname(out), { recursive: true });

const testPassword = process.env.COFFER_UPDATE_KEY_PASSWORD;
if (testPassword !== undefined) {
  const r = tauriCli(["signer", "generate", "--write-keys", out, "--password", testPassword, "--ci"]);
  if (r.status !== 0 || !existsSync(out) || !existsSync(pub)) {
    console.error(redact(r.stderr || r.stdout, testPassword).trim());
    fail("tauri signer generate failed. Nothing usable was made.");
  }
} else {
  if (!process.stdin.isTTY) fail("Run this in a terminal: the Tauri CLI asks for the password in a hidden prompt.");
  console.log("The Tauri CLI now asks for a password, twice. Nothing shows while you type.");
  console.log("Use 12 characters or more. You type it again for each release. Without it no update can be signed.");
  const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (!existsSync(cli)) fail("The Tauri CLI is missing. Run pnpm install first.");
  const env = { ...process.env };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  delete env.CI;
  // stdio inherit: the CLI asks in its own hidden prompt. With --write-keys it prints only the two file paths, never the private key.
  const r = spawnSync(process.execPath, [cli, "signer", "generate", "--write-keys", out], { cwd: root, env, stdio: "inherit" });
  if (r.status !== 0 || !existsSync(out) || !existsSync(pub)) fail("tauri signer generate failed. Nothing usable was made.");
}

console.log(`Public key: ${pub}`);
console.log("Next: tell Claude \"key made\". The public key then goes into src-tauri/tauri.conf.json (plugins.updater.pubkey) for the 0.3.0 build.");
console.log("Keep the private key file and its password safe. Do not put them in the repo.");
