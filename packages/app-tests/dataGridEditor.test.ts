import { strict as assert } from "node:assert";
import { test } from "vitest";
import { computed, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, useDataGridEditor } from "../../apps/desktop/src/composables/useDataGridEditor.ts";
import type { CellValue } from "../../apps/desktop/src/lib/dataGrid/cellValue.ts";
import type { DataGridSaveStatementOptions } from "../../apps/desktop/src/lib/dataGrid/dataGridSql.ts";
import { matchesRowStatusFilter, type RowStatusFilter } from "../../apps/desktop/src/lib/dataGrid/gridRowStatus.ts";
import type { ColumnInfo } from "../../apps/desktop/src/types/database.ts";

function installBrowserTestGlobals() {
  globalThis.document = { querySelector: () => null } as unknown as Document;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/history/save") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(input) !== "/api/query/prepare-data-grid-save") return new Response("unexpected request", { status: 500 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const options = body.options as DataGridSaveStatementOptions;
    return new Response(
      JSON.stringify({
        statements: mockPreparedSaveStatements(options),
        rollbackStatements: [],
        executionSchema: options.databaseType === "oracle" || options.databaseType === "neo4j" ? undefined : options.tableMeta.schema,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

function mockPreparedSaveStatements(options: DataGridSaveStatementOptions): string[] {
  const table = options.tableMeta.schema ? `${quotePgIdentifier(options.tableMeta.schema)}.${quotePgIdentifier(options.tableMeta.tableName)}` : quotePgIdentifier(options.tableMeta.tableName);
  const statements: string[] = [];
  for (const rowIndex of options.deletedRows) {
    const row = options.rows[rowIndex];
    if (!row) continue;
    statements.push(`DELETE FROM ${table} WHERE ${primaryKeyWhere(options, row)};`);
  }
  for (const [rowIndex, changes] of options.dirtyRows) {
    const row = options.rows[rowIndex];
    if (!row) continue;
    const sets = changes.map(([columnIndex, value]) => `${quotePgIdentifier(options.columns[columnIndex])} = ${formatGridSqlLiteral(value, options.databaseType)}`).join(", ");
    statements.push(`UPDATE ${table} SET ${sets} WHERE ${primaryKeyWhere(options, row)};`);
  }
  for (const row of options.newRows) {
    const columns = options.columns.map(quotePgIdentifier).join(", ");
    const values = row.map((value) => formatGridSqlLiteral(value, options.databaseType)).join(", ");
    statements.push(`INSERT INTO ${table} (${columns}) VALUES (${values});`);
  }
  return statements;
}

function primaryKeyWhere(options: DataGridSaveStatementOptions, row: CellValue[]): string {
  return options.tableMeta.primaryKeys
    .map((key) => {
      const index = options.columns.indexOf(key);
      return `${quotePgIdentifier(key)} = ${formatGridSqlLiteral(row[index], options.databaseType)}`;
    })
    .join(" AND ");
}

function quotePgIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function formatGridSqlLiteral(value: CellValue, databaseType?: string): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && databaseType === "postgres") {
    return `'${formatPgArrayLiteral(value)}'`;
  }
  const escaped = `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  return databaseType === "sqlserver" ? `N${escaped}` : escaped;
}

function formatPgArrayLiteral(value: CellValue[]): string {
  return `{${value
    .map((item) => {
      if (Array.isArray(item)) return formatPgArrayLiteral(item);
      if (item === null) return "NULL";
      return `"${String(item).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(",")}}`;
}

function column(name: string, isPrimaryKey = false, extra: string | null = null): ColumnInfo {
  return {
    name,
    data_type: "VARCHAR",
    is_nullable: true,
    column_default: null,
    is_primary_key: isPrimaryKey,
    extra,
  };
}

function createQuickEntryEditor(options: {
  quickEntryEnabled: boolean;
  cacheKey?: string;
  rowStatusFilter?: ReturnType<typeof ref<RowStatusFilter>>;
  filterRowsInGetRowItem?: boolean;
  supportsInsert?: boolean;
  save?: (changes: { dirtyRows: Map<number, Map<number, CellValue>>; newRows: CellValue[][] }) => Promise<void>;
}) {
  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const rowStatusFilter = options.rowStatusFilter ?? ref<RowStatusFilter>("all");
  let editor: ReturnType<typeof useDataGridEditor>;
  editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "people",
      columns: [column("id", true), column("name")],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => undefined),
    customSaveHandler: computed(() => ({
      save: options.save ?? (async () => {}),
      supportsInsert: options.supportsInsert ?? true,
    })),
    sql: computed(() => "SELECT id, name FROM people"),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
    currentWhereInput: computed(() => undefined),
    rowStatusFilter,
    dataGridQuickEntryEnabled: computed(() => options.quickEntryEnabled),
    pageSize: ref(50),
    currentPage: ref(1),
    cacheKey: options.cacheKey ? computed(() => options.cacheKey) : undefined,
    getRowItem: (rowId) => {
      if (rowId === DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID) {
        editor.ensureQuickEntryDraftRow();
        return {
          id: DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID,
          data: editor.quickEntryDraftRow.value,
          isNew: false,
          isDraft: true,
          isDeleted: false,
          isDirtyCol: [false, false],
          status: "draft",
        };
      }
      if (rowId === 0) {
        const dirty = editor.dirtyRows.value.get(0);
        const status = dirty?.size ? "edited" : "clean";
        if (options.filterRowsInGetRowItem && !matchesRowStatusFilter(status, rowStatusFilter.value)) return undefined;
        return {
          id: 0,
          sourceIndex: 0,
          data: editor.rowDataWithChanges(result.value.rows[0], 0),
          isNew: false,
          isDeleted: false,
          isDirtyCol: [false, !!dirty?.has(1)],
          status,
        };
      }
      if (rowId < 0) {
        const newIndex = -rowId - 1;
        const row = editor.newRows.value[newIndex];
        if (!row) return undefined;
        return {
          id: rowId,
          newIndex,
          data: row,
          isNew: true,
          isDeleted: false,
          isDirtyCol: [false, false],
          status: "new",
        };
      }
      return undefined;
    },
    emit: () => {},
  });
  return editor;
}

function createPeopleGridEditor(result = computed(() => ({ columns: ["id", "name"], rows: [[1, "Ada"] as CellValue[]] }))) {
  const rowStatusFilter = ref<RowStatusFilter>("all");
  let editor: ReturnType<typeof useDataGridEditor>;

  editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "people",
      columns: [column("id", true), column("name")],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => undefined),
    customSaveHandler: computed(() => undefined),
    sql: computed(() => "SELECT id, name FROM people"),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
    currentWhereInput: computed(() => undefined),
    rowStatusFilter,
    pageSize: ref(50),
    currentPage: ref(1),
    getRowItem: (rowId) => {
      if (rowId === 0) {
        return {
          id: 0,
          sourceIndex: 0,
          data: editor.rowDataWithChanges(result.value.rows[0], 0),
          isNew: false,
          isDeleted: editor.deletedRows.value.has(0),
          isDirtyCol: [false, editor.dirtyRows.value.get(0)?.has(1) ?? false],
          status: editor.deletedRows.value.has(0) ? "deleted" : editor.dirtyRows.value.has(0) ? "edited" : "clean",
        };
      }
      if (rowId < 0) {
        const newIndex = -rowId - 1;
        const row = editor.newRows.value[newIndex];
        if (!row) return undefined;
        return {
          id: rowId,
          newIndex,
          data: row,
          isNew: true,
          isDeleted: false,
          isDirtyCol: [false, false],
          status: "new",
        };
      }
      return undefined;
    },
    emit: () => {},
  });

  return editor;
}

