import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FOREIGN_KEY_DRILL_BACK,
  foreignKeyDrillBackEntries,
  foreignKeyDrillBackEntryMatchesTab,
  foreignKeyDrillTableTargetFromTab,
  markForeignKeyDrillBackPendingArrival,
  peekForeignKeyDrillBack,
  popForeignKeyDrillBack,
  pushForeignKeyDrillBack,
  type ForeignKeyDrillBackEntry,
  type ForeignKeyDrillBackTab,
} from "@/lib/dataGrid/foreignKeyDrillBack";

function dataTab(overrides: Partial<ForeignKeyDrillBackTab> = {}): ForeignKeyDrillBackTab {
  return {
    connectionId: "c1",
    database: "db",
    sql: "SELECT * FROM orders",
    mode: "data",
    whereInput: undefined,
    tableMeta: { catalog: undefined, database: "db", schema: "public", tableName: "orders", tableType: "TABLE", columns: [], primaryKeys: [] },
    ...overrides,
  };
}

function queryTab(overrides: Partial<ForeignKeyDrillBackTab> = {}): ForeignKeyDrillBackTab {
  return {
    connectionId: "c1",
    database: "db",
    sql: "SELECT * FROM child",
    mode: "query",
    whereInput: undefined,
    tableMeta: undefined,
    ...overrides,
  };
}

function tableEntry(overrides: Partial<ForeignKeyDrillBackEntry> = {}): ForeignKeyDrillBackEntry {
  return {
    restore: { kind: "tableTarget", target: { connectionId: "c1", database: "db", schema: "public", tableName: "orders" } },
    arrivedAt: { connectionId: "c1", database: "db", schema: "public", tableName: "customers" },
    label: "orders",
    ...overrides,
  };
}

function queryEntry(overrides: Partial<ForeignKeyDrillBackEntry> = {}): ForeignKeyDrillBackEntry {
  return {
    restore: { kind: "queryResult", sql: "SELECT * FROM child" },
    arrivedSql: 'SELECT * FROM customers WHERE "id" = 7',
    label: "customers",
    ...overrides,
  };
}

const matchesAny = () => true;

beforeEach(() => {
  // drain the shared reactive stacks between tests
  for (const tabId of ["t1", "t2"]) {
    while (popForeignKeyDrillBack(tabId, matchesAny)) {
      // pop until empty
    }
  }
});

describe("foreignKeyDrillBack stack", () => {
  it("pushes and pops in LIFO order", () => {
    pushForeignKeyDrillBack("t1", tableEntry());
    pushForeignKeyDrillBack("t1", queryEntry());
    expect(foreignKeyDrillBackEntries("t1")).toHaveLength(2);
    expect(popForeignKeyDrillBack("t1", matchesAny)?.restore.kind).toBe("queryResult");
    expect(popForeignKeyDrillBack("t1", matchesAny)?.restore.kind).toBe("tableTarget");
    expect(popForeignKeyDrillBack("t1", matchesAny)).toBeNull();
  });

  it("keeps stacks per tab and reports empty for unknown tabs", () => {
    pushForeignKeyDrillBack("t1", tableEntry());
    expect(foreignKeyDrillBackEntries("t2")).toHaveLength(0);
    expect(popForeignKeyDrillBack("t2", matchesAny)).toBeNull();
  });

  it("caps the stack depth", () => {
    for (let index = 0; index < MAX_FOREIGN_KEY_DRILL_BACK + 5; index += 1) {
      pushForeignKeyDrillBack("t1", queryEntry({ arrivedSql: `sql-${index}` }));
    }
    expect(foreignKeyDrillBackEntries("t1")).toHaveLength(MAX_FOREIGN_KEY_DRILL_BACK);
    expect(foreignKeyDrillBackEntries("t1")[0].arrivedSql).toBe("sql-5");
  });

  it("keeps a not-yet-arrived top hidden but intact, then drops it once uncovered and stale", () => {
    pushForeignKeyDrillBack("t1", tableEntry());
    pushForeignKeyDrillBack("t1", tableEntry({ arrivedAt: { connectionId: "c1", database: "db", schema: "public", tableName: "other" } }));
    // 跳转刚发起、新表尚未落地：tab 仍显示旧内容，peek 返回 null 但不得丢弃栈顶
    expect(peekForeignKeyDrillBack("t1", (entry) => entry.arrivedAt?.tableName === "customers")).toBeNull();
    expect(foreignKeyDrillBackEntries("t1")).toHaveLength(2);
    // 新表落地（匹配成功）清除落地标记；此后失配的栈顶才被视为过期丢弃
    expect(peekForeignKeyDrillBack("t1", (entry) => entry.arrivedAt?.tableName === "other")).not.toBeNull();
    expect(peekForeignKeyDrillBack("t1", (entry) => entry.arrivedAt?.tableName === "customers")?.arrivedAt?.tableName).toBe("customers");
    expect(foreignKeyDrillBackEntries("t1")).toHaveLength(1);
  });

  it("re-marks the remaining top as pending so chained backs survive the restore transition", () => {
    pushForeignKeyDrillBack("t1", tableEntry());
    pushForeignKeyDrillBack("t1", tableEntry({ arrivedAt: { connectionId: "c1", database: "db", schema: "public", tableName: "other" } }));
    // 弹出栈顶发起返回（如 A→B→C 链上从 C 返回 B）：剩余栈顶在 B 落地前不可被丢弃
    expect(popForeignKeyDrillBack("t1", (entry) => entry.arrivedAt?.tableName === "other")).not.toBeNull();
    markForeignKeyDrillBackPendingArrival("t1");
    // 返回途中 tab 仍显示弹出的"other"：剩余栈顶（customers）等待落地，只隐藏不丢弃
    expect(peekForeignKeyDrillBack("t1", (entry) => entry.arrivedAt?.tableName === "other")).toBeNull();
    expect(foreignKeyDrillBackEntries("t1")).toHaveLength(1);
    // 落地后恢复可见
    expect(peekForeignKeyDrillBack("t1", (entry) => entry.arrivedAt?.tableName === "customers")).not.toBeNull();
    expect(foreignKeyDrillBackEntries("t1")).toHaveLength(1);
  });
});

