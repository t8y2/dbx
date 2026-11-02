// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "@/lib/sql/sqlFormatterConfig";
import SqlFormatterSettingsPanel from "../SqlFormatterSettingsPanel.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/lib/export/saveTextFile", () => ({ saveTextFile: vi.fn() }));
// The tabs and configuration component are real; the lazy editor is outside navigation's scope.
vi.mock("@codemirror/view", () => {
  throw new Error("Editor unavailable in navigation test");
});

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  document.body.innerHTML = "";
});

describe("formatter controlled search navigation", () => {
  it("reveals JSON and returns to form without emitting settings changes", async () => {
    const mode = ref<"form" | "json">("form");
    const updateSettings = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp({
      setup: () => () =>
        h(SqlFormatterSettingsPanel, {
          modelValue: DEFAULT_SQL_FORMATTER_SETTINGS,
          mode: mode.value,
          "onUpdate:mode": (value) => {
            mode.value = value;
          },
          "onUpdate:modelValue": updateSettings,
        }),
    });
    app.mount(host);
    mode.value = "json";
    await nextTick();
    await nextTick();
    expect(host.querySelector('[data-settings-search-id="formatter-json"]')?.getAttribute("data-state")).toBe("active");
    mode.value = "form";
    await nextTick();
    await nextTick();
    const tabs = Array.from(host.querySelectorAll('[role="tab"]'));
    expect(tabs.find((tab) => tab.textContent?.includes("settings.sqlFormatterFormMode"))?.getAttribute("aria-selected")).toBe("true");
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
