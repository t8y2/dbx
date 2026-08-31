import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

// Regression for https://github.com/t8y2/dbx/issues/5905: changing a shortcut
// or the sidebar activation mode (and every other draft-gated editor
// setting) was silently discarded whenever the dialog closed any way other
// than the explicit "Apply"/"Apply and Close" buttons — Escape, clicking
// outside, the X button, and every tab's "Close" footer button all bypassed
// the draft entirely. Users only noticed after a later app restart (e.g. to
// install an update) surfaced the still-default values, making it look like
// the update itself had reset their settings.
describe("EditorSettingsDialog unsaved-changes close guard", () => {
  it("imports the shared unsaved-changes decision helper", () => {
    expect(dialogSource).toContain('shouldConfirmEditorSettingsDialogClose, type EditorSettingsDraft } from "@/lib/settings/editorSettingsDraft"');
  });

  it("routes every close path through the same guard instead of emitting update:open directly", () => {
    expect(dialogSource).toContain("function requestCloseSettings(nextOpen: boolean) {");
    expect(dialogSource).toContain("if (shouldConfirmEditorSettingsDialogClose(nextOpen, hasChanges())) {");
    expect(dialogSource).toContain("showUnsavedSettingsCloseConfirm.value = true;");

    // Escape / outside click / the dialog's own X button
    expect(dialogSource).toContain("function onSettingsRootOpenChange(value: boolean) {\n  if (isSettingsPage.value) return;\n  requestCloseSettings(value);\n}");
    // Every tab footer's "Close" button — must work in both dialog and page
    // (variant="page") mode, since App.vue relies on closeSettings() emitting
    // update:open(false) in page mode too (see @update:open on EditorSettingsPage).
    expect(dialogSource).toContain("function closeSettings() {\n  requestCloseSettings(false);\n}");

    // Neither close entrypoint may emit update:open directly anymore - only requestCloseSettings does.
    const closeSettingsBody = dialogSource.slice(dialogSource.indexOf("function closeSettings()"), dialogSource.indexOf("function cancelUnsavedSettingsClose()"));
    expect(closeSettingsBody).not.toContain('emit("update:open"');
  });

  it("lets the user cancel back into the dialog without losing the draft", () => {
    expect(dialogSource).toContain("function cancelUnsavedSettingsClose() {\n  showUnsavedSettingsCloseConfirm.value = false;\n}");
  });

  it("only actually closes (dropping the draft) once the user explicitly confirms discarding", () => {
    expect(dialogSource).toContain('function discardUnsavedSettingsAndClose() {\n  showUnsavedSettingsCloseConfirm.value = false;\n  emit("update:open", false);\n}');
  });

  it("renders a confirmation dialog wired to the guard state and both actions", () => {
    expect(dialogSource).toContain('<Dialog :open="showUnsavedSettingsCloseConfirm" @update:open="(value: boolean) => !value && cancelUnsavedSettingsClose()">');
    expect(dialogSource).toContain('{{ t("settings.unsavedChangesCloseTitle") }}');
    expect(dialogSource).toContain('{{ t("settings.unsavedChangesCloseMessage") }}');
    expect(dialogSource).toContain('@click="cancelUnsavedSettingsClose"');
    expect(dialogSource).toContain('@click="discardUnsavedSettingsAndClose"');
  });
});
