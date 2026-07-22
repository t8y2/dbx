// @vitest-environment happy-dom

import { effectScope, nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  setValue: vi.fn(),
  getValue: vi.fn(() => ""),
  openSearch: vi.fn(),
  focus: vi.fn(),
  onChange: undefined as undefined | ((value: string) => void),
}));

vi.mock("@/composables/useCellDetailEditor", () => ({
  useCellDetailEditor: (options: { onChange?: (value: string) => void }) => {
    mocks.onChange = options.onChange;
    return {
      create: mocks.create,
      destroy: mocks.destroy,
      setValue: mocks.setValue,
      getValue: mocks.getValue,
      openSearch: mocks.openSearch,
      view: { value: { focus: mocks.focus } },
    };
  },
}));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: ref(false), themePalette: ref({}) }) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { theme: "default", fontSize: 13, fontFamily: "monospace" } }),
}));
vi.mock("@/lib/dataGrid/geometryPreview", () => ({ renderWktOnCanvas: vi.fn() }));

import { useDataGridCellDetail } from "@/composables/useDataGridCellDetail";

function detail(): DataGridCellDetail {
  return {
    rowNumber: 1,
    rowId: 1,
    colIndex: 0,
    column: "name",
    type: "VARCHAR",
    comment: "",
    value: "",
    rawValue: "",
    rawValuePreview: "",
    displayValue: "",
    displayValuePreview: "",
    isValuePreviewTruncated: false,
    imagePreviewUrl: null,
    length: 0,
    formattedJson: null,
    isEditable: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onChange = undefined;
  mocks.getValue.mockReturnValue("");
});

describe("useDataGridCellDetail", () => {
  it("focuses CodeMirror after entering cell detail edit mode", async () => {
    const scope = effectScope();
    const composable = scope.run(() => useDataGridCellDetail({ detail: ref(detail()), editValue: ref(""), onCancel: vi.fn() }))!;

    composable.detailsEditorContainer.value = document.createElement("div");
    await nextTick();
    await Promise.resolve();

    expect(mocks.focus).toHaveBeenCalledOnce();

    composable.detailsEditorContainer.value = undefined;
    await nextTick();
    scope.stop();
  });

  it("does not write editor-originated IME composition text back into CodeMirror", async () => {
    const scope = effectScope();
    const editValue = ref("");
    const composable = scope.run(() => useDataGridCellDetail({ detail: ref(detail()), editValue, onCancel: vi.fn() }))!;

    composable.detailsEditorContainer.value = document.createElement("div");
    await nextTick();
    expect(mocks.create).toHaveBeenCalledOnce();

    mocks.getValue.mockReturnValue("ha");
    mocks.onChange?.("ha");
    await nextTick();

    expect(editValue.value).toBe("ha");
    expect(mocks.setValue).not.toHaveBeenCalled();

    editValue.value = "external value";
    await nextTick();
    expect(mocks.setValue).toHaveBeenCalledWith("external value", "VARCHAR");

    composable.detailsEditorContainer.value = undefined;
    await nextTick();
    scope.stop();
  });
});
