import { createContext, useContext, useEffect, useRef } from "react";
import type { ItemType } from "../../lib/contract";

export type Filter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "type"; type: ItemType }
  | { kind: "tag"; tag: string }
  | { kind: "archive" }
  | { kind: "trash" };

export type View = "items" | "generator" | "health" | "settings" | "import";
export type HealthTab = "breached" | "reused" | "weak" | "unsecured" | "old" | "expiring" | "duplicate" | "excluded";
export type SettingsTab = "general" | "security" | "vault" | "shortcuts" | "about";

export interface Nav {
  view: View;
  filter: Filter;
  itemId: string | null;
  /** "new" makes a new item of newType; "edit" edits itemId. */
  editing: "new" | "edit" | null;
  newType: ItemType;
  newTitle?: string;
  /** Open the editor with the generator on the password field ("Change password"). */
  withGenerator?: boolean;
  settingsTab: SettingsTab;
  /** The Health tab to open (a flag chip in the list links to it). */
  healthTab?: HealthTab;
}

export const filterKey = (f: Filter): string =>
  f.kind === "type" ? `type:${f.type}` : f.kind === "tag" ? `tag:${f.tag}` : f.kind;

/** Main-window commands that the keyboard map (SPEC 9) can trigger. */
export type KeyAction = "search" | "newItem" | "edit" | "save" | "cancel" | "copyUsername" | "copyPassword" | "copyTotp" | "reveal" | "delete";

export type KeyHandlers = Partial<Record<KeyAction, () => void>>;

export const KeysContext = createContext<{ register: (owner: string, get: () => KeyHandlers) => () => void }>({
  register: () => () => undefined,
});

/** Register key handlers for as long as the component is mounted. */
export function useKeyHandlers(owner: string, handlers: KeyHandlers) {
  const { register } = useContext(KeysContext);
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => register(owner, () => ref.current), [owner, register]);
}

/** True when focus is in a place where typing goes (input, textarea, editable). */
export function inTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const t = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "range", "button", "submit"].includes(t);
  }
  return (el as HTMLElement).isContentEditable;
}

/** The open edit, for the lock and quit notices (mirrors what edit_state tells Rust). */
export const editInfo: { title: string | null; dirty: boolean } = { title: null, dirty: false };
