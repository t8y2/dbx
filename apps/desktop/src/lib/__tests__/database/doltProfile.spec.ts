import { describe, expect, it } from "vitest";
import { DOLT_SQL_ROUTINES, doltObjectTreeProfileForConnection, doltSqlBuiltinTerms, doltSqlRoutineSignatures, doltSystemTablesVisible, isDoltDriverProfile, setDoltSystemTablesVisible } from "@/lib/database/doltProfile";
import type { ConnectionConfig } from "@/types/database";

function doltConfig(urlParams = ""): ConnectionConfig {
  return {
    id: "dolt-1",
    name: "Dolt",
    db_type: "mysql",
    driver_profile: "dolt",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: "app",
    url_params: urlParams,
  };
}

const documentedDoltProcedures = [
  "DOLT_ADD",
  "DOLT_BACKUP",
  "DOLT_BRANCH",
  "DOLT_CHECKOUT",
  "DOLT_CHERRY_PICK",
  "DOLT_CLEAN",
  "DOLT_CLONE",
  "DOLT_COMMIT",
  "DOLT_COMMIT_HASH_OUT",
  "DOLT_CONFLICTS_RESOLVE",
  "DOLT_FETCH",
  "DOLT_GC",
  "DOLT_MERGE",
  "DOLT_PULL",
  "DOLT_PURGE_DROPPED_DATABASES",
  "DOLT_PUSH",
  "DOLT_REBASE",
  "DOLT_REMOTE",
  "DOLT_RESET",
  "DOLT_REVERT",
  "DOLT_RM",
  "DOLT_SQUASH_HISTORY",
  "DOLT_STASH",
  "DOLT_TAG",
  "DOLT_UNDROP",
  "DOLT_UPDATE_COLUMN_TAG",
  "DOLT_VERIFY_CONSTRAINTS",
  "DOLT_STATS_RESTART",
  "DOLT_STATS_STOP",
  "DOLT_STATS_PURGE",
  "DOLT_STATS_ONCE",
  "DOLT_STATS_WAIT",
  "DOLT_STATS_FLUSH",
  "DOLT_STATS_GC",
  "DOLT_STATS_INFO",
];

const documentedDoltScalarFunctions = ["ACTIVE_BRANCH", "DOLT_MERGE_BASE", "DOLT_HASHOF", "DOLT_HASHOF_DB", "DOLT_HASHOF_TABLE", "DOLT_VERSION", "HAS_ANCESTOR", "LAST_INSERT_UUID", "DOLT_JOIN_COST"];

const documentedDoltTableFunctions = ["DOLT_DIFF", "DOLT_DIFF_STAT", "DOLT_DIFF_SUMMARY", "DOLT_JSON_DIFF", "DOLT_LOG", "DOLT_PATCH", "DOLT_PREVIEW_MERGE_CONFLICTS_SUMMARY", "DOLT_PREVIEW_MERGE_CONFLICTS", "DOLT_REFLOG", "DOLT_SCHEMA_DIFF", "DOLT_QUERY_DIFF", "DOLT_BRANCH_STATUS", "DOLT_TEST_RUN"];

describe("doltProfile", () => {
  it("matches only the dedicated Dolt driver profile", () => {
    expect(isDoltDriverProfile("dolt")).toBe(true);
    expect(isDoltDriverProfile("DOLT")).toBe(true);
    expect(isDoltDriverProfile("mysql")).toBe(false);
    expect(isDoltDriverProfile()).toBe(false);
  });

  it("exposes Dolt routines only for Dolt connections", () => {
    expect(doltSqlBuiltinTerms("mysql")).toBe("");
    expect(doltSqlRoutineSignatures("mysql").size).toBe(0);

    const terms = new Set(doltSqlBuiltinTerms("dolt").split(" "));
    const signatures = doltSqlRoutineSignatures("dolt");
    expect(terms.has("active_branch")).toBe(true);
    expect(terms.has("dolt_branch")).toBe(true);
    expect(terms.has("dolt_version")).toBe(true);
    expect(signatures.get("DOLT_MERGE_BASE")).toEqual(["revision_a", "revision_b"]);
    expect(signatures.size).toBe(DOLT_SQL_ROUTINES.length);
  });

  it("keeps the documented Dolt routine catalog separated by SQL usage", () => {
    expect(DOLT_SQL_ROUTINES.filter((routine) => routine.type === "procedure").map((routine) => routine.name)).toEqual(documentedDoltProcedures);
    expect(DOLT_SQL_ROUTINES.filter((routine) => routine.type === "scalar-function").map((routine) => routine.name)).toEqual(documentedDoltScalarFunctions);
    expect(DOLT_SQL_ROUTINES.filter((routine) => routine.type === "table-function").map((routine) => routine.name)).toEqual(documentedDoltTableFunctions);
  });

  it("maps the system-table switch to the MySQL sessionVariables parameter", () => {
    const enabled = setDoltSystemTablesVisible("dolt", "charset=utf8mb4", true);

    expect(enabled).toBe("charset=utf8mb4&sessionVariables=dolt_show_system_tables%3D1");
    expect(doltSystemTablesVisible("dolt", enabled)).toBe(true);
    expect(doltSystemTablesVisible("mysql", enabled)).toBe(false);
    expect(setDoltSystemTablesVisible("dolt", enabled, false)).toBe("charset=utf8mb4");
  });

  it("preserves unrelated session variables and replaces legacy casing", () => {
    const params = "sessionvariables=sql_mode%3D%27STRICT%2CTRADITIONAL%27%3BDOLT_SHOW_SYSTEM_TABLES%3D0&connect_timeout=10";
    const enabled = setDoltSystemTablesVisible("DOLT", params, true);
    const parsed = new URLSearchParams(enabled);

    expect(parsed.get("sessionVariables")).toBe("sql_mode='STRICT,TRADITIONAL',dolt_show_system_tables=1");
    expect(parsed.get("connect_timeout")).toBe("10");
    expect(doltSystemTablesVisible("dolt", enabled)).toBe(true);
  });

  it("leaves non-Dolt profiles untouched", () => {
    const params = "sessionVariables=sql_mode%3DANSI";
    expect(setDoltSystemTablesVisible("mysql", params, true)).toBe(params);
  });

  it("defines independent table ranges while Dolt system tables are visible", () => {
    expect(doltObjectTreeProfileForConnection(doltConfig("sessionVariables=dolt_show_system_tables%3D1"))).toEqual({
      cacheKey: "dolt-system-tables-v1:shown",
      groupOverrides: [
        {
          nodeType: "group-tables",
          tableNameFilter: { includePatterns: [], excludePatterns: ["dolt%"] },
        },
        {
          nodeType: "group-dolt-system-tables",
          label: "tree.doltSystemTables",
          tableNameFilter: { includePatterns: ["dolt%"], excludePatterns: [] },
        },
      ],
    });
  });

  it("uses a separate hidden cache scope without changing ordinary MySQL", () => {
    expect(doltObjectTreeProfileForConnection(doltConfig())).toEqual({ cacheKey: "dolt-system-tables-v1:hidden", groupOverrides: [] });
    expect(doltObjectTreeProfileForConnection({ ...doltConfig(), driver_profile: "mysql" })).toBeUndefined();
  });
});
