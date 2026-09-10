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
    if (tag.includes("rounded") && tag.includes("border")) return tag;
    start = templateSource.lastIndexOf("<div", start - 1);
  }
  throw new Error(`Missing bordered setting div for settings key: ${key}`);
}

function divTagForAttribute(attribute: string): string {
  const index = templateSource.indexOf(attribute);
  if (index < 0) throw new Error(`Missing template attribute: ${attribute}`);
  let start = templateSource.lastIndexOf("<div", index);
  while (start >= 0) {
    const end = tagEnd(templateSource, start);
    if (end >= index) return templateSource.slice(start, end + 1);
    start = templateSource.lastIndexOf("<div", start - 1);
  }
  throw new Error(`Missing div for template attribute: ${attribute}`);
}

function settingItemDivForText(text: string): string {
  const index = templateSource.indexOf(text);
  if (index < 0) throw new Error(`Missing template text: ${text}`);
  let start = templateSource.lastIndexOf("<div", index);
  while (start >= 0) {
    const end = tagEnd(templateSource, start);
    const tag = templateSource.slice(start, end + 1);
    if (tag.includes("settings-item")) return tag;
    start = templateSource.lastIndexOf("<div", start - 1);
  }
  throw new Error(`Missing settings item for template text: ${text}`);
}

function borderedDivForText(text: string): string {
  const index = templateSource.indexOf(text);
  if (index < 0) throw new Error(`Missing template text: ${text}`);
  let start = templateSource.lastIndexOf("<div", index);
  while (start >= 0) {
    const end = tagEnd(templateSource, start);
    const tag = templateSource.slice(start, end + 1);
    if (tag.includes("rounded") && tag.includes("border")) return tag;
    start = templateSource.lastIndexOf("<div", start - 1);
  }
  throw new Error(`Missing bordered div for template text: ${text}`);
}

describe("EditorSettingsDialog standard item hover feedback", () => {
  it("marks representative editor, navigation, data, toolbar, and update setting rows for the shared hover treatment", () => {
    for (const key of ["showStatementRunButtons", "externalSqlEditorMaxMb", "dataGridTypeColorScheme", "exclusiveRightSidebarPanels", "updateDownloadSource"] as const) {
      expect(borderedSettingDivForKey(key)).toContain("settings-item");
    }
  });

  it("keeps hover feedback off rows while their controls are disabled", () => {
    expect(settingItemDivForText('id="web-sql-file-upload-max-mb"')).toContain("'settings-item-disabled': !webSqlFileUploadMaxMbLoaded || webSqlFileUploadMaxMbLoading");
    expect(settingItemDivForText('id="mcp-http-enabled"')).toContain("'settings-item-disabled': mcpHttpLoading || mcpHttpSaving");
    expect(styleSource).toMatch(/\.settings-item:not\(\.settings-item-disabled\):not\(\.opacity-50\):hover/);
  });

  it("provides legacy color fallbacks before progressively enhancing hover colors", () => {
    const fallbackStart = styleSource.indexOf(".settings-item:not(.settings-item-disabled):not(.opacity-50):hover");
    const enhancementStart = styleSource.indexOf("@supports (background: color-mix(in oklab, black, white))");
    expect(fallbackStart).toBeGreaterThan(-1);
    expect(enhancementStart).toBeGreaterThan(fallbackStart);
    expect(styleSource.slice(fallbackStart, enhancementStart)).toContain("background-color: var(--muted);");
    expect(styleSource.slice(fallbackStart, enhancementStart)).toContain("border-color: var(--muted-foreground);");
    expect(styleSource.slice(enhancementStart)).toContain("color-mix(in oklab");
  });

  it("limits shared hover feedback to independent rows instead of composite and informational containers", () => {
    expect(divTagForAttribute('data-settings-search-id="data-grid-filter-view"')).not.toContain("settings-item");
    expect(borderedSettingDivForKey("dataGridKeepFilterEditorExpanded")).toContain("settings-item");

    for (const text of ['t("settings.mcpHttpWebServiceTitle")', 't("settings.mcpHttpUnsavedChangesHint")', "{{ mcpStatus.bin_path }}", 't("settings.mcpCursorConfigPath")', 't("settings.mcpQoderConfigPath")', 't("settings.supportInfoTitle")'] as const) {
      expect(borderedDivForText(text)).not.toContain("settings-item");
    }
  });

  it("uses direct selectors without styling nested descendants", () => {
    expect(styleSource).not.toContain(".settings-item *");
    expect(styleSource).not.toContain(".settings-item:hover *");
  });

  it("leaves choice cards and shortcut rows on their existing interaction styles", () => {
    expect(borderedSettingDivForKey("showStatementRunButtons")).not.toContain("settings-choice-card");
    expect(templateSource).toContain("settings-shortcut-row group");
  });
});
