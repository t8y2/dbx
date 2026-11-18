// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { expect, it } from "vitest";
import i18n from "@/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import DataGridExportOptionsControl from "../DataGridExportOptionsControl.vue";

it("changes export and toolbar preferences from table view options", async () => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(DataGridExportOptionsControl);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  try {
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
    buttons[1]!.click();
    await nextTick();
    expect(settings.editorSettings.defaultExportMode).toBe("queued");
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("true");
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Hide toolbar labels"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    await nextTick();
    expect(settings.editorSettings.dataGridHideToolbarLabels).toBe(true);
    expect(host.textContent).toContain("Warn about incomplete exports");
  } finally {
    app.unmount();
    host.remove();
  }
});
