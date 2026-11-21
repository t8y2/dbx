import { describe, expect, it } from "vitest";
import { initialVisibleDatabaseSelection } from "@/lib/connection/connectionVisibleDatabases";
import { MATCH_ALL_VISIBLE_DATABASE_PATTERN, filterDatabaseNamesForConnection } from "@/lib/database/visibleDatabases";

describe("initialVisibleDatabaseSelection", () => {
  it("lists the default non-system selection when no filter is configured", () => {
    expect(initialVisibleDatabaseSelection(["app", "mysql", "sys"], undefined, { db_type: "mysql" })).toEqual(["app"]);
  });

  it("selects every database when the match-all pattern is persisted", () => {
    const connection = { db_type: "mysql" as const, visible_database_patterns: [MATCH_ALL_VISIBLE_DATABASE_PATTERN] };
    expect(initialVisibleDatabaseSelection(["app", "mysql", "sys"], undefined, connection)).toEqual(["app", "mysql", "sys"]);
  });

  it("unions an explicit selection with wildcard matches", () => {
    const connection = { db_type: "mysql" as const, visible_database_patterns: ["log_%"] };
    expect(initialVisibleDatabaseSelection(["app", "log_a", "mysql"], ["mysql"], connection)).toEqual(["log_a", "mysql"]);
  });
});

describe("match-all visible database pattern (#12887)", () => {
  it("keeps system databases and databases created later visible", () => {
    const connection = { db_type: "mysql" as const, visible_database_patterns: [MATCH_ALL_VISIBLE_DATABASE_PATTERN] };
    expect(filterDatabaseNamesForConnection(["app", "information_schema", "mysql", "sys", "new_db"], connection)).toEqual(["app", "information_schema", "mysql", "sys", "new_db"]);
  });

  it("keeps the picker selection after show-all and lists newly created databases", () => {
    const names = ["information_schema", "mysql", "performance_schema", "sys", "app"];
    const saved = { db_type: "mysql" as const, visible_databases: undefined, visible_database_patterns: [MATCH_ALL_VISIBLE_DATABASE_PATTERN] };
    expect(filterDatabaseNamesForConnection([...names, "app_new"], saved)).toEqual([...names, "app_new"]);
    expect(initialVisibleDatabaseSelection(names, undefined, saved)).toEqual(names);
  });
});
