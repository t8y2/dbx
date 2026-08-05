import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const dataGridToolbarSource = readFileSync(new URL("../../../components/grid/DataGridToolbar.vue", import.meta.url), "utf8");
const dataGridSource = readFileSync(new URL("../../../components/grid/DataGrid.vue", import.meta.url), "utf8");

describe("data grid toolbar delete row", () => {
  it("declares and renders the delete-row action button", () => {
    expect(dataGridToolbarSource).toMatch(/deleteRow\?: DataGridToolbarActionCapability/);
    expect(dataGridToolbarSource).toMatch(/isDataGridToolbarCapabilityVisible\(deleteRow\)/);
    expect(dataGridToolbarSource).toMatch(/triggerDataGridToolbarAction\(deleteRow\)/);
  });

  it("wires the delete-row capability into the toolbar", () => {
    expect(dataGridSource).toMatch(/:delete-row="deleteRowToolbarCapability"/);
  });

  it("keeps the delete-row capability tied to row deletion state", () => {
    expect(dataGridSource).toMatch(/deleteRowToolbarTargetCount = computed\(\(\) => deletableRowIds\(selectedOrCurrentRowIds\(\)\)\.length\)/);
    expect(dataGridSource).toMatch(/visible: deleteRowToolbarState\.value\.visible/);
    expect(dataGridSource).toMatch(/disabled: deleteRowToolbarState\.value\.disabled/);
    expect(dataGridSource).toMatch(/onTrigger: \(\) => \{\s*deleteCurrentRow\(\);/);
  });
});
