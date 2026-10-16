// Quick Access keys (SPEC 9) and the "Enter copies" table (SPEC 4). On a
// login, Enter fills the window you came from; Ctrl+C copies what Enter
// copied before.
import type { Field, ItemType, ItemView } from "./contract";
import { ITEM_TYPES } from "./itemTypes";

export type QuickKey =
  | "up"
  | "down"
  | "enter"
  | "copy"
  | "copyUsername"
  | "copyPassword"
  | "copyTotp"
  | "actions"
  | "openInCoffer"
  | "autotype"
  | "autotypePassword"
  | "escape"
  | "back";

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  /** The search caret is at the end of its text (Right arrow opens the action list only then). */
  caretAtEnd: boolean;
  /** Text is selected in the search: Ctrl+C copies that text, not the item. */
  hasSelection?: boolean;
}

/** Map one keydown to a Quick Access command, or null to let the field handle it. */
export function quickKey(e: KeyInput): QuickKey | null {
  if (e.altKey || e.metaKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.ctrlKey && !e.shiftKey) {
    if (k === "c") return e.hasSelection ? null : "copy";
    if (k === "u") return "copyUsername";
    if (k === "p") return "copyPassword";
    if (k === "t") return "copyTotp";
    if (k === "o") return "openInCoffer";
    if (k === "Enter") return "autotype";
    return null;
  }
  // Tier 2 auto-type: Ctrl+Shift+Enter types the password alone.
  if (e.ctrlKey) return k === "Enter" ? "autotypePassword" : null;
  switch (k) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Enter":
      return e.shiftKey ? null : "enter";
    case "ArrowRight":
      return e.caretAtEnd ? "actions" : null;
    case "ArrowLeft":
      return "back";
    case "Escape":
      return "escape";
    default:
      return null;
  }
}

export type EnterPlan = { kind: "copy"; role: string; fallbackRole: string | null; words: string } | { kind: "open" };

/** What Enter does for an item type (SPEC 4 table). */
export function enterPlan(type: ItemType): EnterPlan {
  const def = ITEM_TYPES[type];
  if (!def.enterCopies) return { kind: "open" };
  return { kind: "copy", role: def.enterCopies, fallbackRole: def.enterFallback, words: def.enterLabel ?? def.enterCopies };
}

/** A field "has a value" when it is masked (a stored secret) or its plain value is not empty. */
export function fieldHasValue(f: Field): boolean {
  return f.masked === true || f.value.trim() !== "";
}

export type CopyTarget = { ok: true; fieldId: string; label: string } | { ok: false; message: string };

/** Find the field a copy should use, by built-in role, with an optional fallback role. */
export function resolveCopyTarget(item: Pick<ItemView, "fields">, role: string, fallbackRole: string | null, words: string): CopyTarget {
  const find = (r: string) => item.fields.find((f) => f.builtin === r && fieldHasValue(f));
  const hit = find(role) ?? (fallbackRole ? find(fallbackRole) : undefined);
  if (hit) return { ok: true, fieldId: hit.id, label: hit.label };
  return { ok: false, message: `This item has no ${words}.` };
}

/** Words for the shortcut keys, used in "This item has no <field>". */
export const SHORTCUT_WORDS = { username: "username", password: "password", totp: "one-time code" } as const;

/** The hint under the selected Quick Access row: what Enter will do. */
export function enterHint(type: ItemType): string {
  const plan = enterPlan(type);
  return plan.kind === "open" ? "Enter opens in Coffer" : `Enter copies the ${plan.words}`;
}

/** The words on a selected row: what Enter does ("Password", "Public key", "Open"). */
export function enterWords(type: ItemType): string {
  const plan = enterPlan(type);
  if (plan.kind === "open") return "Open";
  return plan.words.charAt(0).toUpperCase() + plan.words.slice(1);
}

/** Enter fills logins (with a window to fill); every other type keeps Enter = copy or open. */
export function entersFill(type: ItemType, hasTarget: boolean): boolean {
  return type === "login" && hasTarget;
}

/** The order Quick Access walks a login in, one copy per open. */
export const COPY_CHAIN = ["username", "password", "totp"] as const;
export type ChainRole = (typeof COPY_CHAIN)[number];

/**
 * After a copy of `lastRole` from this item, the next field to copy: the first
 * later role in COPY_CHAIN that the item has a value for, or null at the end.
 */
export function nextChainField(item: Pick<ItemView, "fields">, lastRole: string | null): { role: ChainRole; fieldId: string; label: string } | null {
  const at = COPY_CHAIN.indexOf(lastRole as ChainRole);
  if (at < 0) return null;
  for (const role of COPY_CHAIN.slice(at + 1)) {
    const f = item.fields.find((x) => x.builtin === role && fieldHasValue(x));
    if (f) return { role, fieldId: f.id, label: f.label };
  }
  return null;
}

/** "261749" -> "261 749"; other lengths stay as they are. */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}
