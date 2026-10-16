// Plain words for the errors of the tier 2 commands. Rust's messages are
// plain sentences safe to show; each code still gets its own words when a
// message is empty, and a few codes need different words in the UI.
import type { CofferError } from "./contract";

const or = (e: CofferError, fallback: string): string => e.message.trim() || fallback;

/** vault_unlock_hello. tampered and olderFile go to their own screens in the main window. */
export function helloErrorText(e: CofferError): string {
  switch (e.code) {
    case "helloFailed":
      return or(e, "Windows Hello did not confirm it is you. Use your master password.");
    case "helloUnavailable":
      return or(e, "Windows Hello is not available now. Use your master password.");
    case "needsSecretKey":
      return "This PC has no Secret Key for this vault. Unlock with your master password and Secret Key.";
    case "vaultMissing":
      return or(e, "Coffer cannot find the vault file.");
    case "tampered":
      return "This vault file was changed outside Coffer. Open Coffer to restore a backup.";
    case "olderFile":
      return "This vault file is older than the one this PC last saw. Open Coffer to choose what to do.";
    case "corrupt":
      return or(e, "This file is not a readable Coffer vault.");
    case "kdfTooWeak":
    case "kdfTooStrong":
      return or(e, "This vault file asks for unsafe key settings, so Coffer did not open it.");
    default:
      return or(e, "Windows Hello did not unlock Coffer. Use your master password.");
  }
}

/** autotype. Rust sends every refusal (no target window, the window is gone, administrator, ...) as "invalid" with the reason. */
export function autotypeErrorText(e: CofferError): string {
  switch (e.code) {
    case "invalid":
      return or(e, "Coffer typed nothing.");
    case "notFound":
      return or(e, "This item has no value for that, so Coffer typed nothing.");
    case "locked":
      return "Coffer is locked. Unlock it, then try again. Coffer typed nothing.";
    case "badCredentials":
      return "Wrong master password. Coffer typed nothing.";
    case "repromptRequired":
      return "This item asks for your master password. Coffer typed nothing.";
    default:
      return or(e, "Coffer could not type. Check what was typed.");
  }
}

/** totp_from_image. */
export function qrErrorText(e: CofferError, source: "file" | "screen"): string {
  switch (e.code) {
    case "notFound":
      return or(e, source === "screen" ? "Coffer found no QR code on the screen." : "Coffer found no QR code in that image.");
    case "unsupportedFormat":
      return or(e, "Coffer cannot read this QR code or image.");
    case "invalid":
      return or(e, "The QR code is not a one-time code setup (otpauth://).");
    case "io":
      return or(e, source === "screen" ? "Coffer could not read the screen." : "Coffer could not read that file.");
    case "locked":
      return "Coffer is locked. Unlock it, then try again.";
    default:
      return or(e, "Coffer could not read a QR code.");
  }
}

/** secret_key_rotate. */
export function rotateErrorText(e: CofferError): string {
  switch (e.code) {
    case "badCredentials":
      return "Wrong master password.";
    case "conflict":
      return or(e, "Saving is paused, so Coffer did not change the Secret Key.");
    case "vaultMissing":
      return or(e, "The vault file is gone, so Coffer did not change the Secret Key.");
    case "locked":
      return "Coffer is locked. Unlock it, then try again.";
    default:
      return or(e, "Coffer could not change the Secret Key. Nothing changed.");
  }
}
