// @vitest-environment happy-dom

import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useDataGridCellDetailEdit } from "@/composables/useDataGridCellDetailEdit";
import { MONGO_DOCUMENT_GRID_NULL } from "@/lib/mongo/mongoDocumentValues";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

function detail(value: string): DataGridCellDetail {
  return {
    rowNumber: 1,
    rowId: 3,
    colIndex: 1,
    column: "value",
    type: "",
    comment: "",
    value,
    rawValue: value,
    rawValuePreview: value,
    displayValue: "NULL",
    displayValuePreview: "NULL",
    isValuePreviewTruncated: false,
    imagePreviewUrl: null,
    length: value.length,
    formattedJson: "",
    isEditable: true,
  };
}

describe("useDataGridCellDetailEdit", () => {
  it("preserves the Mongo collection null marker in detail editing and set-null", async () => {
    const activeDetail = ref<DataGridCellDetail | null>(detail(MONGO_DOCUMENT_GRID_NULL));
    const applyCellValue = vi.fn();
    const editorText = (value: string | number | boolean | null) => (value === MONGO_DOCUMENT_GRID_NULL ? "NULL" : String(value ?? ""));
    const editor = useDataGridCellDetailEdit({
      activeDetail: computed(() => activeDetail.value),
      activeTab: ref("details"),
      jsonFormatted: computed(() => false),
      databaseType: computed(() => "mongodb"),
      resultRows: computed(() => [["id", MONGO_DOCUMENT_GRID_NULL]]),
      getColumnInfo: () => undefined,
      cellEditorText: editorText,
      nullValue: () => MONGO_DOCUMENT_GRID_NULL,
      getRowItem: () => ({ sourceIndex: 0, isNew: false, isDeleted: false }),
      hydrateLargeValueCell: async () => true,
      applyCellValue,
      restoreCellValue: vi.fn(),
      syncEditor: vi.fn(),
      refreshDetail: vi.fn(),
      warnFormattedJsonEdit: vi.fn(),
    });

    await editor.startDetailEdit();
    expect(editor.detailEditValue.value).toBe("NULL");

    editor.commitDetailEdit();
    expect(applyCellValue).toHaveBeenLastCalledWith(3, 1, MONGO_DOCUMENT_GRID_NULL);

    editor.setDetailNull();
    expect(applyCellValue).toHaveBeenLastCalledWith(3, 1, MONGO_DOCUMENT_GRID_NULL);
  });
});