test("row data helper reuses unchanged rows and clones dirty rows only", () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const row = ["AFW", 1995, 35271.907090628745] as CellValue[];
  const result = computed(() => ({
    columns: ["code", "year", "score"],
    rows: [row],
  }));
  const editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "metrics",
      columns: [column("code", true), column("year", true), column("score")],
      primaryKeys: ["code", "year"],
    })),
    onExecuteSql: computed(() => undefined),
    sql: computed(() => undefined),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
    currentWhereInput: computed(() => undefined),
    rowStatusFilter: ref("all"),
    getRowItem: () => undefined,
    pageSize: ref(100),
    currentPage: ref(1),
    emit: () => {},
  });

  assert.equal(editor.rowDataWithChanges(row, 0), row);

  editor.dirtyRows.value.set(0, new Map([[2, 10]]));
  const dirtyRow = editor.rowDataWithChanges(row, 0);

  assert.notEqual(dirtyRow, row);
  assert.deepEqual(dirtyRow, ["AFW", 1995, 10]);
  assert.deepEqual(row, ["AFW", 1995, 35271.907090628745]);
});

test("cloning a row copies non-generated primary key values without executing save", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["code", "year", "score"],
    rows: [["AFW", 1995, 35271.907090628745] as CellValue[]],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  let saveCalls = 0;
  let editor: ReturnType<typeof useDataGridEditor>;

  editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "metrics",
      columns: [column("code", true), column("year", true), column("score")],
      primaryKeys: ["code", "year"],
    })),
    onExecuteSql: computed(() => undefined),
    customSaveHandler: computed(() => ({
      save: async () => {
        saveCalls += 1;
      },
      supportsInsert: true,
    })),
    sql: computed(() => undefined),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
    currentWhereInput: computed(() => undefined),
    rowStatusFilter,
    pageSize: ref(100),
    currentPage: ref(1),
    getRowItem: (rowId) => {
      if (rowId === 0) {
        return {
          id: 0,
          sourceIndex: 0,
          data: result.value.rows[0],
          isNew: false,
          isDeleted: false,
          isDirtyCol: [false, false, false],
          status: "clean",
        };
      }
      if (rowId < 0) {
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
      }
      return undefined;
    },
    emit: () => {},
  });

  editor.cloneRow(0);
  await nextTick();

  assert.equal(saveCalls, 0);
  assert.deepEqual(editor.newRows.value, [["AFW", 1995, 35271.907090628745]]);
  assert.equal(editor.transactionActive.value, true);
  assert.deepEqual(editor.editingCell.value, { rowId: -1, col: 0 });

  await editor.saveChanges();

  assert.equal(saveCalls, 1);
  assert.deepEqual(editor.newRows.value, []);
});

test("cloning a row clears auto-generated key columns", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  let editor: ReturnType<typeof useDataGridEditor>;

  editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "people",
      columns: [column("id", true, "auto_increment"), column("name")],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => undefined),
    customSaveHandler: computed(() => undefined),
    sql: computed(() => undefined),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
    currentWhereInput: computed(() => undefined),
    rowStatusFilter,
    pageSize: ref(100),
    currentPage: ref(1),
    getRowItem: (rowId) => {
      if (rowId !== 0) return undefined;
      return {
        id: 0,
        sourceIndex: 0,
        data: result.value.rows[0],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false],
        status: "clean",
      };
    },
    emit: () => {},
  });

  editor.cloneRow(0);
  await nextTick();

  assert.deepEqual(editor.newRows.value, [[null, "Ada"]]);
});

test("saving deleted rows reloads current table data", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  const emitted: unknown[][] = [];
  let editor: ReturnType<typeof useDataGridEditor>;

  editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => "conn-1"),
    database: computed(() => "main"),
    tableMeta: computed(() => ({
      tableName: "people",
      columns: [column("id", true), column("name")],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => undefined),
    customSaveHandler: computed(() => ({ save: async () => {} })),
    sql: computed(() => "SELECT id, name FROM people"),
    searchText: ref("ada"),
    whereFilterInput: ref("name ILIKE '%a%'"),
    orderByInput: ref("id DESC"),
    currentWhereInput: computed(() => "name ILIKE '%a%'"),
    rowStatusFilter,
    pageSize: ref(50),
    currentPage: ref(3),
    getRowItem: (rowId) => {
      if (rowId !== 0) return undefined;
      return {
        id: 0,
        sourceIndex: 0,
        data: result.value.rows[0],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false],
        status: "clean",
      };
    },
    emit: (...args) => {
      emitted.push(args);
    },
  });

  editor.applyDeleteRow(0);
  await editor.saveChanges();

  assert.deepEqual(emitted, [["reload", "SELECT id, name FROM people", "ada", "name ILIKE '%a%'", "id DESC", 50, 100]]);
});

