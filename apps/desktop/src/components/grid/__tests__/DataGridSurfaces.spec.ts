// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
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
  return {
    Check: icon,
    ChevronDown: icon,
    ChevronUp: icon,
    ChevronLeft: icon,
    ChevronRight: icon,
    ChevronsLeft: icon,
    ChevronsRight: icon,
    Download: icon,
    Filter: icon,
    FileDiff: icon,
    Loader2: icon,
    FileUp: icon,
    Upload: icon,
    Search: icon,
    X: icon,
    Code2: icon,
    Copy: icon,
    Eye: icon,
    EyeOff: icon,
    GripVertical: icon,
    Info: icon,
    Pencil: icon,
    Plus: icon,
    RotateCcw: icon,
    Trash2: icon,
  };
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
vi.mock("@/components/ui/switch", async () => ({ Switch: (await import("./vueHostHarness")).createPassthroughStub("Switch", "button") }));
vi.mock("@/components/ui/label", async () => ({ Label: (await import("./vueHostHarness")).createPassthroughStub("Label", "label") }));
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
import DataGridCopyColumnNamesDialog from "@/components/grid/DataGridCopyColumnNamesDialog.vue";
import DataGridFilterBuilder from "@/components/grid/DataGridFilterBuilder.vue";
import DataGridFilterWorkbench from "@/components/grid/DataGridFilterWorkbench.vue";
import DataGridTextFilterWorkbench from "@/components/grid/DataGridTextFilterWorkbench.vue";
import DataGridPagination from "@/components/grid/DataGridPagination.vue";
import DataGridQueryControls from "@/components/grid/DataGridQueryControls.vue";
import DataGridSearchBar from "@/components/grid/DataGridSearchBar.vue";

const dataGridSource = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");

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

function localDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem("dbx-filter-builder-value-shortcut-hint-days");
});
describe("DataGrid canvas surfaces", () => {
  it("uses the stable overlay for viewport and device-pixel measurement", () => {
    expect(dataGridSource).toContain("function canvasMeasurementSurface(): HTMLElement | null");
    expect(dataGridSource).toContain("return canvasOverlayRef.value ?? null;");
    expect(dataGridSource).toContain("const measurementSurface = canvasMeasurementSurface();");
    expect(dataGridSource).toContain("getSurface: canvasMeasurementSurface,");
    expect(dataGridSource).toContain("const canvas = inactiveCanvasSurface();");
    expect(dataGridSource).toContain("canvasUsingBackSurface.value = !canvasUsingBackSurface.value;");
  });

  it("uses the canvas that actually received the event during a surface flip", () => {
    expect(dataGridSource).toContain("function canvasEventSurface(event: MouseEvent): HTMLCanvasElement | null");
    expect(dataGridSource).toContain("const currentTarget = event.currentTarget;");
    expect(dataGridSource).toContain("return currentTarget instanceof HTMLCanvasElement ? currentTarget : activeCanvasSurface();");
    expect(dataGridSource).toContain("const canvas = canvasEventSurface(event);");

    const canvasMouseMove = dataGridSource.slice(dataGridSource.indexOf("function onCanvasMouseMove"), dataGridSource.indexOf("function onCanvasMouseLeave"));
    expect(canvasMouseMove).toContain("const cursorSurface = canvasEventSurface(event);");
  });

  it("handles double clicks on the stable canvas container", () => {
    expect(dataGridSource).toContain('@dblclick="onCanvasDblClick"');
    expect(dataGridSource.match(/@dblclick="onCanvasDblClick"/g)).toHaveLength(1);
    expect(dataGridSource).toContain("@dblclick.stop");
  });
});

describe("DataGridSearchBar", () => {
  it("focuses/selects the input and forwards keyboard, navigation, and suggestion interactions", async () => {
    const keydown = vi.fn();
    const acceptSuggestion = vi.fn();
    const hoverSuggestion = vi.fn();
    const navigate = vi.fn();
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
      onNavigate: navigate,
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

    const previousButton = findOne(mounted.root, (node) => node.props["aria-label"] === "search.prevMatch");
    const nextButton = findOne(mounted.root, (node) => node.props["aria-label"] === "search.nextMatch");
    expect(dispatch(previousButton, "mousedown").defaultPrevented).toBe(true);
    dispatch(previousButton, "click");
    dispatch(nextButton, "click");
    expect(navigate.mock.calls).toEqual([[-1], [1]]);

    const closeButton = findOne(mounted.root, (node) => node.props["aria-label"] === "search.close");
    dispatch(closeButton, "click");
    expect(close).toHaveBeenCalledOnce();

    await mounted.setProps({ matchCount: 0 });
    expect(previousButton.props.disabled).toBe(true);
    expect(nextButton.props.disabled).toBe(true);
  });
});

