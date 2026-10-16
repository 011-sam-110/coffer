import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, toCofferError } from "./ipc";

// The ErrorCode union as written in the contract file (the source of truth).
function contractCodes(): string[] {
  // Line comments go first: they may hold ";" or quotes.
  const src = readFileSync(join(import.meta.dirname, "contract.ts"), "utf-8").replace(/\/\/.*$/gm, "");
  const m = /export type ErrorCode =([\s\S]*?);/.exec(src);
  if (!m) throw new Error("ErrorCode not found in contract.ts");
  return [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]);
}

describe("error codes", () => {
  it("knows every ErrorCode of the contract, and no other", () => {
    expect([...ERROR_CODES].sort()).toEqual(contractCodes().sort());
  });
  it("keeps a known code and turns an unknown one into io", () => {
    expect(toCofferError({ code: "olderFile", message: "m" }).code).toBe("olderFile");
    expect(toCofferError({ code: "exists", message: "m" }).code).toBe("exists");
    expect(toCofferError({ code: "kdfTooStrong", message: "m" }).code).toBe("kdfTooStrong");
    expect(toCofferError({ code: "nope", message: "m" }).code).toBe("io");
  });
});
