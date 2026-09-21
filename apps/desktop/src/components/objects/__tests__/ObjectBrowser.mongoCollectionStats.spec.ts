import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const objectBrowserSource = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");

describe("ObjectBrowser MongoDB collection statistics (#9705)", () => {
  it("requests table statistics for every engine, MongoDB included", () => {
    // The loader used to skip MongoDB wholesale, so the columns below stayed
    // empty even though the backend can now answer `collStats` per collection.
    expect(objectBrowserSource).not.toContain('if (props.connection.db_type !== "mongodb") void loadObjectStatistics');
    expect(objectBrowserSource).toContain("void loadObjectStatistics(request, cacheWriteToken, cachedAt);");
  });

  it("renders the row/size columns and their sort keys for MongoDB", () => {
    expect(objectBrowserSource).toContain("const showObjectRowStats = computed(() => showTableStatistics.value);");
    expect(objectBrowserSource).toContain("const supportsObjectSizeStats = computed(() => !isVictoriaMetrics.value);");
  });

  it("keeps the batch table toolbar SQL-only", () => {
    expect(objectBrowserSource).toContain("const supportsBatchTableActions = computed(() => !isVictoriaMetrics.value && !isMongodb.value);");
    for (const handler of ["openBatchDatabaseExport", "copySelectedTablesToClipboard", "requestBatchTruncateTables", "requestBatchEmptyTables", "requestBatchDropTables"]) {
      const button = new RegExp(`v-if="supportsBatchTableActions[^"]*"[^>]*@click="${handler}"`);
      expect(objectBrowserSource).toMatch(button);
    }
    // No toolbar action may key off the stats-column flag any more.
    expect(objectBrowserSource).not.toContain('v-if="supportsObjectSizeStats');
  });
});
