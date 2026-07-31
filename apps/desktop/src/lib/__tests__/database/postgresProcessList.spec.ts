import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  buildKingbaseKillSql,
  buildKingbasePgKillSql,
  buildPgKillSql,
  isKingbaseOwnSessionCatalogCompatibilityError,
  isKingbaseProcessListCatalogCompatibilityError,
  isKingbaseTerminateCatalogCompatibilityError,
  isPgProcessListCompatibilityError,
  KINGBASE_OWN_SESSION_SQL,
  KINGBASE_PG_OWN_SESSION_SQL,
  KINGBASE_PG_PROCESS_LIST_SQL,
  KINGBASE_PROCESS_LIST_SQL,
  mapPgProcessRows,
  OPENGAUSS_OWN_SESSION_SQL,
  OPENGAUSS_PROCESS_LIST_SQL,
  pgKillResultError,
  PG_PROCESS_LIST_LEGACY_SQL,
  PG_PROCESS_LIST_SQL,
} from "@/lib/database/postgresProcessList";
import { connectionSupportsProcessList, resolveProcessListDriver, resolveProcessListDriverForConnection, supportsProcessList } from "@/lib/database/processListDrivers";
import type { ConnectionConfig } from "@/types/database";

function result(columns: string[], rows: (string | number | boolean | null)[][]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

describe("mapPgProcessRows", () => {
  it("maps a pg_stat_activity result into typed rows", () => {
    const rows = mapPgProcessRows(result(["pid", "user", "db", "client", "app", "state", "wait", "time", "query"], [[4211, "app", "shop", "10.0.0.4", "psql", "active", "Client:ClientRead", 12, "SELECT * FROM orders"]]));
    expect(rows).toEqual([
      {
        id: 4211,
        user: "app",
        db: "shop",
        client: "10.0.0.4",
        app: "psql",
        state: "active",
        wait: "Client:ClientRead",
        time: 12,
        query: "SELECT * FROM orders",
      },
    ]);
  });

  it("tolerates NULL columns and case-variant names", () => {
    const rows = mapPgProcessRows(result(["PID", "USER", "DB", "CLIENT", "APP", "STATE", "WAIT", "TIME", "QUERY"], [["4200", "postgres", null, "local", null, "idle", null, "340", null]]));
    expect(rows[0]).toMatchObject({ id: 4200, user: "postgres", db: null, app: null, state: "idle", wait: null, time: 340, query: null });
  });

  it("returns an empty array for empty or malformed input", () => {
    expect(mapPgProcessRows(null)).toEqual([]);
    expect(mapPgProcessRows(undefined)).toEqual([]);
    expect(mapPgProcessRows(result([], []))).toEqual([]);
  });
});

describe("buildPgKillSql", () => {
  it("builds pg_terminate_backend for a valid pid", () => {
    expect(buildPgKillSql(4211)).toBe("SELECT pg_terminate_backend(4211)");
  });

  it("rejects non-integer, zero, or negative pids", () => {
    expect(() => buildPgKillSql(1.5)).toThrow();
    expect(() => buildPgKillSql(0)).toThrow();
    expect(() => buildPgKillSql(-1)).toThrow();
    expect(() => buildPgKillSql(Number.NaN)).toThrow();
  });

  it("builds the KingbaseES sys_terminate_backend call with the same PID validation", () => {
    expect(buildKingbaseKillSql(4211)).toBe("SELECT sys_terminate_backend(4211)");
    expect(() => buildKingbaseKillSql(0)).toThrow();
    expect(() => buildKingbaseKillSql(1.5)).toThrow();
  });
});

describe("PostgreSQL-family process SQL", () => {
  it("uses openGauss's pg catalog and boolean waiting column", () => {
    const driver = resolveProcessListDriver("opengauss");
    expect(driver?.listSql).toBe(OPENGAUSS_PROCESS_LIST_SQL);
    expect(driver?.ownSessionSql).toBe(OPENGAUSS_OWN_SESSION_SQL);
    expect(OPENGAUSS_PROCESS_LIST_SQL).toContain("FROM pg_catalog.pg_stat_activity");
    expect(OPENGAUSS_PROCESS_LIST_SQL).toContain("CASE WHEN waiting");
    expect(OPENGAUSS_PROCESS_LIST_SQL).not.toContain("wait_event_type");
    expect(driver?.buildKillSql(7)).toBe("SELECT pg_terminate_backend(7)");
  });

  it("uses KingbaseES's sys catalog and session functions", () => {
    const driver = resolveProcessListDriver("kingbase");
    expect(driver?.listSql).toBe(KINGBASE_PROCESS_LIST_SQL);
    expect(driver?.ownSessionSql).toBe(KINGBASE_OWN_SESSION_SQL);
    expect(KINGBASE_PROCESS_LIST_SQL).toContain("FROM sys_catalog.sys_stat_activity");
    expect(KINGBASE_PROCESS_LIST_SQL).toContain("wait_event_type");
    expect(KINGBASE_PROCESS_LIST_SQL).toContain("extract(epoch FROM CAST(CURRENT_TIMESTAMP AS TIMESTAMP))");
    expect(KINGBASE_PROCESS_LIST_SQL).toContain("extract(epoch FROM CAST(coalesce(query_start, xact_start, backend_start) AS TIMESTAMP))");
    expect(KINGBASE_PROCESS_LIST_SQL).not.toContain("CURRENT_TIMESTAMP - coalesce(query_start");
    expect(driver?.buildKillSql(7)).toBe("SELECT sys_terminate_backend(7)");
  });

  it("provides pg_catalog fallbacks for pg-compatible KingbaseES servers", () => {
    const driver = resolveProcessListDriver("kingbase");
    expect(driver?.fallbackListSql).toBe(KINGBASE_PG_PROCESS_LIST_SQL);
    expect(driver?.fallbackOwnSessionSql).toBe(KINGBASE_PG_OWN_SESSION_SQL);
    expect(driver?.buildFallbackKillSql?.(7)).toBe("SELECT pg_terminate_backend(7)");
    expect(KINGBASE_PG_PROCESS_LIST_SQL).toContain("FROM pg_catalog.pg_stat_activity");
    expect(KINGBASE_PG_PROCESS_LIST_SQL).not.toContain("sys_catalog");
    expect(buildKingbasePgKillSql(4211)).toBe("SELECT pg_terminate_backend(4211)");
  });

  it("retries only missing sys relation/function errors", () => {
    expect(isKingbaseProcessListCatalogCompatibilityError(new Error('relation "sys_catalog.sys_stat_activity" does not exist (SQLSTATE 42P01)'))).toBe(true);
    expect(isKingbaseOwnSessionCatalogCompatibilityError(Object.assign(new Error("function sys_backend_pid() does not exist"), { code: "42883" }))).toBe(true);
    expect(isKingbaseTerminateCatalogCompatibilityError(new Error("function sys_terminate_backend(integer) does not exist (SQLSTATE 42883)"))).toBe(true);
    expect(isKingbaseProcessListCatalogCompatibilityError(Object.assign(new Error("permission denied for relation sys_catalog.sys_stat_activity"), { code: "42501" }))).toBe(false);
    expect(isKingbaseOwnSessionCatalogCompatibilityError(new Error("authentication failed for sys_backend_pid"))).toBe(false);
    expect(isKingbaseTerminateCatalogCompatibilityError(new Error("connection refused"))).toBe(false);
  });
});

describe("Postgres compatibility", () => {
  it("provides a pre-9.6 query and only falls back for missing wait-event columns", () => {
    expect(PG_PROCESS_LIST_SQL).toContain("wait_event_type");
    expect(PG_PROCESS_LIST_LEGACY_SQL).toContain("CASE WHEN waiting THEN 'Lock'");
    expect(PG_PROCESS_LIST_LEGACY_SQL).not.toContain("wait_event_type");
    expect(isPgProcessListCompatibilityError(new Error('column "wait_event_type" does not exist'))).toBe(true);
    expect(isPgProcessListCompatibilityError({ code: "42703" })).toBe(true);
    expect(isPgProcessListCompatibilityError(new Error("permission denied for view pg_stat_activity"))).toBe(false);
  });

  it("requires pg_terminate_backend to confirm termination", () => {
    expect(pgKillResultError([result(["pg_terminate_backend"], [[true]])])).toBeNull();
    expect(pgKillResultError([result(["pg_terminate_backend"], [["t"]])])).toBeNull();
    expect(pgKillResultError([result(["pg_terminate_backend"], [[false]])])).toContain("did not terminate");
    expect(pgKillResultError([result(["pg_terminate_backend"], [])])).toContain("did not terminate");
  });
});

describe("resolveProcessListDriver", () => {
  it("routes MySQL and Postgres engines to distinct drivers", () => {
    const mysql = resolveProcessListDriver("mysql");
    const postgres = resolveProcessListDriver("postgres");
    expect(mysql?.buildKillSql(7)).toBe("KILL CONNECTION 7");
    expect(postgres?.buildKillSql(7)).toBe("SELECT pg_terminate_backend(7)");
    expect(postgres?.fallbackListSql).toBe(PG_PROCESS_LIST_LEGACY_SQL);
    expect(postgres?.shouldUseFallbackListSql?.(new Error('column "wait_event" does not exist'))).toBe(true);
    expect(postgres?.killResultError?.([result(["pg_terminate_backend"], [[false]])])).toContain("did not terminate");
    expect(resolveProcessListDriver("sqlite")).toBeNull();
  });

  it("unifies process-list support across both families", () => {
    expect(supportsProcessList("mysql")).toBe(true);
    expect(supportsProcessList("postgres")).toBe(true);
    expect(supportsProcessList("opengauss")).toBe(true);
    expect(supportsProcessList("kingbase")).toBe(true);
    // Postgres wire-protocol lookalikes with divergent catalogs stay excluded.
    expect(supportsProcessList("redshift")).toBe(false);
    expect(supportsProcessList("questdb")).toBe(false);
    expect(supportsProcessList("sqlite")).toBe(false);
    expect(supportsProcessList(undefined)).toBe(false);
  });
});

function conn(partial: Partial<ConnectionConfig>): ConnectionConfig {
  return { db_type: "mysql", ...partial } as ConnectionConfig;
}

describe("connectionSupportsProcessList", () => {
  it("gates on the real connection profile", () => {
    expect(connectionSupportsProcessList(conn({ db_type: "mysql" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "postgres" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "opengauss" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "gaussdb", driver_profile: "opengauss" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "gaussdb", driver_profile: "gaussdb" }))).toBe(false);
    expect(connectionSupportsProcessList(conn({ db_type: "kingbase" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "sqlite" }))).toBe(false);
    expect(connectionSupportsProcessList(undefined)).toBe(false);
  });

  it("resolves JDBC connections by their effective engine", () => {
    expect(connectionSupportsProcessList(conn({ db_type: "jdbc", connection_string: "jdbc:mysql://db:3306/app" }))).toBe(true);
    expect(connectionSupportsProcessList(conn({ db_type: "jdbc", connection_string: "jdbc:postgresql://db:5432/app" }))).toBe(true);
  });

  it("excludes Kyuubi / Hive2 JDBC that infer as MySQL but cannot serve SHOW PROCESSLIST", () => {
    expect(connectionSupportsProcessList(conn({ db_type: "jdbc", connection_string: "jdbc:kyuubi://gw:10009/" }))).toBe(false);
    expect(connectionSupportsProcessList(conn({ db_type: "jdbc", connection_string: "jdbc:hive2://hs2:10000/default" }))).toBe(false);
  });
});

describe("resolveProcessListDriverForConnection", () => {
  it("returns the engine driver for a JDBC MySQL connection and null for lookalikes", () => {
    expect(resolveProcessListDriverForConnection(conn({ db_type: "jdbc", connection_string: "jdbc:mysql://db/app" }))?.buildKillSql(9)).toBe("KILL CONNECTION 9");
    expect(resolveProcessListDriverForConnection(conn({ db_type: "jdbc", connection_string: "jdbc:hive2://hs2/default" }))).toBeNull();
  });
});
