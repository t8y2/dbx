import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const toolbarSource = readFileSync(new URL("../../../components/layout/AppToolbar.vue", import.meta.url), "utf8");

function functionSource(name: string, nextName: string): string {
  const start = appSource.indexOf(`function ${name}`);
  const end = appSource.indexOf(`function ${nextName}`, start + 1);
  return appSource.slice(start, end);
}

describe("right sidebar panel entry points", () => {
  it("routes toolbar and close actions through the centralized controller", () => {
    expect(appSource).toContain("@toggle-ai=\"toggleRightSidebarPanel('ai')\"");
    expect(appSource).toContain("@toggle-history=\"toggleRightSidebarPanel('history')\"");
    expect(appSource).toContain("@toggle-sql-library=\"toggleRightSidebarPanel('sqlLibrary')\"");
    expect(appSource).toContain("@toggle-sql-file-panel=\"toggleRightSidebarPanel('sqlFile')\"");
    expect(appSource).toContain("@close=\"closeRightSidebarPanel('history')\"");
    expect(appSource).toContain("@close=\"closeRightSidebarPanel('sqlLibrary')\"");
    expect(appSource).toContain("@close=\"closeRightSidebarPanel('sqlFile')\"");
  });

  it("routes welcome, history analysis, selection, and error-fix opens through the same controller", () => {
    expect(appSource).toContain("@show-history=\"openRightSidebarPanel('history')\"");
    expect(functionSource("fixWithAi", "sendSelectionToAi")).toContain('openRightSidebarPanel("ai")');
    expect(functionSource("sendSelectionToAi", "openAiPanel")).toContain('openRightSidebarPanel("ai")');
    expect(functionSource("openAiPanel", "analyzeHistoryWithAi")).toContain('openRightSidebarPanel("ai")');
  });

  it("keeps existing persisted panel keys and synchronizes exclusivity after settings load", () => {
    expect(appSource).toContain('ai: "dbx-ai-panel-open"');
    expect(appSource).toContain('sqlLibrary: "dbx-sql-library-open"');
    expect(appSource).toContain('sqlFile: "dbx-sql-file-panel-open"');
    expect(appSource).not.toContain('history: "dbx-');
    expect(appSource).toContain("settingsStore.isEditorSettingsLoaded");
    expect(appSource).toContain("enforceRightSidebarPanelExclusivity(currentRightSidebarPanelState(), lastOpenedRightSidebarPanel)");
  });

  it("does not couple toolbar visibility to panel closing", () => {
    for (const [setting, event] of [
      ["sqlLibrary", "toggle-sql-library"],
      ["sqlFileTree", "toggle-sql-file-panel"],
      ["history", "toggle-history"],
      ["ai", "toggle-ai"],
    ]) {
      expect(toolbarSource).toContain(`<Tooltip v-if="toolbarItems.${setting}">`);
      expect(toolbarSource).toContain(`@click="emit('${event}')"`);
    }
    expect(appSource).not.toMatch(/watch\([\s\S]{0,180}toolbarItems\.(ai|history|sqlLibrary|sqlFileTree)[\s\S]{0,180}closeRightSidebarPanel/);
  });
});
