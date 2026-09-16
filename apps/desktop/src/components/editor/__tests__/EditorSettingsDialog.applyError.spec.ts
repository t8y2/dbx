import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

// Regression for https://github.com/t8y2/dbx/issues/6485: applying editor
// settings (e.g. the editor font) could appear to "do nothing" because
// persistSettings() has several awaited persistence steps with no error
// handling. On a rejected save, "Apply" was completely silent and "Apply &
// Close" never called closeSettings(), leaving the dialog stuck open with no
// feedback at all.
describe("EditorSettingsDialog apply persistence error handling", () => {
  it("shares a single apply entrypoint between Apply and Apply & Close", () => {
    // Both buttons must go through one shared persist/apply routine instead of
    // each calling persistSettings() directly with divergent semantics.
    const block = dialogSource.slice(dialogSource.indexOf("function applySettingsErrorToast"), dialogSource.indexOf("async function restartDbxForDuckDbIsolation()"));
    const entrypointCalls = (block.match(/await applySettingsForResult\(\)/g) || []).length;
    // one call in applySettings() + one (guarded) call in applySettingsAndClose()
    expect(entrypointCalls).toBeGreaterThanOrEqual(2);
    // the shared entrypoint exists and wraps persistSettings
    expect(block).toContain("async function applySettingsForResult(): Promise<boolean>");
    expect(block).toContain("await persistSettings();");
  });

  it("never closes the dialog before persistence succeeds", () => {
    // "Apply & Close" must only proceed to closeSettings() after a successful
    // apply. Before the fix, closeSettings() ran unconditionally after
    // `await persistSettings()`, so a rejected save left the dialog stuck open.
    const block = dialogSource.slice(dialogSource.indexOf("async function applySettingsAndClose()"), dialogSource.indexOf("async function restartDbxForDuckDbIsolation()"));
    expect(block).toMatch(/if \(await applySettingsForResult\(\)\) \{\s*\n\s*closeSettings\(\);/);
  });

  it("surfaces persistence failures instead of silently swallowing them", () => {
    const resultBlock = dialogSource.slice(dialogSource.indexOf("async function applySettingsForResult()"), dialogSource.indexOf("async function applySettings()"));
    expect(resultBlock).toContain("try {");
    expect(resultBlock).toContain("catch (error)");
    expect(resultBlock).toContain("applySettingsErrorToast(error)");
    expect(resultBlock).toContain("return false;");
    // a user-facing message is wired up (and translated in every locale)
    expect(dialogSource).toContain('toast(t("settings.applyFailed"');
  });
});
