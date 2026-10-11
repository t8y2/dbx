// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import PasswordInput from "@/components/ui/PasswordInput.vue";

const mountedContainers: HTMLDivElement[] = [];

async function mountPasswordInput(value: string) {
  const container = document.createElement("div");
  mountedContainers.push(container);
  document.body.append(container);

  const app = createApp(PasswordInput, { modelValue: value });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: { common: { showPassword: "Show password", hidePassword: "Hide password" } } } }));
  app.mount(container);
  await nextTick();
  return container;
}

afterEach(() => {
  while (mountedContainers.length > 0) mountedContainers.pop()?.remove();
});

describe("PasswordInput", () => {
  it("marks the field so dialogs can copy the raw value when revealed", async () => {
    const container = await mountPasswordInput("p^ss%40@x#y");
    const input = container.querySelector<HTMLInputElement>("input[data-password-input]");

    expect(input).not.toBeNull();
    expect(input?.value).toBe("p^ss%40@x#y");
    expect(input?.getAttribute("type")).toBe("password");

    container.querySelector<HTMLButtonElement>("button")?.click();
    await nextTick();
    expect(container.querySelector<HTMLInputElement>("input[data-password-input]")?.getAttribute("type")).toBe("text");
  });
});
