import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsSources = ["../../editor/EditorSettingsDialog.vue", "../../editor/SqlFormatterSettingsPanel.vue", "../McpAuthorizationStepper.vue", "../McpDatabaseScopePicker.vue", "../McpResourceScopePicker.vue", "../SettingsTransferPanel.vue"].map((path) => ({
  path,
  source: readFileSync(new URL(path, import.meta.url), "utf8"),
}));

describe("settings select styling", () => {
  it("uses the shared Select component instead of native select controls", () => {
    for (const { path, source } of settingsSources) {
      expect(source, path).not.toMatch(/<select(?:\s|>)/);
    }
  });
});