test("saving inserted rows reloads current table data", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  const emitted: unknown[][] = [];
  const executedSql: string[] = [];

  const editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    tableMeta: computed(() => ({
      schema: "public",
      tableName: "people",
      columns: [column("id", true), column("name")],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => async (sql: string) => {
      executedSql.push(sql);
    }),
    customSaveHandler: computed(() => undefined),
    sql: computed(() => "SELECT id, name FROM people"),
    searchText: ref("linus"),
    whereFilterInput: ref("name ILIKE '%l%'"),
    orderByInput: ref("id DESC"),
    currentWhereInput: computed(() => "name ILIKE '%l%'"),
    rowStatusFilter,
    pageSize: ref(50),
    currentPage: ref(2),
    getRowItem: () => undefined,
    emit: (...args) => {
      emitted.push(args);
    },
  });

  editor.newRows.value = [[2, "Linus"]];
  await editor.saveChanges();

  assert.deepEqual(executedSql, [`INSERT INTO "public"."people" ("id", "name") VALUES (2, 'Linus');`]);
  assert.deepEqual(emitted, [["reload", "SELECT id, name FROM people", "linus", "name ILIKE '%l%'", "id DESC", 50, 50]]);
});

test("saving edited rows without deletes does not reload table data", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  const emitted: unknown[][] = [];
  let editor: ReturnType<typeof useDataGridEditor>;

  editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => "conn-1"),
    database: computed(() => "main"),
    tableMeta: computed(() => ({
      tableName: "people",
      columns: [column("id", true), column("name")],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => undefined),
    customSaveHandler: computed(() => ({ save: async () => {} })),
    sql: computed(() => "SELECT id, name FROM people"),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
    currentWhereInput: computed(() => undefined),
    rowStatusFilter,
    pageSize: ref(50),
    currentPage: ref(1),
    getRowItem: (rowId) => {
      if (rowId !== 0) return undefined;
      return {
        id: 0,
        sourceIndex: 0,
        data: result.value.rows[0],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false],
        status: "clean",
      };
    },
    emit: (...args) => {
      emitted.push(args);
    },
  });

  editor.applyCellValue(0, 1, "Ada Lovelace");
  await editor.saveChanges();

  assert.deepEqual(emitted, []);
  assert.deepEqual(result.value.rows[0], [1, "Ada Lovelace"]);
});

test("undo and redo restore pending cell edits before save", () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const editor = createPeopleGridEditor(result);

  editor.applyCellValue(0, 1, "Ada Lovelace");
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, false);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada Lovelace"]);

  editor.undoPendingChange();
  assert.equal(editor.canUndoPendingChange.value, false);
  assert.equal(editor.canRedoPendingChange.value, true);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada"]);

  editor.redoPendingChange();
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, false);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada Lovelace"]);
});

test("typing NULL preserves the literal string value", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const editor = createPeopleGridEditor(result);

  editor.applyCellValue(0, 1, "NULL");

  assert.equal(editor.dirtyRows.value.get(0)?.get(1), "NULL");
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "NULL"]);
  assert.deepEqual(await editor.previewChanges(), [`UPDATE "people" SET "name" = 'NULL' WHERE "id" = 1;`]);
});

test("setting a cell to NULL records pending SQL and supports undo and redo", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const editor = createPeopleGridEditor(result);

  editor.applyCellValue(0, 1, null);

  assert.equal(editor.dirtyRows.value.get(0)?.get(1), null);
  assert.equal(editor.hasPendingChanges.value, true);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, null]);

  const statements = await editor.previewChanges();
  assert.deepEqual(statements, ['UPDATE "people" SET "name" = NULL WHERE "id" = 1;']);
  assert.doesNotMatch(statements.join("\n"), /["']NULL["']/);

  editor.undoPendingChange();
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada"]);

  editor.redoPendingChange();
  assert.equal(editor.dirtyRows.value.get(0)?.get(1), null);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, null]);
});

test("setting an existing NULL cell to NULL is a no-op", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, null] as CellValue[]],
  }));
  const editor = createPeopleGridEditor(result);

  editor.applyCellValue(0, 1, null);

  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.hasPendingChanges.value, false);
  assert.equal(editor.canUndoPendingChange.value, false);
  assert.deepEqual(await editor.previewChanges(), []);
});

test("generated empty strings remain distinct from NULL cells", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, null] as CellValue[]],
  }));
  const editor = createPeopleGridEditor(result);

  editor.applyCellValue(0, 1, "");
  assert.equal(editor.dirtyRows.value.size, 0);

  editor.applyCellValue(0, 1, "", { preserveEmptyString: true });
  assert.equal(editor.dirtyRows.value.get(0)?.get(1), "");
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, ""]);
  assert.deepEqual(await editor.previewChanges(), [`UPDATE "people" SET "name" = '' WHERE "id" = 1;`]);
});

test("a failed NULL save keeps the pending cell edit", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  const editor = createQuickEntryEditor({
    quickEntryEnabled: false,
    save: async () => {
      throw new Error("NULL write rejected");
    },
  });

  editor.applyCellValue(0, 1, null);
  await editor.saveChanges();

  assert.equal(editor.saveError.value, "NULL write rejected");
  assert.equal(editor.dirtyRows.value.get(0)?.get(1), null);
  assert.equal(editor.hasPendingChanges.value, true);
});

test("a NOT NULL validation failure keeps the pending NULL cell edit recoverable", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  globalThis.fetch = (async (input) => {
    if (String(input) !== "/api/query/prepare-data-grid-save") return new Response("unexpected request", { status: 500 });
    return new Response(
      JSON.stringify({
        validationError: 'Column "name" does not allow NULL.',
        statements: [],
        rollbackStatements: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  const editor = createPeopleGridEditor();

  editor.applyCellValue(0, 1, null);
  await editor.saveChanges();

  assert.equal(editor.saveError.value, 'Column "name" does not allow NULL.');
  assert.equal(editor.dirtyRows.value.get(0)?.get(1), null);
  assert.equal(editor.hasPendingChanges.value, true);
  assert.equal(editor.canUndoPendingChange.value, true);

  editor.undoPendingChange();
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.saveError.value, "");

  editor.redoPendingChange();
  await editor.saveChanges();
  assert.equal(editor.saveError.value, 'Column "name" does not allow NULL.');

  editor.discardChanges();
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.hasPendingChanges.value, false);
  assert.equal(editor.saveError.value, "");
});

test("restoring a pending cell edit records undo and redo history", () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const editor = createPeopleGridEditor(result);

  editor.applyCellValue(0, 1, "Ada Lovelace");
  editor.restoreCellValue(0, 1);
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, false);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada"]);

  editor.undoPendingChange();
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, true);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada Lovelace"]);

  editor.redoPendingChange();
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, false);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada"]);
});

