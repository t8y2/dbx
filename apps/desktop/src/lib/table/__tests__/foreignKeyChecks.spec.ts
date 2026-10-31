import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { foreignKeyChecksPreview, foreignKeyChecksScript, foreignKeyChecksTargetResults, isForeignKeyChecksOverride, runForeignKeyChecksBatch, supportsForeignKeyChecksOption } from "../foreignKeyChecks";

function result(statement_index: number, overrides: Partial<QueryResult> = {}): QueryResult {
  return { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1, statement_index, ...overrides } as QueryResult;
}

describe("foreign key checks option", () => {
  it("is offered for MySQL only", () => {
    expect(supportsForeignKeyChecksOption("mysql")).toBe(true);
    expect(supportsForeignKeyChecksOption("postgres")).toBe(false);
    expect(isForeignKeyChecksOverride("default", "mysql")).toBe(false);
    expect(isForeignKeyChecksOverride("disable", "postgres")).toBe(false);
    expect(isForeignKeyChecksOverride("disable", "mysql")).toBe(true);
  });

  it("leaves the default script unchanged", () => {
    expect(foreignKeyChecksScript(["DROP TABLE `a`", "DROP TABLE `b`;"], "default", "mysql")).toBe("DROP TABLE `a`;\nDROP TABLE `b`;");
    expect(foreignKeyChecksPreview("DROP TABLE `a`;\nDROP TABLE `b`;", "default", "mysql")).toBe("DROP TABLE `a`;\nDROP TABLE `b`;");
  });

  it("wraps disable / enable with save, set and restore of the session value", () => {
    expect(foreignKeyChecksPreview("TRUNCATE TABLE `a`;\nTRUNCATE TABLE `b`;", "disable", "mysql")).toBe(
      ["SET @dbx_saved_foreign_key_checks = @@SESSION.FOREIGN_KEY_CHECKS;", "SET FOREIGN_KEY_CHECKS = 0;", "TRUNCATE TABLE `a`;", "TRUNCATE TABLE `b`;", "SET FOREIGN_KEY_CHECKS = @dbx_saved_foreign_key_checks;"].join("\n"),
    );
    expect(foreignKeyChecksScript(["DELETE FROM `a`"], "enable", "mysql")).toContain("SET FOREIGN_KEY_CHECKS = 1;");
    expect(foreignKeyChecksPreview("TRUNCATE a", "disable", "postgres")).toBe("TRUNCATE a");
  });

  it("runs one continue-on-error batch and maps results back to the caller's statements", async () => {
    const execute = vi.fn(async (_sql: string, onProgress: (p: { completed: number; total: number; success: boolean }) => void) => {
      for (let i = 1; i <= 5; i += 1) onProgress({ completed: i, total: 5, success: i !== 4 });
      return [result(0), result(1), result(2), result(3, { execution_error: true, error: { code: "Q", detail: "locked" } as QueryResult["error"] }), result(4)];
    });
    const progress: number[] = [];
    const results = await runForeignKeyChecksBatch(["DROP TABLE `a`", "DROP TABLE `b`"], "disable", execute, (p) => progress.push(p.completed));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toContain("SET FOREIGN_KEY_CHECKS = 0;");
    expect(execute.mock.calls[0]![2]).toEqual({ continueOnError: true });
    expect(progress).toEqual([1, 2, 2]);
    expect(results.map((r) => r.statement_index)).toEqual([0, 1]);

    const outcome = foreignKeyChecksTargetResults([{ target: "a" }, { target: "b" }], results);
    expect(outcome.succeeded).toEqual(["a"]);
    expect(outcome.failed[0]).toMatchObject({ target: "b" });
    expect(outcome.failed[0]!.error.message).toBe("locked");
  });

  it("fails when the setup statement fails instead of reporting success", async () => {
    const execute = vi.fn(async () => [result(0), result(1, { execution_error: true, error: { code: "Q", detail: "denied" } as QueryResult["error"] }), result(2), result(3)]);
    await expect(runForeignKeyChecksBatch(["DROP TABLE `a`"], "disable", execute)).rejects.toThrow("Failed to set FOREIGN_KEY_CHECKS: denied");
  });

  it("treats a missing statement result as failed", () => {
    const outcome = foreignKeyChecksTargetResults([{ target: "a" }, { target: "b" }], [result(0)]);
    expect(outcome.succeeded).toEqual(["a"]);
    expect(outcome.failed.map((f) => f.target)).toEqual(["b"]);
  });
});
