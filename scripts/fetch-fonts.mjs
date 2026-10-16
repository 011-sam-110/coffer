#!/usr/bin/env node
// Fetch the ITF-licensed fonts into public/fonts/itf/ (git-ignored).
//
// Licence rule (ITF Free Font License): the files may ship inside the app, but
// they must never be committed to the repo, which may become public. So the
// repo keeps only this script; `pnpm dev` and `pnpm build` run it first.
// It does nothing when the files are already there, and it never fails the
// build: without the files the CSS falls back to Segoe UI Variable.
//
// Source: the Fontshare kit zip https://api.fontshare.com/v2/fonts/download/<slug>
// Licence records: docs/font-licences.jsonl
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FONTS = [
  {
    slug: "switzer",
    dir: "public/fonts/itf/switzer",
    files: {
      "Switzer-Variable.woff2": "fonts/Switzer-Variable.woff2",
      "Switzer-VariableItalic.woff2": "fonts/Switzer-VariableItalic.woff2",
      "FFL.txt": "FFL.txt",
    },
  },
];

/** Read the entries of a zip held in memory (stored or deflated members only). */
function unzip(buf) {
  const out = new Map();
  // End of central directory: signature 0x06054b50, search from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
  }
  return out;
}

const base = (name) => name.split("/").pop();

async function fetchFont(font) {
  const targets = Object.values(font.files).map((rel) => join(root, font.dir, rel));
  if (targets.every((t) => existsSync(t))) {
    console.log(`fonts: ${font.slug} is in place`);
    return;
  }
  const url = `https://api.fontshare.com/v2/fonts/download/${font.slug}`;
  const res = await fetch(url, { headers: { "User-Agent": "coffer-fetch-fonts" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const zip = unzip(Buffer.from(await res.arrayBuffer()));
  for (const [member, rel] of Object.entries(font.files)) {
    const hit = [...zip.keys()].find((k) => base(k) === member);
    if (!hit) throw new Error(`${member} is not in the ${font.slug} kit`);
    const target = join(root, font.dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, zip.get(hit));
  }
  console.log(`fonts: fetched ${font.slug} into ${font.dir}`);
}

for (const font of FONTS) {
  try {
    await fetchFont(font);
  } catch (e) {
    console.warn(`fonts: could not fetch ${font.slug} (${e.message}). The UI falls back to Segoe UI Variable.`);
  }
}