test("undo and redo cover row add and delete operations", () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const editor = createPeopleGridEditor();

  editor.addRow();
  assert.equal(editor.newRows.value.length, 1);
  editor.undoPendingChange();
  assert.equal(editor.newRows.value.length, 0);
  editor.redoPendingChange();
  assert.equal(editor.newRows.value.length, 1);

  editor.applyDeleteRow(0);
  assert.deepEqual([...editor.deletedRows.value], [0]);
  editor.undoPendingChange();
  assert.deepEqual([...editor.deletedRows.value], []);
  assert.equal(editor.newRows.value.length, 1);
  editor.redoPendingChange();
  assert.deepEqual([...editor.deletedRows.value], [0]);
});

test("batch row delete records a single undo snapshot", () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[], [2, "Linus"] as CellValue[], [3, "Grace"] as CellValue[]],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  let editor: ReturnType<typeof useDataGridEditor>;

  editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "people",
      columns: [column("id", true), column("name")],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => undefined),
    customSaveHandler: computed(() => undefined),
    sql: computed(() => "SELECT id, name FROM people"),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
    currentWhereInput: computed(() => undefined),
    rowStatusFilter,
    pageSize: ref(50),
    currentPage: ref(1),
    getRowItem: (rowId) => {
      if (rowId >= 0 && result.value.rows[rowId]) {
        return {
          id: rowId,
          sourceIndex: rowId,
          data: result.value.rows[rowId],
          isNew: false,
          isDeleted: editor.deletedRows.value.has(rowId),
          isDirtyCol: [false, editor.dirtyRows.value.get(rowId)?.has(1) ?? false],
          status: editor.deletedRows.value.has(rowId) ? "deleted" : editor.dirtyRows.value.has(rowId) ? "edited" : "clean",
        };
      }
      if (rowId < 0) {
        const newIndex = -rowId - 1;
        const row = editor.newRows.value[newIndex];
        if (!row) return undefined;
        return {
          id: rowId,
          newIndex,
          data: row,
          isNew: true,
          isDeleted: false,
          isDirtyCol: [false, false],
          status: "new",
        };
      }
      return undefined;
    },
    emit: () => {},
  });

  editor.applyDeleteRows([0, 1]);
  assert.deepEqual([...editor.deletedRows.value], [0, 1]);

  editor.undoPendingChange();
  assert.deepEqual([...editor.deletedRows.value], []);
  assert.equal(editor.canUndoPendingChange.value, false);

  editor.redoPendingChange();
  assert.deepEqual([...editor.deletedRows.value], [0, 1]);

  editor.newRows.value = [
    [4, "Katherine"],
    [5, "Margaret"],
    [6, "Donald"],
  ];
  editor.applyDeleteRows([-1, -2]);
  assert.deepEqual(editor.newRows.value, [[6, "Donald"]]);
});

test("undo and redo restore pending cell edits before save", () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const editor = createPeopleGridEditor(result);

  editor.applyCellValue(0, 1, "Ada Lovelace");
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, false);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada Lovelace"]);

  editor.undoPendingChange();
  assert.equal(editor.canUndoPendingChange.value, false);
  assert.equal(editor.canRedoPendingChange.value, true);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada"]);

  editor.redoPendingChange();
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, false);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada Lovelace"]);
});

test("restoring a pending cell edit records undo and redo history", () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "name"],
    rows: [[1, "Ada"] as CellValue[]],
  }));
  const editor = createPeopleGridEditor(result);

  editor.applyCellValue(0, 1, "Ada Lovelace");
  editor.restoreCellValue(0, 1);
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, false);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada"]);

  editor.undoPendingChange();
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, true);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada Lovelace"]);

  editor.redoPendingChange();
  assert.equal(editor.canUndoPendingChange.value, true);
  assert.equal(editor.canRedoPendingChange.value, false);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.deepEqual(editor.rowDataWithChanges(result.value.rows[0], 0), [1, "Ada"]);
});

test("undo and redo cover row add and delete operations", () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const editor = createPeopleGridEditor();

  editor.addRow();
  assert.equal(editor.newRows.value.length, 1);
  editor.undoPendingChange();
  assert.equal(editor.newRows.value.length, 0);
  editor.redoPendingChange();
  assert.equal(editor.newRows.value.length, 1);

  editor.applyDeleteRow(0);
  assert.deepEqual([...editor.deletedRows.value], [0]);
  editor.undoPendingChange();
  assert.deepEqual([...editor.deletedRows.value], []);
  assert.equal(editor.newRows.value.length, 1);
  editor.redoPendingChange();
  assert.deepEqual([...editor.deletedRows.value], [0]);
});

test("keeps appended empty-table rows when parent refreshes an equivalent rows array", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = ref<{ columns: string[]; rows: CellValue[][] }>({ columns: ["id", "name"], rows: [] });
  const editor = createPeopleGridEditor(computed(() => result.value));

  editor.addRow();
  await nextTick();
  assert.equal(editor.newRows.value.length, 1);

  result.value = { columns: ["id", "name"], rows: [] };
  await nextTick();
  assert.equal(editor.newRows.value.length, 1);

  result.value = { columns: ["id", "name"], rows: [[1, "Ada"] as CellValue[]] };
  await nextTick();
  assert.equal(editor.newRows.value.length, 0);
});

