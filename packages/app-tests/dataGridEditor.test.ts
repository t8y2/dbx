import { strict as assert } from "node:assert";
import { test } from "vitest";
import { computed, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useDataGridEditor } from "../../apps/desktop/src/composables/useDataGridEditor.ts";
import type { CellValue } from "../../apps/desktop/src/lib/cellValue.ts";
import type { DataGridSaveStatementOptions } from "../../apps/desktop/src/lib/dataGridSql.ts";
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

function createPeopleGridEditor(result = computed(() => ({ columns: ["id", "name"], rows: [[1, "Ada"] as CellValue[]] }))) {
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

test("failed table data save records a failed history entry", async () => {
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
    if (url === "/api/query/execute-in-transaction") {
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
});
