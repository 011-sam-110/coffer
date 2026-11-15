#!/usr/bin/env node
// Make Coffer's update signing key pair. Sam runs this ONCE, in his own terminal:
//
//   node scripts/make-update-key.mjs
//
// It asks for a password in a hidden prompt (twice), then runs
// `tauri signer generate`. The private key goes to
// %USERPROFILE%\.tauri\coffer-updater.key, locked with that password, and the
// public key next to it (.pub). Nothing goes into the repo. It refuses to
// overwrite a key that is there. It prints only the public key path and the
// next step: never the password, never the private key.
//
// Tests only: --out <path> writes the pair somewhere else, and
// COFFER_UPDATE_KEY_PASSWORD gives the password instead of the prompt.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fail, keyPath, promptHidden, redact, tauriCli } from "./release-lib.mjs";

const MIN_LENGTH = 12;

function outPath() {
  const i = process.argv.indexOf("--out");
  if (i === -1) return keyPath();
  const p = process.argv[i + 1];
  if (!p) fail("--out needs a path.");
  return resolve(p);
}

async function password() {
  const fromEnv = process.env.COFFER_UPDATE_KEY_PASSWORD;
  if (fromEnv !== undefined) return fromEnv;
  if (!process.stdin.isTTY) throw new Error("Run this in a terminal: it asks for the password in a hidden prompt.");
  console.log("The password locks the signing key. You type it again for each release. Without it no update can be signed.");
  const first = await promptHidden(`Password for the update signing key (${MIN_LENGTH} characters or more): `);
  const again = await promptHidden("Type it again: ");
  if (first !== again) fail("The two passwords are not the same. Nothing was made.");
  return first;
}

const out = outPath();
const pub = `${out}.pub`;
if (existsSync(out) || existsSync(pub)) {
  fail(`A key is already at ${out}. Coffer keeps it: installed copies trust only that key. Nothing was made.`);
}

let pw;
try {
  pw = await password();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
if (pw.length < MIN_LENGTH) fail(`Use ${MIN_LENGTH} characters or more. Nothing was made.`);

mkdirSync(dirname(out), { recursive: true });
const r = tauriCli(["signer", "generate", "--write-keys", out, "--password", pw, "--ci"]);
if (r.status !== 0 || !existsSync(out) || !existsSync(pub)) {
  console.error(redact(r.stderr || r.stdout, pw).trim());
  fail("tauri signer generate failed. Nothing usable was made.");
}
pw = "";

console.log(`Public key: ${pub}`);
console.log("Next: tell Claude \"key made\". The public key then goes into src-tauri/tauri.conf.json (plugins.updater.pubkey) for the 0.3.0 build.");
console.log("Keep the private key file and its password safe. Do not put them in the repo.");