test("keeps dirty new and deleted state when infinite scrolling appends rows", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const firstRow = [1, "Ada"] as CellValue[];
  const secondRow = [2, "Grace"] as CellValue[];
  const result = ref<{ columns: string[]; rows: CellValue[][]; appended_from_row_count?: number }>({ columns: ["id", "name"], rows: [firstRow, secondRow] });
  const editor = createPeopleGridEditor(computed(() => result.value));

  editor.applyCellValue(0, 1, "Ada Lovelace");
  editor.deletedRows.value = new Set([1]);
  editor.addRow();
  await nextTick();

  result.value = { columns: ["id", "name"], rows: [firstRow, secondRow, [3, "Linus"] as CellValue[]], appended_from_row_count: 2 };
  await nextTick();

  assert.equal(editor.dirtyRows.value.get(0)?.get(1), "Ada Lovelace");
  assert.deepEqual([...editor.deletedRows.value], [1]);
  assert.equal(editor.newRows.value.length, 1);

  result.value = { columns: ["id", "name"], rows: [[1, "Ada"] as CellValue[], [2, "Grace"] as CellValue[]] };
  await nextTick();
  assert.equal(editor.dirtyRows.value.size, 0, "explicit result replacement still clears stale source indexes");
  assert.equal(editor.deletedRows.value.size, 0);
  assert.equal(editor.newRows.value.length, 0);
});

test("saving manually typed JSON from a MySQL grid normalizes smart quotes", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "payload"],
    rows: [[1, "{}"] as CellValue[]],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  const executedSql: string[] = [];

  const editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "settings",
      columns: [column("id", true), { ...column("payload"), data_type: "json" }],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => async (sql: string) => {
      executedSql.push(sql);
    }),
    customSaveHandler: computed(() => undefined),
    sql: computed(() => "SELECT id, payload FROM settings"),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
    currentWhereInput: computed(() => undefined),
    rowStatusFilter,
    pageSize: ref(50),
    currentPage: ref(1),
    getRowItem: (rowId) => {
      if (rowId !== 0) return undefined;
      return {
        id: 0,
        sourceIndex: 0,
        data: result.value.rows[0],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false],
        status: "clean",
      };
    },
    emit: () => {},
  });

  editor.applyCellValue(0, 1, "{“2:3”:“3:4”,“3:2”:“4:3”,“21:9”:“16:9”}");
  await editor.saveChanges();

  assert.deepEqual(executedSql, [`UPDATE "settings" SET "payload" = '{"2:3":"3:4","3:2":"4:3","21:9":"16:9"}' WHERE "id" = 1;`]);
});

test("saving manually typed JSON arrays from a Postgres array column uses array values", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const result = computed(() => ({
    columns: ["id", "tags"],
    rows: [[1, "{legacy}"] as CellValue[]],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  const executedSql: string[] = [];

  const editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => undefined),
    database: computed(() => undefined),
    tableMeta: computed(() => ({
      tableName: "articles",
      columns: [column("id", true), { ...column("tags"), data_type: "_text" }],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => async (sql: string) => {
      executedSql.push(sql);
    }),
    customSaveHandler: computed(() => undefined),
    sql: computed(() => "SELECT id, tags FROM articles"),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
    currentWhereInput: computed(() => undefined),
    rowStatusFilter,
    pageSize: ref(50),
    currentPage: ref(1),
    getRowItem: (rowId) => {
      if (rowId !== 0) return undefined;
      return {
        id: 0,
        sourceIndex: 0,
        data: result.value.rows[0],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false],
        status: "clean",
      };
    },
    emit: () => {},
  });

  editor.applyCellValue(0, 1, `["draft","发布"]`);
  await editor.saveChanges();

  assert.deepEqual(executedSql, [`UPDATE "articles" SET "tags" = '{"draft","发布"}' WHERE "id" = 1;`]);
});

