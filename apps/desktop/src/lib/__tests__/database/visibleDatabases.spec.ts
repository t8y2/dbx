import { describe, expect, it } from "vitest";
import { connectionUsesVisibleSchemaFilter, filterSchemaNamesForConnection, filterSchemaNamesForVisiblePicker, isSystemSchemaName } from "@/lib/database/visibleDatabases";

describe("visibleDatabases schema filtering", () => {
  it("hides common Kingbase system schemas by default", () => {
    expect(filterSchemaNamesForVisiblePicker(["anon", "dbms_job", "information_schema", "pg_catalog", "public", "sys", "sys_catalog", "wmsys", "xlog_record_read"], { db_type: "kingbase", username: "test" })).toEqual(["public"]);
  });

  it("keeps the current schema visible even when it matches a system schema name", () => {
    expect(
      filterSchemaNamesForVisiblePicker(["public", "sys", "sys_catalog"], {
        db_type: "kingbase",
        username: "sys",
      }),
    ).toEqual(["public", "sys"]);
  });

  it("keeps Oracle DIP visible while hiding default system schemas", () => {
    expect(filterSchemaNamesForConnection(["DBX_TEST", "DIP", "SYSTEM"], { db_type: "oracle", database: "XE" }, "XE")).toEqual(["DBX_TEST", "DIP"]);
  });

  it("uses Oracle schema filtering for inferred JDBC connections", () => {
    const connection = {
      db_type: "jdbc" as const,
      connection_string: "jdbc:oracle:thin:@//localhost:1521/XE",
      username: "DBX_TEST",
    };

    expect(connectionUsesVisibleSchemaFilter(connection)).toBe(true);
    expect(filterSchemaNamesForConnection(["ANONYMOUS", "DBX_TEST", "SYS", "SYSTEM"], connection, "")).toEqual(["DBX_TEST"]);
  });

  it("keeps the Dameng login schema visible while hiding default system schemas", () => {
    expect(filterSchemaNamesForConnection(["APP", "SYS", "SYSDBA", "SYSDBO", "SYSAUDITOR"], { db_type: "dameng", username: "SYSDBA" }, "")).toEqual(["APP", "SYSDBA"]);
  });

  it("hides openGauss system schemas and prefixes while keeping user schemas", () => {
    expect(filterSchemaNamesForVisiblePicker(["blockchain", "cstore", "db4ai", "dbe_perf", "dbe_pldeveloper", "dbe_sql_util", "information_schema", "pg_catalog", "public", "snapshot", "sqladvisor", "xmltype"], { db_type: "opengauss", username: "app_user" })).toEqual(["public"]);
  });

  it("keeps all schemas visible when show-system-schemas is enabled", () => {
    expect(filterSchemaNamesForConnection(["blockchain", "db4ai", "public", "test2", "xmltype"], { db_type: "opengauss", show_system_schemas: true }, "postgres")).toEqual(["blockchain", "db4ai", "public", "test2", "xmltype"]);
  });

  it("respects explicit visible schema configuration after default filtering", () => {
    expect(
      filterSchemaNamesForConnection(
        ["public", "sys_catalog", "reporting"],
        {
          db_type: "kingbase",
          visible_schemas: { test: ["sys_catalog"] },
        },
        "test",
      ),
    ).toEqual(["sys_catalog"]);
  });

  it("matches prefix-based system schema rules", () => {
    expect(isSystemSchemaName("kingbase", "xlog_record_read")).toBe(true);
    expect(isSystemSchemaName("opengauss", "dbe_pldeveloper")).toBe(true);
    expect(isSystemSchemaName("kingbase", "public")).toBe(false);
  });
});

describe("visible database wildcard patterns (issue #7164)", () => {
  it("matches names with % and _ wildcards", async () => {
    const { databaseNameMatchesVisiblePatterns } = await import("@/lib/database/visibleDatabases");
    expect(databaseNameMatchesVisiblePatterns("n1_order", ["%n1%"])).toBe(true);
    expect(databaseNameMatchesVisiblePatterns("main", ["%n1%"])).toBe(false);
    expect(databaseNameMatchesVisiblePatterns("db1", ["db_"])).toBe(true);
    expect(databaseNameMatchesVisiblePatterns("db12", ["db_"])).toBe(false);
    expect(databaseNameMatchesVisiblePatterns("a.b", ["a.b"])).toBe(true);
    expect(databaseNameMatchesVisiblePatterns("axb", ["a.b"])).toBe(false);
    expect(databaseNameMatchesVisiblePatterns("N1_ORDER", ["%n1%"])).toBe(false);
    expect(databaseNameMatchesVisiblePatterns("any", [])).toBe(false);
    expect(databaseNameMatchesVisiblePatterns("any", undefined)).toBe(false);
  });

  it("unions exact selection with pattern matches in filterVisibleDatabaseNames", async () => {
    const { filterVisibleDatabaseNames } = await import("@/lib/database/visibleDatabases");
    const names = ["n1_order", "n2_user", "main", "report"];
    expect(filterVisibleDatabaseNames(names, ["main"], ["%n1%"])).toEqual(["n1_order", "main"]);
    expect(filterVisibleDatabaseNames(names, undefined, ["n%"])).toEqual(["n1_order", "n2_user"]);
    expect(filterVisibleDatabaseNames(names, ["main"], undefined)).toEqual(["main"]);
    expect(filterVisibleDatabaseNames(names, undefined, [])).toEqual(names);
  });

  it("applies patterns for connections in filterDatabaseNamesForConnection", async () => {
    const { filterDatabaseNamesForConnection } = await import("@/lib/database/visibleDatabases");
    const connection = { db_type: "mysql" as const, visible_database_patterns: ["%n1%"] };
    expect(filterDatabaseNamesForConnection(["n1_order", "main", "mysql", "sys"], connection)).toEqual(["n1_order"]);
  });

  it("parses user pattern input with separators, trimming and dedupe", async () => {
    const { parseVisibleDatabasePatternsInput } = await import("@/lib/database/visibleDatabases");
    expect(parseVisibleDatabasePatternsInput(" %n1%, n2_； \n%n1% ,，")).toEqual(["%n1%", "n2_"]);
    expect(parseVisibleDatabasePatternsInput("   ")).toEqual([]);
  });

  it("treats pattern-only configuration as a configured sidebar filter", async () => {
    const { connectionHasConfiguredSidebarVisibleFilter } = await import("@/lib/sidebar/sidebarVisibleFilterSummary");
    expect(connectionHasConfiguredSidebarVisibleFilter({ db_type: "mysql", visible_databases: undefined, visible_database_patterns: ["%n1%"] })).toBe(true);
    expect(connectionHasConfiguredSidebarVisibleFilter({ db_type: "mysql", visible_databases: undefined, visible_database_patterns: [] })).toBe(false);
  });

  it("counts pattern-matched databases in the sidebar filter summary", async () => {
    const { sidebarVisibleFilterSummary } = await import("@/lib/sidebar/sidebarVisibleFilterSummary");
    const summary = sidebarVisibleFilterSummary({ db_type: "mysql", visible_databases: ["main"], visible_database_patterns: ["%n1%"] }, ["main", "n1_order", "n2_user", "mysql"]);
    expect(summary.isActive).toBe(true);
    expect(summary.selected).toBe(2);
    expect(summary.total).toBe(3);
  });
});
