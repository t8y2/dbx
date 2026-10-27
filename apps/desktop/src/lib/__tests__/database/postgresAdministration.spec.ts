import { describe, expect, it } from "vitest";
import type { ConnectionConfig, QueryResult, TreeNode } from "@/types/database";
import { postgresConnectionChildren, supportsPostgresAdministration, unwrapPostgresConnectionChildren } from "@/lib/database/postgresAdministration";
import { buildDatabaseTreeNodes } from "@/lib/database/databaseTree";
import { applySidebarDatabaseStorage, sidebarDatabaseNames } from "@/lib/sidebar/sidebarDatabaseStorage";
import { treeNodeRowAction } from "@/lib/sidebar/treeNodeClick";
import { canTreeNodeShowExpander } from "@/lib/sidebar/sidebarTreeItemLayout";
import { blockingIdentity, buildPgLockDetailsSql, buildPgSignalSql, mapPgBlockingRows, pgSignalResultError } from "@/lib/database/postgresLocks";
const connection = { id: "pg", name: "PG", db_type: "postgres", username: "viewer", database: "smart" } as ConnectionConfig;
const result = (rows: unknown[][], columns = ["wait_pid", "hold_pid"]): QueryResult => ({ columns, rows, affected_rows: 0, execution_time_ms: 0 }) as QueryResult;

describe("PostgreSQL administration tree", () => {
  it("keeps database identities, utility nodes and loaded descendants across projection and cache round trips", () => {
    const databases = buildDatabaseTreeNodes("pg", [{ name: "smart" }, { name: "other" }]);
    databases[1].children = [{ id: "pg:smart:public", type: "schema", label: "public", isExpanded: true }];
    const users: TreeNode = { id: "pg:__user_admin", type: "user-admin", label: "Users" };
    const grouped = postgresConnectionChildren(connection, [...databases, users]);
    expect(grouped.map((node) => node.type)).toEqual(["postgres-databases", "postgres-admin", "postgres-info", "user-admin"]);
    expect(grouped[0].isExpanded).toBe(true);
    expect(grouped[0].children).toEqual(databases);
    grouped[0].isExpanded = false;
    const reloaded = postgresConnectionChildren(connection, unwrapPostgresConnectionChildren(grouped), grouped);
    expect(reloaded[0].isExpanded).toBe(false);
    expect(reloaded[0].children![1]).toBe(databases[1]);
    expect(unwrapPostgresConnectionChildren(reloaded)).toEqual([...databases, users]);
    expect(postgresConnectionChildren(connection, grouped, grouped)).toEqual(reloaded);
  });
  it("keeps size badges working through the database group", () => {
    const grouped = postgresConnectionChildren(connection, buildDatabaseTreeNodes("pg", [{ name: "smart" }]));
    expect(sidebarDatabaseNames(grouped)).toEqual(["smart"]);
    expect(applySidebarDatabaseStorage(grouped, [{ name: "smart", size_bytes: 1024 }])).toBe(true);
    expect(grouped[0].children![0].sizeBytes).toBe(1024);
  });
  it("does not expose PostgreSQL tools for compatible engines", () => {
    for (const db_type of ["mysql", "opengauss", "kingbase"] as const) expect(supportsPostgresAdministration({ ...connection, db_type })).toBe(false);
    expect(supportsPostgresAdministration({ ...connection, driver_profile: "cockroachdb" })).toBe(false);
    const children = buildDatabaseTreeNodes("pg", [{ name: "smart" }]);
    expect(postgresConnectionChildren({ ...connection, db_type: "mysql" }, children)).toBe(children);
  });
  it("opens tools on a single click even under double-click activation", () => {
    for (const type of ["postgres-sessions", "postgres-locks", "postgres-status", "postgres-info-category"] as const) {
      expect(treeNodeRowAction(type, false, "double", "postgres")).toBe("toggle");
      expect(canTreeNodeShowExpander({ id: type, type, label: "tool" })).toBe(false);
    }
  });
});
describe("PostgreSQL blocking snapshots and signals", () => {
  it("keeps all blocker pairs, deduplicates parallel PIDs, preserves prepared transactions and restricted data", () => {
    const rows = mapPgBlockingRows(
      result([
        [10, 20],
        [10, 30],
        [10, 20],
        [11, 0],
        [12, null],
        [0, 20],
        ["x", 30],
      ]),
    );
    expect(rows.map((row) => [row.wait_pid, row.hold_pid])).toEqual([
      [10, 20],
      [10, 30],
      [11, 0],
    ]);
    expect(blockingIdentity(rows[2], "hold")).toBeNull();
    expect(blockingIdentity(rows[0], "wait")).toBeNull();
  });
  it("preserves timestamp precision and binds cancellation to the observed query", () => {
    const target = { pid: 21, backendStart: "2026-10-27 12:00:00.123456+00", queryStart: "2026-10-27 13:00:00.654321+00" };
    expect(buildPgSignalSql(target, "cancel")).toBe("SELECT pg_cancel_backend(21) FROM pg_catalog.pg_stat_activity WHERE pid = 21 AND backend_start::text = '2026-10-27 12:00:00.123456+00' AND query_start::text = '2026-10-27 13:00:00.654321+00' AND pid <> pg_catalog.pg_backend_pid()");
    expect(buildPgSignalSql(target, "terminate")).toBe("SELECT pg_terminate_backend(21) FROM pg_catalog.pg_stat_activity WHERE pid = 21 AND backend_start::text = '2026-10-27 12:00:00.123456+00' AND pid <> pg_catalog.pg_backend_pid()");
  });
  it("escapes identity text and rejects missing identity or unsafe PID", () => {
    expect(buildPgSignalSql({ pid: 1, backendStart: "a'b" }, "terminate")).toContain("'a''b'");
    for (const pid of [0, -1, 1.2, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => buildPgSignalSql({ pid, backendStart: "date" }, "cancel")).toThrow();
    expect(() => buildPgLockDetailsSql({ pid: 1, backendStart: "" })).toThrow();
  });
  it("distinguishes accepted, rejected and obsolete targets", () => {
    expect(pgSignalResultError(result([[true]], ["pg_cancel_backend"]), "cancel")).toBeNull();
    expect(pgSignalResultError(result([[false]], ["pg_terminate_backend"]), "terminate")).toBe("postgresAdmin.signalRejected");
    expect(pgSignalResultError(result([], ["pg_terminate_backend"]), "terminate")).toBe("postgresAdmin.targetChanged");
  });
});
