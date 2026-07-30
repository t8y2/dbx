import { describe, expect, it } from "vitest";
import { filterSchemaNamesForConnection, filterSchemaNamesForVisiblePicker, isSystemSchemaName } from "@/lib/database/visibleDatabases";

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
