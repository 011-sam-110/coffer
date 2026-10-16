// Client-side checks for typing a Secret Key (SPEC 3.2). The real check (the
// check symbol) is secret_key_validate in Rust; this only flags a character
// that can never be in a Secret Key, at once, as the user types.
export const SECRET_KEY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";

/** Strip the "C1" version prefix, spaces and dashes; upper-case the rest. ("1" is not in the alphabet, so a glued "C1" is the prefix.) */
export function secretKeyBody(input: string): string {
  return input
    .replace(/[\s-]+/g, "")
    .toUpperCase()
    .replace(/^C1/, "");
}

/** Symbols per group after "C1" (core secret_key.rs: C1-AAAAAA-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXK). */
export const SECRET_KEY_GROUPS = [6, 6, 6, 5, 5, 5];
const SECRET_KEY_LENGTH = SECRET_KEY_GROUPS.reduce((a, b) => a + b, 0);

/**
 * The key in the form Rust reads: "C1-" and the groups. The user may type spaces,
 * hyphens, lower case, and leave out "C1". A key of the wrong length goes as
 * "C1-" plus its symbols, so Rust's message counts them.
 */
export function normalizeSecretKey(input: string): string {
  const body = secretKeyBody(input);
  if (body.length !== SECRET_KEY_LENGTH) return `C1-${body}`;
  let at = 0;
  return ["C1", ...SECRET_KEY_GROUPS.map((n) => body.slice(at, (at += n)))].join("-");
}

/** The last group of a key (the one the kit check asks for). */
export function lastSecretKeyGroup(key: string): string {
  return secretKeyBody(key).slice(-SECRET_KEY_GROUPS[SECRET_KEY_GROUPS.length - 1]);
}

/** Under every Secret Key field. */
export const SECRET_KEY_INPUT_HINT = "Spaces, hyphens, lower case and a missing C1 are fine.";

/** The first character that is not in the alphabet, or null. Input ignores case, spaces and dashes. */
export function badSecretKeyChar(input: string): string | null {
  for (const ch of secretKeyBody(input)) if (!SECRET_KEY_ALPHABET.includes(ch)) return ch;
  return null;
}

export function secretKeyCharMessage(input: string): string | null {
  const ch = badSecretKeyChar(input);
  if (!ch) return null;
  const hint = ch === "0" || ch === "O" ? " (0 and O are never used)" : ch === "1" || ch === "I" ? " (1 and I are never used)" : "";
  return `This character is not in a Secret Key: ${ch}${hint}.`;
}
