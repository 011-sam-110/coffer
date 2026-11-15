#!/usr/bin/env node
// Stage what the installer adds next to coffer.exe (SPEC 3.13) in
// bridge-stage/: coffer-bridge.exe and the built extension. The NSIS hooks
// (src-tauri/windows/hooks.nsh) copy them into the install folder and
// register the native messaging host.
//
// `tauri build` runs it as part of beforeBuildCommand. A debug build
// (TAURI_ENV_DEBUG=true) stages the debug bridge.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "bridge-stage");
const profile = process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env }, shell: false });
  if (r.status !== 0) {
    console.error(`stage-bridge: ${cmd} ${args.join(" ")} failed (exit ${r.status}).`);
    process.exit(1);
  }
}

function targetDir() {
  const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  return meta.target_directory;
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// The extension: type-check, then build into bridge-stage/extension.
run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "extension")]);
run(process.execPath, [join(root, "extension", "build.mjs")], { COFFER_EXTENSION_OUT: join(stage, "extension") });

// coffer-bridge.exe.
run("cargo", ["build", "-p", "coffer-bridge", ...(profile === "release" ? ["--release"] : [])]);
const exe = join(targetDir(), profile, "coffer-bridge.exe");
if (!existsSync(exe)) {
  console.error(`stage-bridge: ${exe} is not there after the build.`);
  process.exit(1);
}
copyFileSync(exe, join(stage, "coffer-bridge.exe"));
console.log(`stage-bridge: staged coffer-bridge.exe (${profile}) and the extension in ${stage}`);
