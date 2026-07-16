import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");
const connectionTreeSource = readFileSync(new URL("../../../components/sidebar/ConnectionTree.vue", import.meta.url), "utf8");
const ddlViewDialogSource = readFileSync(new URL("../../../components/objects/DdlViewDialog.vue", import.meta.url), "utf8");

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

  it("forwards the DDL dialog catalog to the metadata API", () => {
    expect(ddlViewDialogSource).toMatch(/api\.getTableDdl\([\s\S]*?props\.objectType, props\.catalog\)/);
  });
});
