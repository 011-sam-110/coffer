// Auto-type sequences (SPEC 10). The same grammar as the Rust parser in
// src-tauri/src/autotype.rs, so the editor can point at a bad token before a save.

/** The sequence Coffer types when an item has none of its own. */
export const DEFAULT_AUTOTYPE = "{USERNAME}{TAB}{PASSWORD}{ENTER}";
/** The longest {DELAY ms}. */
export const MAX_DELAY_MS = 10_000;

export type AutotypeToken =
  | { kind: "text"; text: string }
  | { kind: "username" }
  | { kind: "password" }
  | { kind: "totp" }
  | { kind: "tab" }
  | { kind: "enter" }
  | { kind: "delay"; ms: number }
  | { kind: "field"; label: string };

export type ParsedAutotype = { ok: true; tokens: AutotypeToken[] } | { ok: false; message: string };

/** Parse a sequence. Text outside braces is typed as it is. Messages match Rust's. */
export function parseAutotype(seq: string): ParsedAutotype {
  const tokens: AutotypeToken[] = [];
  let text = "";
  let rest = seq;
  for (;;) {
    const open = rest.indexOf("{");
    if (open < 0) break;
    text += rest.slice(0, open);
    const after = rest.slice(open + 1);
    const close = after.indexOf("}");
    if (close < 0) return { ok: false, message: `An auto-type token is not closed: {${after}` };
    const name = after.slice(0, close);
    if (text) {
      tokens.push({ kind: "text", text });
      text = "";
    }
    const upper = name.trim().toUpperCase();
    if (upper === "USERNAME") tokens.push({ kind: "username" });
    else if (upper === "PASSWORD") tokens.push({ kind: "password" });
    else if (upper === "TOTP") tokens.push({ kind: "totp" });
    else if (upper === "TAB") tokens.push({ kind: "tab" });
    else if (upper === "ENTER") tokens.push({ kind: "enter" });
    else if (upper.startsWith("DELAY ")) {
      const raw = upper.slice("DELAY ".length).trim();
      const ms = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isFinite(ms)) return { ok: false, message: `{${name}} needs a number of milliseconds.` };
      if (ms > MAX_DELAY_MS) return { ok: false, message: `{${name}} is too long: at most ${MAX_DELAY_MS} ms.` };
      tokens.push({ kind: "delay", ms });
    } else if (upper.startsWith("FIELD:")) {
      const label = name.trim().slice("FIELD:".length).trim();
      if (!label) return { ok: false, message: "{FIELD:} needs a field name." };
      tokens.push({ kind: "field", label });
    } else return { ok: false, message: `Coffer does not know the auto-type token {${name}}.` };
    rest = after.slice(close + 1);
  }
  text += rest;
  if (text) tokens.push({ kind: "text", text });
  return { ok: true, tokens };
}

/** True when the item types the default sequence (none of its own, or the same text). */
export function isDefaultSequence(seq: string | null | undefined): boolean {
  const s = (seq ?? "").replace(/\s+/g, "").toUpperCase();
  return s === "" || s === DEFAULT_AUTOTYPE;
}

/** The words on the Quick Access action that types the item's sequence (short: labels never truncate at 400 px; F1 has the long words). */
export function autotypeLabel(seq: string | null | undefined): string {
  return isDefaultSequence(seq) ? "Fill sign-in" : "Type sequence";
}
