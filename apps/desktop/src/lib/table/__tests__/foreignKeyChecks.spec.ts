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

  it("runs setup, body, and restore on one session", async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (sql: string, onProgress: (p: { completed: number; total: number; success: boolean }) => void) => {
      calls.push(sql);
      if (sql.includes("DROP TABLE")) {
        onProgress({ completed: 1, total: 2, success: true });
        onProgress({ completed: 2, total: 2, success: false });
        return [result(0), result(1, { execution_error: true, error: { code: "Q", detail: "locked" } as QueryResult["error"] })];
      }
      return [result(0)];
    });
    const progress: number[] = [];
    const results = await runForeignKeyChecksBatch(
      ["DROP TABLE `a`", "DROP TABLE `b`"],
      "disable",
      {
        open: vi.fn(),
        execute,
        close: vi.fn(),
      },
      (p) => progress.push(p.completed),
    );

    expect(execute).toHaveBeenCalledTimes(4);
    expect(calls).toEqual(["SET @dbx_saved_foreign_key_checks = @@SESSION.FOREIGN_KEY_CHECKS", "SET FOREIGN_KEY_CHECKS = 0", "DROP TABLE `a`;\nDROP TABLE `b`;", "SET FOREIGN_KEY_CHECKS = @dbx_saved_foreign_key_checks"]);
    expect(progress).toEqual([1, 2]);
    expect(results.map((r) => r.statement_index)).toEqual([0, 1]);

    const outcome = foreignKeyChecksTargetResults([{ target: "a" }, { target: "b" }], results);
    expect(outcome.succeeded).toEqual(["a"]);
    expect(outcome.failed[0]).toMatchObject({ target: "b" });
    expect(outcome.failed[0]!.error.message).toBe("locked");
  });

  it("does not run the body when setup fails and still closes the session", async () => {
    const calls: string[] = [];
    const executor = {
      open: vi.fn(),
      execute: vi.fn(async (sql: string) => {
        calls.push(sql);
        return [sql.startsWith("SET @") ? result(0) : result(0, { execution_error: true, error: { code: "Q", detail: "denied" } as QueryResult["error"] })];
      }),
      close: vi.fn(),
    };
    await expect(runForeignKeyChecksBatch(["DROP TABLE `a`"], "disable", executor)).rejects.toThrow("Failed to set FOREIGN_KEY_CHECKS: denied");
    expect(calls).toEqual(["SET @dbx_saved_foreign_key_checks = @@SESSION.FOREIGN_KEY_CHECKS", "SET FOREIGN_KEY_CHECKS = 0", "SET FOREIGN_KEY_CHECKS = @dbx_saved_foreign_key_checks"]);
    expect(executor.close).toHaveBeenCalledOnce();
  });

  it("does not restore when saving the original value fails", async () => {
    const executor = {
      open: vi.fn(),
      execute: vi.fn().mockResolvedValue([result(0, { execution_error: true, error: { code: "Q", detail: "save denied" } as QueryResult["error"] })]),
      close: vi.fn(),
    };
    await expect(runForeignKeyChecksBatch(["DROP TABLE `a`"], "disable", executor)).rejects.toThrow("Failed to save FOREIGN_KEY_CHECKS: save denied");
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(executor.close).toHaveBeenCalledOnce();
  });

  it("restores after body cancellation and reports restore failure", async () => {
    const executor = {
      open: vi.fn(),
      execute: vi
        .fn()
        .mockResolvedValueOnce([result(0)])
        .mockResolvedValueOnce([result(0)])
        .mockRejectedValueOnce(new Error("cancelled"))
        .mockResolvedValueOnce([result(0)]),
      close: vi.fn(),
    };
    await expect(runForeignKeyChecksBatch(["DROP TABLE `a`"], "disable", executor)).rejects.toThrow("cancelled");
    expect(executor.execute).toHaveBeenCalledTimes(4);

    const restoreFailure = {
      open: vi.fn(),
      execute: vi
        .fn()
        .mockResolvedValueOnce([result(0)])
        .mockResolvedValueOnce([result(0)])
        .mockResolvedValueOnce([result(0)])
        .mockResolvedValueOnce([result(0, { execution_error: true, error: { code: "Q", detail: "restore denied" } as QueryResult["error"] })]),
      close: vi.fn(),
    };
    await expect(runForeignKeyChecksBatch(["DROP TABLE `a`"], "disable", restoreFailure)).rejects.toThrow("restore denied");
    expect(restoreFailure.close).toHaveBeenCalledOnce();
  });

  it("treats a missing statement result as failed", () => {
    const outcome = foreignKeyChecksTargetResults([{ target: "a" }, { target: "b" }], [result(0)]);
    expect(outcome.succeeded).toEqual(["a"]);
    expect(outcome.failed.map((f) => f.target)).toEqual(["b"]);
  });
});
