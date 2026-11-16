import { describe, expect, it } from "vitest";
import { canSaveSqlTab, type SqlTabSaveTarget } from "@/lib/tabs/sqlTabSaveTarget";

const PROCEDURE_SOURCE = { schema: "dbo", name: "p", objectType: "PROCEDURE" } as const;

function saveTarget(overrides: Partial<SqlTabSaveTarget>): SqlTabSaveTarget {
  return { externalSqlPath: undefined, savedSqlId: undefined, sql: "", objectSource: undefined, ...overrides };
}

describe("canSaveSqlTab", () => {
  it("keeps a saved SQL library tab saveable after its content is deleted", () => {
    // Issue #9247: emptying a query file is a legitimate edit that must reach the file.
    expect(canSaveSqlTab(saveTarget({ savedSqlId: "file-1", sql: "" }))).toBe(true);
  });

  it("treats whitespace-only content in a saved tab as the emptied state, not as content", () => {
    expect(canSaveSqlTab(saveTarget({ savedSqlId: "file-1", sql: "\n\t " }))).toBe(true);
  });

  it("keeps an external .sql file tab saveable after its content is deleted", () => {
    expect(canSaveSqlTab(saveTarget({ externalSqlPath: "/tmp/query.sql", sql: "" }))).toBe(true);
  });

  it("still allows a brand-new tab with content", () => {
    expect(canSaveSqlTab(saveTarget({ sql: "SELECT 1;" }))).toBe(true);
  });

  it("still blocks a brand-new tab with nothing to persist", () => {
    expect(canSaveSqlTab(saveTarget({ sql: "  \n" }))).toBe(false);
  });

  it("still blocks an emptied object-source tab", () => {
    // Saving an empty routine body would send a body-less CREATE to the server.
    expect(canSaveSqlTab(saveTarget({ objectSource: PROCEDURE_SOURCE, sql: "" }))).toBe(false);
    expect(canSaveSqlTab(saveTarget({ objectSource: PROCEDURE_SOURCE, savedSqlId: "file-1", sql: "" }))).toBe(false);
  });

  it("allows an object-source tab with content", () => {
    expect(canSaveSqlTab(saveTarget({ objectSource: PROCEDURE_SOURCE, sql: "CREATE PROCEDURE dbo.p AS SELECT 1;" }))).toBe(true);
  });
});
