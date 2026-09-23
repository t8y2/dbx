import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");
const metadataLoaderSource = readFileSync(new URL("../../../composables/useDataGridTableMetadataLoaders.ts", import.meta.url), "utf8");

describe("DataGrid DDL search navigation", () => {
  it("resets navigation when the raw search query changes", () => {
    expect(dataGridSource).toMatch(/watch\(\s*searchQuery,\s*async \(\) => \{\s*ddlSearchMatchIndex\.value = 0;/);
  });

  it("highlights the DDL once and marks the rendered DOM for the search", () => {
    // #9212: re-highlighting (and re-parsing) the whole DDL on every keystroke
    // froze the window, so the highlighted HTML only depends on the DDL itself
    // and the search marks are applied to the already-rendered <pre>.
    expect(dataGridSource).toMatch(/const highlightedDdlContent = computed\(\(\) => \(ddlContent\.value \? highlight\(ddlContent\.value\) : ""\)\);/);
    expect(dataGridSource).toContain('v-html="highlightedDdlContent"');
    expect(dataGridSource).toContain('import { applyDdlSearchMarks } from "@/lib/sql/ddlSearchMarks"');
    expect(dataGridSource).not.toContain("filteredDdlContent");
    expect(dataGridSource.match(/applyDdlSearchMarks\(ddlPreRef\.value, searchQuery\.value\)/g) ?? []).toHaveLength(3);
  });

  it("uses the shared DDL cache policy and exposes refresh controls", () => {
    expect(metadataLoaderSource).toContain('from "@/lib/metadata/objectDdlCache"');
    expect(metadataLoaderSource).toContain("async function fetchDdl(force = options.settingsStore.editorSettings.refreshDdlOnOpen)");
    expect(metadataLoaderSource).toMatch(/objectType: tableObjectSourceKind\(props\.tableMeta\.tableType\)/);
    expect(metadataLoaderSource).toContain("loadObjectDdl(request, { force })");
    expect(dataGridSource).toMatch(/async function refreshActiveTableInfo\(\)[\s\S]*?fetchDdl\(true\)[\s\S]*?fetchTableInfoColumns\(true\)[\s\S]*?fetchIndexes\(\)[\s\S]*?fetchForeignKeys\(\)[\s\S]*?fetchConstraints\(\)[\s\S]*?fetchTriggers\(\)/);
    expect(dataGridSource).toContain('@click="refreshActiveTableInfo"');
    expect(metadataLoaderSource).toMatch(/loadObjectMetadataFacet\(request, "columns"/);
    expect(dataGridSource).toMatch(/activeTableInfoTab\.value === "constraints"\) return constraintsLoading\.value/);
    expect(dataGridSource).not.toContain("setTableInfoRefreshDdlOnOpen");
  });
});
