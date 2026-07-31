// @vitest-environment happy-dom

import { createApp, nextTick, ref } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it } from "vitest";
import PasswordInput from "@/components/ui/PasswordInput.vue";

const mountedApps: Array<ReturnType<typeof createApp>> = [];

async function mountPasswordInput(toggleTabIndex?: number) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    components: { PasswordInput },
    setup() {
      return { toggleTabIndex, value: ref("") };
    },
    template: '<PasswordInput v-model="value" :toggle-tab-index="toggleTabIndex" />',
  });
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: { en: { common: { hidePassword: "Hide password", showPassword: "Show password" } } },
    }),
  );
  app.mount(host);
  mountedApps.push(app);
  await nextTick();
  return host.querySelector("button") as HTMLButtonElement;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

describe("PasswordInput", () => {
  it("keeps the visibility toggle in the default tab order", async () => {
    expect((await mountPasswordInput()).tabIndex).toBe(0);
  });

  it("allows forms to remove the visibility toggle from the tab order", async () => {
    expect((await mountPasswordInput(-1)).tabIndex).toBe(-1);
  });
});
