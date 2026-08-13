import { describe, expect, it } from "vitest";
import { savedSqlImportTarget } from "@/lib/savedSql/savedSqlImportTarget";

describe("savedSqlImportTarget", () => {
  it("inherits an explicitly associated local file target at the library root", () => {
    expect(savedSqlImportTarget({ connectionId: "conn-1", database: "sales", catalog: "hive" })).toEqual({
      connectionId: "conn-1",
      database: "sales",
      catalog: "hive",
    });
  });

  it("keeps an unassociated local file unassociated at the library root", () => {
    expect(savedSqlImportTarget({ connectionId: "", database: "" })).toEqual({ connectionId: "", database: "" });
  });

  it("keeps the destination folder connection and inherits a matching database", () => {
    expect(savedSqlImportTarget({ connectionId: "conn-1", database: "sales", catalog: "iceberg" }, { connectionId: "conn-1" })).toEqual({
      connectionId: "conn-1",
      database: "sales",
      catalog: "iceberg",
    });
  });

  it("does not apply a database from a different connection to the destination folder", () => {
    expect(savedSqlImportTarget({ connectionId: "conn-2", database: "analytics" }, { connectionId: "conn-1" })).toEqual({
      connectionId: "conn-1",
      database: "",
      catalog: undefined,
    });
  });

  it("uses the destination folder for an unassociated source", () => {
    expect(savedSqlImportTarget({ connectionId: "", database: "" }, { connectionId: "conn-1" })).toEqual({
      connectionId: "conn-1",
      database: "",
      catalog: undefined,
    });
  });
});