describe("DataGridPagination", () => {
  it("keeps drag summaries count-only and wires the derived average without materializing selected cells", () => {
    const summaryStart = dataGridSource.indexOf("const selectionSummary = computed");
    const pendingSummary = dataGridSource.indexOf("createPendingSelectionSummary(selectedCellCount.value, multiRowCount.value)", summaryStart);
    const materializedSummary = dataGridSource.indexOf("summarizeSelection(selectedCells.value)", summaryStart);

    expect(summaryStart).toBeGreaterThan(-1);
    expect(pendingSummary).toBeGreaterThan(summaryStart);
    expect(materializedSummary).toBeGreaterThan(pendingSummary);
    expect(dataGridSource).toContain('const selectionSummaryAverageText = computed(() => {\n  if (isSelectingCells.value) return "…";');
    expect(dataGridSource).toContain(':selection-summary-average-text="selectionSummaryAverageText"');
  });

  it("shows average beside the existing selection summary values", () => {
    const mounted = mountComponent(DataGridPagination, {
      selectionSummary: { cellCount: 4, rowCount: 2 },
      selectionSummarySumText: "10",
      selectionSummaryAverageText: "2.5",
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
    });

    const summaryText = hostText(mounted.root);
    expect(summaryText).toContain("grid.selectionSum");
    expect(summaryText).toContain("grid.selectionAverage");
    expect(summaryText).toContain("grid.selectionCells");
    expect(summaryText).toContain("grid.rows");
  });

  it("enforces first/previous/next/last disabled boundaries", async () => {
    const firstPage = vi.fn();
    const previousPage = vi.fn();
    const nextPage = vi.fn();
    const lastPage = vi.fn();
    const mounted = mountComponent(DataGridPagination, {
      selectionSummary: null,
      selectionSummarySumText: "",
      selectionSummaryAverageText: "",
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

    await mounted.setProps({ loading: true });
    const busyNavigation = findAll(mounted.root, (node) => node.props["data-stub"] === "Button" && node.props.class === "h-5 w-5 shrink-0");
    expect(busyNavigation.map((node) => node.props.disabled)).toEqual([true, true, true, true]);
    expect(findOne(mounted.root, (node) => node.props["aria-label"] === "grid.jumpToPage").props.disabled).toBe(true);
  });

  it("jumps to an entered page and enforces page input boundaries", async () => {
    const jumpPage = vi.fn();
    const mounted = mountComponent(DataGridPagination, {
      selectionSummary: null,
      selectionSummarySumText: "",
      selectionSummaryAverageText: "",
      loading: false,
      infiniteScrollEnabled: false,
      infiniteScrollAllLoaded: false,
      pageSize: 100,
      customPageSizeInput: "",
      pageSizeMenuItems: [],
      exportMenuItems: [],
      currentPage: 3,
      maxPage: 12,
      canGoNextPage: true,
      canJumpLastPage: true,
      onJumpPage: jumpPage,
    });
    const pageInput = findOne(mounted.root, (node) => node.props["aria-label"] === "grid.jumpToPage");

    expect(pageInput.props.modelValue).toBe("3");
    pageInput.props["onUpdate:modelValue"]("8");
    await nextTick();
    const enter = dispatch(pageInput, "keydown", { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(enter.propagationStopped).toBe(true);
    expect(jumpPage).toHaveBeenLastCalledWith(8);

    pageInput.props["onUpdate:modelValue"]("99");
    await nextTick();
    dispatch(pageInput, "keydown", { key: "Enter" });
    expect(jumpPage).toHaveBeenLastCalledWith(12);

    pageInput.props["onUpdate:modelValue"]("0");
    await nextTick();
    dispatch(pageInput, "keydown", { key: "Enter" });
    await nextTick();
    const resetPageInput = findOne(mounted.root, (node) => node.props["aria-label"] === "grid.jumpToPage");
    expect(jumpPage).toHaveBeenCalledTimes(2);
    expect(resetPageInput.props.modelValue).toBe("3");
  });

  it("hides pagination controls when the data source does not support paging", () => {
    const mounted = mountComponent(DataGridPagination, {
      paginationEnabled: false,
      selectionSummary: null,
      selectionSummarySumText: "",
      selectionSummaryAverageText: "",
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
    });

    expect(findAll(mounted.root, (node) => node.props["data-stub"] === "Button" && node.props.class === "h-5 w-5 shrink-0")).toHaveLength(0);
  });
});

describe("DataGridColumnHeader", () => {
  it("limits the metadata tooltip trigger to the column text block", () => {
    const mounted = mountComponent(DataGridColumnHeader, {
      name: "status",
      actualColumnIndex: 0,
      visibleColumnIndex: 0,
      copyColumnNameLabel: "copy",
      columnNameLabel: "name",
      columnTypeLabel: "type",
      columnCommentLabel: "comment",
    });
    const tooltip = findOne(mounted.root, (node) => node.props["data-stub"] === "LightTooltip");
    const trigger = findOne(mounted.root, (node) => node.props["data-column-tooltip-trigger"] === "");
    const actions = findOne(mounted.root, (node) => node.props["data-column-header-actions"] === "");
    const resizeHandle = findOne(mounted.root, (node) => node.props["data-column-resize-handle"] === "");

    expect(trigger.parent).toBe(tooltip);
    expect(actions.parent).not.toBe(tooltip);
    expect(resizeHandle.parent).not.toBe(tooltip);
  });

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

  it("shows column nullability in the header tooltip without an inline badge", () => {
    const baseProps = {
      name: "nickname",
      actualColumnIndex: 1,
      visibleColumnIndex: 1,
      copyColumnNameLabel: "copy",
      columnNameLabel: "name",
      columnTypeLabel: "type",
      columnCommentLabel: "comment",
      nullableLabel: "nullable",
      yesLabel: "yes",
      noLabel: "no",
      columnIndexLabel: "index",
      columnPrimaryIndexLabel: "primary",
      columnUniqueIndexLabel: "unique",
      columnRegularIndexLabel: "regular",
    };
    const nullable = mountComponent(DataGridColumnHeader, { ...baseProps, columnNullability: "nullable" });
    const required = mountComponent(DataGridColumnHeader, { ...baseProps, columnNullability: "required" });

    expect(findAll(nullable.root, (node) => node.props["data-grid-header-nullable"] === "")).toHaveLength(0);
    expect(findAll(required.root, (node) => node.props["data-grid-header-nullable"] === "")).toHaveLength(0);
    expect(hostText(nullable.root)).toContain("nullableyes");
    expect(hostText(required.root)).toContain("nullableno");
  });
});

describe("DataGridFilterBuilder", () => {
  it("renders a compact text rule without framed form controls", async () => {
    const updateRule = vi.fn();
    const add = vi.fn();
    const mounted = mountComponent(DataGridFilterBuilder, {
      rules: [{ id: "r1", columnName: "account_id", mode: "equals", rawValue: "7", rawEndValue: "", conjunction: "AND" }],
      columns: ["account_id"],
      filteredColumns: ["account_id"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      layout: "text",
      showHeader: false,
      showFooter: false,
      onUpdateRule: updateRule,
      onAdd: add,
    });
    const ruleGrid = findOne(mounted.root, (node) => String(node.props.class).includes("grid-cols-[18px_22px_var(--filter-builder-column-width)_92px_minmax(140px,1fr)_auto]"));
    const enabledCheckbox = findOne(mounted.root, (node) => node.props.role === "checkbox");
    const triggers = findAll(mounted.root, (node) => node.props["data-stub"] === "SelectTrigger");
    const valueEditor = findOne(mounted.root, (node) => node.props["data-filter-value-editor"] === "");
    const addButton = findOne(mounted.root, (node) => node.props["aria-label"] === "grid.filterBuilderAddRule");

    expect(enabledCheckbox.props["aria-checked"]).toBe(true);
    expect(triggers.every((trigger) => String(trigger.props.class).includes("border-0"))).toBe(true);
    expect(valueEditor.props.placeholder).toBe("grid.filterBuilderTextValue");
    expect(String(ruleGrid.props.class)).toContain("border-b");

    dispatch(enabledCheckbox, "click");
    dispatch(addButton, "click");
    dispatch(valueEditor, "keydown", { key: "Enter", shiftKey: true });
    await mounted.setProps({
      rules: [
        { id: "r1", columnName: "account_id", mode: "equals", rawValue: "7", rawEndValue: "", conjunction: "AND" },
        { id: "r2", columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" },
      ],
    });
    await nextTick();

    expect(updateRule).toHaveBeenCalledWith("r1", { disabled: true });
    expect(add).toHaveBeenCalledTimes(2);
    expect(findAll(mounted.root, (node) => node.props["data-stub"] === "Select")[2].props.open).toBe(false);
    const ruleItems = findAll(mounted.root, (node) => node.props["data-filter-rule-item"] === "");
    const conjunction = findOne(mounted.root, (node) => node.props["data-filter-conjunction"] === "");
    expect(ruleItems).toHaveLength(2);
    expect(ruleItems[1].props["data-connected"]).toBe("");
    expect(hostText(conjunction)).toBe("AND");
    dispatch(conjunction, "click");
    expect(updateRule).toHaveBeenCalledWith("r2", { conjunction: "OR" });
  });

  it("opens the first empty rule column search on request", async () => {
    const mounted = mountComponent(DataGridFilterBuilder, {
      rules: [{ id: "r1", columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      columns: ["id"],
      filteredColumns: ["id"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
    });

    await mounted.exposed.value.openFirstEmptyRuleColumnSearch();

    const columnSelect = findAll(mounted.root, (node) => node.props["data-stub"] === "Select")[0];
    expect(columnSelect.props.open).toBe(true);
  });

  it("keeps selected columns and values readable without stretching the controls", () => {
    const mounted = mountComponent(DataGridFilterBuilder, {
      rules: [{ id: "r1", columnName: "appointmentStatusWithAnExceptionallyLongName", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      columns: ["appointmentStatusWithAnExceptionallyLongName", "name"],
      filteredColumns: ["name"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
    });
    const selects = findAll(mounted.root, (node) => node.props["data-stub"] === "Select");
    const selectContents = findAll(mounted.root, (node) => node.props["data-stub"] === "SelectContent");
    const triggers = findAll(mounted.root, (node) => node.props["data-stub"] === "SelectTrigger");
    const selectValues = findAll(mounted.root, (node) => node.props["data-stub"] === "SelectValue");
    const items = findAll(mounted.root, (node) => node.props["data-stub"] === "SelectItem");
    const filterBuilder = findOne(mounted.root, (node) => String(node.props.class).includes("w-fit max-w-full"));
    const ruleGrid = findOne(mounted.root, (node) => String(node.props.class).includes("grid-cols-[18px_var(--filter-builder-column-width)_92px_var(--filter-builder-value-width)_auto]"));
    const searchInput = findOne(mounted.root, (node) => node.type === "input" && node.props.placeholder === "grid.filterBuilderSearchColumns");
    const valueEditor = findOne(mounted.root, (node) => node.props["data-filter-value-editor"] === "");

    expect(selects).toHaveLength(2);
    expect(selects[0].props["onUpdate:open"]).toEqual(expect.any(Function));
    expect(selects[0].props["onUpdate:modelValue"]).toEqual(expect.any(Function));
    expect(selectContents[0].props.onCloseAutoFocus).toEqual(expect.any(Function));
    expect(triggers).toHaveLength(2);
    expect(hostText(selectValues[0])).toBe("appointmentStatusWithAnExceptionallyLongName");
    expect(items).toHaveLength(2);
    expect(items.every((item) => String(item.props.class).includes("rounded-none"))).toBe(true);
    expect(searchInput.props.placeholder).toBe("grid.filterBuilderSearchColumns");
    expect(valueEditor.props.placeholder).toBe("grid.filterBuilderValue");
    expect(filterBuilder.props.style).toEqual({ "--filter-builder-column-width": "178px", "--filter-builder-value-width": "178px" });
    expect(String(ruleGrid.props.class)).toContain("grid-cols-[18px_var(--filter-builder-column-width)_92px_var(--filter-builder-value-width)_auto]");
    expect(String(ruleGrid.props.class)).toContain("justify-start");
    for (const trigger of triggers) {
      expect(String(trigger.props.class)).toContain("w-full");
      expect(String(trigger.props.class)).toContain("overflow-hidden");
      expect(String(trigger.props.class)).toContain("[&_[data-slot=select-value]]:min-w-0");
      expect(String(trigger.props.class)).toContain("[&_[data-slot=select-value]]:truncate");
    }
  });

  it("sizes the column control from the longest available column", () => {
    const mounted = mountComponent(DataGridFilterBuilder, {
      rules: [{ id: "r1", columnName: "id", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      columns: ["id", "name"],
      filteredColumns: ["id", "name"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
    });
    const filterBuilder = findOne(mounted.root, (node) => String(node.props.class).includes("w-fit max-w-full"));

    expect(filterBuilder.props.style).toEqual({ "--filter-builder-column-width": "88px", "--filter-builder-value-width": "178px" });
  });

  it("renders reorder handles and supports keyboard condition moves", () => {
    const move = vi.fn();
    const mounted = mountComponent(DataGridFilterBuilder, {
      rules: [
        { id: "r1", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" },
        { id: "r2", columnName: "name", mode: "equals", rawValue: "Alice", rawEndValue: "", conjunction: "AND", disabled: true },
      ],
      columns: ["id", "name"],
      filteredColumns: ["id", "name"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      onMove: move,
    });
    const handles = findAll(mounted.root, (node) => node.props["data-filter-drag-handle"] === "");

    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => handle.props.draggable === undefined)).toBe(true);
    expect(handles.every((handle) => typeof handle.props.onPointerdown === "function")).toBe(true);
    expect(handles.every((handle) => String(handle.props.class).includes("touch-none"))).toBe(true);
    expect(handles[0].props["aria-label"]).toBe("grid.filterBuilderReorderRule");
    const arrowDown = dispatch(handles[0], "keydown", { key: "ArrowDown" });
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(move).toHaveBeenCalledWith("r1", 1);
    dispatch(handles[1], "keydown", { key: "ArrowUp" });
    expect(move).toHaveBeenLastCalledWith("r2", 0);
  });

  it("keeps search focus while navigating and selecting filtered columns", async () => {
    const onUpdateRule = vi.fn();
    const onAdd = vi.fn();
    const mounted = mountComponent(DataGridFilterBuilder, {
      rules: [{ id: "r1", columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      columns: ["id", "image_size_bytes"],
      filteredColumns: ["id", "image_size_bytes"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      onUpdateRule,
      onAdd,
    });
    const columnSelect = findAll(mounted.root, (node) => node.props["data-stub"] === "Select")[0];
    const searchInput = findOne(mounted.root, (node) => node.type === "input" && node.props.placeholder === "grid.filterBuilderSearchColumns");

    columnSelect.props["onUpdate:open"](true);
    await nextTick();

    let columnItems = findAll(mounted.root, (node) => node.props["data-stub"] === "SelectItem").slice(0, 2);
    expect(columnItems[0].props["data-filter-active"]).toBe("");
    const imeKeyCodeEnter = dispatch(searchInput, "keydown", { key: "Enter", keyCode: 229 });
    expect(imeKeyCodeEnter.defaultPrevented).toBe(false);
    expect(imeKeyCodeEnter.propagationStopped).toBe(true);
    dispatch(searchInput, "compositionstart");
    dispatch(searchInput, "compositionend");
    const imeCompositionEndEnter = dispatch(searchInput, "keydown", { key: "Enter", keyCode: 13 });
    expect(imeCompositionEndEnter.defaultPrevented).toBe(false);
    expect(imeCompositionEndEnter.propagationStopped).toBe(true);
    expect(onUpdateRule).not.toHaveBeenCalled();
    expect(dispatch(searchInput, "keydown", { key: "a" }).propagationStopped).toBe(true);
    expect(dispatch(searchInput, "keydown", { key: "Backspace" }).propagationStopped).toBe(true);

    const arrowDown = dispatch(searchInput, "keydown", { key: "ArrowDown" });
    expect(arrowDown.defaultPrevented).toBe(true);
    expect(arrowDown.propagationStopped).toBe(true);
    await nextTick();
    columnItems = findAll(mounted.root, (node) => node.props["data-stub"] === "SelectItem").slice(0, 2);
    expect(columnItems[1].props["data-filter-active"]).toBe("");

    const leftInput = { value: "image_", selectionStart: 4, selectionEnd: 4, setSelectionRange: vi.fn() };
    const leftArrow = dispatch(searchInput, "keydown", { key: "ArrowLeft", currentTarget: leftInput });
    expect(leftArrow.defaultPrevented).toBe(true);
    expect(leftArrow.propagationStopped).toBe(true);
    expect(leftInput.setSelectionRange).toHaveBeenCalledWith(3, 3);

    const rightInput = { value: "image_", selectionStart: 1, selectionEnd: 4, setSelectionRange: vi.fn() };
    const rightArrow = dispatch(searchInput, "keydown", { key: "ArrowRight", currentTarget: rightInput });
    expect(rightArrow.defaultPrevented).toBe(true);
    expect(rightArrow.propagationStopped).toBe(true);
    expect(rightInput.setSelectionRange).toHaveBeenCalledWith(4, 4);

    const enter = dispatch(searchInput, "keydown", { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(enter.propagationStopped).toBe(true);
    expect(onUpdateRule).toHaveBeenCalledWith("r1", { columnName: "image_size_bytes" });
    expect(onAdd).not.toHaveBeenCalled();
    expect(dispatch(searchInput, "keydown", { key: "Process", isComposing: true }).propagationStopped).toBe(true);
  });

  it("adds another rule after selecting a column with shift-enter", async () => {
    const onUpdateRule = vi.fn();
    const secondRule = { id: "r2", columnName: "id", mode: "equals" as const, rawValue: "", rawEndValue: "", conjunction: "AND" as const };
    let mounted: ReturnType<typeof mountComponent>;
    const onAdd = vi.fn(() => {
      void mounted.setProps({ rules: [{ id: "r1", columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }, secondRule] });
    });
    mounted = mountComponent(DataGridFilterBuilder, {
      rules: [{ id: "r1", columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      columns: ["id"],
      filteredColumns: ["id"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      onUpdateRule,
      onAdd,
    });
    const columnSelect = findAll(mounted.root, (node) => node.props["data-stub"] === "Select")[0];
    const searchInput = findOne(mounted.root, (node) => node.type === "input" && node.props.placeholder === "grid.filterBuilderSearchColumns");

    columnSelect.props["onUpdate:open"](true);
    await nextTick();
    const shiftEnter = dispatch(searchInput, "keydown", { key: "Enter", shiftKey: true });

    expect(shiftEnter.defaultPrevented).toBe(true);
    expect(shiftEnter.propagationStopped).toBe(true);
    expect(onUpdateRule).toHaveBeenCalledWith("r1", { columnName: "id" });
    expect(onAdd).toHaveBeenCalledOnce();
    await nextTick();
    const columnSelects = findAll(mounted.root, (node) => node.props["data-stub"] === "Select").filter((_node, index) => index % 2 === 0);
    const firstSelectContent = findAll(mounted.root, (node) => node.props["data-stub"] === "SelectContent")[0];
    const closeAutoFocus = dispatch(firstSelectContent, "closeAutoFocus");
    expect(closeAutoFocus.defaultPrevented).toBe(true);
    expect(columnSelects).toHaveLength(2);
    expect(columnSelects[0].props.open).toBe(false);
    expect(columnSelects[1].props.open).toBe(true);
  });

  it("shows the value editor shortcut hint from the second rule twice per day for up to three days and adds a rule on shift-enter", async () => {
    const onAdd = vi.fn();
    const onApply = vi.fn();
    const mountFilterBuilder = () =>
      mountComponent(DataGridFilterBuilder, {
        rules: [
          { id: "r1", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" },
          { id: "r2", columnName: "name", mode: "equals", rawValue: "n", rawEndValue: "", conjunction: "AND" },
        ],
        columns: ["id"],
        filteredColumns: ["id"],
        modeOptions: [{ value: "equals", labelKey: "equals" }],
        columnSearch: "",
        onAdd,
        onApply,
      });
    const mounted = mountFilterBuilder();
    const valueEditors = findAll(mounted.root, (node) => node.props["data-filter-value-editor"] === "");
    const valueEditor = valueEditors[0];
    const secondValueEditor = valueEditors[1];

    expect(hostText(mounted.root)).not.toContain("grid.filterBuilderValueShortcutHint");
    dispatch(valueEditor, "focus");
    await nextTick();
    expect(hostText(mounted.root)).not.toContain("grid.filterBuilderValueShortcutHint");

    dispatch(secondValueEditor, "focus");
    await nextTick();
    expect(hostText(mounted.root)).toContain("grid.filterBuilderValueShortcutHint");
    dispatch(secondValueEditor, "blur");
    await nextTick();
    expect(hostText(mounted.root)).not.toContain("grid.filterBuilderValueShortcutHint");
    expect(JSON.parse(localStorage.getItem("dbx-filter-builder-value-shortcut-hint-days") ?? "[]")).toEqual([{ date: localDateKey(), count: 1 }]);

    dispatch(secondValueEditor, "focus");
    await nextTick();
    expect(hostText(mounted.root)).toContain("grid.filterBuilderValueShortcutHint");
    expect(JSON.parse(localStorage.getItem("dbx-filter-builder-value-shortcut-hint-days") ?? "[]")).toEqual([{ date: localDateKey(), count: 2 }]);
    dispatch(secondValueEditor, "blur");
    dispatch(secondValueEditor, "focus");
    await nextTick();
    expect(hostText(mounted.root)).not.toContain("grid.filterBuilderValueShortcutHint");

    localStorage.setItem(
      "dbx-filter-builder-value-shortcut-hint-days",
      JSON.stringify([
        { date: "2026-01-01", count: 2 },
        { date: "2026-01-02", count: 2 },
      ]),
    );
    const thirdDayMounted = mountFilterBuilder();
    const thirdDaySecondValueEditor = findAll(thirdDayMounted.root, (node) => node.props["data-filter-value-editor"] === "")[1];
    dispatch(thirdDaySecondValueEditor, "focus");
    await nextTick();
    expect(hostText(thirdDayMounted.root)).toContain("grid.filterBuilderValueShortcutHint");
    expect(JSON.parse(localStorage.getItem("dbx-filter-builder-value-shortcut-hint-days") ?? "[]")).toHaveLength(3);

    localStorage.setItem(
      "dbx-filter-builder-value-shortcut-hint-days",
      JSON.stringify([
        { date: "2026-01-01", count: 2 },
        { date: "2026-01-02", count: 2 },
        { date: "2026-01-03", count: 2 },
      ]),
    );
    const exhaustedMounted = mountFilterBuilder();
    const exhaustedSecondValueEditor = findAll(exhaustedMounted.root, (node) => node.props["data-filter-value-editor"] === "")[1];
    dispatch(exhaustedSecondValueEditor, "focus");
    await nextTick();
    expect(hostText(exhaustedMounted.root)).not.toContain("grid.filterBuilderValueShortcutHint");

    const imeKeyCodeEnter = dispatch(secondValueEditor, "keydown", { key: "Enter", keyCode: 229 });
    expect(imeKeyCodeEnter.defaultPrevented).toBe(false);
    expect(imeKeyCodeEnter.propagationStopped).toBe(true);
    dispatch(secondValueEditor, "compositionstart");
    dispatch(secondValueEditor, "compositionend");
    const imeCompositionEndEnter = dispatch(secondValueEditor, "keydown", { key: "Enter", keyCode: 13 });
    expect(imeCompositionEndEnter.defaultPrevented).toBe(false);
    expect(imeCompositionEndEnter.propagationStopped).toBe(true);
    expect(onAdd).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();

    const shiftEnter = dispatch(secondValueEditor, "keydown", { key: "Enter", shiftKey: true, repeat: false });
    expect(shiftEnter.defaultPrevented).toBe(true);
    expect(shiftEnter.propagationStopped).toBe(true);
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();

    dispatch(secondValueEditor, "keydown", { key: "Enter", shiftKey: false });
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("does not show the value editor shortcut hint for list value editors", async () => {
    const mounted = mountComponent(DataGridFilterBuilder, {
      rules: [
        { id: "r1", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" },
        { id: "r2", columnName: "name", mode: "in", rawValue: "n", rawEndValue: "", conjunction: "AND" },
      ],
      columns: ["id"],
      filteredColumns: ["id"],
      modeOptions: [
        { value: "equals", labelKey: "equals" },
        { value: "in", labelKey: "in" },
      ],
      columnSearch: "",
    });
    dispatch(
      findOne(mounted.root, (node) => node.type === "textarea"),
      "focus",
    );
    await nextTick();
    expect(hostText(mounted.root)).not.toContain("grid.filterBuilderValueShortcutHint");
  });
});

describe("DataGridQueryControls", () => {
  it("opens column search when the filter button creates the first rule", async () => {
    let mounted: ReturnType<typeof mountComponent>;
    const firstRule = { id: "r1", columnName: "", mode: "equals" as const, rawValue: "", rawEndValue: "", conjunction: "AND" as const };
    const ensureRule = vi.fn(() => {
      void mounted.setProps({ rules: [firstRule], filterBuilderOpen: true });
    });
    mounted = mountComponent(DataGridQueryControls, {
      whereInput: "",
      orderByInput: "",
      columns: ["id"],
      conditionColumns: ["id"],
      historyScope: {},
      canUseWhereSearch: true,
      compact: false,
      leadingBorder: false,
      filterBuilderOpen: false,
      filterEditorView: "quick",
      filterButtonActive: false,
      filterButtonCount: 0,
      hasLocalColumnFilters: false,
      localFilterCount: 0,
      localFilterSummaries: [],
      rules: [],
      filteredColumns: ["id"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      applyWhere: vi.fn(),
      applyOrderBy: vi.fn(),
      clearOrderBy: vi.fn(),
      onEnsureRule: ensureRule,
    });

    const filterButton = findOne(mounted.root, (node) => node.type === "button" && String(node.props.class).includes("-translate-x-1"));
    dispatch(filterButton, "click");
    await nextTick();
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await nextTick();

    const columnSelect = findAll(mounted.root, (node) => node.props["data-stub"] === "Select")[0];
    expect(ensureRule).toHaveBeenCalledOnce();
    expect(columnSelect.props.open).toBe(true);
  });

  it("does not open column search when filter rules already exist", async () => {
    let mounted: ReturnType<typeof mountComponent>;
    const ensureRule = vi.fn(() => {
      void mounted.setProps({ filterBuilderOpen: true });
    });
    mounted = mountComponent(DataGridQueryControls, {
      whereInput: "id = 1",
      orderByInput: "",
      columns: ["id"],
      conditionColumns: ["id"],
      historyScope: {},
      canUseWhereSearch: true,
      compact: false,
      leadingBorder: false,
      filterBuilderOpen: false,
      filterEditorView: "quick",
      filterButtonActive: true,
      filterButtonCount: 1,
      hasLocalColumnFilters: false,
      localFilterCount: 0,
      localFilterSummaries: [],
      rules: [{ id: "r1", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }],
      filteredColumns: ["id"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      applyWhere: vi.fn(),
      applyOrderBy: vi.fn(),
      clearOrderBy: vi.fn(),
      onEnsureRule: ensureRule,
    });

    const filterButton = findOne(mounted.root, (node) => node.type === "button" && String(node.props.class).includes("-translate-x-1"));
    dispatch(filterButton, "click");
    await nextTick();

    const columnSelect = findAll(mounted.root, (node) => node.props["data-stub"] === "Select")[0];
    expect(ensureRule).toHaveBeenCalledOnce();
    expect(columnSelect.props.open).toBe(false);
  });

  it("gives filter rules enough horizontal space for longer column names", () => {
    const mounted = mountComponent(DataGridQueryControls, {
      whereInput: "",
      orderByInput: "",
      columns: ["appointmentStatusWithAnExceptionallyLongName"],
      conditionColumns: ["appointmentStatusWithAnExceptionallyLongName"],
      historyScope: {},
      canUseWhereSearch: true,
      compact: false,
      leadingBorder: false,
      filterBuilderOpen: true,
      filterEditorView: "quick",
      filterButtonActive: false,
      filterButtonCount: 0,
      hasLocalColumnFilters: false,
      localFilterCount: 0,
      localFilterSummaries: [],
      rules: [{ id: "r1", columnName: "appointmentStatusWithAnExceptionallyLongName", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      filteredColumns: ["appointmentStatusWithAnExceptionallyLongName"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      applyWhere: vi.fn(),
      applyOrderBy: vi.fn(),
      clearOrderBy: vi.fn(),
    });
    const popoverContent = findOne(mounted.root, (node) => node.props["data-stub"] === "PopoverContent");

    expect(String(popoverContent.props.class)).toContain("w-fit");
    expect(String(popoverContent.props.class)).toContain("max-w-[calc(100vw-16px)]");
    expect(String(popoverContent.props.class)).toContain("max-h-[var(--reka-popover-content-available-height)]");
    expect(String(popoverContent.props.class)).toContain("overflow-y-auto");
    expect(popoverContent.props["data-filter-rules-scroll"]).toBe("");
    expect(popoverContent.props["collision-padding"]).toBe(8);
  });

  it("keeps filter actions available in the popover", () => {
    const addRule = vi.fn();
    const clearFilters = vi.fn();
    const applyFilters = vi.fn();
    const resetFilters = vi.fn();
    const mounted = mountComponent(DataGridQueryControls, {
      whereInput: "id = 1",
      orderByInput: "",
      columns: ["id"],
      conditionColumns: ["id"],
      historyScope: {},
      canUseWhereSearch: true,
      compact: false,
      leadingBorder: false,
      filterBuilderOpen: true,
      filterEditorView: "quick",
      filterButtonActive: true,
      filterButtonCount: 1,
      hasLocalColumnFilters: false,
      localFilterCount: 0,
      localFilterSummaries: [],
      rules: [{ id: "r1", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }],
      filteredColumns: ["id"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      applyWhere: vi.fn(),
      applyOrderBy: vi.fn(),
      clearOrderBy: vi.fn(),
      onAddRule: addRule,
      onClearFilters: clearFilters,
      onApplyFilters: applyFilters,
      onResetFilters: resetFilters,
    });

    dispatch(
      findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.clearFilter"),
      "click",
    );
    dispatch(
      findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.filterBuilderAddRule"),
      "click",
    );
    dispatch(
      findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.resetFilterBuilder"),
      "click",
    );
    dispatch(
      findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.applyFilter"),
      "click",
    );
    const whereInput = findOne(mounted.root, (node) => node.type === "textarea" && node.props.placeholder === "WHERE");
    const whereControl = whereInput.parent?.parent;
    expect(whereControl).toBeTruthy();
    const whereButtons = findAll(whereControl!, (node) => node.type === "button");
    dispatch(whereButtons[whereButtons.length - 1], "click");

    expect(addRule).toHaveBeenCalledOnce();
    expect(clearFilters).toHaveBeenCalledTimes(2);
    expect(resetFilters).toHaveBeenCalledOnce();
    expect(applyFilters).toHaveBeenCalledOnce();
  });

  it("keeps view selection out of the data grid controls", async () => {
    const mounted = mountComponent(DataGridQueryControls, {
      whereInput: "",
      orderByInput: "",
      columns: ["id"],
      conditionColumns: ["id"],
      historyScope: {},
      canUseWhereSearch: true,
      compact: false,
      leadingBorder: false,
      filterBuilderOpen: true,
      filterEditorView: "quick",
      filterButtonActive: false,
      filterButtonCount: 0,
      hasLocalColumnFilters: false,
      localFilterCount: 0,
      localFilterSummaries: [],
      rules: [{ id: "r1", columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      filteredColumns: ["id"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      applyWhere: vi.fn(),
      applyOrderBy: vi.fn(),
      clearOrderBy: vi.fn(),
    });

    expect(hostText(mounted.root)).not.toContain("grid.filterQuickView");
    expect(hostText(mounted.root)).not.toContain("grid.filterConditionView");
    expect(findAll(mounted.root, (node) => node.type === "button" && String(node.props.class).includes("-translate-x-1"))).toHaveLength(1);

    await mounted.setProps({ filterEditorView: "conditions", filterBuilderOpen: false });
    await nextTick();
    expect(findOne(mounted.root, (node) => node.type === "textarea" && node.props.placeholder === "WHERE")).toBeTruthy();
    expect(findAll(mounted.root, (node) => node.type === "button" && String(node.props.class).includes("-translate-x-1"))).toHaveLength(0);
  });
});

describe("DataGridFilterWorkbench", () => {
  it("scrolls to the newest rule when a condition is added", async () => {
    const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const firstRule = { id: "r1", columnName: "id", mode: "equals" as const, rawValue: "1", rawEndValue: "", conjunction: "AND" as const };
    const mounted = mountComponent(DataGridFilterWorkbench, {
      sqlPreview: "WHERE id = 1",
      rules: [firstRule],
      columns: ["id", "name"],
      filteredColumns: ["id", "name"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
    });
    const scroller = findOne(mounted.root, (node) => node.props["data-filter-rules-scroll"] === "") as any;
    scroller.scrollTop = 0;
    scroller.scrollHeight = 480;

    await mounted.setProps({ rules: [firstRule, { ...firstRule, id: "r2", columnName: "name" }] });
    await nextTick();

    expect(scroller.scrollTop).toBe(480);
    requestAnimationFrame.mockRestore();
  });

  it("does not auto-open field search in the conditions view", async () => {
    const mounted = mountComponent(DataGridFilterWorkbench, {
      sqlPreview: "",
      rules: [{ id: "r1", columnName: "", mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" }],
      columns: ["id", "name"],
      filteredColumns: ["id", "name"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
    });
    await nextTick();

    expect(findOne(mounted.root, (node) => node.props["data-stub"] === "Select").props.open).toBe(false);
  });

  it("exposes persistent condition editing, SQL preview, and explicit actions", async () => {
    const ensureRule = vi.fn();
    const addRule = vi.fn();
    const apply = vi.fn();
    const reset = vi.fn();
    const clear = vi.fn();
    const copySql = vi.fn();
    const updateRule = vi.fn();
    const mounted = mountComponent(DataGridFilterWorkbench, {
      sqlPreview: "WHERE (tenant_id = 7) AND (status = 'open')",
      rules: [
        { id: "r1", columnName: "tenant_id", mode: "equals", rawValue: "7", rawEndValue: "", conjunction: "AND" },
        { id: "r2", columnName: "status", mode: "equals", rawValue: "open", rawEndValue: "", conjunction: "AND" },
      ],
      columns: ["id", "tenant_id", "status"],
      filteredColumns: ["id", "tenant_id", "status"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      onEnsureRule: ensureRule,
      onAddRule: addRule,
      onApply: apply,
      onReset: reset,
      onClear: clear,
      onCopySql: copySql,
      onUpdateRule: updateRule,
    });
    await nextTick();

    expect(ensureRule).toHaveBeenCalledOnce();
    expect(hostText(mounted.root)).not.toContain("grid.filterQuickView");
    expect(hostText(mounted.root)).not.toContain("grid.filterConditionView");
    expect(hostText(mounted.root)).toContain("grid.clearFilter");
    expect(hostText(mounted.root)).toContain("WHERE (tenant_id = 7) AND (status = 'open')");
    const ruleScroller = findOne(mounted.root, (node) => node.props["data-filter-rules-scroll"] === "");
    expect(String(ruleScroller.props.class)).toContain("overflow-auto");
    const conjunctions = findAll(mounted.root, (node) => node.props["data-filter-conjunction"] === "");
    const ruleItems = findAll(mounted.root, (node) => node.props["data-filter-rule-item"] === "");
    expect(conjunctions).toHaveLength(1);
    expect(hostText(conjunctions[0])).toBe("AND");
    expect(ruleItems[1].props["data-connected"]).toBe("");
    dispatch(conjunctions[0], "click");
    expect(updateRule).toHaveBeenCalledWith("r2", { conjunction: "OR" });

    dispatch(
      findOne(mounted.root, (node) => node.props["aria-label"] === "grid.copyFilterSql"),
      "click",
    );
    dispatch(
      findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.filterBuilderAddRule"),
      "click",
    );
    const resetButton = findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.resetFilterBuilder");
    expect(resetButton.props.variant).toBe("outline");
    dispatch(resetButton, "click");
    dispatch(
      findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.applyFilter"),
      "click",
    );
    dispatch(
      findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.clearFilter"),
      "click",
    );

    expect(copySql).toHaveBeenCalledOnce();
    expect(addRule).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("shows the empty preview state without enabling copy", () => {
    const mounted = mountComponent(DataGridFilterWorkbench, {
      sqlPreview: "",
      rules: [],
      columns: [],
      filteredColumns: [],
      modeOptions: [],
      columnSearch: "",
    });

    expect(hostText(mounted.root)).toContain("grid.filterSqlPreviewEmpty");
    expect(findOne(mounted.root, (node) => node.props["aria-label"] === "grid.copyFilterSql").props.disabled).toBe(true);
  });
});

describe("DataGridTextFilterWorkbench", () => {
  it("exposes a persisted keyboard-resizable text filter panel", async () => {
    const ensureRule = vi.fn();
    const updateHeight = vi.fn();
    const addRule = vi.fn();
    const mounted = mountComponent(DataGridTextFilterWorkbench, {
      height: 168,
      sqlPreview: "WHERE account_id = 7",
      rules: [{ id: "r1", columnName: "account_id", mode: "equals", rawValue: "7", rawEndValue: "", conjunction: "AND" }],
      columns: ["account_id"],
      filteredColumns: ["account_id"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      onEnsureRule: ensureRule,
      onAddRule: addRule,
      "onUpdate:height": updateHeight,
    });
    await nextTick();
    const panel = findOne(mounted.root, (node) => node.props["data-grid-text-filter-workbench"] === "");
    const rulesArea = findOne(mounted.root, (node) => node.props["data-filter-rules-scroll"] === "") as any;
    const resizeHandle = findOne(mounted.root, (node) => node.props.role === "separator");
    const resetButton = findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.resetFilterBuilder");

    expect(ensureRule).toHaveBeenCalledOnce();
    expect(panel.props.style).toEqual({ height: "168px", maxHeight: "55vh" });
    expect(resizeHandle.props["aria-valuenow"]).toBe(168);
    const addTooltip = findOne(mounted.root, (node) => node.props["data-stub"] === "Tooltip");
    expect(addTooltip.props.delayDuration ?? addTooltip.props["delay-duration"]).toBe(800);
    expect(hostText(addTooltip)).toContain("Shift+Enter");
    expect(resetButton.props.variant).toBe("outline");

    rulesArea.focus = vi.fn();
    dispatch(rulesArea, "pointerdown");
    const addShortcut = dispatch(rulesArea, "keydown", { key: "Enter", shiftKey: true });
    dispatch(rulesArea, "keydown", { key: "Enter", shiftKey: false });
    expect(rulesArea.focus).toHaveBeenCalledOnce();
    expect(addShortcut.defaultPrevented).toBe(true);
    expect(addShortcut.propagationStopped).toBe(true);
    expect(addRule).toHaveBeenCalledOnce();

    dispatch(resizeHandle, "keydown", { key: "ArrowDown" });
    await nextTick();
    expect(updateHeight).toHaveBeenCalledWith(176);
  });
});

describe("cell detail surfaces", () => {
  it("presents printable LONG BLOB bytes as text and copies the presented value", async () => {
    const copyText = vi.fn();
    const blobDetail = detail({
      type: "LONGBLOB",
      value: "0x2332303035383035",
      rawValue: "0x2332303035383035",
      rawValuePreview: "0x2332303035383035",
      displayValue: "#2005805",
      displayValuePreview: "#2005",
      formattedJson: "",
    });
    const dialog = mountComponent(DataGridCellDetailDialog, {
      open: true,
      detail: blobDetail,
      typeColorClass: () => "",
      openImagePreview: vi.fn(),
      copyText,
      canDownloadBinaryValue: () => true,
      downloadBinaryValue: vi.fn(),
      canImportBinaryValue: () => false,
      importBinaryValue: vi.fn(),
      databaseType: "mysql",
    });
    const panel = mountComponent(DataGridCellDetailPanel, {
      detail: blobDetail,
      panelIsBottom: true,
      metadataCollapsed: false,
      valueFillsHeight: false,
      editing: false,
      sideJsonView: false,
      showCompactJson: false,
      canCompactJson: false,
      typeColorClass: () => "",
      canDownloadBinaryValue: () => true,
      downloadBinaryValue: vi.fn(),
      canImportBinaryValue: () => false,
      importBinaryValue: vi.fn(),
      openImagePreview: vi.fn(),
      canCopySqlCondition: () => true,
      databaseType: "mysql",
    });

    expect(hostText(dialog.root)).toContain("#2005");
    expect(hostText(dialog.root)).not.toContain("#2005805");
    expect(hostText(panel.root)).toContain("#2005");
    expect(hostText(panel.root)).not.toContain("#2005805");
    dispatch(
      findOne(dialog.root, (node) => node.props.title === "grid.copyValue"),
      "click",
    );
    expect(copyText).toHaveBeenCalledWith("#2005805");
  });

  it("keeps non-MySQL BLOB detail previews in hex", () => {
    const panel = mountComponent(DataGridCellDetailPanel, {
      detail: detail({ type: "BLOB", value: "0x2332303035383035", rawValue: "0x2332303035383035", rawValuePreview: "0x2332303035383035", displayValue: "BLOB [8 bytes]", displayValuePreview: "BLOB [8 bytes]", formattedJson: "" }),
      panelIsBottom: true,
      metadataCollapsed: false,
      valueFillsHeight: false,
      editing: false,
      sideJsonView: false,
      showCompactJson: false,
      canCompactJson: false,
      typeColorClass: () => "",
      canDownloadBinaryValue: () => true,
      downloadBinaryValue: vi.fn(),
      canImportBinaryValue: () => false,
      importBinaryValue: vi.fn(),
      openImagePreview: vi.fn(),
      canCopySqlCondition: () => true,
      databaseType: "sqlite",
    });

    expect(hostText(panel.root)).toContain("0x2332303035383035");
  });

  it("keeps non-text LONG BLOB values in hex", () => {
    const panel = mountComponent(DataGridCellDetailPanel, {
      detail: detail({ type: "LONGBLOB", value: "0x89504e470d0a1a0a", rawValue: "0x89504e470d0a1a0a", rawValuePreview: "0x89504e470d0a1a0a", formattedJson: "" }),
      panelIsBottom: true,
      metadataCollapsed: false,
      valueFillsHeight: false,
      editing: false,
      sideJsonView: false,
      showCompactJson: false,
      canCompactJson: false,
      typeColorClass: () => "",
      canDownloadBinaryValue: () => true,
      downloadBinaryValue: vi.fn(),
      canImportBinaryValue: () => false,
      importBinaryValue: vi.fn(),
      openImagePreview: vi.fn(),
      canCopySqlCondition: () => true,
      databaseType: "mysql",
    });

    expect(hostText(panel.root)).toContain("0x89504e470d0a1a0a");
  });

  it("copies the presented value, emits edit, closes, and replaces the JSON result", async () => {
    const copyText = vi.fn();
    const edit = vi.fn();
    const updateOpen = vi.fn();
    const importBinaryValue = vi.fn();
    const mounted = mountComponent(DataGridCellDetailDialog, {
      open: true,
      detail: detail({ type: "BYTEA", isEditable: true }),
      typeColorClass: () => "",
      openImagePreview: vi.fn(),
      copyText,
      canDownloadBinaryValue: () => false,
      downloadBinaryValue: vi.fn(),
      canImportBinaryValue: () => true,
      importBinaryValue,
      onEdit: edit,
      "onUpdate:open": updateOpen,
    });
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
    dispatch(
      findOne(mounted.root, (node) => node.props.title === "grid.importBinaryValue"),
      "click",
    );
    expect(importBinaryValue).toHaveBeenCalledOnce();

    await mounted.setProps({ detail: detail({ rawValue: '{"b":2}', formattedJson: '{\n  "b": 2\n}' }) });
    expect(mocks.editor.setValue).toHaveBeenCalledWith('{\n  "b": 2\n}', "json");
    await mounted.setProps({ detail: detail({ value: null, rawValue: "", formattedJson: "" }) });
    expect(mocks.editor.destroy).toHaveBeenCalledOnce();

    const dialog = findOne(mounted.root, (node) => node.props["data-stub"] === "Dialog");
    dialog.props["onUpdate:open"](false);
    expect(updateOpen).toHaveBeenCalledWith(false);
  });

  it("forwards panel actions and only starts JSON editing from preview whitespace", async () => {
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
      canImportBinaryValue: () => false,
      importBinaryValue: vi.fn(),
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

    await mounted.setProps({ detail: detail() });
    const jsonPreview = findOne(mounted.root, (node) => node.props["data-cell-detail-json-preview"] === "");
    const doubleClickCapture = jsonPreview.props.onDblclickCapture;
    const textLine = {
      ownerDocument: {
        createRange: () => ({
          selectNodeContents: vi.fn(),
          getClientRects: () => [{ left: 10, right: 110, top: 20, bottom: 40 }],
        }),
      },
    };
    const lineTarget = { closest: (selector: string) => (selector === ".cm-line" ? textLine : null) };

    doubleClickCapture({ target: lineTarget, clientX: 60, clientY: 30 });
    expect(startEdit).toHaveBeenCalledTimes(2);

    doubleClickCapture({ target: lineTarget, clientX: 160, clientY: 30 });
    doubleClickCapture({ target: { closest: () => null }, clientX: 60, clientY: 80 });
    expect(startEdit).toHaveBeenCalledTimes(4);
  });

  it("only enables JSON comparison for changed drafts and prevents editor blur on pointer down", async () => {
    const compareJson = vi.fn();
    const mounted = mountComponent(DataGridCellDetailPanel, {
      detail: detail(),
      panelIsBottom: true,
      metadataCollapsed: false,
      valueFillsHeight: true,
      editing: true,
      sideJsonView: false,
      showCompactJson: true,
      canCompactJson: true,
      showCompareJson: true,
      canCompareJson: false,
      typeColorClass: () => "",
      canDownloadBinaryValue: () => false,
      downloadBinaryValue: vi.fn(),
      canImportBinaryValue: () => false,
      importBinaryValue: vi.fn(),
      openImagePreview: vi.fn(),
      canCopySqlCondition: () => true,
      onCompareJson: compareJson,
    });

    const disabledCompare = findOne(mounted.root, (node) => node.props.title === "grid.compareJson");
    expect(disabledCompare.props.disabled).toBe(true);
    dispatch(disabledCompare, "click");
    expect(compareJson).not.toHaveBeenCalled();

    await mounted.setProps({ canCompareJson: true });
    const enabledCompare = findOne(mounted.root, (node) => node.props.title === "grid.compareJson");
    expect(dispatch(enabledCompare, "mousedown").defaultPrevented).toBe(true);
    dispatch(enabledCompare, "click");
    expect(compareJson).toHaveBeenCalledOnce();
  });

  it("snapshots comparison values before opening and suppresses modal-induced blur commits", () => {
    expect(dataGridSource).toContain("detailValueDiffSnapshot.value = snapshot;");
    expect(dataGridSource).toContain("detailValueDiffOpen.value = true;");
    expect(dataGridSource).toContain("if (!detailValueDiffOpen.value) commitValueEditorEdit();");
    expect(dataGridSource).toContain(':disabled="!canCompareDetailJson" @mousedown.prevent @click="openDetailJsonCompare"');
    expect(dataGridSource).toContain('v-model:open="detailValueDiffOpen" :snapshot="detailValueDiffSnapshot"');
  });
});

describe("DataGridCopyColumnNamesDialog", () => {
  beforeEach(() => {
    localStorage.removeItem("dbx-copy-column-names-separator");
  });

  function previewText(mounted: ReturnType<typeof mountComponent>) {
    return hostText(findOne(mounted.root, (node) => node.props["data-copy-column-names-preview"] === ""));
  }

  it("previews the formatted names and copies with the chosen separator and quoting", async () => {
    const copy = vi.fn();
    const openChange = vi.fn();
    const mounted = mountComponent(DataGridCopyColumnNamesDialog, {
      open: true,
      columnNames: ["id", "type"],
      databaseType: "mysql",
      onCopy: copy,
      "onUpdate:open": openChange,
    });
    expect(previewText(mounted)).toBe("id\ttype");

    findOne(mounted.root, (node) => node.props["data-stub"] === "Select").props["onUpdate:modelValue"]("comma-newline");
    findOne(mounted.root, (node) => node.props["data-stub"] === "Switch").props["onUpdate:modelValue"](true);
    await nextTick();
    expect(previewText(mounted)).toBe("`id`,\n`type`");

    dispatch(
      findOne(mounted.root, (node) => node.props["data-stub"] === "Button" && hostText(node) === "grid.copy"),
      "click",
    );
    expect(copy).toHaveBeenCalledWith("`id`,\n`type`");
    expect(openChange).toHaveBeenCalledWith(false);
    expect(localStorage.getItem("dbx-copy-column-names-separator")).toBe("comma-newline");
  });

  it("hides the quote option for non-SQL databases and ignores invalid separators", async () => {
    const mounted = mountComponent(DataGridCopyColumnNamesDialog, {
      open: true,
      columnNames: ["id", "type"],
      databaseType: "mongodb",
      onCopy: vi.fn(),
    });
    expect(findAll(mounted.root, (node) => node.props["data-stub"] === "Switch")).toHaveLength(0);

    findOne(mounted.root, (node) => node.props["data-stub"] === "Select").props["onUpdate:modelValue"]("bogus");
    await nextTick();
    expect(previewText(mounted)).toBe("id\ttype");
  });
});