test("single-statement table data save uses auto-commit and records a failed history entry", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const permissionError = "Statement 1 failed: Server error: ERROR 42000 (1142): UPDATE command denied to user";
  const savedHistoryEntries: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-data-grid-save") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const options = body.options as DataGridSaveStatementOptions;
      return new Response(
        JSON.stringify({
          statements: mockPreparedSaveStatements(options),
          rollbackStatements: [`UPDATE "pp_questions" SET "title" = 'Old title' WHERE "id" = 1;`],
          executionSchema: options.tableMeta.schema,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute-batch") {
      return new Response(permissionError, { status: 500 });
    }
    if (url === "/api/history/save") {
      savedHistoryEntries.push(JSON.parse(String(init?.body ?? "{}")).entry);
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  }) as typeof fetch;

  const result = computed(() => ({
    columns: ["id", "title"],
    rows: [[1, "Old title"] as CellValue[]],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  const editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => "conn-1"),
    database: computed(() => "app_db"),
    tableMeta: computed(() => ({
      tableName: "pp_questions",
      columns: [column("id", true), column("title")],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => undefined),
    customSaveHandler: computed(() => undefined),
    sql: computed(() => "SELECT id, title FROM pp_questions"),
    searchText: ref(""),
    whereFilterInput: ref(""),
    currentWhereInput: computed(() => undefined),
    orderByInput: ref(""),
    rowStatusFilter,
    pageSize: ref(50),
    currentPage: ref(1),
    getRowItem: (rowId) => {
      if (rowId !== 0) return undefined;
      return {
        id: 0,
        sourceIndex: 0,
        data: result.value.rows[0],
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false],
        status: "clean",
      };
    },
    emit: () => {},
  });

  editor.applyCellValue(0, 1, "New title");
  await editor.saveChanges();

  assert.equal(editor.saveError.value, permissionError);
  assert.equal(editor.dirtyRows.value.size, 1);
  assert.equal(savedHistoryEntries.length, 1);
  const historyEntry = savedHistoryEntries[0];
  assert.equal(historyEntry.success, false);
  assert.equal(historyEntry.error, permissionError);
  assert.equal(historyEntry.activity_kind, "data_change");
  assert.equal(historyEntry.operation, "UPDATE");
  assert.equal(historyEntry.target, "pp_questions");
  assert.equal(historyEntry.rollback_sql, undefined);
  assert.equal(historyEntry.affected_rows, undefined);
  assert.equal(historyEntry.sql, `UPDATE "pp_questions" SET "title" = 'New title' WHERE "id" = 1;`);
  const details = JSON.parse(String(historyEntry.details_json));
  assert.equal(details.statement_count, 1);
  assert.equal(details.rollback_statement_count, 0);
  assert.equal("statements" in details, false);
  assert.equal("rollback_statements" in details, false);
});

test("multi-statement table data save remains transactional", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const executionEndpoints: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-data-grid-save") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const options = body.options as DataGridSaveStatementOptions;
      return new Response(
        JSON.stringify({
          statements: mockPreparedSaveStatements(options),
          rollbackStatements: [],
          executionSchema: options.tableMeta.schema,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute-in-transaction" || url === "/api/query/execute-batch") {
      executionEndpoints.push(url);
      return new Response(JSON.stringify({ affected_rows: 2 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/history/save") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(`unexpected request: ${url}`, { status: 500 });
  }) as typeof fetch;

  const result = computed(() => ({
    columns: ["id", "title"],
    rows: [
      [1, "Old title 1"],
      [2, "Old title 2"],
    ] as CellValue[][],
  }));
  const rowStatusFilter = ref<"all" | "changed" | "edited" | "new" | "deleted">("all");
  const editor = useDataGridEditor({
    result,
    editable: computed(() => true),
    databaseType: computed(() => "mysql"),
    connectionId: computed(() => "conn-1"),
    database: computed(() => "app_db"),
    tableMeta: computed(() => ({
      tableName: "pp_questions",
      columns: [column("id", true), column("title")],
      primaryKeys: ["id"],
    })),
    onExecuteSql: computed(() => undefined),
    customSaveHandler: computed(() => undefined),
    sql: computed(() => "SELECT id, title FROM pp_questions"),
    searchText: ref(""),
    whereFilterInput: ref(""),
    currentWhereInput: computed(() => undefined),
    orderByInput: ref(""),
    rowStatusFilter,
    pageSize: ref(50),
    currentPage: ref(1),
    getRowItem: (rowId) => {
      const row = result.value.rows[rowId];
      if (!row) return undefined;
      return {
        id: rowId,
        sourceIndex: rowId,
        data: row,
        isNew: false,
        isDeleted: false,
        isDirtyCol: [false, false],
        status: "clean",
      };
    },
    emit: () => {},
  });

  editor.applyCellValue(0, 1, "New title 1");
  editor.applyCellValue(1, 1, "New title 2");
  await editor.saveChanges();

  assert.deepEqual(executionEndpoints, ["/api/query/execute-in-transaction"]);
  assert.equal(editor.saveError.value, "");
  assert.equal(editor.dirtyRows.value.size, 0);
});

test("quick entry off keeps blur edits pending without saving", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  const editor = createQuickEntryEditor({
    quickEntryEnabled: false,
    save: async () => {
      saveCalls += 1;
    },
  });

  editor.startEdit(0, 1);
  editor.editValue.value = "Ada Lovelace";
  await editor.commitEditFromBlur();

  assert.equal(saveCalls, 0);
  assert.equal(editor.dirtyRows.value.size, 1);
  assert.equal(editor.dirtyRows.value.get(0)?.get(1), "Ada Lovelace");
});

test("explicit enum commits distinguish NULL, empty string, and the literal NULL", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();

  const nullEditor = createPeopleGridEditor();
  nullEditor.startEdit(0, 1);
  await nullEditor.commitEditAndMaybeAutoSave({ explicitValue: null });
  assert.equal(nullEditor.dirtyRows.value.get(0)?.get(1), null);

  const emptyEditor = createPeopleGridEditor();
  emptyEditor.startEdit(0, 1);
  await emptyEditor.commitEditAndMaybeAutoSave({ explicitValue: "" });
  assert.equal(emptyEditor.dirtyRows.value.get(0)?.get(1), "");

  const literalEditor = createPeopleGridEditor();
  literalEditor.startEdit(0, 1);
  await literalEditor.commitEditAndMaybeAutoSave({ explicitValue: "NULL" });
  assert.equal(literalEditor.dirtyRows.value.get(0)?.get(1), "NULL");
});

test("quick entry on saves existing row edits on blur", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async () => {
      saveCalls += 1;
    },
  });

  editor.startEdit(0, 1);
  editor.editValue.value = "Ada Lovelace";
  await editor.commitEditFromBlur();

  assert.equal(saveCalls, 1);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.saveError.value, "");
});

test("quick entry on saves existing row edits on Enter commit", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  let saveFinished!: () => void;
  const saveFinishedPromise = new Promise<void>((resolve) => {
    saveFinished = resolve;
  });
  const savedDirtyRows: Array<Array<[number, Array<[number, CellValue]>]>> = [];
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async ({ dirtyRows }) => {
      saveCalls += 1;
      savedDirtyRows.push([...dirtyRows.entries()].map(([rowIndex, changes]) => [rowIndex, [...changes.entries()]]));
      saveFinished();
    },
  });

  editor.startEdit(0, 1);
  editor.editValue.value = "Ada Lovelace";
  editor.onEditKeydown({
    key: "Enter",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as KeyboardEvent);
  await saveFinishedPromise;

  assert.equal(saveCalls, 1);
  assert.deepEqual(savedDirtyRows, [[[0, [[1, "Ada Lovelace"]]]]]);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.saveError.value, "");
});

test("quick entry queues blur saves made while a save is running", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  let firstSaveStarted!: () => void;
  let releaseFirstSave!: () => void;
  const firstSaveStartedPromise = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const firstSaveBlocker = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const savedDirtyRows: Array<Array<[number, Array<[number, CellValue]>]>> = [];
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async ({ dirtyRows }) => {
      saveCalls += 1;
      savedDirtyRows.push([...dirtyRows.entries()].map(([rowIndex, changes]) => [rowIndex, [...changes.entries()]]));
      if (saveCalls === 1) {
        firstSaveStarted();
        await firstSaveBlocker;
      }
    },
  });

  editor.startEdit(0, 1);
  editor.editValue.value = "Ada 1";
  const firstCommit = editor.commitEditFromBlur();
  await firstSaveStartedPromise;

  editor.startEdit(0, 1);
  editor.editValue.value = "Ada 2";
  await editor.commitEditFromBlur();

  assert.equal(saveCalls, 1);
  assert.equal(editor.dirtyRows.value.get(0)?.get(1), "Ada 2");

  releaseFirstSave();
  await firstCommit;

  assert.equal(saveCalls, 2);
  assert.deepEqual(savedDirtyRows, [[[0, [[1, "Ada 1"]]]], [[0, [[1, "Ada 2"]]]]]);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.saveError.value, "");
});