describe("foreignKeyDrillBackEntryMatchesTab (table-data arrival)", () => {
  it("matches the stamped table identity including catalog/schema fallbacks", () => {
    const entry = tableEntry();
    expect(foreignKeyDrillBackEntryMatchesTab(entry, dataTab({ tableMeta: { catalog: undefined, database: "db", schema: "public", tableName: "customers", tableType: "TABLE", columns: [], primaryKeys: [] } }))).toBe(true);
    expect(foreignKeyDrillBackEntryMatchesTab(entry, dataTab({ tableMeta: undefined }))).toBe(false);
  });

  it("rejects a different table, schema, database, connection or non-data mode", () => {
    const entry = tableEntry();
    expect(foreignKeyDrillBackEntryMatchesTab(entry, dataTab())).toBe(false);
    expect(foreignKeyDrillBackEntryMatchesTab(entry, dataTab({ tableMeta: { catalog: undefined, database: "db", schema: "sales", tableName: "customers", tableType: "TABLE", columns: [], primaryKeys: [] } }))).toBe(false);
    expect(foreignKeyDrillBackEntryMatchesTab(entry, dataTab({ database: "other" }))).toBe(false);
    expect(foreignKeyDrillBackEntryMatchesTab(entry, queryTab({ tableMeta: { catalog: undefined, database: "db", schema: "public", tableName: "customers", tableType: "TABLE", columns: [], primaryKeys: [] } }))).toBe(false);
  });

  it("rejects a table entry without arrival identity", () => {
    expect(foreignKeyDrillBackEntryMatchesTab({ restore: { kind: "tableTarget", target: { connectionId: "c1", database: "db", tableName: "orders" } } }, dataTab())).toBe(false);
  });
});

describe("foreignKeyDrillBackEntryMatchesTab (query result arrival)", () => {
  it("matches the SQL behind the displayed result with resultBaseSql precedence", () => {
    const entry = queryEntry();
    expect(foreignKeyDrillBackEntryMatchesTab(entry, queryTab({ resultBaseSql: 'SELECT * FROM customers WHERE "id" = 7' }))).toBe(true);
    expect(foreignKeyDrillBackEntryMatchesTab(entry, queryTab({ resultBaseSql: undefined, lastExecutedSql: 'SELECT * FROM customers WHERE "id" = 7' }))).toBe(true);
    expect(foreignKeyDrillBackEntryMatchesTab(entry, queryTab())).toBe(false);
  });

  it("rejects an entry without arrivedSql", () => {
    expect(foreignKeyDrillBackEntryMatchesTab({ restore: { kind: "queryResult", sql: "SELECT 1" } }, queryTab({ sql: "SELECT 1" }))).toBe(false);
  });
});

describe("foreignKeyDrillTableTargetFromTab", () => {
  it("captures the table identity plus the live where filter", () => {
    const target = foreignKeyDrillTableTargetFromTab(dataTab({ whereInput: '"status" = 2' }));
    expect(target).toMatchObject({ connectionId: "c1", database: "db", schema: "public", tableName: "orders", tableType: "TABLE", whereInput: '"status" = 2' });
  });

  it("omits an empty where filter and returns null without a table identity", () => {
    expect(foreignKeyDrillTableTargetFromTab(dataTab())?.whereInput).toBeUndefined();
    expect(foreignKeyDrillTableTargetFromTab(queryTab())).toBeNull();
    expect(foreignKeyDrillTableTargetFromTab(dataTab({ tableMeta: undefined }))).toBeNull();
  });
});
