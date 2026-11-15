// The menu's CSS, inside a closed shadow root: the page's CSS cannot reach
// it, and it cannot reach the page. Coffer's Red Dark tokens (a copy of
// src/styles/theme.css). "Coffer Switzer" is loaded from the extension by the
// content script; until it loads, Segoe UI shows.

/** The host element's own style (inline, !important: a page rule cannot move or hide it quietly). */
export const HOST_STYLE = [
  "all: initial",
  "position: fixed",
  "inset: 0 auto auto 0",
  "width: 0",
  "height: 0",
  "margin: 0",
  "padding: 0",
  "border: 0",
  "background: transparent",
  "overflow: visible",
  "display: block",
  "z-index: 2147483647",
  "pointer-events: none",
  "color-scheme: dark",
]
  .map((d) => `${d} !important`)
  .join("; ");

export const CSS = `
:host {
  --background: oklch(0.216 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.238 0 0);
  --primary: oklch(0.584 0.235 20.651);
  --primary-foreground: oklch(1 0 0);
  --primary-hover: oklch(0.62 0.235 20.651);
  --secondary: oklch(0.321 0 0);
  --accent: oklch(0.324 0.13 17.463);
  --muted-foreground: oklch(0.724 0 0);
  --border: oklch(0.321 0 0);
  --ring: oklch(0.584 0.235 20.651);
  --radius: 4px;
  --font-sans: "Coffer Switzer", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.cf {
  position: fixed;
  pointer-events: auto;
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: 14px;
  line-height: 1.4;
  letter-spacing: 0.01em;
  color: var(--foreground);
  text-align: left;
  -webkit-font-smoothing: antialiased;
}
.cf-btn {
  width: 24px;
  height: 24px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--radius);
  background: var(--primary);
  color: var(--primary-foreground);
  display: grid;
  place-items: center;
  font: 700 12px/1 var(--font-sans);
  cursor: pointer;
}
.cf-btn:hover { background: var(--primary-hover); }
.cf-menu {
  min-width: 260px;
  max-width: 420px;
  padding: 6px;
  display: grid;
  gap: 2px;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 10px 25px 0 hsl(0 0% 0% / 0.5);
}
.cf-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 6px 8px 8px;
  font-size: 12px;
  color: var(--muted-foreground);
}
.cf-k {
  font: 500 11px/1.5 var(--font-mono);
  letter-spacing: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 5px;
  color: var(--muted-foreground);
  white-space: nowrap;
}
.cf-list { display: grid; gap: 2px; max-height: 280px; overflow-y: auto; }
.cf-item {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 8px;
  border-radius: var(--radius);
  cursor: pointer;
}
.cf-item:hover { background: var(--secondary); }
.cf-item[aria-selected="true"] { background: var(--accent); }
.cf-av {
  width: 32px;
  height: 32px;
  border-radius: var(--radius);
  display: grid;
  place-items: center;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0;
}
.cf-t, .cf-s { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cf-t { font-size: 14px; font-weight: 600; }
.cf-s { font-size: 12.5px; color: var(--muted-foreground); }
.cf-line { padding: 4px 8px 8px; font-size: 13px; color: var(--muted-foreground); }
.cf-line b { color: var(--foreground); font-weight: 600; }
.cf-foot {
  border-top: 1px solid var(--border);
  margin-top: 4px;
  padding: 8px 8px 4px;
  font-size: 13px;
  color: var(--muted-foreground);
}
.cf-act {
  margin: 0 8px 8px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--radius);
  background: var(--primary);
  color: var(--primary-foreground);
  font: 500 14px/1 var(--font-sans);
  cursor: pointer;
  justify-self: start;
}
.cf-act:hover { background: var(--primary-hover); }
.cf-btn:focus-visible, .cf-act:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.cf-note {
  transform: translateX(-100%);
  padding: 8px 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 10px 25px 0 hsl(0 0% 0% / 0.5);
  font-size: 13px;
  white-space: nowrap;
}
`;
