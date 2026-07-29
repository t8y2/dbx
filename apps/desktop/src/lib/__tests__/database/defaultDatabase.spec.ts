import { describe, expect, it } from "vitest";
import { decodeSelectableDatabaseValue, EMPTY_DATABASE_SELECT_VALUE, encodeSelectableDatabaseValue, isDefaultDatabase, resolveDefaultDatabase, TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE } from "@/lib/database/defaultDatabase";

describe("defaultDatabase selectable values", () => {
  it("encodes empty tree-schema databases with the default database sentinel", () => {
    expect(encodeSelectableDatabaseValue("postgres", "")).toBe(TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE);
    expect(decodeSelectableDatabaseValue("postgres", TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE)).toBe("");
  });

  it("encodes empty non-tree-schema databases with a non-empty sentinel", () => {
    expect(encodeSelectableDatabaseValue("access", "")).toBe(EMPTY_DATABASE_SELECT_VALUE);
    expect(decodeSelectableDatabaseValue("access", EMPTY_DATABASE_SELECT_VALUE)).toBe("");
  });

  it("preserves non-empty database names", () => {
    expect(encodeSelectableDatabaseValue("access", "653128SXB.mdb")).toBe("653128SXB.mdb");
    expect(decodeSelectableDatabaseValue("access", "653128SXB.mdb")).toBe("653128SXB.mdb");
  });

  it("uses main for SQLite connections with stale file paths", () => {
    expect(resolveDefaultDatabase({ db_type: "sqlite", database: "/tmp/stale.sqlite" }, [])).toBe("main");
    expect(resolveDefaultDatabase({ db_type: "sqlite", database: "C:\\data\\stale.db" }, [])).toBe("main");
    expect(resolveDefaultDatabase({ db_type: "sqlite", database: "file:/tmp/stale.sqlite" }, [])).toBe("main");
    expect(resolveDefaultDatabase({ db_type: "sqlite", database: ":memory:" }, [])).toBe("main");
    expect(isDefaultDatabase({ db_type: "sqlite", database: "/tmp/stale.sqlite" }, "main")).toBe(true);
    expect(resolveDefaultDatabase({ db_type: "sqlite", host: "relative.sqlite", database: undefined }, ["relative.sqlite"])).toBe("main");
    expect(resolveDefaultDatabase({ db_type: "sqlite", host: "legacyfile", database: undefined }, ["legacyfile"])).toBe("main");
  });

  it("preserves a SQLite attached database alias", () => {
    expect(resolveDefaultDatabase({ db_type: "sqlite", database: "analytics" }, ["main", "analytics"])).toBe("analytics");
    expect(isDefaultDatabase({ db_type: "sqlite", database: "analytics" }, "analytics")).toBe(true);
    expect(resolveDefaultDatabase({ db_type: "sqlite", host: "primary.db", database: undefined }, ["analytics.db"])).toBe("analytics.db");
  });
});
