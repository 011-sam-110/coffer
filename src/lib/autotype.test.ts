import { describe, expect, it } from "vitest";
import { autotypeLabel, DEFAULT_AUTOTYPE, isDefaultSequence, parseAutotype } from "./autotype";
import { autotypeErrorText, helloErrorText, qrErrorText, rotateErrorText } from "./tier2Errors";
import { ERROR_CODES } from "./ipc";

describe("parseAutotype", () => {
  it("reads the default sequence", () => {
    expect(parseAutotype(DEFAULT_AUTOTYPE)).toEqual({ ok: true, tokens: [{ kind: "username" }, { kind: "tab" }, { kind: "password" }, { kind: "enter" }] });
  });
  it("reads every token, any case, with text between", () => {
    expect(parseAutotype("{username}x{TAB}{Delay 250}{TOTP}{FIELD: PIN code}{ENTER} done")).toEqual({
      ok: true,
      tokens: [
        { kind: "username" },
        { kind: "text", text: "x" },
        { kind: "tab" },
        { kind: "delay", ms: 250 },
        { kind: "totp" },
        { kind: "field", label: "PIN code" },
        { kind: "enter" },
        { kind: "text", text: " done" },
      ],
    });
  });
  it("gives Rust's messages for bad sequences", () => {
    expect(parseAutotype("{USERNAME")).toEqual({ ok: false, message: "An auto-type token is not closed: {USERNAME" });
    expect(parseAutotype("{SPACE}")).toEqual({ ok: false, message: "Coffer does not know the auto-type token {SPACE}." });
    expect(parseAutotype("{DELAY x}")).toEqual({ ok: false, message: "{DELAY x} needs a number of milliseconds." });
    expect(parseAutotype("{DELAY 20000}")).toEqual({ ok: false, message: "{DELAY 20000} is too long: at most 10000 ms." });
    expect(parseAutotype("{FIELD: }")).toEqual({ ok: false, message: "{FIELD:} needs a field name." });
  });
  it("names the action by the sequence", () => {
    expect(isDefaultSequence(null)).toBe(true);
    expect(isDefaultSequence(" {username}{tab}{password}{enter} ")).toBe(true);
    expect(autotypeLabel(null)).toBe("Type username + password");
    expect(autotypeLabel("{PASSWORD}{ENTER}")).toBe("Type sequence");
  });
});

describe("tier 2 error words", () => {
  it("has words for every error code, with no dash", () => {
    for (const code of ERROR_CODES) {
      for (const text of [
        helloErrorText({ code, message: "" }),
        autotypeErrorText({ code, message: "" }),
        qrErrorText({ code, message: "" }, "screen"),
        qrErrorText({ code, message: "" }, "file"),
        rotateErrorText({ code, message: "" }),
      ]) {
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/[–—]/);
      }
    }
  });
  it("shows the shell's reason for an auto-type refusal", () => {
    expect(autotypeErrorText({ code: "invalid", message: "Coffer cannot type into an app running as administrator." })).toBe("Coffer cannot type into an app running as administrator.");
    expect(helloErrorText({ code: "needsSecretKey", message: "x" })).toMatch(/Secret Key/);
    expect(rotateErrorText({ code: "badCredentials", message: "x" })).toBe("Wrong master password.");
  });
});
