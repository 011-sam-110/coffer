// Client-side checks for typing a Secret Key (SPEC 3.2). The real check (the
// check symbol) is secret_key_validate in Rust; this only flags a character
// that can never be in a Secret Key, at once, as the user types.
export const SECRET_KEY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";

/** Strip the "C1" version prefix, spaces and dashes; upper-case the rest. */
export function secretKeyBody(input: string): string {
  return input
    .trim()
    .replace(/^c1(?=[-\s]|$)/i, "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
}

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
