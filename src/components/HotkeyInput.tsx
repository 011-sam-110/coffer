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
    </div>
  );
}
