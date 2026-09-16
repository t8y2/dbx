import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");
const largeValueSource = readFileSync(new URL("../../../composables/useDataGridLargeValues.ts", import.meta.url), "utf8");

function functionSource(name: string, nextName: string): string {
  const start = largeValueSource.indexOf(`function ${name}`);
  const relativeEnd = largeValueSource.slice(start).search(new RegExp(`\\n\\s*(?:async\\s+)?function\\s+${nextName}\\b`));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(relativeEnd).toBeGreaterThan(0);
  return largeValueSource.slice(start, start + relativeEnd);
}

describe("DataGrid large-value reload SQL", () => {
  it("projects the synthetic rowid through the rowid-wrapped select on full-value reloads", () => {
    const fetchChunkSource = functionSource("fetchLargeValueRequestChunk", "resolveLargeValueCells");

    // Keyless Oracle tables address rows via the hidden __DBX_ROWID alias; the
    // reload must opt into the ROWIDTOCHAR inline view so the generated SQL
    // never references __DBX_ROWID as a base-table column (ORA-00904).
    expect(fetchChunkSource).toContain("includeRowId: shouldIncludeSyntheticRowId(options.databaseType.value, tableMeta.primaryKeys, tableMeta.tableType)");
  });

  it("keeps the visible-preview hydration consistent with the synthetic key", () => {
    const hydrateSource = functionSource("hydrateVisibleLargeValuePreviews", "runVisibleLargeValuePreviewHydration");

    expect(hydrateSource).toContain("includeRowId: shouldIncludeSyntheticRowId(options.databaseType.value, tableMeta.primaryKeys, tableMeta.tableType)");
  });
});
