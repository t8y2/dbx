import type { QueryTab } from "@/types/database";
import type { TabResultSnapshot } from "@/lib/tabs/tabResultCache";

export function queryResultLifecycleSnapshot(): TabResultSnapshot {
  const first = {
    columns: ["id", "name"],
    rows: [[1, "Ada"]],
    affected_rows: 0,
    execution_time_ms: 4,
    sourceStatement: "SELECT id, name FROM users",
  };
  const second = {
    columns: ["count"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 2,
    sourceStatement: "SELECT COUNT(*) FROM users",
  };
  const resultRuns: NonNullable<QueryTab["resultRuns"]> = [
    {
      id: "run-1",
      sequence: 1,
      result: first,
      results: [first, second],
      activeResultIndex: 0,
      resultLocalSortOriginalRows: [[1, "Ada"]],
      resultBaseSql: "SELECT id, name FROM users",
      resultPageSql: "SELECT id, name FROM users LIMIT 100 OFFSET 200",
      resultPageLimit: 100,
      resultPageOffset: 200,
      tableMeta: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        columns: [{ name: "id", data_type: "integer", nullable: false }],
        primaryKeys: ["id"],
      },
    },
  ];
  return {
    result: first,
    results: [first, second],
    activeResultIndex: 0,
    resultLocalSortOriginalRows: [[1, "Ada"]],
    resultRuns,
    activeResultRunId: "run-1",
    queryAnalysis: { tableName: "users", schema: "public", allowInsert: true, allowInsertDelete: true },
    querySourceColumns: ["id", "name"],
    tableMeta: resultRuns[0].tableMeta,
    resultPageSql: "SELECT id, name FROM users LIMIT 100 OFFSET 200",
    resultPageLimit: 100,
    resultPageOffset: 200,
    resultCountSql: "SELECT COUNT(*) FROM users",
    resultTotalRowCount: 301,
    cachedAt: 1,
  };
}
