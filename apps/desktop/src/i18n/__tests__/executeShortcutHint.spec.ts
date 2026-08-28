import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import i18n, { setLocale } from "@/i18n";
import { formatShortcutDisplay } from "@/lib/editor/shortcutDisplay";

// https://github.com/t8y2/dbx/issues/6199
// "设置为 Windows 但编辑器提示仍为 Mac" — the toolbar's Execute-button tooltip and the
// Editor Settings "Execute Mode" label hardcode "(Cmd+Enter)" in every locale, including
// English, so the hints can disagree with both the current platform and a customized binding.

const toolbarSource = readFileSync(new URL("../../components/layout/EditorToolbar.vue", import.meta.url), "utf8");
const settingsDialogSource = readFileSync(new URL("../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("execute-shortcut hints reflect the configured binding", () => {
  it.each([
    ["MacIntel", "Mod+Enter", "⌘ ↵"],
    ["Win32", "Mod+Enter", "Ctrl + ↵"],
    ["Linux x86_64", "Mod+Enter", "Ctrl + ↵"],
    ["Win32", "Shift+Mod+Enter", "Ctrl + Shift + ↵"],
  ])("formats %s shortcuts for the active platform", (platform, shortcut, expected) => {
    expect(formatShortcutDisplay(shortcut, platform)).toBe(expected);
  });

  it("interpolates the formatted shortcut into the toolbar label and settings description", async () => {
    const shortcut = formatShortcutDisplay("Shift+Mod+Enter", "Win32");

    await setLocale("en");
    expect(i18n.global.t("toolbar.executeShortcut", { shortcut })).toBe("Execute selection/query (Ctrl + Shift + ↵)");
    expect(i18n.global.t("settings.executeMode")).toBe("Execute mode");
    expect(i18n.global.t("settings.executeModeDescription", { shortcut })).toBe("Run SQL shortcut: Ctrl + Shift + ↵. Controls whether it executes all SQL or the statement at the cursor by default.");

    await setLocale("zh-CN");
    expect(i18n.global.t("toolbar.executeShortcut", { shortcut })).toBe("执行选中/全部 (Ctrl + Shift + ↵)");
    expect(i18n.global.t("settings.executeMode")).toBe("执行模式");
    expect(i18n.global.t("settings.executeModeDescription", { shortcut })).toBe("执行 SQL 快捷键：Ctrl + Shift + ↵。用于控制默认执行全部 SQL 或光标所在语句。");
    await setLocale("en");
  });

  it("EditorToolbar.vue uses the saved executeSql shortcut", () => {
    expect(toolbarSource).toContain("formatShortcutDisplay(settingsStore.editorSettings.shortcuts.executeSql)");
    expect(toolbarSource).toMatch(/t\(\s*"toolbar\.executeShortcut"\s*,\s*\{\s*shortcut:\s*executeShortcutDisplay\.value/);
  });

  it("EditorSettingsDialog.vue uses the currently edited executeSql shortcut", () => {
    expect(settingsDialogSource).toMatch(/function translateWithExecuteShortcut\([^)]*\)[^}]*formatShortcutDisplay\(editShortcuts\.value\.executeSql\)/);
    expect(settingsDialogSource).toContain('translateWithExecuteShortcut("settings.executeModeDescription")');
  });

  it("EditorSettingsDialog.vue uses the same edited shortcut in settings search", () => {
    expect(settingsDialogSource).toMatch(/resolveSettingsSearchEntries\(\s*\[[^\]]*\]\s*,\s*\{[^}]*\}\s*,\s*translateWithExecuteShortcut\s*,/s);
  });
});
