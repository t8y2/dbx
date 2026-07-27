import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");
const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");
const sidebarRuntimeSource = readFileSync(new URL("../../../components/sidebar/SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");
const openTabsPersistenceSource = readFileSync(new URL("../../app/openTabsPersistence.ts", import.meta.url), "utf8");

describe("Doris external catalog completion wiring", () => {
  it("preserves the selected catalog from the sidebar query action into QueryEditor", () => {
    expect(sidebarRuntimeSource).toContain('queryStore.createTab(node.connectionId, node.database, undefined, "query", node.schema, undefined, node.catalog)');
    expect(contentAreaSource).toContain(':catalog="activeTab.catalog"');
    expect(queryEditorSource).toContain("catalog?: string;");
    expect(openTabsPersistenceSource).toContain("catalog: tab.catalog");
  });

  it("includes catalog scope in table and column completion requests", () => {
    expect(queryEditorSource).toMatch(/lookupLocalCompletionTables\([\s\S]*?props\.catalog/);
    expect(queryEditorSource).toMatch(/listCompletionTables\([\s\S]*?props\.catalog/);
    expect(queryEditorSource).toMatch(/listCompletionColumns\([\s\S]*?catalog\)/);
    expect(queryEditorSource).toMatch(/watch\(\s*\(\) => props\.catalog,[\s\S]*?refreshCompletionCache\(\)/);
    expect(queryEditorSource).toMatch(/function shouldLoadCompletionObjects[\s\S]*?if \(props\.catalog\) return false/);
    expect(queryEditorSource).toMatch(/if \(!props\.catalog && props\.databaseType !== "oracle"[\s\S]*?listCompletionObjects/);
  });
});
