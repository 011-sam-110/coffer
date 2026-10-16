// Records a keyboard shortcut such as "Ctrl+Shift+Space".
import { useState } from "react";
import { ErrorText, Keys, cx } from "./ui";

const MOD_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

export function comboFromEvent(e: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }): string | null {
  if (MOD_KEYS.has(e.key)) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean) as string[];
  if (mods.length === 0 || (mods.length === 1 && mods[0] === "Shift")) return null; // a global hotkey needs Ctrl, Alt or Win
  let key = e.code === "Space" ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  return [...mods, key].join("+");
}

/** What Ctrl + a letter does in most apps. */
const APP_KEYS: Record<string, string> = {
  A: "Select all",
  B: "Bold",
  C: "Copy",
  D: "Bookmark",
  F: "Find",
  N: "New window",
  O: "Open",
  P: "Print",
  R: "Reload",
  S: "Save",
  T: "New tab",
  V: "Paste",
  W: "Close tab",
  X: "Cut",
  Y: "Redo",
  Z: "Undo",
};
/** Quick Access's own keys (they never reach Quick Access while a global hotkey takes them). */
const QUICK_KEYS: Record<string, string> = { C: "Copy", P: "Copy password", U: "Copy username", T: "Copy code", O: "Open in Coffer" };

/**
 * A warning when a global hotkey takes a key that apps or Quick Access use:
 * Windows gives the keys to Coffer, so no app sees them any more.
 */
export function hotkeyClash(combo: string | null): string | null {
  const m = combo?.match(/^Ctrl\+([A-Z0-9])$/);
  if (!m) return null;
  const key = m[1];
  const app = APP_KEYS[key];
  const quick = QUICK_KEYS[key];
  const what = [app && `${app} in most apps`, quick && `${quick} in Quick Access`].filter(Boolean).join(" and ") || "a shortcut in many apps";
  return `Ctrl+${key} is ${what}. While Coffer holds it, no app gets it. Try Ctrl+Shift+Space.`;
}

export function HotkeyInput({
  value,
  onChange,
  label,
  status,
}: {
  value: string | null;
  onChange: (combo: string) => void;
  label: string;
  status?: "ok" | "inUse" | "off";
}) {
  const [recording, setRecording] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-label={`${label}: ${value ?? "off"}. Press to change.`}
        data-hotkey-recording={recording || undefined}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") return setRecording(false);
          const combo = comboFromEvent(e);
          if (combo) {
            onChange(combo);
            setRecording(false);
          }
        }}
        className={cx("control flex h-8 min-w-[180px] cursor-pointer items-center justify-between gap-3 text-left", recording && "border-ring")}
      >
        {recording ? <span className="text-xs text-muted-foreground">Press the new keys. Esc cancels.</span> : value ? <Keys combo={value} /> : <span className="text-muted-foreground">Off</span>}
      </button>
      {status === "inUse" && <ErrorText alert={false}>In use by another app. Choose other keys.</ErrorText>}
      {status !== "inUse" && hotkeyClash(value) && <p className="max-w-[300px] text-xs text-gold">{hotkeyClash(value)}</p>}
    </div>
  );
}
