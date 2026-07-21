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
  return {
    Check: icon,
    ChevronDown: icon,
    ChevronUp: icon,
    ChevronLeft: icon,
    ChevronRight: icon,
    ChevronsLeft: icon,
    ChevronsRight: icon,
    Filter: icon,
    Loader2: icon,
    Upload: icon,
    Search: icon,
    X: icon,
    Code2: icon,
    Copy: icon,
    Eye: icon,
    EyeOff: icon,
    Info: icon,
    Pencil: icon,
    Plus: icon,
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
import DataGridQueryControls from "@/components/grid/DataGridQueryControls.vue";
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
  it("clips long selected values inside the filter grid", () => {
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
    const ruleGrid = findOne(mounted.root, (node) => String(node.props.class).includes("grid-cols-[minmax(0,1fr)_80px_minmax(0,1fr)_auto]"));
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
    expect(String(ruleGrid.props.class)).toContain("grid-cols-[minmax(0,1fr)_80px_minmax(0,1fr)_auto]");
    for (const trigger of triggers) {
      expect(String(trigger.props.class)).toContain("w-full");
      expect(String(trigger.props.class)).toContain("overflow-hidden");
      expect(String(trigger.props.class)).toContain("[&_[data-slot=select-value]]:min-w-0");
      expect(String(trigger.props.class)).toContain("[&_[data-slot=select-value]]:truncate");
    }
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

  it("adds a rule instead of applying when shift-enter is pressed in a value editor", () => {
    const onAdd = vi.fn();
    const onApply = vi.fn();
    const mounted = mountComponent(DataGridFilterBuilder, {
      rules: [{ id: "r1", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }],
      columns: ["id"],
      filteredColumns: ["id"],
      modeOptions: [{ value: "equals", labelKey: "equals" }],
      columnSearch: "",
      onAdd,
      onApply,
    });
    const valueEditor = findOne(mounted.root, (node) => node.props["data-filter-value-editor"] === "");

    const shiftEnter = dispatch(valueEditor, "keydown", { key: "Enter", shiftKey: true, repeat: false });
    expect(shiftEnter.defaultPrevented).toBe(true);
    expect(shiftEnter.propagationStopped).toBe(true);
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();

    dispatch(valueEditor, "keydown", { key: "Enter", shiftKey: false });
    expect(onApply).toHaveBeenCalledOnce();
  });
});

describe("DataGridQueryControls", () => {
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

    expect(String(popoverContent.props.class)).toContain("w-[480px]");
    expect(String(popoverContent.props.class)).toContain("max-w-[calc(100vw-24px)]");
  });

  it("keeps filter actions available in the popover", () => {
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
      onClearFilters: clearFilters,
      onApplyFilters: applyFilters,
      onResetFilters: resetFilters,
    });

    dispatch(
      findOne(mounted.root, (node) => node.type === "button" && hostText(node) === "grid.clearFilter"),
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

    expect(clearFilters).toHaveBeenCalledTimes(2);
    expect(resetFilters).toHaveBeenCalledOnce();
    expect(applyFilters).toHaveBeenCalledOnce();
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
