import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

// Regression for https://github.com/t8y2/dbx/issues/9881: the shortcut draft was
// written straight from the captured key event, while persistence re-normalizes it
// and swaps "another platform's default" literals for the local platform default.
// The draft then never equaled the stored value again, so `hasChanges()` stayed true
// forever: "Apply" looked like it did nothing and "Apply and Close" always asked
// about unsaved changes — the shortcut (and every other pending edit) could never be
// saved. The capture path must therefore write the same value the store will keep.
describe("EditorSettingsDialog shortcut capture normalization", () => {
  it("round-trips a captured combination through the persistence normalizer", () => {
    expect(dialogSource).toContain("resolveCapturedShortcutEdit,");
    expect(dialogSource).toContain("const captured = resolveCapturedShortcutEdit(actionId, shortcut, editShortcuts.value);");
  });

  it("refuses combinations the store would rewrite, keeping the previous shortcut", () => {
    expect(dialogSource).toContain('toast(t("settings.shortcutPlatformDefault"), 3000);');

    const guardStart = dialogSource.indexOf("if (captured.rejectedByPlatformDefault) {");
    const guardEnd = dialogSource.indexOf("if (captured.changed) {", guardStart);

    expect(guardStart).toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guardStart);
    // 拒绝分支必须先结束编辑、且不得写入草稿（保留原值 → 草稿仍是落盘值的不动点）
    const guardBody = dialogSource.slice(guardStart, guardEnd);
    expect(guardBody).toContain("editingShortcutId.value = null;");
    expect(guardBody).toContain("return;");
    expect(guardBody).not.toContain("editShortcuts.value =");
  });

  it("adopts the normalized result so the draft can never diverge from the stored value", () => {
    expect(dialogSource).toContain("editShortcuts.value = captured.shortcuts;");
  });

  it("re-syncs the shortcut draft from the store after a successful apply", () => {
    const bodyStart = dialogSource.indexOf("async function persistSettings() {");
    const bodyEnd = dialogSource.indexOf("function applySettingsErrorToast(", bodyStart);

    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    expect(dialogSource.slice(bodyStart, bodyEnd)).toContain("editShortcuts.value = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);");
  });
});