test("quick entry replays queued saves when row-status filters hide the saved row", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  const rowStatusFilter = ref<RowStatusFilter>("edited");
  let saveCalls = 0;
  let firstSaveStarted!: () => void;
  let releaseFirstSave!: () => void;
  const firstSaveStartedPromise = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const firstSaveBlocker = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const savedDirtyRows: Array<Array<[number, Array<[number, CellValue]>]>> = [];
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    rowStatusFilter,
    filterRowsInGetRowItem: true,
    save: async ({ dirtyRows }) => {
      saveCalls += 1;
      savedDirtyRows.push([...dirtyRows.entries()].map(([rowIndex, changes]) => [rowIndex, [...changes.entries()]]));
      if (saveCalls === 1) {
        firstSaveStarted();
        await firstSaveBlocker;
      }
    },
  });

  rowStatusFilter.value = "all";
  editor.startEdit(0, 1);
  editor.editValue.value = "Ada 1";
  const firstCommit = editor.commitEditFromBlur();
  await firstSaveStartedPromise;

  rowStatusFilter.value = "edited";
  editor.startEdit(0, 1);
  editor.editValue.value = "Ada 2";
  await editor.commitEditFromBlur();

  assert.equal(saveCalls, 1);
  assert.equal(editor.dirtyRows.value.get(0)?.get(1), "Ada 2");

  releaseFirstSave();
  await firstCommit;

  assert.equal(saveCalls, 2);
  assert.deepEqual(savedDirtyRows, [[[0, [[1, "Ada 1"]]]], [[0, [[1, "Ada 2"]]]]]);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.saveError.value, "");
});

test("quick entry preserves an active edit when auto-save clears the row from a status filter", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  const rowStatusFilter = ref<RowStatusFilter>("edited");
  let saveCalls = 0;
  let firstSaveStarted!: () => void;
  let releaseFirstSave!: () => void;
  const firstSaveStartedPromise = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const firstSaveBlocker = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const savedDirtyRows: Array<Array<[number, Array<[number, CellValue]>]>> = [];
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    rowStatusFilter,
    filterRowsInGetRowItem: true,
    save: async ({ dirtyRows }) => {
      saveCalls += 1;
      savedDirtyRows.push([...dirtyRows.entries()].map(([rowIndex, changes]) => [rowIndex, [...changes.entries()]]));
      if (saveCalls === 1) {
        firstSaveStarted();
        await firstSaveBlocker;
      }
    },
  });

  rowStatusFilter.value = "all";
  editor.startEdit(0, 1);
  editor.editValue.value = "Ada 1";
  const firstCommit = editor.commitEditFromBlur();
  await firstSaveStartedPromise;

  rowStatusFilter.value = "edited";
  editor.startEdit(0, 0);
  editor.editValue.value = "2";

  releaseFirstSave();
  await firstCommit;

  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.editingCell.value?.rowId, 0);

  await editor.commitEditFromBlur();

  assert.equal(saveCalls, 2);
  assert.deepEqual(savedDirtyRows, [[[0, [[1, "Ada 1"]]]], [[0, [[0, 2]]]]]);
  assert.equal(editor.dirtyRows.value.size, 0);
});

test("quick entry keeps queued blur save after an earlier auto-save fails", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  let firstSaveStarted!: () => void;
  let releaseFirstSave!: () => void;
  const firstSaveStartedPromise = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const firstSaveBlocker = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const savedDirtyRows: Array<Array<[number, Array<[number, CellValue]>]>> = [];
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async ({ dirtyRows }) => {
      saveCalls += 1;
      savedDirtyRows.push([...dirtyRows.entries()].map(([rowIndex, changes]) => [rowIndex, [...changes.entries()]]));
      if (saveCalls === 1) {
        firstSaveStarted();
        await firstSaveBlocker;
        throw new Error("first save failed");
      }
    },
  });

  editor.startEdit(0, 1);
  editor.editValue.value = "Ada 1";
  const firstCommit = editor.commitEditFromBlur();
  await firstSaveStartedPromise;

  editor.startEdit(0, 1);
  editor.editValue.value = "Ada 2";
  await editor.commitEditFromBlur();

  assert.equal(saveCalls, 1);
  assert.equal(editor.dirtyRows.value.get(0)?.get(1), "Ada 2");

  releaseFirstSave();
  await firstCommit;

  assert.equal(saveCalls, 2);
  assert.deepEqual(savedDirtyRows, [[[0, [[1, "Ada 1"]]]], [[0, [[1, "Ada 2"]]]]]);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.saveError.value, "");
});

test("quick entry saves a queued revert made while an earlier auto-save is running", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  let firstSaveStarted!: () => void;
  let releaseFirstSave!: () => void;
  const firstSaveStartedPromise = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const firstSaveBlocker = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const savedDirtyRows: Array<Array<[number, Array<[number, CellValue]>]>> = [];
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async ({ dirtyRows }) => {
      saveCalls += 1;
      savedDirtyRows.push([...dirtyRows.entries()].map(([rowIndex, changes]) => [rowIndex, [...changes.entries()]]));
      if (saveCalls === 1) {
        firstSaveStarted();
        await firstSaveBlocker;
      }
    },
  });

  editor.startEdit(0, 1);
  editor.editValue.value = "Ada 1";
  const firstCommit = editor.commitEditFromBlur();
  await firstSaveStartedPromise;

  editor.startEdit(0, 1);
  editor.editValue.value = "Ada";
  await editor.commitEditFromBlur();

  assert.equal(saveCalls, 1);
  assert.equal(editor.dirtyRows.value.size, 0);

  releaseFirstSave();
  await firstCommit;

  assert.equal(saveCalls, 2);
  assert.deepEqual(savedDirtyRows, [[[0, [[1, "Ada 1"]]]], [[0, [[1, "Ada"]]]]]);
  assert.equal(editor.dirtyRows.value.size, 0);
  assert.equal(editor.saveError.value, "");
});

