// @vitest-environment happy-dom

import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, hostText, mountComponent } from "./vueHostHarness";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

const mocks = vi.hoisted(() => ({
  editor: { create: vi.fn(), destroy: vi.fn(), setValue: vi.fn(), openSearch: vi.fn() },
  updateSettings: vi.fn(),
  renderWkt: vi.fn(),
  panelCancel: vi.fn(),
  panelOpenSearch: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("./vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { Check: icon, ChevronLeft: icon, ChevronRight: icon, ChevronsLeft: icon, ChevronsRight: icon, Loader2: icon, Upload: icon, Search: icon, X: icon, Code2: icon, Copy: icon, Eye: icon, EyeOff: icon, Info: icon, Pencil: icon, Plus: icon, Trash2: icon };
});

vi.mock("@/components/ui/button", async () => ({ Button: (await import("./vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("./vueHostHarness")).createPassthroughStub("Input", "input") }));
vi.mock("@/components/ui/dialog", async () => {
  const { createPassthroughStub } = await import("./vueHostHarness");
  return { Dialog: createPassthroughStub("Dialog"), DialogContent: createPassthroughStub("DialogContent"), DialogFooter: createPassthroughStub("DialogFooter"), DialogHeader: createPassthroughStub("DialogHeader"), DialogTitle: createPassthroughStub("DialogTitle") };
});
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { createPassthroughStub } = await import("./vueHostHarness");
  return { DropdownMenu: createPassthroughStub("DropdownMenu"), DropdownMenuContent: createPassthroughStub("DropdownMenuContent"), DropdownMenuItem: createPassthroughStub("DropdownMenuItem", "button"), DropdownMenuTrigger: createPassthroughStub("DropdownMenuTrigger") };
});
vi.mock("@/components/ui/popover", async () => {
  const { createPassthroughStub } = await import("./vueHostHarness");
  return { Popover: createPassthroughStub("Popover"), PopoverContent: createPassthroughStub("PopoverContent"), PopoverTrigger: createPassthroughStub("PopoverTrigger") };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { createPassthroughStub } = await import("./vueHostHarness");
  return { Tooltip: createPassthroughStub("Tooltip"), TooltipContent: createPassthroughStub("TooltipContent"), TooltipTrigger: createPassthroughStub("TooltipTrigger") };
});
vi.mock("@/components/ui/select", async () => {
  const { createPassthroughStub } = await import("./vueHostHarness");
  return { Select: createPassthroughStub("Select"), SelectContent: createPassthroughStub("SelectContent"), SelectItem: createPassthroughStub("SelectItem"), SelectTrigger: createPassthroughStub("SelectTrigger"), SelectValue: createPassthroughStub("SelectValue") };
});
vi.mock("@/components/ui/tabs", async () => ({ TabsContent: (await import("./vueHostHarness")).createPassthroughStub("TabsContent") }));
vi.mock("@/components/ui/LightDropdown.vue", async () => ({ default: (await import("./vueHostHarness")).createPassthroughStub("LightDropdown") }));
vi.mock("@/components/ui/LightTooltip.vue", async () => ({ default: (await import("./vueHostHarness")).createPassthroughStub("LightTooltip") }));
vi.mock("@/components/grid/TemporalCellEditor.vue", async () => ({ default: (await import("./vueHostHarness")).createPassthroughStub("TemporalCellEditor") }));
vi.mock("@/composables/useCellDetailEditor", () => ({ useCellDetailEditor: () => mocks.editor }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: {} } }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { cellDetailJsonFormatted: true, theme: "default", fontSize: 13, fontFamily: "monospace" }, updateEditorSettings: mocks.updateSettings }) }));
vi.mock("@/lib/dataGrid/geometryPreview", () => ({ isHexGeometry: () => false, renderWktOnCanvas: mocks.renderWkt }));
vi.mock("@/composables/useDataGridCellDetail", async () => {
  const { ref } = await import("vue");
  return {
    useDataGridCellDetail: ({ onCancel }: { onCancel: () => void }) => {
      mocks.panelCancel.mockImplementation(onCancel);
      return { geometryPreviewOpen: ref(false), geometryCanvas: ref(), detailsEditorContainer: ref(), sideJsonPreviewContainer: ref(), openSearch: mocks.panelOpenSearch };
    },
  };
});

