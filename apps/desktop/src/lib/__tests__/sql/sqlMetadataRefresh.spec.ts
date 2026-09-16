import { describe, expect, it } from "vitest";
import { sqlMetadataRefreshTarget } from "@/lib/sql/sqlMetadataRefresh";

describe("sqlMetadataRefreshTarget", () => {
  it.each(["CREATE TEMP TABLE session_rows (id int)", "CREATE GLOBAL TEMPORARY TABLE session_rows (id int)", "DROP TABLE #temp_list", "DROP TABLE IF EXISTS ##global_temp", "ALTER TABLE [#temp_list] ADD note nvarchar(50)"])(
    "does not refresh persistent metadata for temporary table DDL: %s",
    (sql) => {
      expect(sqlMetadataRefreshTarget(sql, "dbo")).toEqual({ scope: "none" });
    },
  );

  it("still refreshes the active schema for persistent table DDL", () => {
    expect(sqlMetadataRefreshTarget("DROP TABLE orders", "dbo")).toEqual({ scope: "database", schema: "dbo" });
  });

  it("does not treat MySQL hash comments as metadata changes", () => {
    expect(sqlMetadataRefreshTarget("SELECT 1; # DROP TABLE orders", "app")).toEqual({ scope: "none" });
  });

  it("refreshes persistent DDL while ignoring temporary statements in the same batch", () => {
    expect(sqlMetadataRefreshTarget("CREATE TABLE #stage (id int); ALTER TABLE sales.orders ADD note varchar(50)", "dbo")).toEqual({ scope: "database", schema: "sales" });
  });
});
