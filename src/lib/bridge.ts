// Words for Settings > Browsers and the Connect prompt (SPEC 3.13).
import type { BridgeInfo, BrowserLink, PairRequest } from "./contract";
import { formatDate, relativeTime } from "./format";

export interface BrowserRow {
  key: string;
  name: string;
  link: BrowserLink | null;
}

/**
 * The rows of "Connected browsers": each connected browser, and a "Not
 * connected" row for Chrome and for Microsoft Edge when neither is connected.
 */
export function browserRows(info: BridgeInfo | null): BrowserRow[] {
  const links = info?.browsers ?? [];
  const rows: BrowserRow[] = links.map((l) => ({ key: l.id, name: l.name, link: l }));
  for (const [browser, name] of [
    ["chrome", "Chrome"],
    ["edge", "Microsoft Edge"],
  ] as const) {
    if (!links.some((l) => l.browser === browser)) rows.push({ key: browser, name, link: null });
  }
  return rows;
}

/** "Connected on 15 Nov 2026. Last used 2 minutes ago." */
export function connectedLine(link: BrowserLink, now: number = Date.now()): string {
  const on = `Connected on ${formatDate(link.pairedAt)}.`;
  return link.lastUsedAt ? `${on} Last used ${relativeTime(link.lastUsedAt, now)}.` : on;
}

/** "maple · river · otter · lamp" */
export function pairWords(req: Pick<PairRequest, "words">): string {
  return req.words.join(" · ");
}
