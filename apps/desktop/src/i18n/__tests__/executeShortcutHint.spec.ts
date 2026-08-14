import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import i18n, { setLocale } from "@/i18n";

// https://github.com/t8y2/dbx/issues/6199
// "设置为 Windows 但编辑器提示仍为 Mac" — the toolbar's Execute-button tooltip and the
// Editor Settings "Execute Mode" label hardcode "(Cmd+Enter)" in every locale, including
// English, so Windows/Linux users always see the Mac modifier regardless of their platform.

const toolbarSource = readFileSync(new URL("../../components/layout/EditorToolbar.vue", import.meta.url), "utf8");
const settingsDialogSource = readFileSync(new URL("../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("execute-shortcut hint follows platform instead of hardcoding Mac", () => {
  it("interpolates {mod} into the toolbar execute-button tooltip for both platforms", async () => {
    await setLocale("en");
    expect(i18n.global.t("toolbar.executeShortcut", { mod: "Ctrl" })).toBe("Execute selection/query (Ctrl+Enter)");
    expect(i18n.global.t("toolbar.executeShortcut", { mod: "Cmd" })).toBe("Execute selection/query (Cmd+Enter)");

    await setLocale("zh-CN");
    expect(i18n.global.t("toolbar.executeShortcut", { mod: "Ctrl" })).toBe("执行选中/全部 (Ctrl+Enter)");
    await setLocale("en");
  });

  it("interpolates {mod} into the Editor Settings execute-mode label for both platforms", async () => {
    await setLocale("en");
    expect(i18n.global.t("settings.executeMode", { mod: "Ctrl" })).toBe("Execute Mode (Ctrl+Enter)");
    expect(i18n.global.t("settings.executeMode", { mod: "Cmd" })).toBe("Execute Mode (Cmd+Enter)");

    await setLocale("zh-CN");
    expect(i18n.global.t("settings.executeMode", { mod: "Ctrl" })).toBe("执行模式 (Ctrl+Enter)");
    await setLocale("en");
  });

  it("EditorToolbar.vue passes the platform-aware mod into the tooltip translation call", () => {
    expect(toolbarSource).toMatch(/t\(\s*"toolbar\.executeShortcut"\s*,\s*\{\s*mod:/);
  });

  it("EditorSettingsDialog.vue passes the platform-aware mod into the execute-mode label translation call", () => {
    expect(settingsDialogSource).toMatch(/function translateWithShortcutMod\([^)]*\)[^}]*t\(\s*key\s*,\s*\{\s*mod:/);
    expect(settingsDialogSource).toContain('translateWithShortcutMod("settings.executeMode")');
  });

  it("EditorSettingsDialog.vue routes the settings-search translate function through translateWithShortcutMod, not raw t, so {mod} in search-index labels also resolves", () => {
    expect(settingsDialogSource).toMatch(/resolveSettingsSearchEntries\(\s*\[[^\]]*\]\s*,\s*\{[^}]*\}\s*,\s*translateWithShortcutMod\s*,/s);
  });
});
