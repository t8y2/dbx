import { computed, ref, type Ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDataGridPendingSnapshot, DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, useDataGridEditor } from "@/composables/useDataGridEditor";
import type { CellValue } from "@/lib/dataGrid/cellValue";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  prepareDataGridSave: vi.fn(),
  executeBatch: vi.fn(),
  executeInTransaction: vi.fn(),
  addHistory: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  prepareDataGridSave: mocks.prepareDataGridSave,
  executeBatch: mocks.executeBatch,
  executeInTransaction: mocks.executeInTransaction,
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: mocks.getConfig }),
}));
vi.mock("@/stores/historyStore", () => ({
  useHistoryStore: () => ({ add: mocks.addHistory }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({
  useProductionSafetyStore: () => ({}),
}));

function createEditor(sourceColumns?: Array<string | undefined>, confirmDangerousRowDeletion = true, cacheKey?: string) {
  let editor: ReturnType<typeof useDataGridEditor>;
  const result = ref<{ columns: string[]; rows: CellValue[][] }>({
    columns: ["first", "hidden", "last"],
    rows: [],
  });

  editor = useDataGridEditor({
    result: computed(() => result.value),
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => "connection-1"),
    database: computed(() => "app"),
    tableMeta: computed(() => ({
      tableName: "people",
      columns: [
        { name: "first", data_type: "varchar" },
        { name: "hidden", data_type: "varchar" },
        { name: "last", data_type: "varchar" },
      ],
      primaryKeys: [],
    })),
    sourceColumns: computed(() => sourceColumns),
    onExecuteSql: computed(() => undefined),
    sql: computed(() => undefined),
    searchText: ref(""),
    whereFilterInput: ref(""),
    currentWhereInput: computed(() => undefined),
    orderByInput: ref(""),
    rowStatusFilter: ref("all"),
    confirmDangerousRowDeletion: computed(() => confirmDangerousRowDeletion),
    pageSize: ref(100),
    currentPage: ref(1),
    cacheKey: computed(() => cacheKey),
    getRowItem: (rowId) => {
      if (rowId === DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID) {
        return {
          id: rowId,
          data: editor.quickEntryDraftRow.value,
          isNew: false,
          isDraft: true,
          isDeleted: false,
          isDirtyCol: [false, false, false],
          status: "draft",
        };
      }
      const newIndex = -rowId - 1;
      const row = editor.newRows.value[newIndex];
      if (!row) return undefined;
      return {
        id: rowId,
        newIndex,
        data: row,
        isNew: true,
        isDeleted: false,
        isDirtyCol: [false, false, false],
        status: "new",
      };
    },
    emit: vi.fn(),
  });

  editor.newRows.value = [[null, null, null]];
  return editor;
}

describe("useDataGridEditor result snapshots", () => {
  it("does not restore scroll or editing state into a replacement result identity", () => {
    class TestScroller {
      scrollTop = 0;
      scrollLeft = 0;
      scrollTo({ top, left }: ScrollToOptions) {
        if (typeof top === "number") this.scrollTop = top;
        if (typeof left === "number") this.scrollLeft = left;
      }
    }
    vi.stubGlobal("HTMLElement", TestScroller);
    const oldKey = "tab-current-0-execution-1";
    const previous = createEditor(undefined, true, oldKey);
    const previousScroller = new TestScroller();
    previousScroller.scrollTop = 6_400;
    previousScroller.scrollLeft = 24;
    previous.scrollerRef.value = previousScroller as unknown as NonNullable<typeof previous.scrollerRef.value>;
    previous.editingCell.value = { rowId: -1, col: 0 };
    previous.editValue.value = "Ada";
    previous.savePendingSnapshot(true, true);

    const replacement = createEditor(undefined, true, "tab-current-0-execution-2");
    const replacementScroller = new TestScroller();
    replacement.scrollerRef.value = replacementScroller as unknown as NonNullable<typeof replacement.scrollerRef.value>;
    replacement.restorePendingSnapshotFocus();
    expect(replacement.editingCell.value).toBeNull();
    expect(replacementScroller.scrollTop).toBe(0);
    expect(replacementScroller.scrollLeft).toBe(0);

    clearDataGridPendingSnapshot(oldKey);
    const oldIdentity = createEditor(undefined, true, oldKey);
    const oldIdentityScroller = new TestScroller();
    oldIdentity.scrollerRef.value = oldIdentityScroller as unknown as NonNullable<typeof oldIdentity.scrollerRef.value>;
    oldIdentity.restorePendingSnapshotFocus();
    expect(oldIdentity.editingCell.value).toBeNull();
    expect(oldIdentityScroller.scrollTop).toBe(0);
    expect(oldIdentityScroller.scrollLeft).toBe(0);
  });
});

describe("useDataGridEditor row deletion confirmation", () => {
  it("keeps the row pending until confirmation when confirmation is enabled", () => {
    const editor = createEditor(undefined, true);

    editor.requestDeleteRow(-1);

    expect(editor.showDeleteRowConfirm.value).toBe(true);
    expect(editor.newRows.value).toHaveLength(1);

    editor.confirmDeleteRow();
    expect(editor.newRows.value).toHaveLength(0);
  });

  it("applies row deletion immediately when confirmation is disabled", () => {
    const editor = createEditor(undefined, false);

    editor.requestDeleteRow(-1);

    expect(editor.showDeleteRowConfirm.value).toBe(false);
    expect(editor.newRows.value).toHaveLength(0);
  });
});

describe("useDataGridEditor appendPastedRowsToNewRow", () => {
  beforeEach(() => {
    mocks.getConfig.mockReturnValue({ id: "connection-1", db_type: "postgres" });
  });

  it("fills the selected blank new row and appends remaining rows using visible columns", () => {
    const editor = createEditor();

    const result = editor.appendPastedRowsToNewRow(
      -1,
      [
        ["Ada", "Lovelace"],
        ["Grace", "Hopper"],
      ],
      [0, 2],
    );

    expect(result).toEqual({ ok: true, rowCount: 2 });
    expect(editor.newRows.value).toEqual([
      ["Ada", null, "Lovelace"],
      ["Grace", null, "Hopper"],
    ]);
    expect(editor.hasPendingChanges.value).toBe(true);
  });

  it("fills following blank new rows before adding more rows", () => {
    const editor = createEditor();
    editor.newRows.value = [
      [null, null, null],
      [null, null, null],
    ];

    const result = editor.appendPastedRowsToNewRow(-1, [["Ada"], ["Grace"]], [0, 2]);

    expect(result).toEqual({ ok: true, rowCount: 2 });
    expect(editor.newRows.value).toEqual([
      ["Ada", null, null],
      ["Grace", null, null],
    ]);
  });

  it("turns rows pasted into the terminal new-row draft into pending rows", () => {
    const editor = createEditor();
    editor.newRows.value = [];

    const result = editor.appendPastedRowsToNewRow(
      DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID,
      [
        ["Ada", "Lovelace"],
        ["Grace", "Hopper"],
      ],
      [0, 2],
    );

    expect(result).toEqual({ ok: true, rowCount: 2 });
    expect(editor.newRows.value).toEqual([
      ["Ada", null, "Lovelace"],
      ["Grace", null, "Hopper"],
    ]);
    expect(editor.quickEntryDraftRow.value).toEqual([null, null, null]);
    expect(editor.hasPendingChanges.value).toBe(true);

    editor.undoPendingChange();
    expect(editor.newRows.value).toEqual([]);
    expect(editor.quickEntryDraftRow.value).toEqual([null, null, null]);

    editor.redoPendingChange();
    expect(editor.newRows.value).toEqual([
      ["Ada", null, "Lovelace"],
      ["Grace", null, "Hopper"],
    ]);
  });

  it("rejects a non-empty terminal new-row draft", () => {
    const editor = createEditor();
    editor.newRows.value = [];
    editor.quickEntryDraftRow.value = ["already", null, null];

    const result = editor.appendPastedRowsToNewRow(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, [["Ada"]], [0, 2]);

    expect(result).toEqual({ ok: false, reason: "target-not-empty" });
    expect(editor.newRows.value).toEqual([]);
    expect(editor.quickEntryDraftRow.value).toEqual(["already", null, null]);
  });

  it("truncates pasted columns that exceed the visible table columns", () => {
    const editor = createEditor();

    const result = editor.appendPastedRowsToNewRow(-1, [["Ada", "Byron", "Lovelace"]], [0, 2]);

    expect(result).toEqual({ ok: true, rowCount: 1 });
    expect(editor.newRows.value).toEqual([["Ada", null, "Byron"]]);
    expect(editor.canUndoPendingChange.value).toBe(true);
  });

  it("rejects an empty textual clipboard payload without changing pending rows", () => {
    const editor = createEditor();

    const result = editor.appendPastedRowsToNewRow(-1, [[""]], [0, 2]);

    expect(result).toEqual({ ok: false, reason: "empty-paste" });
    expect(editor.newRows.value).toEqual([[null, null, null]]);
    expect(editor.canUndoPendingChange.value).toBe(false);
  });

  it("rejects a paste that targets a read-only visible column", () => {
    const editor = createEditor(["first", undefined, "last"]);

    const result = editor.appendPastedRowsToNewRow(-1, [["Ada"]], [1]);

    expect(result).toEqual({ ok: false, reason: "readonly-column" });
    expect(editor.newRows.value).toEqual([[null, null, null]]);
  });

  it("does not overwrite an existing new row selected as the append target", () => {
    const editor = createEditor();
    editor.newRows.value = [["already", null, null]];

    const result = editor.appendPastedRowsToNewRow(-1, [["Ada"]], [0, 2]);

    expect(result).toEqual({ ok: false, reason: "target-not-empty" });
    expect(editor.newRows.value).toEqual([["already", null, null]]);
  });

  it("treats a batch append as one undoable change", () => {
    const editor = createEditor();

    editor.appendPastedRowsToNewRow(-1, [["Ada"], ["Grace"]], [0, 2]);
    editor.undoPendingChange();
    expect(editor.newRows.value).toEqual([[null, null, null]]);

    editor.redoPendingChange();
    expect(editor.newRows.value).toEqual([
      ["Ada", null, null],
      ["Grace", null, null],
    ]);
  });

  it("uses resolved full values instead of preview values when cloning", () => {
    const editor = createEditor();
    editor.newRows.value = [["Ada", "preview...", "Lovelace"]];

    editor.cloneRow(-1, new Map([[1, "full payload"]]));

    expect(editor.newRows.value[1]).toEqual(["Ada", "full payload", "Lovelace"]);
  });
});

describe("useDataGridEditor saveChanges reload", () => {
  beforeEach(() => {
    mocks.prepareDataGridSave.mockReset();
    mocks.executeBatch.mockReset();
    mocks.executeInTransaction.mockReset();
    mocks.addHistory.mockReset();
    mocks.getConfig.mockReset();
  });

  function createSaveTestEditor(options: { currentPage?: Ref<number>; prepareFullReload?: () => void; customSaveHandler?: { save: ReturnType<typeof vi.fn> } } = {}) {
    const emit = vi.fn();
    const currentPage = options.currentPage ?? ref(1);
    const result = ref<{ columns: string[]; rows: CellValue[][] }>({
      columns: ["id", "status"],
      rows: [
        [1, "pending"],
        [2, "pending"],
      ],
    });
    const editor = useDataGridEditor({
      result: computed(() => result.value),
      editable: computed(() => true),
      databaseType: computed(() => "mysql"),
      connectionId: computed(() => "connection-1"),
      database: computed(() => "app"),
      tableMeta: computed(() => ({
        tableName: "orders_test",
        columns: [
          { name: "id", data_type: "int" },
          { name: "status", data_type: "varchar" },
        ],
        primaryKeys: ["id"],
      })),
      sourceColumns: computed(() => undefined),
      onExecuteSql: computed(() => undefined),
      customSaveHandler: computed(() => options.customSaveHandler),
      sql: computed(() => undefined),
      searchText: ref(""),
      whereFilterInput: ref(""),
      currentWhereInput: computed(() => undefined),
      orderByInput: ref(""),
      rowStatusFilter: ref("all"),
      confirmDangerousRowDeletion: computed(() => true),
      pageSize: ref(100),
      currentPage,
      cacheKey: computed(() => undefined),
      getRowItem: () => undefined,
      prepareFullReload: options.prepareFullReload,
      emit,
    });
    return { editor, emit, currentPage };
  }

  it("reloads after a pure row update, so database-computed columns (e.g. ON UPDATE CURRENT_TIMESTAMP) refresh without a manual page reload", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders_test SET status='shipped' WHERE id=1"], rollbackStatements: [] });
    mocks.executeBatch.mockResolvedValue({ affected_rows: 1 });

    const { editor, emit } = createSaveTestEditor();
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(mocks.executeBatch).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  it("does not reload when there are no pending changes to save", async () => {
    const { editor, emit } = createSaveTestEditor();

    await editor.saveChanges();

    expect(mocks.prepareDataGridSave).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("reload", expect.anything());
  });

  it("prepares one first-page reload after saving edits from three accumulated infinite-scroll pages", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({
      statements: ["UPDATE orders_test SET status='shipped' WHERE id=1", "UPDATE orders_test SET status='cancelled' WHERE id=2"],
      rollbackStatements: [],
    });
    mocks.executeInTransaction.mockResolvedValue({ affected_rows: 2 });
    const infiniteScrollState = {
      lastPage: 3,
      requestedOffset: 200 as number | undefined,
      requestedLimit: 100 as number | undefined,
    };
    const currentPage = ref(3);
    const prepareFullReload = vi.fn(() => {
      currentPage.value = 1;
      infiniteScrollState.lastPage = 0;
      infiniteScrollState.requestedOffset = undefined;
      infiniteScrollState.requestedLimit = undefined;
    });
    const created = createSaveTestEditor({ currentPage, prepareFullReload });
    created.editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));
    created.editor.dirtyRows.value.set(1, new Map([[1, "cancelled"]]));

    await created.editor.saveChanges();

    expect(mocks.executeInTransaction).toHaveBeenCalledTimes(1);
    expect(prepareFullReload).toHaveBeenCalledTimes(1);
    expect(infiniteScrollState).toEqual({ lastPage: 0, requestedOffset: undefined, requestedLimit: undefined });
    expect(created.emit).toHaveBeenCalledTimes(1);
    expect(created.emit).toHaveBeenCalledWith("reload", undefined, "", undefined, undefined, 100, 0);
  });

  it("keeps the custom save path from reloading after a pure update", async () => {
    const customSave = vi.fn().mockResolvedValue(undefined);
    const prepareFullReload = vi.fn();
    const { editor, emit } = createSaveTestEditor({ customSaveHandler: { save: customSave }, prepareFullReload });
    editor.dirtyRows.value.set(0, new Map([[1, "shipped"]]));

    await editor.saveChanges();

    expect(customSave).toHaveBeenCalledTimes(1);
    expect(prepareFullReload).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("reload", expect.anything());
  });
});
