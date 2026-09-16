import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("EditorSettingsDialog AI test result isolation", () => {
  it("clears the previous test result when opening another configuration", () => {
    expect(dialogSource).toMatch(/function aiEnterEditMode\(configId\?: string\) \{\s*syncAiEditState\(\);/);
  });

  it("clears the previous test result when changing provider in the editor", () => {
    expect(dialogSource).toMatch(/if \(presetId === aiEditProviderPresetId\.value\) return;\s*\n\s*syncAiEditState\(\);/);
  });
});
