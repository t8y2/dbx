import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api.ts";
import type { DatabaseSearchColumnLite } from "@/lib/database/databaseSearchColumns";
import { countProbeConditions, DATABASE_SEARCH_PROBE_CONDITION_LIMIT, DATABASE_SEARCH_PROBE_TABLE_BATCH_SIZE, nextProbeChunkEnd, probeTables } from "@/lib/database/databaseSearchProbe";

afterEach(() => {
  vi.restoreAllMocks();
});

function col(name: string, data_type: string): DatabaseSearchColumnLite {
  return { name, data_type, is_primary_key: false };
}

describe("databaseSearchProbe", () => {
  it("counts text columns and numeric columns only for numeric terms", () => {
    const columns = [col("a", "varchar"), col("b", "int"), col("c", "text"), col("d", "decimal")];
    expect(countProbeConditions(columns, "alice")).toBe(2);
    expect(countProbeConditions(columns, "42")).toBe(4);
    expect(countProbeConditions([], "alice")).toBe(0);
  });

  it("caps chunks at the table batch size", () => {
    const tasks = Array.from({ length: 30 }, () => [col("a", "varchar")]);
    expect(nextProbeChunkEnd(0, tasks.length, tasks, "x")).toBe(DATABASE_SEARCH_PROBE_TABLE_BATCH_SIZE);
    expect(nextProbeChunkEnd(15, tasks.length, tasks, "x")).toBe(30);
  });

  it("splits before the table that would exceed the condition limit", () => {
    // 每表 60 条件:第 8 张起累计 480,第 9 张会到 540 > 500 → 批在第 8 张后切分
    const heavy = Array.from({ length: 60 }, (_, i) => col(`c${i}`, "varchar"));
    const tasks = Array.from({ length: 12 }, () => heavy);
    expect(nextProbeChunkEnd(0, tasks.length, tasks, "x")).toBe(8);

    // 无列信息的表按 0 条件计,不触顶
    const unknown = [heavy, undefined, heavy, undefined];
    expect(nextProbeChunkEnd(0, 4, unknown, "x")).toBe(4);
  });

  it("always takes at least one table even beyond the condition limit", () => {
    const huge = Array.from({ length: DATABASE_SEARCH_PROBE_CONDITION_LIMIT + 10 }, (_, i) => col(`c${i}`, "varchar"));
    expect(nextProbeChunkEnd(0, 3, [huge, huge, huge], "x")).toBe(1);
  });

  it("maps label rows back to hit table indexes via includedIndices", async () => {
    const buildSpy = vi.spyOn(api, "buildDatabaseSearchProbeSql").mockResolvedValue({
      sql: "SELECT 1",
      // 输入 3 张表,第 0、2 张进探测分支(t0、t1),第 1 张被剔除
      includedIndices: [0, 2],
    });
    const executeQuery = vi.fn().mockResolvedValue({
      columns: ["TABLE_LABEL", "HITS"],
      rows: [
        ["t0", 3],
        ["t1", 0],
        ["tX", 9],
      ],
    });

    const hits = await probeTables({
      databaseType: "dameng",
      term: "alice",
      limit: 20,
      tables: [
        { tableName: "a", columns: [col("x", "varchar2")] },
        { tableName: "b", columns: [col("x", "blob")] },
        { tableName: "c", columns: [col("y", "text")] },
      ],
      executeQuery,
      executionId: "e",
    });

    expect(buildSpy).toHaveBeenCalled();
    // t0 命中(hits=3)→ 输入下标 0;t1 未命中(hits=0);未知标签 tX 忽略;被剔除的输入下标 1 不出现
    expect([...hits]).toEqual([0]);
    expect(hits.has(1)).toBe(false);
    expect(hits.has(2)).toBe(false);
  });

  it("returns empty set when the builder yields no sql", async () => {
    vi.spyOn(api, "buildDatabaseSearchProbeSql").mockResolvedValue(null);
    const hits = await probeTables({
      databaseType: "mysql",
      term: "alice",
      limit: 20,
      tables: [{ tableName: "a", columns: [col("x", "varchar")] }],
      executeQuery: vi.fn(),
      executionId: "e",
    });
    expect(hits.size).toBe(0);
  });

  it("propagates statement failures so callers fall back per table", async () => {
    vi.spyOn(api, "buildDatabaseSearchProbeSql").mockResolvedValue({ sql: "SELECT 1", includedIndices: [0] });
    const executeQuery = vi.fn().mockRejectedValue(new Error("table dropped"));
    await expect(
      probeTables({
        databaseType: "mysql",
        term: "alice",
        limit: 20,
        tables: [{ tableName: "a", columns: [col("x", "varchar")] }],
        executeQuery,
        executionId: "e",
      }),
    ).rejects.toThrow("table dropped");
  });
});
