import { describe, expect, it } from "vitest";
import { collectDuplicateTableColumnComments } from "@/lib/database/dbAdminSql";

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
