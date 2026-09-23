import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");
const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");
const queryEditorPropsSource = readFileSync(new URL("../../../components/editor/queryEditorTypes.ts", import.meta.url), "utf8");
const completionSource = readFileSync(new URL("../../../components/editor/useQueryEditorCompletion.ts", import.meta.url), "utf8");
const metadataSource = readFileSync(new URL("../../../components/editor/useQueryEditorCompletionMetadata.ts", import.meta.url), "utf8");
const sidebarRuntimeSource = readFileSync(new URL("../../../components/sidebar/SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");
const openTabsPersistenceSource = readFileSync(new URL("../../app/openTabsPersistence.ts", import.meta.url), "utf8");

describe("Doris external catalog completion wiring", () => {
  it("preserves the selected catalog from the sidebar query action into QueryEditor", () => {
    expect(sidebarRuntimeSource).toContain('queryStore.createTab(node.connectionId, node.database, undefined, "query", node.schema, undefined, node.catalog)');
    expect(contentAreaSource).toContain(':catalog="activeTab.catalog"');
    expect(queryEditorSource).toContain("defineProps<QueryEditorProps>()");
    expect(queryEditorPropsSource).toContain("catalog?: string;");
    expect(openTabsPersistenceSource).toContain("catalog: tab.catalog");
  });

  it("includes catalog scope in table and column completion requests", () => {
    expect(completionSource).toMatch(/lookupLocalCompletionTables\([\s\S]*?props\.catalog/);
    expect(completionSource).toMatch(/listCompletionTables\([\s\S]*?props\.catalog/);
    expect(metadataSource).toMatch(/listCompletionColumns\([\s\S]*?catalog\)/);
    expect(queryEditorSource).toMatch(/watch\(\s*\(\) => props\.catalog,[\s\S]*?refreshCompletionCache\(\)/);
    expect(completionSource).toMatch(/function shouldLoadCompletionObjects[\s\S]*?if \(props\.catalog\) return false/);
    expect(completionSource).toMatch(/if \(!props\.catalog && props\.databaseType !== "oracle"[\s\S]*?listCompletionObjects/);
  });
});
