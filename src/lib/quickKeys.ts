// Quick Access keys (SPEC 9) and the "Enter copies" table (SPEC 4).
import type { Field, ItemType, ItemView } from "./contract";
import { ITEM_TYPES } from "./itemTypes";

export type QuickKey =
  | "up"
  | "down"
  | "enter"
  | "copyUsername"
  | "copyPassword"
  | "copyTotp"
  | "actions"
  | "openInCoffer"
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
}

/** Map one keydown to a Quick Access command, or null to let the field handle it. */
export function quickKey(e: KeyInput): QuickKey | null {
  if (e.altKey || e.metaKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.ctrlKey && !e.shiftKey) {
    if (k === "u") return "copyUsername";
    if (k === "p") return "copyPassword";
    if (k === "t") return "copyTotp";
    if (k === "o") return "openInCoffer";
    return null;
  }
  if (e.ctrlKey) return null;
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
