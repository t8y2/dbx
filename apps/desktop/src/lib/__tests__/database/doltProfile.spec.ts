import { describe, expect, it } from "vitest";
import { DOLT_SQL_ROUTINES, doltObjectTreeProfileForConnection, doltSqlBuiltinTerms, doltSqlRoutineSignatures, doltSystemTablesVisible, isDoltDriverProfile, setDoltSystemTablesVisible } from "@/lib/database/doltProfile";
import type { ConnectionConfig } from "@/types/database";

function doltConfig(showDoltSystemTables = false): ConnectionConfig {
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
    external_config: showDoltSystemTables ? { doltShowSystemTables: true } : undefined,
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
  "DOLT_COUNT_COMMITS",
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
  "DOLT_THREAD_DUMP",
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
  "DOLT_STATS_TIMERS",
];

const documentedDoltScalarFunctions = ["ACTIVE_BRANCH", "DOLT_MERGE_BASE", "DOLT_HASHOF", "DOLT_HASHOF_DB", "DOLT_HASHOF_TABLE", "DOLT_STORAGE_FORMAT", "DOLT_VERSION", "HAS_ANCESTOR", "DOLT_JOIN_COST"];

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

  it("stores system-table visibility in the existing profile config slot", () => {
    const config = { ...doltConfig(), external_config: { retained: true } };
    setDoltSystemTablesVisible(config, true);
    expect(config.external_config).toEqual({ retained: true, doltShowSystemTables: true });
    expect(doltSystemTablesVisible(config)).toBe(true);

    setDoltSystemTablesVisible(config, false);
    expect(config.external_config).toEqual({ retained: true });
    expect(doltSystemTablesVisible(config)).toBe(false);
  });

  it("defines independent table ranges while Dolt system tables are visible", () => {
    expect(doltObjectTreeProfileForConnection(doltConfig(true))).toEqual({
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

  it("tracks the current Dolt procedure and scalar-function registries", () => {
    const routines = new Map(DOLT_SQL_ROUTINES.map((routine) => [routine.name, routine.type]));

    expect(routines.get("DOLT_COUNT_COMMITS")).toBe("procedure");
    expect(routines.get("DOLT_THREAD_DUMP")).toBe("procedure");
    expect(routines.get("DOLT_STATS_TIMERS")).toBe("procedure");
    expect(routines.get("DOLT_STORAGE_FORMAT")).toBe("scalar-function");
    expect(routines.has("LAST_INSERT_UUID")).toBe(false);
  });
});
