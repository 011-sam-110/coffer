#!/usr/bin/env node
// Coffer's release flow (SPEC 3.12). Two steps, because the signing key's
// password is Sam's alone:
//
//   node scripts/release.mjs build      Claude (or anyone) runs it. It needs no
//       private key. It refuses unless plugins.updater.pubkey in
//       src-tauri/tauri.conf.json is a real key that matches
//       %USERPROFILE%\.tauri\coffer-updater.key.pub, then runs the release
//       build (about 15 minutes) and writes a build record next to the
//       installer.
//
//   node scripts/release.mjs publish [--notes "text" | --notes-file path]
//       Sam runs it in his own terminal. It asks for the key password in a
//       hidden prompt, signs the installer (`tauri signer sign`), checks the
//       signature against the public key, writes latest.json and creates a
//       full (not pre-release) GitHub release with both files. Every installed
//       Coffer then finds it within 6 hours. It prints only outcomes.
//
// Options for tests: build --debug (a debug build), --allow-dirty (uncommitted
// changes); publish --dry-run (sign and write latest.json, no GitHub release)
// and --url-base <url> (where latest.json says the installer is). The env
// COFFER_UPDATE_KEY moves the key pair, COFFER_UPDATE_KEY_PASSWORD gives the
// password, and TAURI_CONFIG is applied as `tauri build` applies it.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, fail, keyPath, loadConfig, promptHidden, pubkeyProblem, redact, root, sha256, tauriCli, verifySignature } from "./release-lib.mjs";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) fail(`${name} needs a value.`);
  return v;
};

function git(...a) {
  return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
}

function targetDir() {
  try {
    const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    return meta.target_directory;
  } catch {
    for (const dir of [root, join(root, "..")]) {
      try {
        const m = readFileSync(join(dir, ".cargo", "config.toml"), "utf8").match(/target-dir\s*=\s*"([^"]+)"/);
        if (m) return m[1];
      } catch {
        /* next */
      }
    }
    return join(root, "target");
  }
}

function versions(conf) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const cargo = readFileSync(join(root, "Cargo.toml"), "utf8").match(/\[workspace\.package\][^[]*?\nversion\s*=\s*"([^"]+)"/)?.[1];
  return { conf: conf.version, pkg, cargo };
}

function bundleDir(profile) {
  return join(targetDir(), profile, "bundle", "nsis");
}

function installerName(conf) {
  return `${conf.productName}_${conf.version}_x64-setup.exe`;
}

function common() {
  const conf = loadConfig();
  const problem = pubkeyProblem(conf, `${keyPath()}.pub`);
  if (problem) fail(`Refused: ${problem}`);
  if (!process.env.TAURI_CONFIG) {
    const v = versions(conf);
    if (v.pkg !== v.conf || v.cargo !== v.conf) fail(`Refused: the versions differ (tauri.conf.json ${v.conf}, package.json ${v.pkg}, Cargo.toml ${v.cargo}).`);
  }
  const profile = flag("--debug") ? "debug" : "release";
  return { conf, profile, dir: bundleDir(profile) };
}

function build() {
  const { conf, profile, dir } = common();
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty && !flag("--allow-dirty")) fail(`Refused: commit these changes first, so the release matches a commit:\n${dirty}`);
  const commit = git("rev-parse", "HEAD");
  console.log(`Building Coffer ${conf.version} (${profile}) from ${commit.slice(0, 7)}. A release build takes about 15 minutes.`);
  // The build needs no private key: signing is the publish step.
  const env = { ...process.env };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  // The CLI takes TAURI_CONFIG only as --config (a QA build's identity, version and key).
  const extra = process.env.TAURI_CONFIG ? ["--config", process.env.TAURI_CONFIG] : [];
  delete env.TAURI_CONFIG;
  const cliArgs = ["build", ...(profile === "debug" ? ["--debug"] : []), ...extra];
  const r = spawnSync(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...cliArgs], { cwd: root, stdio: "inherit", env });
  if (r.status !== 0) fail(`tauri build failed (exit ${r.status}).`);
  const installer = join(dir, installerName(conf));
  if (!existsSync(installer)) fail(`The build ran, but there is no installer at ${installer}.`);
  const record = {
    version: conf.version,
    productName: conf.productName,
    installer: installerName(conf),
    sha256: sha256(readFileSync(installer)),
    pubkeySha256: sha256(Buffer.from(String(conf.plugins.updater.pubkey).trim())),
    commit,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, `release-${conf.version}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Installer: ${installer}`);
  console.log(`SHA-256: ${record.sha256}`);
  console.log("Next: Sam runs  node scripts/release.mjs publish  in his own terminal.");
}