import DataGridCellDetailDialog from "@/components/grid/DataGridCellDetailDialog.vue";
import DataGridCellDetailPanel from "@/components/grid/DataGridCellDetailPanel.vue";
import DataGridColumnHeader from "@/components/grid/DataGridColumnHeader.vue";
import DataGridFilterBuilder from "@/components/grid/DataGridFilterBuilder.vue";
import DataGridPagination from "@/components/grid/DataGridPagination.vue";
import DataGridSearchBar from "@/components/grid/DataGridSearchBar.vue";

function detail(patch: Partial<DataGridCellDetail> = {}): DataGridCellDetail {
  return {
    rowNumber: 1,
    rowId: 0,
    colIndex: 0,
    column: "payload",
    type: "JSON",
    comment: "",
    value: '{"a":1}',
    rawValue: '{"a":1}',
    rawValuePreview: '{"a":1}',
    displayValue: '{"a":1}',
    displayValuePreview: '{"a":1}',
    isValuePreviewTruncated: false,
    imagePreviewUrl: null,
    length: 7,
    formattedJson: '{\n  "a": 1\n}',
    isEditable: true,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DataGridSearchBar", () => {
  it("focuses/selects the input and forwards keyboard and suggestion interactions", () => {
    const keydown = vi.fn();
    const acceptSuggestion = vi.fn();
    const hoverSuggestion = vi.fn();
    const close = vi.fn();
    const mounted = mountComponent(DataGridSearchBar, {
      open: true,
      text: "pay",
      suggestions: ["payload"],
      suggestionIndex: 0,
      matchCount: 2,
      currentMatchIndex: 0,
      hasDeferredSearchText: false,
      onKeydown: keydown,
      onAcceptSuggestion: acceptSuggestion,
      onHoverSuggestion: hoverSuggestion,
      onClose: close,
    });
    const input = findOne(mounted.root, (node) => node.type === "input");

    mounted.exposed.value.focus(true);
    expect(input.focused).toBe(true);
    expect(input.selected).toBe(true);
    dispatch(input, "keydown", { key: "Enter" });
    expect(keydown).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));

    const suggestion = findOne(mounted.root, (node) => hostText(node) === "payload" && !!node.props.onMousedown);
    const mouseDown = dispatch(suggestion, "mousedown");
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(acceptSuggestion).toHaveBeenCalledWith(0);
    dispatch(suggestion, "mouseenter");
    expect(hoverSuggestion).toHaveBeenCalledWith(0);

    const closeButton = findOne(mounted.root, (node) => node.type === "button");
    dispatch(closeButton, "click");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("DataGridPagination", () => {
  it("enforces first/previous/next/last disabled boundaries", async () => {
    const firstPage = vi.fn();
    const previousPage = vi.fn();
    const nextPage = vi.fn();
    const lastPage = vi.fn();
    const mounted = mountComponent(DataGridPagination, {
      selectionSummary: null,
      selectionSummarySumText: "",
      loading: false,
      infiniteScrollEnabled: false,
      infiniteScrollAllLoaded: false,
      pageSize: 100,
      customPageSizeInput: "",
      pageSizeMenuItems: [],
      exportMenuItems: [],
      currentPage: 1,
      canGoNextPage: false,
      canJumpLastPage: false,
      onFirstPage: firstPage,
      onPreviousPage: previousPage,
      onNextPage: nextPage,
      onLastPage: lastPage,
    });
    const navigation = findAll(mounted.root, (node) => node.props["data-stub"] === "Button" && node.props.class === "h-5 w-5 shrink-0");

    expect(navigation.map((node) => node.props.disabled)).toEqual([true, true, true, true]);
    navigation.forEach((node) => dispatch(node, "click"));
    expect(firstPage).not.toHaveBeenCalled();
    expect(previousPage).not.toHaveBeenCalled();
    expect(nextPage).not.toHaveBeenCalled();
    expect(lastPage).not.toHaveBeenCalled();

    await mounted.setProps({ currentPage: 2, canGoNextPage: true, canJumpLastPage: true });
    const enabledNavigation = findAll(mounted.root, (node) => node.props["data-stub"] === "Button" && node.props.class === "h-5 w-5 shrink-0");
    expect(enabledNavigation.map((node) => node.props.disabled)).toEqual([false, false, false, false]);
    enabledNavigation.forEach((node) => dispatch(node, "click"));
    expect(firstPage).toHaveBeenCalledOnce();
    expect(previousPage).toHaveBeenCalledOnce();
    expect(nextPage).toHaveBeenCalledOnce();
    expect(lastPage).toHaveBeenCalledOnce();
  });
});

describe("DataGridColumnHeader", () => {
  it("cancels resize-handle clicks without leaking header click events", () => {
    const click = vi.fn();
    const clickCapture = vi.fn();
    const resizeStart = vi.fn();
    const autoFit = vi.fn();
    const mounted = mountComponent(DataGridColumnHeader, {
      name: "id",
      actualColumnIndex: 0,
      visibleColumnIndex: 0,
      dark: true,
      copyColumnNameLabel: "copy",
      columnNameLabel: "name",
      columnTypeLabel: "type",
      columnCommentLabel: "comment",
      onClick: click,
      onClickCapture: clickCapture,
      onResizeStart: resizeStart,
      onAutoFit: autoFit,
    });
    const handle = findOne(mounted.root, (node) => node.props["data-column-resize-handle"] === "");
    const header = findOne(mounted.root, (node) => node.props["data-grid-column-index"] === 0);
    expect(String(header.props.class)).toContain("data-grid-header-cell--dark");

    const down = dispatch(handle, "mousedown");
    expect(down.propagationStopped).toBe(true);
    expect(resizeStart).toHaveBeenCalledOnce();
    const handleClick = dispatch(handle, "click");
    expect(handleClick.propagationStopped).toBe(true);
    expect(handleClick.defaultPrevented).toBe(true);
    expect(click).not.toHaveBeenCalled();
    expect(clickCapture).not.toHaveBeenCalled();
    dispatch(handle, "dblclick");
    expect(autoFit).toHaveBeenCalledOnce();
  });

  it("keeps configured type and comment lines mounted for columns without values", () => {
    const empty = mountComponent(DataGridColumnHeader, {
      name: "id",
      actualColumnIndex: 0,
      visibleColumnIndex: 0,
      showTypeLine: true,
      showCommentLine: true,
      copyColumnNameLabel: "copy",
      columnNameLabel: "name",
      columnTypeLabel: "type",
      columnCommentLabel: "comment",
    });
    const emptyType = findOne(empty.root, (node) => node.props["data-grid-header-type-line"] === "");
    const emptyComment = findOne(empty.root, (node) => node.props["data-grid-header-comment-line"] === "");

    expect(String(emptyType.props.class)).toContain("h-3");
    expect(String(emptyType.props.class)).toContain("invisible");
    expect(emptyType.props.title).toBeUndefined();
    expect(String(emptyComment.props.class)).toContain("h-3");
    expect(String(emptyComment.props.class)).toContain("invisible");
    expect(emptyComment.props.title).toBeUndefined();

    const populated = mountComponent(DataGridColumnHeader, {
      name: "status",
      actualColumnIndex: 1,
      visibleColumnIndex: 1,
      columnType: "varchar",
      columnComment: "Current status",
      showTypeLine: true,
      showCommentLine: true,
      copyColumnNameLabel: "copy",
      columnNameLabel: "name",
      columnTypeLabel: "type",
      columnCommentLabel: "comment",
    });
    const populatedType = findOne(populated.root, (node) => node.props["data-grid-header-type-line"] === "");
    const populatedComment = findOne(populated.root, (node) => node.props["data-grid-header-comment-line"] === "");

    expect(String(populatedType.props.class)).not.toContain("invisible");
    expect(populatedType.props.title).toBe("varchar");
    expect(String(populatedComment.props.class)).not.toContain("invisible");
    expect(populatedComment.props.title).toBe("Current status");
  });

  it("omits optional header lines when both display settings are off", () => {
    const mounted = mountComponent(DataGridColumnHeader, {
      name: "id",
      actualColumnIndex: 0,
      visibleColumnIndex: 0,
      columnType: "number",
      columnComment: "Identifier",
      copyColumnNameLabel: "copy",
      columnNameLabel: "name",
      columnTypeLabel: "type",
      columnCommentLabel: "comment",
    });

    expect(findAll(mounted.root, (node) => node.props["data-grid-header-type-line"] === "")).toHaveLength(0);
    expect(findAll(mounted.root, (node) => node.props["data-grid-header-comment-line"] === "")).toHaveLength(0);
  });
});

describe("DataGridFilterBuilder", () => {
  it("isolates text-entry keys while preserving popup navigation keys", () => {
    const mounted = mountComponent(DataGridFilterBuilder, { rules: [{ id: "r1", columnName: "id", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }], columns: ["id"], filteredColumns: ["id"], modeOptions: [{ value: "equals", labelKey: "equals" }], columnSearch: "" });
    const searchInput = findOne(mounted.root, (node) => node.type === "input" && node.props.placeholder === "grid.filterBuilderSearchColumns");

    expect(dispatch(searchInput, "keydown", { key: "a" }).propagationStopped).toBe(true);
    expect(dispatch(searchInput, "keydown", { key: "Backspace" }).propagationStopped).toBe(true);
    expect(dispatch(searchInput, "keydown", { key: "ArrowDown" }).propagationStopped).toBe(false);
    expect(dispatch(searchInput, "keydown", { key: "Process", isComposing: true }).propagationStopped).toBe(true);
  });
});

describe("cell detail surfaces", () => {
  it("copies the presented value, emits edit, closes, and replaces the JSON result", async () => {
    const copyText = vi.fn();
    const edit = vi.fn();
    const updateOpen = vi.fn();
    const mounted = mountComponent(DataGridCellDetailDialog, { open: true, detail: detail(), typeColorClass: () => "", openImagePreview: vi.fn(), copyText, canDownloadBinaryValue: () => false, downloadBinaryValue: vi.fn(), onEdit: edit, "onUpdate:open": updateOpen });
    await nextTick();
    await nextTick();

    const copyValue = findOne(mounted.root, (node) => node.props.title === "grid.copyValue");
    dispatch(copyValue, "click");
    expect(copyText).toHaveBeenCalledWith('{\n  "a": 1\n}');
    dispatch(
      findOne(mounted.root, (node) => node.props.title === "grid.editValue"),
      "click",
    );
    expect(edit).toHaveBeenCalledOnce();

    await mounted.setProps({ detail: detail({ rawValue: '{"b":2}', formattedJson: '{\n  "b": 2\n}' }) });
    expect(mocks.editor.setValue).toHaveBeenCalledWith('{\n  "b": 2\n}', "json");
    await mounted.setProps({ detail: detail({ value: null, rawValue: "", formattedJson: "" }) });
    expect(mocks.editor.destroy).toHaveBeenCalledOnce();

    const dialog = findOne(mounted.root, (node) => node.props["data-stub"] === "Dialog");
    dialog.props["onUpdate:open"](false);
    expect(updateOpen).toHaveBeenCalledWith(false);
  });

  it("forwards panel edit/copy/cancel actions and exposes search", () => {
    const startEdit = vi.fn();
    const copyValue = vi.fn();
    const cancel = vi.fn();
    const mounted = mountComponent(DataGridCellDetailPanel, {
      detail: detail({ formattedJson: "" }),
      panelIsBottom: false,
      metadataCollapsed: false,
      valueFillsHeight: false,
      editing: false,
      sideJsonView: false,
      showCompactJson: false,
      canCompactJson: false,
      typeColorClass: () => "",
      canDownloadBinaryValue: () => false,
      downloadBinaryValue: vi.fn(),
      openImagePreview: vi.fn(),
      canCopySqlCondition: () => true,
      onStartEdit: startEdit,
      onCopyValue: copyValue,
      onCancel: cancel,
    });

    dispatch(
      findOne(mounted.root, (node) => node.props.title === "grid.editValue"),
      "click",
    );
    dispatch(
      findOne(mounted.root, (node) => node.props.title === "grid.copyValue"),
      "click",
    );
    dispatch(
      findOne(mounted.root, (node) => node.type === "pre"),
      "dblclick",
    );
    expect(startEdit).toHaveBeenCalledTimes(2);
    expect(copyValue).toHaveBeenCalledOnce();
    mocks.panelCancel();
    expect(cancel).toHaveBeenCalledOnce();
    mounted.exposed.value.openSearch();
    expect(mocks.panelOpenSearch).toHaveBeenCalledOnce();
  });
});
