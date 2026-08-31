import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toolbarSource = readFileSync(new URL("../../../components/grid/DataGridToolbar.vue", import.meta.url), "utf8");
const dataGridSource = readFileSync(new URL("../../../components/grid/DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid geometry layer preview toolbar entry", () => {
  it("opens the registered geometry preview action from a visible map button", () => {
    expect(toolbarSource).toMatch(/layerPreview\?: DataGridToolbarActionCapability/);
    expect(toolbarSource).toMatch(/isDataGridToolbarCapabilityVisible\(layerPreview\)/);
    expect(toolbarSource).toMatch(/triggerDataGridToolbarAction\(layerPreview\)/);
    expect(toolbarSource).toMatch(/<Map class="data-grid-topbar-action-icon/);

    expect(dataGridSource).toMatch(/candidate\.id === "geometry-map-preview"/);
    expect(dataGridSource).toMatch(/:layer-preview="layerPreviewToolbarCapability"/);
    expect(dataGridSource).toMatch(/executePreviewAction\(action\)/);
  });
});
