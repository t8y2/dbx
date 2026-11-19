// @vitest-environment happy-dom

import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForeignKeyChecksMode } from "@/lib/table/foreignKeyChecks";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import ForeignKeyChecksSelect from "@/components/objects/ForeignKeyChecksSelect.vue";

const mountedApps: App[] = [];

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("ForeignKeyChecksSelect", () => {
  it("renders the label, the current mode and the hint", async () => {
    const mode = ref<ForeignKeyChecksMode>("default");
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({ render: () => h(ForeignKeyChecksSelect, { modelValue: mode.value, "onUpdate:modelValue": (value: ForeignKeyChecksMode) => (mode.value = value) }) });
    mountedApps.push(app);
    app.mount(host);
    await nextTick();

    const root = host.querySelector("[data-testid='foreign-key-checks-option']");
    expect(root?.textContent).toContain("contextMenu.foreignKeyChecks");
    expect(root?.textContent).toContain("contextMenu.foreignKeyChecksHint");
    expect(host.querySelector("[data-testid='foreign-key-checks-select']")?.textContent).toContain("contextMenu.foreignKeyChecksDefault");

    mode.value = "disable";
    await nextTick();
    expect(host.querySelector("[data-testid='foreign-key-checks-select']")?.textContent).toContain("contextMenu.foreignKeyChecksDisable");
  });
});
