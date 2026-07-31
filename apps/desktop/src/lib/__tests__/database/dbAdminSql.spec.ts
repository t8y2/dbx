import { describe, expect, it } from "vitest";
import { collectDuplicateTableColumnComments, duplicateTableStructureRequiresScript } from "@/lib/database/dbAdminSql";

describe("collectDuplicateTableColumnComments", () => {
  it("preserves meaningful whitespace and excludes whitespace-only comments", () => {
    expect(
      collectDuplicateTableColumnComments([
        { name: "LEADING", comment: "  leading" },
        { name: "TRAILING", comment: "trailing  " },
        { name: "BOTH", comment: "  Owner's; display name  " },
        { name: "WHITESPACE_ONLY", comment: " \t\n" },
        { name: "EMPTY", comment: "" },
        { name: "NULL", comment: null },
      ]),
    ).toEqual([
      { name: "LEADING", comment: "  leading" },
      { name: "TRAILING", comment: "trailing  " },
      { name: "BOTH", comment: "  Owner's; display name  " },
    ]);
  });
});

describe("duplicateTableStructureRequiresScript", () => {
  it("detects generated table and column comment statements", () => {
    expect(duplicateTableStructureRequiresScript('CREATE TABLE "copy" (LIKE "source" INCLUDING ALL);\nCOMMENT ON TABLE "copy" IS \'orders\';')).toBe(true);
    expect(duplicateTableStructureRequiresScript('CREATE TABLE "copy" AS SELECT * FROM "source" WHERE 1=0;\nCOMMENT ON COLUMN "copy"."id" IS \'identifier\';')).toBe(true);
  });

  it("keeps single-statement structure copies on the query path", () => {
    expect(duplicateTableStructureRequiresScript('CREATE TABLE "copy" (LIKE "source" INCLUDING ALL);')).toBe(false);
  });
});
