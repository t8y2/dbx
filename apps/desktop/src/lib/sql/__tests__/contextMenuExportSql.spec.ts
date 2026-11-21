import { describe, expect, it, vi } from "vitest";
import { resolveContextMenuExportSql } from "../contextMenuExportSql";

const DOCUMENT = ["CREATE TABLE t (id Int64);", "WITH 1 AS min_id SELECT * FROM t WHERE id >= min_id;", "SELECT 2;"].join("\n");
const WITH_STATEMENT = "WITH 1 AS min_id SELECT * FROM t WHERE id >= min_id;";

function sources(overrides: Partial<Parameters<typeof resolveContextMenuExportSql>[0]> = {}) {
  return {
    selectedSql: "",
    position: DOCUMENT.indexOf("WITH"),
    documentSql: DOCUMENT,
    databaseType: "clickhouse" as const,
    findStatementAtPosition: vi.fn(async () => WITH_STATEMENT),
    statementAtPosition: vi.fn(() => null),
    ...overrides,
  };
}

describe("resolveContextMenuExportSql", () => {
  it("exports the selection as-is without asking the backend", async () => {
    const options = sources({ selectedSql: "  SELECT 1  " });

    await expect(resolveContextMenuExportSql(options)).resolves.toBe("SELECT 1");
    expect(options.findStatementAtPosition).not.toHaveBeenCalled();
    expect(options.statementAtPosition).not.toHaveBeenCalled();
  });

  it("exports only the statement at the right-click position in a multi-statement document", async () => {
    const options = sources();

    await expect(resolveContextMenuExportSql(options)).resolves.toBe(WITH_STATEMENT);
    expect(options.findStatementAtPosition).toHaveBeenCalledExactlyOnceWith(DOCUMENT, DOCUMENT.indexOf("WITH"), "clickhouse");
  });

  it("falls back to the whole document when the position is unknown", async () => {
    const options = sources({ position: null });

    await expect(resolveContextMenuExportSql(options)).resolves.toBe(DOCUMENT);
    expect(options.findStatementAtPosition).not.toHaveBeenCalled();
  });

  it("falls back to the front-end statement range when the backend splitter fails", async () => {
    const options = sources({
      findStatementAtPosition: vi.fn(async () => {
        throw new Error("backend unavailable");
      }),
      statementAtPosition: vi.fn(() => WITH_STATEMENT),
    });

    await expect(resolveContextMenuExportSql(options)).resolves.toBe(WITH_STATEMENT);
    expect(options.statementAtPosition).toHaveBeenCalledExactlyOnceWith(DOCUMENT.indexOf("WITH"));
  });

  it("falls back to the front-end statement range when the backend returns only whitespace", async () => {
    const options = sources({ findStatementAtPosition: vi.fn(async () => " \n "), statementAtPosition: vi.fn(() => WITH_STATEMENT) });

    await expect(resolveContextMenuExportSql(options)).resolves.toBe(WITH_STATEMENT);
  });

  it("exports the whole document when no statement can be resolved at all", async () => {
    const options = sources({ findStatementAtPosition: vi.fn(async () => ""), statementAtPosition: vi.fn(() => null) });

    await expect(resolveContextMenuExportSql(options)).resolves.toBe(DOCUMENT);
  });
});
