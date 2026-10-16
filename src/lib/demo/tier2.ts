// Demo values for the tier 2 commands: a QR code result and an SSH key pair.
// The key pair has the real shape (ssh-ed25519 blob, SHA256 fingerprint) but
// random bytes: it is not a usable key.

export const DEMO_QR_URI = "otpauth://totp/Example:alex@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";

const b64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** An SSH wire string: a 4-byte big-endian length, then the bytes. */
function wire(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export async function demoSshKey(): Promise<{ privateKey: string; publicKey: string; fingerprint: string }> {
  const pub = crypto.getRandomValues(new Uint8Array(32));
  const blob = concat(wire(new TextEncoder().encode("ssh-ed25519")), wire(pub));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob as Uint8Array<ArrayBuffer>));
  const body = b64(concat(new TextEncoder().encode("openssh-key-v1\0"), crypto.getRandomValues(new Uint8Array(219))));
  const lines = body.match(/.{1,70}/g) ?? [];
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${b64(blob)}`,
    fingerprint: `SHA256:${b64(digest).replace(/=+$/, "")}`,
  };
}
