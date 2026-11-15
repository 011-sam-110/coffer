// @vitest-environment jsdom
// Which fields are sign-in fields, on fixture pages, and the fill's events.
import { beforeEach, describe, expect, it } from "vitest";
import { fieldKind, firstLoginFields, isVisible, loginFields } from "./fields";
import { fillLogin, setValue } from "./fill";
import { fakeMeasure } from "./testMeasure";

function page(html: string) {
  document.body.innerHTML = html;
  const $ = <T extends Element = HTMLInputElement>(sel: string) => document.querySelector(sel) as unknown as T;
  return $;
}

const kind = (el: Element | null) => fieldKind(el, fakeMeasure);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("sign-in fields", () => {
  it("a classic form: the email and the password box, not the search box above it", () => {
    const $ = page(`
      <form role="search"><input type="search" name="q" id="q" placeholder="Search the shop"></form>
      <form id="signin" action="/session">
        <label for="email">Email</label><input id="email" type="email" autocomplete="username">
        <label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password">
        <button>Sign in</button>
      </form>`);
    expect(kind($("#email"))).toBe("username");
    expect(kind($("#pw"))).toBe("password");
    expect(kind($("#q"))).toBeNull();
    expect(loginFields($("#email"), fakeMeasure)).toEqual({ username: $("#email"), password: $("#pw") });
    expect(loginFields($("#pw"), fakeMeasure)).toEqual({ username: $("#email"), password: $("#pw") });
  });

  it("a form with no <form> and a plain text username box", () => {
    const $ = page(`
      <div><input id="user" name="login"><input id="pw" type="password"><button>Log in</button></div>`);
    expect(kind($("#user"))).toBe("username");
    expect(loginFields($("#pw"), fakeMeasure).username).toBe($("#user"));
  });

  it("an identifier-first page: one email box and Next", () => {
    const $ = page(`<form><input id="id" type="email" autocomplete="username"><button>Next</button></form>`);
    expect(kind($("#id"))).toBe("username");
    expect(loginFields($("#id"), fakeMeasure)).toEqual({ username: $("#id"), password: null });
    const $2 = page(`<form action="/login"><label for="e">Email or phone</label><input id="e" name="identifier"><button>Next</button></form>`);
    expect(kind($2("#e"))).toBe("username");
  });

  it("a password-only page", () => {
    const $ = page(`<form><p>alex@example.com</p><input id="pw" type="password"><button>Sign in</button></form>`);
    expect(kind($("#pw"))).toBe("password");
    expect(loginFields($("#pw"), fakeMeasure)).toEqual({ username: null, password: $("#pw") });
  });

  it("a search box, a newsletter box and a plain text box get no button", () => {
    const $ = page(`
      <header><input id="s1" type="search" placeholder="Search"></header>
      <div role="search"><input id="s2" type="text" name="query"></div>
      <input id="s3" name="q">
      <form><input id="news" type="email" placeholder="Your email"><button>Subscribe</button></form>
      <form><input id="city" name="city"><button>Next</button></form>
      <form><textarea id="t"></textarea></form>`);
    for (const id of ["s1", "s2", "s3", "news", "city", "t"]) expect(kind($(`#${id}`)), id).toBeNull();
    expect(firstLoginFields(document, fakeMeasure)).toBeNull();
  });

  it("a sign-up form (two new passwords) is not a sign-in form; a change form fills only the current password", () => {
    const $ = page(`<form><input id="u" autocomplete="username"><input id="a" type="password" autocomplete="new-password"><input id="b" type="password" autocomplete="new-password"></form>`);
    expect(kind($("#a"))).toBeNull();
    expect(kind($("#b"))).toBeNull();
    const $2 = page(`<form><input id="c" type="password" autocomplete="current-password"><input id="n" type="password" autocomplete="new-password"></form>`);
    expect(kind($2("#c"))).toBe("password");
    expect(kind($2("#n"))).toBeNull();
  });

  it("hidden decoy boxes are never sign-in fields and never filled", () => {
    const $ = page(`
      <style>.gone { display: none }</style>
      <form>
        <input id="u" autocomplete="username">
        <input id="d1" type="password" class="gone">
        <input id="d2" type="password" style="position:absolute; left:-9999px">
        <input id="d3" type="password" style="opacity:0">
        <input id="d4" type="password" style="width:1px; height:1px">
        <div aria-hidden="true"><input id="d5" type="password"></div>
        <div style="visibility:hidden"><input id="d6" type="password"></div>
        <input id="d7" type="password" hidden>
        <input id="d8" type="hidden" name="password">
        <input id="pw" type="password">
        <button>Sign in</button>
      </form>`);
    for (const id of ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"]) {
      expect(isVisible($(`#${id}`), fakeMeasure), id).toBe(false);
      expect(kind($(`#${id}`)), id).toBeNull();
    }
    const fields = loginFields($("#u"), fakeMeasure);
    expect(fields).toEqual({ username: $("#u"), password: $("#pw") });
    fillLogin(fields, { username: "alex@example.com", password: "s3cret-pass" }, fakeMeasure);
    for (const id of ["d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8"]) expect($(`#${id}`).value, id).toBe("");
    expect($("#pw").value).toBe("s3cret-pass");
  });

  it("a disabled or read-only box is not a sign-in field", () => {
    const $ = page(`<form><input id="u" autocomplete="username" disabled><input id="p" type="password" readonly></form>`);
    expect(kind($("#u"))).toBeNull();
    expect(kind($("#p"))).toBeNull();
  });

  it("finds a sign-in field inside an open shadow root", () => {
    page(`<div id="host"></div>`);
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<form><input id="u" autocomplete="username"><input id="p" type="password"></form>`;
    const p = root.getElementById("p") as HTMLInputElement;
    expect(kind(p)).toBe("password");
    expect(loginFields(p, fakeMeasure).username).toBe(root.getElementById("u"));
  });
});

describe("the fill", () => {
  it("sets the value with the native setter, then fires input and change", () => {
    const $ = page(`<input id="u">`);
    const el = $("#u");
    const seen: string[] = [];
    // A framework's own copy of the value (React keeps one on the element): a fill must go around it.
    let tracked = "";
    Object.defineProperty(el, "value", {
      configurable: true,
      get: () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.get!.call(el),
      set: (v: string) => {
        tracked = v;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      },
    });
    for (const t of ["keydown", "input", "change", "blur"]) el.addEventListener(t, (e) => seen.push(`${e.type}:${(e as InputEvent).inputType ?? ""}:${el.value}`));
    setValue(el, "alex@example.com");
    expect(seen).toEqual(["input:insertReplacementText:alex@example.com", "change::alex@example.com"]);
    expect(tracked, "the framework's copy is still the old value, so it sees a change").toBe("");
    expect(el.value).toBe("alex@example.com");
  });

  it("the events bubble to the page's listeners on the form", () => {
    const $ = page(`<form id="f"><input id="u"><input id="p" type="password"></form>`);
    const got: string[] = [];
    $("#f").addEventListener("input", (e) => got.push((e.target as HTMLInputElement).id));
    fillLogin({ username: $("#u"), password: $("#p") }, { username: "alex", password: "pw" }, fakeMeasure);
    expect(got).toEqual(["u", "p"]);
  });

  it("a box that went away before the fill gets nothing", () => {
    const $ = page(`<form><input id="u"><input id="p" type="password"></form>`);
    const fields = { username: $("#u"), password: $("#p") };
    $("#p").style.display = "none";
    expect(fillLogin(fields, { username: "alex", password: "pw" }, fakeMeasure)).toEqual(["username"]);
    expect($("#p").value).toBe("");
  });
});
