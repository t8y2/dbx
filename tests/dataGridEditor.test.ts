import { strict as assert } from "node:assert";
import test from "node:test";
import { computed, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { useDataGridEditor } from "../src/composables/useDataGridEditor.ts";
import type { ColumnInfo } from "../src/types/database.ts";

type CellValue = string | number | boolean | null;

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
    customSave: computed(() => async () => {
      saveCalls += 1;
    }),
    sql: computed(() => undefined),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
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
    customSave: computed(() => undefined),
    sql: computed(() => undefined),
    searchText: ref(""),
    whereFilterInput: ref(""),
    orderByInput: ref(""),
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
