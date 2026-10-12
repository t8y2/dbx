// @vitest-environment happy-dom

import { createPinia, setActivePinia } from "pinia";
import { createApp, nextTick, type App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import DataGridEmptyColumnsControl from "../DataGridEmptyColumnsControl.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import i18n from "@/i18n";

let app: App | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.replaceChildren();
});

describe("empty-column view option", () => {
  it("updates the persisted option without changing the NULL-only setting", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const settings = useSettingsStore();
    const host = document.createElement("div");
    document.body.append(host);
    app = createApp(DataGridEmptyColumnsControl, { count: 2, columnCount: 4 });
    app.use(pinia).use(i18n).mount(host);
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.disabled).toBe(false);
    toggle.click();
    await nextTick();
    expect(settings.editorSettings.dataGridHideEmptyColumns).toBe(true);
    expect(settings.editorSettings.dataGridHideNullColumns).toBe(false);
    toggle.click();
    await nextTick();
    expect(settings.editorSettings.dataGridHideEmptyColumns).toBe(false);
  });

  it("allows an active preference to be disabled even with no empty columns", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const settings = useSettingsStore();
    settings.updateEditorSettings({ dataGridHideEmptyColumns: true });
    const host = document.createElement("div");
    app = createApp(DataGridEmptyColumnsControl, { count: 0, columnCount: 0 });
    app.use(pinia).use(i18n).mount(host);
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.disabled).toBe(false);
    toggle.click();
    await nextTick();
    expect(settings.editorSettings.dataGridHideEmptyColumns).toBe(false);
    expect(toggle.disabled).toBe(true);
  });
});
