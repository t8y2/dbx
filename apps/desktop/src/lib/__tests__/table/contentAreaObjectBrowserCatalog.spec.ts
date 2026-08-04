import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");
const connectionTreeSource = readFileSync(new URL("../../../components/sidebar/ConnectionTree.vue", import.meta.url), "utf8");
const ddlViewDialogSource = readFileSync(new URL("../../../components/objects/DdlViewDialog.vue", import.meta.url), "utf8");
const objectBrowserSource = readFileSync(new URL("../../../components/objects/ObjectBrowser.vue", import.meta.url), "utf8");
const fetchTableDdlSource = objectBrowserSource.match(/async function fetchTableDdl\(\)[\s\S]*?(?=\nasync function fetchTableColumns\()/)?.[0] ?? "";
const exportStructureSource = objectBrowserSource.match(/async function exportStructure\([\s\S]*?(?=\nasync function exportDataLegacy\()/)?.[0] ?? "";

function openingTag(source: string, componentName: string): string {
  return source.match(new RegExp(`<${componentName}\\b[\\s\\S]*?>`))?.[0] ?? "";
}

describe("ContentArea external catalog wiring", () => {
  it("passes the object browser catalog to ObjectBrowser", () => {
    expect(openingTag(contentAreaSource, "ObjectBrowser")).toContain(':catalog="activeTab.objectBrowser?.catalog"');
  });

  it("does not attach object browser state to DataGrid", () => {
    expect(openingTag(contentAreaSource, "DataGrid")).not.toContain("activeTab.objectBrowser?.catalog");
  });

  it("passes the sidebar catalog to the DDL dialog", () => {
    expect(openingTag(connectionTreeSource, "SidebarDdlViewDialog")).toContain(':catalog="sidebarDdlTarget.catalog"');
  });

  it("forwards the DDL dialog catalog to the persistent DDL loader", () => {
    expect(ddlViewDialogSource).toMatch(/loadObjectDdl\([\s\S]*?objectType: props\.objectType,[\s\S]*?catalog: props\.catalog/);
  });
});

describe("ContentArea object browser refresh wiring", () => {
  it("routes content refresh through the ObjectBrowser handle", () => {
    expect(contentAreaSource).toContain('if (props.activeTab.mode === "objects") return objectBrowserRef.value?.refresh?.() ?? false;');
  });

  it("exposes object and active table-info reloads as refresh", () => {
    expect(objectBrowserSource).toMatch(/function refresh\(\): boolean \{\s+void reload\(\);\s+void refreshActiveTableInfo\(\);\s+return true;\s+\}/);
    expect(objectBrowserSource).toContain("defineExpose({ focusSearch, refresh });");
  });

  it("shows the configured content refresh shortcut on the refresh button", () => {
    expect(objectBrowserSource).toContain("formatShortcut(settingsStore.editorSettings.shortcuts.refreshData)");
    expect(objectBrowserSource).toMatch(/<Button[^>]*:title="refreshTooltip"[^>]*@click="refresh">/);
  });
});

describe("ObjectBrowser DDL API boundaries", () => {
  it("uses display DDL for the table information panel", () => {
    expect(fetchTableDdlSource).toMatch(/api\.getTableDisplayDdl\([\s\S]*?props\.catalog\);/);
  });

  it("keeps structure exports on the portable base DDL", () => {
    expect(exportStructureSource).toMatch(/api\.getTableDdl\([\s\S]*?props\.catalog\);/);
    expect(exportStructureSource).not.toContain("api.getTableDisplayDdl(");
  });
});