test("quick entry blocks editing a pending new row while its insert is saving", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  let firstSaveStarted!: () => void;
  let releaseFirstSave!: () => void;
  const firstSaveStartedPromise = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const firstSaveBlocker = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const savedNewRows: CellValue[][][] = [];
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async ({ newRows }) => {
      saveCalls += 1;
      savedNewRows.push(newRows.map((row) => [...row]));
      if (saveCalls === 1) {
        firstSaveStarted();
        await firstSaveBlocker;
      }
    },
  });

  editor.startEdit(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 1);
  editor.editValue.value = "Grace";
  const firstCommit = editor.commitEditFromBlur();
  await firstSaveStartedPromise;

  const pendingNewRowItem = {
    id: -1,
    newIndex: 0,
    data: editor.newRows.value[0],
    isNew: true,
    isDeleted: false,
    isDirtyCol: [false, false],
    status: "new",
  };
  assert.equal(editor.isSavingNewRow(pendingNewRowItem), true);

  editor.startEdit(-1, 1);

  assert.equal(editor.editingCell.value, null);
  assert.equal(saveCalls, 1);
  assert.deepEqual(editor.newRows.value, [[null, "Grace"]]);

  releaseFirstSave();
  await firstCommit;

  assert.equal(saveCalls, 1);
  assert.deepEqual(savedNewRows, [[[null, "Grace"]]]);
  assert.deepEqual(editor.newRows.value, []);
  assert.equal(editor.isSavingNewRow(pendingNewRowItem), false);
  assert.equal(editor.saveError.value, "");
});

test("quick entry draft row ignores blank blur commits", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async () => {
      saveCalls += 1;
    },
  });

  editor.startEdit(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 1);
  editor.editValue.value = "   ";
  await editor.commitEditFromBlur();

  assert.equal(saveCalls, 0);
  assert.deepEqual(editor.newRows.value, []);
  assert.deepEqual(editor.quickEntryDraftRow.value, [null, null]);
});

test("quick entry draft row becomes a new row and saves on blur", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  const savedNewRows: CellValue[][][] = [];
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async ({ newRows }) => {
      saveCalls += 1;
      savedNewRows.push(newRows.map((row) => [...row]));
    },
  });

  editor.startEdit(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 1);
  editor.editValue.value = "Grace";
  await editor.commitEditFromBlur();

  assert.equal(saveCalls, 1);
  assert.deepEqual(savedNewRows, [[[null, "Grace"]]]);
  assert.deepEqual(editor.newRows.value, []);
  assert.deepEqual(editor.quickEntryDraftRow.value, [null, null]);
  assert.equal(editor.saveError.value, "");
});

test("custom save handler without insert support keeps pending new rows", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    supportsInsert: false,
    save: async () => {
      saveCalls += 1;
    },
  });
  editor.newRows.value = [[null, "Grace"]];

  await editor.saveChanges();

  assert.equal(saveCalls, 0);
  assert.equal(editor.saveError.value, "当前保存目标不支持新增行。");
  assert.deepEqual(editor.newRows.value, [[null, "Grace"]]);
  assert.equal(editor.hasPendingChanges.value, true);
});

test("quick entry draft row pasted values become a new row and save once", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  const savedNewRows: CellValue[][][] = [];
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async ({ newRows }) => {
      saveCalls += 1;
      savedNewRows.push(newRows.map((row) => [...row]));
    },
  });

  editor.applyCellValue(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 0, "2");
  editor.applyCellValue(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 1, "Grace");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(saveCalls, 1);
  assert.deepEqual(savedNewRows, [[["2", "Grace"]]]);
  assert.deepEqual(editor.newRows.value, []);
  assert.deepEqual(editor.quickEntryDraftRow.value, [null, null]);
  assert.equal(editor.saveError.value, "");
});

test("quick entry off keeps pasted draft row as a pending new row", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  const editor = createQuickEntryEditor({
    quickEntryEnabled: false,
    save: async () => {
      saveCalls += 1;
    },
  });

  editor.applyCellValue(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 1, "Grace");
  await Promise.resolve();

  assert.equal(saveCalls, 0);
  assert.deepEqual(editor.newRows.value, [[null, "Grace"]]);
  assert.deepEqual(editor.quickEntryDraftRow.value, [null, null]);
  assert.equal(editor.hasPendingChanges.value, true);
});

test("quick entry draft row keeps editing across draft cells without saving", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  let saveCalls = 0;
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async () => {
      saveCalls += 1;
    },
  });

  editor.startEdit(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 1);
  editor.editValue.value = "Grace";
  await editor.commitEditFromBlur({ promoteDraft: false });

  assert.equal(saveCalls, 0);
  assert.deepEqual(editor.newRows.value, []);
  assert.deepEqual(editor.quickEntryDraftRow.value, [null, "Grace"]);
  assert.equal(editor.saveError.value, "");
});

test("quick entry draft row survives pending snapshot restore", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  const firstEditor = createQuickEntryEditor({
    quickEntryEnabled: true,
    cacheKey: "quick-entry-draft-snapshot",
  });

  firstEditor.startEdit(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 1);
  firstEditor.editValue.value = "Grace";
  await firstEditor.commitEditFromBlur({ promoteDraft: false });
  firstEditor.startEdit(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 0);
  firstEditor.editValue.value = "2";
  firstEditor.savePendingSnapshot(true, false);

  const restoredEditor = createQuickEntryEditor({
    quickEntryEnabled: true,
    cacheKey: "quick-entry-draft-snapshot",
  });

  assert.deepEqual(restoredEditor.quickEntryDraftRow.value, [null, "Grace"]);
  assert.deepEqual(restoredEditor.editingCell.value, { rowId: DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, col: 0 });
  assert.equal(restoredEditor.editValue.value, "2");

  await restoredEditor.commitEditFromBlur();

  assert.deepEqual(restoredEditor.newRows.value, []);
  assert.deepEqual(restoredEditor.quickEntryDraftRow.value, [null, null]);
});

test("quick entry auto-save failure keeps the pending new row", async () => {
  setActivePinia(createPinia());
  installBrowserTestGlobals();
  const editor = createQuickEntryEditor({
    quickEntryEnabled: true,
    save: async () => {
      throw new Error("insert failed");
    },
  });

  editor.startEdit(DATA_GRID_QUICK_ENTRY_DRAFT_ROW_ID, 1);
  editor.editValue.value = "Grace";
  await editor.commitEditFromBlur();

  assert.equal(editor.saveError.value, "insert failed");
  assert.deepEqual(editor.newRows.value, [[null, "Grace"]]);
  assert.equal(editor.hasPendingChanges.value, true);

  editor.startEdit(-1, 1);

  assert.deepEqual(editor.editingCell.value, { rowId: -1, col: 1 });
});
