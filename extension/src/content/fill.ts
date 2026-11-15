// Put a login into a page's fields so the page's own code sees it: the
// native value setter (React and Vue keep their own copy of a field's value,
// and a plain `el.value = x` can go around it), then the input and change
// events a person's typing would fire.
import { isVisible, type LoginFields, type Measure, realMeasure } from "./fields";

const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

/** Set one field's value the way typing would, and tell the page. */
export function setValue(el: HTMLInputElement, value: string): void {
  if (nativeValue) nativeValue.call(el, value);
  else el.value = value;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Fill the username and password boxes. Each box is checked again at the
 * moment of the fill: a box that is gone or hidden now gets nothing.
 * Returns which boxes it filled.
 */
export function fillLogin(fields: LoginFields, login: { username: string; password: string }, m: Measure = realMeasure): Array<"username" | "password"> {
  const done: Array<"username" | "password"> = [];
  const ok = (el: HTMLInputElement | null): el is HTMLInputElement => !!el && el.isConnected && !el.disabled && !el.readOnly && isVisible(el, m);
  if (ok(fields.username) && login.username) {
    setValue(fields.username, login.username);
    done.push("username");
  }
  if (ok(fields.password) && login.password) {
    setValue(fields.password, login.password);
    done.push("password");
  }
  return done;
}
