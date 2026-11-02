import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const supportedLocales = ["az", "en", "es", "id", "it", "ja", "ko", "pt-BR", "ru", "th", "tr", "zh-CN", "zh-TW"];
const viewKeys = [
  "viewMode",
  "viewManage",
  "viewOverview",
  "overviewSummary",
  "overviewPluginsHint",
  "overviewOpenDetails",
  "expandCategory",
  "collapseCategory",
  "mcpPluginToolsMode",
  "mcpPluginToolsModeDescription",
  "mcpPluginToolsModeFlat",
  "mcpPluginToolsModeLazy",
  "mcpPluginToolsModeAuto",
  "mcpPluginToolsModeFlatDescription",
  "mcpPluginToolsModeLazyDescription",
  "mcpPluginToolsModeAutoDescription",
];

describe("MCP capability view translations", () => {
  it("defines every view label in every supported locale", () => {
    for (const locale of supportedLocales) {
      const source = readFileSync(new URL(`../../../i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      for (const key of viewKeys) expect(source, `${locale}.${key}`).toMatch(new RegExp(`\\b${key}: "[^"\\n]+"`));
      expect(source, `${locale}.overviewSummary placeholders`).toMatch(/overviewSummary: "[^"]*\{toolsets\}[^"]*\{total\}[^"]*\{enabled\}/);
    }
  });
});
