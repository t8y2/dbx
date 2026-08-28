import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DdlViewDialog.vue", import.meta.url), "utf8");

describe("DdlViewDialog freshness", () => {
  it("uses the persisted refresh preference when the dialog opens", () => {
    expect(source).toMatch(/watch\(\s*\(\) => props\.open,[\s\S]*?await loadDdl\(settingsStore\.editorSettings\.refreshDdlOnOpen\);/);
  });

  it("refreshes the current DDL immediately when the preference is enabled", () => {
    expect(source).toMatch(/function setRefreshDdlOnOpen\(value: boolean\)[\s\S]*?if \(value\) void loadDdl\(true\);/);
  });

  it("explains how the refresh preference affects cached DDL", () => {
    expect(source).toContain('import { HelpTooltip } from "@/components/ui/tooltip";');
    expect(source).toMatch(/<HelpTooltip :label="t\('contextMenu\.refreshDdlOnOpenHint'\)"[\s\S]*?t\("contextMenu\.refreshDdlOnOpenHint"\)[\s\S]*?<\/HelpTooltip>/);
  });
});