async function publish() {
  const { conf, dir } = common();
  const dryRun = flag("--dry-run");
  const installer = join(dir, installerName(conf));
  const recordPath = join(dir, `release-${conf.version}.json`);
  if (!existsSync(installer) || !existsSync(recordPath)) fail(`Refused: no build of ${conf.version} in ${dir}. Run node scripts/release.mjs build first.`);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const bytes = readFileSync(installer);
  if (record.version !== conf.version || record.sha256 !== sha256(bytes)) fail("Refused: the installer is not the one release.mjs build made. Build again.");
  if (record.pubkeySha256 !== sha256(Buffer.from(String(conf.plugins.updater.pubkey).trim()))) fail("Refused: the installer was built with another public key. Build again.");
  const tag = `v${conf.version}`;
  if (!dryRun) {
    if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) fail("Refused: gh is not signed in. Run gh auth login first.");
    if (spawnSync("gh", ["release", "view", tag, "--repo", REPO], { stdio: "ignore" }).status === 0) fail(`Refused: the release ${tag} exists already.`);
    if (spawnSync("git", ["branch", "-r", "--contains", record.commit], { cwd: root, encoding: "utf8" }).stdout.trim() === "") fail(`Refused: the build's commit ${record.commit.slice(0, 7)} is not on GitHub. Push it first.`);
  }
  const notesFile = option("--notes-file");
  const notes = notesFile ? readFileSync(notesFile, "utf8").trim() : (option("--notes") ?? `Coffer ${conf.version}`);

  let password;
  try {
    password = process.env.COFFER_UPDATE_KEY_PASSWORD ?? (await promptHidden("Password for the update signing key: "));
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  // --app-version puts the version into the signed comment; Coffer checks it (requireSignedVersion).
  const r = tauriCli(["signer", "sign", "--private-key-path", keyPath(), "--app-version", conf.version, installer], { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password });
  const shown = redact(`${r.stderr ?? ""}${r.stdout ?? ""}`, password).trim();
  password = "";
  const sigPath = `${installer}.sig`;
  if (r.status !== 0 || !existsSync(sigPath)) {
    if (shown) console.error(shown.split(/\r?\n/).filter((l) => /error|password|key/i.test(l)).slice(0, 3).join("\n"));
    fail("Signing failed. Check the password. Nothing was published.");
  }
  const signature = readFileSync(sigPath, "utf8").trim();
  try {
    const trusted = verifySignature(bytes, signature, conf.plugins.updater.pubkey);
    if (!trusted.includes(conf.version)) throw new Error(`the signed comment does not name ${conf.version}`);
  } catch (e) {
    fail(`Refused: the new signature does not check out against the built-in public key (${e instanceof Error ? e.message : e}). Nothing was published.`);
  }

  const base = option("--url-base") ?? `https://github.com/${REPO}/releases/download/${tag}/`;
  const latest = {
    version: conf.version,
    notes,
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: { "windows-x86_64": { signature, url: `${base.replace(/\/?$/, "/")}${installerName(conf)}` } },
  };
  const latestPath = join(dir, "latest.json");
  writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`Signed ${installerName(conf)}; the signature checks out against the built-in public key.`);
  if (dryRun) {
    console.log(`Dry run: wrote ${latestPath}. No GitHub release.`);
    return;
  }
  const notesPath = join(dir, `notes-${conf.version}.md`);
  writeFileSync(notesPath, `${notes}\n`);
  // A full release (no --prerelease, no --draft): releases/latest skips pre-releases.
  const gh = spawnSync("gh", ["release", "create", tag, installer, latestPath, "--repo", REPO, "--title", `Coffer ${conf.version}`, "--notes-file", notesPath, "--target", record.commit, "--latest"], {
    cwd: root,
    encoding: "utf8",
  });
  if (gh.status !== 0) fail(`gh release create failed: ${(gh.stderr || gh.stdout).trim()}`);
  console.log(`Published: ${gh.stdout.trim()}`);
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/latest/download/latest.json`, { redirect: "follow" });
    const live = res.ok ? await res.json() : null;
    console.log(live?.version === conf.version ? `latest.json on GitHub says ${conf.version}. Installed copies of Coffer find it within 6 hours.` : "GitHub does not serve the new latest.json yet. Check again in a minute.");
  } catch {
    console.log("Could not read latest.json back from GitHub. Check the release page.");
  }
}

if (command === "build") build();
else if (command === "publish") await publish();
else fail("Usage: node scripts/release.mjs build | publish [--notes \"text\" | --notes-file path]");
