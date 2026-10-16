// @vitest-environment jsdom
// The New item editor puts the cursor in the name once, when it opens. Typing
// in any other field keeps the cursor in that field (it used to jump back to
// the name after each key).
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../store";
import { ItemEditor } from "./ItemEditor";

afterEach(cleanup);

describe("New item editor focus", () => {
  it("focuses the name on open, then leaves the cursor where the user types", async () => {
    const user = userEvent.setup();
    render(
      <StoreProvider>
        <ItemEditor mode="new" itemId={null} newType="login" onDone={() => undefined} />
      </StoreProvider>,
    );
    const name = await screen.findByLabelText("Item name");
    await waitFor(() => expect(document.activeElement).toBe(name));

    await user.type(name, "GitHub");
    expect(name).toHaveProperty("value", "GitHub");

    for (const label of ["Username", "Password"]) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      await user.click(field);
      await user.type(field, "abc");
      expect(document.activeElement, `cursor after typing in ${label}`).toBe(field);
      expect(field.value).toBe("abc");
    }
    expect(name).toHaveProperty("value", "GitHub");
  });
});
