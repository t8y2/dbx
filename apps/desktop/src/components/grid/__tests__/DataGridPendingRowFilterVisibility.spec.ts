import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid pending row visibility under local column filters", () => {
  it("keeps pending new rows visible while a local column filter is active", () => {
    // The pending-row branch of displayRowRefs must not consult the local
    // column filter matchers; only the row status filter applies (#9201).
    expect(dataGridSource).toMatch(/const row = newRows\.value\[newIndex\];[\s\S]{0,200}?if \(!row\) continue;/);
    expect(dataGridSource).not.toContain("!rowMatchesLocalColumnFilters(row)");
  });
});
