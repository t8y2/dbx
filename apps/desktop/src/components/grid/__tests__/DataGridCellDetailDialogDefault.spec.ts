import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(resolve(import.meta.dirname, "../DataGrid.vue"), "utf8");
const editorSettingsDialogSource = readFileSync(resolve(import.meta.dirname, "../../editor/EditorSettingsDialog.vue"), "utf8");

describe("DataGrid cell detail dialog default preference (#2303)", () => {
  it("binds cellDetailDialogDefault to settingsStore.editorSettings.dataGridCellDetailDialogDefault", () => {
    expect(dataGridSource).toMatch(/const cellDetailDialogDefault = computed\(\(\) => settingsStore\.editorSettings\.dataGridCellDetailDialogDefault\);/);
  });

  it("opens cell detail dialog directly when cellDetailDialogDefault is enabled in showCellDetailsForVisibleCell", () => {
    expect(dataGridSource).toContain(
      "function showCellDetailsForVisibleCell(rowIndex: number, visibleColIdx: number, actualColIdx: number) {\n" +
        "  clearRowSelection();\n" +
        "  invalidateContextMenuTarget();\n" +
        "  selectSingleCell(rowIndex, visibleColIdx);\n" +
        "  if (cellDetailDialogDefault.value) {\n" +
        "    showCellDetail.value = false;\n" +
        "    openCellDetailDialog(rowIndex, actualColIdx);\n" +
        "  } else {\n" +
        "    showCellDetails(rowIndex, actualColIdx);\n" +
        "  }\n" +
        "}",
    );
  });

  it("opens cell detail dialog directly when cellDetailDialogDefault is enabled in showTransposeCellDetails", () => {
    expect(dataGridSource).toContain(
      "function showTransposeCellDetails(rowIndex: number, actualColIdx: number) {\n" +
        "  const visibleColIdx = visibleColumnIndexes.value.indexOf(actualColIdx);\n" +
        "  if (visibleColIdx < 0) return;\n" +
        "  clearRowSelection();\n" +
        "  invalidateContextMenuTarget();\n" +
        "  selectSingleCell(rowIndex, visibleColIdx);\n" +
        "  transposeRowIndex.value = rowIndex;\n" +
        "  if (cellDetailDialogDefault.value) {\n" +
        "    showCellDetail.value = false;\n" +
        "    openCellDetailDialog(rowIndex, actualColIdx);\n" +
        "  } else {\n" +
        "    showCellDetails(rowIndex, actualColIdx);\n" +
        "  }\n" +
        "  gridRef.value?.focus({ preventScroll: true });\n" +
        "}",
    );
  });

  it("renders the dataGridCellDetailDialogDefault switch in EditorSettingsDialog", () => {
    expect(editorSettingsDialogSource).toContain('id="data-grid-cell-detail-dialog-default"');
    expect(editorSettingsDialogSource).toContain('v-model="editDataGridCellDetailDialogDefault"');
    expect(editorSettingsDialogSource).toContain('t("settings.dataGridCellDetailDialogDefault")');
    expect(editorSettingsDialogSource).toContain('t("settings.dataGridCellDetailDialogDefaultDescription")');
  });
});
