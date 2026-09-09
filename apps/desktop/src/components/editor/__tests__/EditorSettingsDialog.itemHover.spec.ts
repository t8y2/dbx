import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");
const templateSource = dialogSource.slice(dialogSource.indexOf("<template>"));
const styleSource = dialogSource.slice(dialogSource.indexOf("<style>"), dialogSource.indexOf("</style>"));

function sourceIndexForKey(key: string): number {
  const index = templateSource.indexOf(`t("settings.${key}")`);
  if (index < 0) throw new Error(`Missing settings key: ${key}`);
  return index;
}

function tagEnd(source: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

function borderedSettingDivForKey(key: string): string {
  const keyIndex = sourceIndexForKey(key);
  let start = templateSource.lastIndexOf("<div", keyIndex);
  while (start >= 0) {
    const end = tagEnd(templateSource, start);
    const tag = templateSource.slice(start, end + 1);
    if (tag.includes("rounded-md") && tag.includes("border")) return tag;
    start = templateSource.lastIndexOf("<div", start - 1);
  }
  throw new Error(`Missing bordered setting div for settings key: ${key}`);
}

describe("EditorSettingsDialog standard item hover feedback", () => {
  it("marks representative editor, navigation, and data setting rows for the shared hover treatment", () => {
    for (const key of ["showStatementRunButtons", "externalSqlEditorMaxMb", "dataGridTypeColorScheme"] as const) {
      expect(borderedSettingDivForKey(key)).toContain("settings-item");
    }
  });

  it("uses a direct, disabled-safe hover contract without styling nested descendants", () => {
    expect(styleSource).toMatch(/\.settings-item:not\(\.opacity-50\)\s*\{[\s\S]*?transition:\s*background-color 150ms ease-out,\s*border-color 150ms ease-out;/);
    expect(styleSource).toMatch(/\.settings-item:not\(\.opacity-50\):hover\s*\{[\s\S]*?background-color:/);
    expect(styleSource).not.toContain(".settings-item *");
    expect(styleSource).not.toContain(".settings-item:hover *");
  });

  it("leaves choice cards and shortcut rows on their existing interaction styles", () => {
    expect(borderedSettingDivForKey("showStatementRunButtons")).not.toContain("settings-choice-card");
    expect(templateSource).toContain("settings-shortcut-row group");
  });
});
