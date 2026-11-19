import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSettingsStore } from "@/stores/settingsStore";

const globalsCss = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

describe("font smoothing setting (#13359)", () => {
  it("defaults to off and round-trips through the settings store", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const settings = useSettingsStore();
    expect(settings.editorSettings.fontSmoothing).toBe(false);

    settings.updateEditorSettings({ fontSmoothing: true });
    expect(settings.editorSettings.fontSmoothing).toBe(true);
    settings.updateEditorSettings({ fontSmoothing: false });
    expect(settings.editorSettings.fontSmoothing).toBe(false);
  });

  it("only applies smoothing under the opt-in class", () => {
    // The base body rule keeps the platform default; smoothing lives behind
    // html.dbx-font-smoothing so the off state is byte-identical to pre-#13359.
    expect(globalsCss).toContain("html.dbx-font-smoothing body");
    expect(globalsCss).toContain("-webkit-font-smoothing: antialiased");
    const bodyRule = globalsCss.match(/body \{[^}]*\}/)?.[0] ?? "";
    expect(bodyRule).not.toContain("font-smoothing");
  });
});
