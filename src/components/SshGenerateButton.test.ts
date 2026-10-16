import { describe, expect, it } from "vitest";
import { newItemForm } from "../lib/itemForm";
import { formHasSshKey, withSshKey } from "./SshGenerateButton";

describe("SSH key generation in the editor", () => {
  const pair = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n", publicKey: "ssh-ed25519 AAAAC3", fingerprint: "SHA256:abc" };

  it("fills the three key fields and leaves the passphrase", () => {
    const f = withSshKey(newItemForm("sshKey", "Server"), pair);
    const by = (role: string) => f.fields.find((x) => x.builtin === role)?.value;
    expect(by("privateKey")).toBe(pair.privateKey);
    expect(by("publicKey")).toBe(pair.publicKey);
    expect(by("fingerprint")).toBe(pair.fingerprint);
    expect(by("passphrase")).toBe("");
  });

  it("asks before it replaces a key: a typed one or a stored one", () => {
    const empty = newItemForm("sshKey", "Server");
    expect(formHasSshKey(empty)).toBe(false);
    expect(formHasSshKey(withSshKey(empty, pair))).toBe(true);
    const stored = { ...empty, fields: empty.fields.map((x) => (x.builtin === "privateKey" ? { ...x, value: null, hasStored: true } : x)) };
    expect(formHasSshKey(stored)).toBe(true);
  });
});
