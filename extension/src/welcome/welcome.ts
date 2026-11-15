// The first-run page: the steps, and a button that turns off the browser's
// own "Offer to save passwords" (chrome.privacy.services.passwordSavingEnabled).

const button = document.getElementById("turn-off") as HTMLButtonElement;
const line = document.getElementById("offers") as HTMLElement;
const setting = chrome.privacy.services.passwordSavingEnabled;

async function show() {
  try {
    const { value, levelOfControl } = await setting.get({});
    if (levelOfControl === "not_controllable" || levelOfControl === "controlled_by_other_extensions") {
      line.textContent = value ? "A policy or another extension controls this setting, so Coffer cannot change it." : "The browser's offers are off.";
      button.hidden = true;
      return;
    }
    line.textContent = value ? "The browser's offers are on." : "The browser's offers are off.";
    button.hidden = !value;
  } catch (e) {
    line.textContent = `Coffer could not read this setting: ${e instanceof Error ? e.message : String(e)}`;
  }
}

button.addEventListener("click", async () => {
  button.disabled = true;
  try {
    await setting.set({ value: false });
  } catch (e) {
    line.textContent = `Coffer could not change this setting: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    button.disabled = false;
  }
  await show();
});

void show();
