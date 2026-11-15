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

describe("A login named with a web address", () => {
  const open = () =>
    render(
      <StoreProvider>
        <ItemEditor mode="new" itemId={null} newType="login" onDone={() => undefined} />
      </StoreProvider>,
    );

  it("fills Website from the name and says so", async () => {
    const user = userEvent.setup();
    open();
    const name = await screen.findByLabelText("Item name");
    await user.type(name, "github.com");
    const website = screen.getByLabelText("Website") as HTMLInputElement;
    expect(website.value).toBe("https://github.com");
    expect(screen.getByText("Taken from the name.")).toBeTruthy();
    expect(website.getAttribute("aria-describedby")).toBeTruthy();
    // The name stays as typed.
    expect(name).toHaveProperty("value", "github.com");
  });

  it("takes the host of a full address", async () => {
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByLabelText("Item name"), "https://accounts.google.com/signin");
    expect((screen.getByLabelText("Website") as HTMLInputElement).value).toBe("https://accounts.google.com");
  });

  it("leaves Website empty for a plain name", async () => {
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByLabelText("Item name"), "GitHub");
    expect((screen.getByLabelText("Website") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("Taken from the name.")).toBeNull();
  });

  it("stops following the name once the user edits Website", async () => {
    const user = userEvent.setup();
    open();
    const name = await screen.findByLabelText("Item name");
    await user.type(name, "github.com");
    const website = screen.getByLabelText("Website") as HTMLInputElement;
    await user.clear(website);
    await user.type(website, "https://gitlab.com");
    expect(screen.queryByText("Taken from the name.")).toBeNull();
    await user.clear(name);
    await user.type(name, "bitbucket.org");
    expect(website.value).toBe("https://gitlab.com");
  });

  it("clears its own Website again when the name stops reading as an address", async () => {
    const user = userEvent.setup();
    open();
    const name = await screen.findByLabelText("Item name");
    await user.type(name, "github.com");
    await user.clear(name);
    await user.type(name, "GitHub");
    expect((screen.getByLabelText("Website") as HTMLInputElement).value).toBe("");
  });
});
