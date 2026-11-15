// Auto update (SPEC 3.12): the words Settings shows for an UpdateState.
import type { UpdateState } from "./contract";
import { relativeTime } from "./format";

/** The "ready" banner above Settings, or null when there is none. */
export interface UpdateBannerText {
  title: string;
  detail: string;
  /** Show "Restart now". */
  restart: boolean;
}

export function updateBanner(state: UpdateState | null, autoUpdate: boolean): UpdateBannerText | null {
  if (!state?.version) return null;
  if (state.phase === "ready") {
    return {
      title: `Coffer ${state.version} is ready.`,
      detail: autoUpdate ? "It installs the next time Coffer locks." : "It installs when you click Restart now.",
      restart: true,
    };
  }
  if (state.phase === "installing") {
    return { title: `Installing Coffer ${state.version}.`, detail: "Coffer restarts by itself, locked.", restart: false };
  }
  return null;
}

/** The second line of the "Coffer <version>" row. */
export function updateLine(state: UpdateState | null, now: number = Date.now()): string {
  if (!state) return "";
  const checked = state.checkedAt ? ` Checked ${relativeTime(state.checkedAt, now)}.` : "";
  switch (state.phase) {
    case "off":
      return state.error ?? "This build does not update.";
    case "checking":
      return "Checking GitHub for a new version...";
    case "downloading":
      return `Downloading Coffer ${state.version} and checking its signature...`;
    case "installing":
      return `Installing Coffer ${state.version}.`;
    case "ready":
      return `Version ${state.version} is downloaded and its signature checked.${state.error ? ` ${state.error}` : checked}`;
    case "idle":
      if (state.error) return state.checkedAt ? `${state.error} Last check that worked: ${relativeTime(state.checkedAt, now)}.` : state.error;
      return state.checkedAt ? `Coffer is up to date.${checked}` : "Coffer checks for a new version soon after it starts.";
  }
}

/** The description of "Install updates automatically". */
export function autoUpdateHint(autoUpdate: boolean): string {
  return autoUpdate
    ? "Coffer checks GitHub for a new version every 6 hours and checks its signature. The update installs the next time Coffer locks."
    : "Coffer still checks GitHub every 6 hours and shows a new version here. It installs only when you click Restart now.";
}

/** "Check now" can run. */
export function canCheck(state: UpdateState | null): boolean {
  return !!state && (state.phase === "idle" || state.phase === "ready");
}
