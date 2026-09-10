// @vitest-environment happy-dom

import { computed, ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import { useDataGridCellDetailEdit } from "@/composables/useDataGridCellDetailEdit";
import { MONGO_DOCUMENT_GRID_NULL } from "@/lib/mongo/mongoDocumentValues";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

function detail(value: string, patch: Partial<DataGridCellDetail> = {}): DataGridCellDetail {
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
    ...patch,
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

  it("synchronizes the latest long value after asynchronous hydration", async () => {
    const previewValue = "preview";
    const longValue = "x".repeat(15000);
    const activeDetail = ref<DataGridCellDetail | null>(detail(previewValue));
    let finishHydration!: (result: boolean) => void;
    const syncEditor = vi.fn();
    const editor = useDataGridCellDetailEdit({
      activeDetail: computed(() => activeDetail.value),
      activeTab: ref("valueEditor"),
      jsonFormatted: computed(() => false),
      databaseType: computed(() => "mongodb"),
      resultRows: computed(() => [["id", previewValue]]),
      getColumnInfo: () => undefined,
      getRowItem: () => ({ sourceIndex: 0, isNew: false, isDeleted: false }),
      hydrateLargeValueCell: () => new Promise<boolean>((resolve) => (finishHydration = resolve)),
      applyCellValue: vi.fn(),
      restoreCellValue: vi.fn(),
      syncEditor,
      refreshDetail: vi.fn(),
      warnFormattedJsonEdit: vi.fn(),
    });

    const start = editor.startDetailEdit();
    activeDetail.value = detail(longValue);
    finishHydration(true);
    await start;

    expect(editor.detailEditValue.value).toBe(longValue);
    expect(syncEditor).toHaveBeenLastCalledWith(longValue, "");
  });

  it("updates an already mounted editor when the selected cell changes", async () => {
    const activeDetail = ref<DataGridCellDetail | null>(detail("short"));
    const activeTab = ref<"details" | "valueEditor">("details");
    const syncEditor = vi.fn();
    const editor = useDataGridCellDetailEdit({
      activeDetail: computed(() => activeDetail.value),
      activeTab,
      jsonFormatted: computed(() => false),
      databaseType: computed(() => "mongodb"),
      resultRows: computed(() => [["id", "short"]]),
      getColumnInfo: () => undefined,
      getRowItem: () => ({ sourceIndex: 0, isNew: false, isDeleted: false }),
      hydrateLargeValueCell: async () => true,
      applyCellValue: vi.fn(),
      restoreCellValue: vi.fn(),
      syncEditor,
      refreshDetail: vi.fn(),
      warnFormattedJsonEdit: vi.fn(),
    });

    activeTab.value = "valueEditor";
    await Promise.resolve();
    await Promise.resolve();
    syncEditor.mockClear();

    const longValue = "x".repeat(15000);
    activeDetail.value = detail(longValue, { rowId: 4 });
    await Promise.resolve();

    expect(editor.detailEditValue.value).toBe(longValue);
    expect(syncEditor).toHaveBeenLastCalledWith(longValue, "");
  });

  it("ignores a late async start after the detail editor is reset", async () => {
    const activeDetail = ref<DataGridCellDetail | null>(detail("preview"));
    let finishHydration!: (result: boolean) => void;
    const editor = useDataGridCellDetailEdit({
      activeDetail: computed(() => activeDetail.value),
      activeTab: ref("valueEditor"),
      jsonFormatted: computed(() => false),
      databaseType: computed(() => "mongodb"),
      resultRows: computed(() => [["id", "preview"]]),
      getColumnInfo: () => undefined,
      getRowItem: () => ({ sourceIndex: 0, isNew: false, isDeleted: false }),
      hydrateLargeValueCell: () => new Promise<boolean>((resolve) => (finishHydration = resolve)),
      applyCellValue: vi.fn(),
      restoreCellValue: vi.fn(),
      syncEditor: vi.fn(),
      refreshDetail: vi.fn(),
      warnFormattedJsonEdit: vi.fn(),
    });

    const start = editor.startDetailEdit();
    editor.resetDetailEdit();
    finishHydration(true);
    await start;

    expect(editor.isEditingDetail.value).toBe(false);
    expect(editor.detailEditValue.value).toBe("");
  });
});
