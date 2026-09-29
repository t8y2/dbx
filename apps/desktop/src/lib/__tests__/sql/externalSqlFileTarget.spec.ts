// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  activeTabExternalSqlFileTarget,
  EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY,
  MAX_EXTERNAL_SQL_FILE_TARGETS,
  forgetExternalSqlFileTarget,
  moveExternalSqlFileTarget,
  rememberExternalSqlFileTarget,
  resolveExternalSqlFileTarget,
  resolveExternalSqlFileTargetForActiveTab,
  unassociatedExternalSqlFileTarget,
} from "@/lib/sql/externalSqlFileTarget";

describe("external SQL file targets", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores the saved data source across normalized file paths", () => {
    rememberExternalSqlFileTarget(" C:\\work\\report.sql ", { connectionId: "saved-connection", database: "sales", catalog: "hive" });

    expect(resolveExternalSqlFileTarget("C:/work/report.sql", () => true, { connectionId: "fallback", database: "default" })).toEqual({
      connectionId: "saved-connection",
      database: "sales",
      catalog: "hive",
    });
  });

  it("prefers a remembered target over the active SQL tab", () => {
    rememberExternalSqlFileTarget("/work/report.sql", { connectionId: "saved-connection", database: "saved_db", catalog: "saved_catalog", schema: "saved_schema" });
    const tabs = [{ id: "active-tab", connectionId: "active-connection", database: "active_db", catalog: "active_catalog", schema: "active_schema", mode: "query" as const }];

    expect(
      resolveExternalSqlFileTargetForActiveTab("/work/report.sql", tabs, "active-tab", (connectionId) => {
        if (connectionId === "saved-connection" || connectionId === "active-connection") return { db_type: "postgres" };
        return undefined;
      }),
    ).toEqual({
      connectionId: "saved-connection",
      database: "saved_db",
      catalog: "saved_catalog",
      schema: "saved_schema",
    });
  });

  it("uses the active SQL tab context for a previously unassociated file", () => {
    const tabs = [{ id: "active-tab", connectionId: "active-connection", database: "analytics", catalog: "hive", schema: "reporting", mode: "query" as const }];

    expect(resolveExternalSqlFileTargetForActiveTab("/work/new.sql", tabs, "active-tab", () => ({ db_type: "postgres" }))).toEqual({
      connectionId: "active-connection",
      database: "analytics",
      catalog: "hive",
      schema: "reporting",
    });
  });

  it("keeps the fallback unassociated without an active tab", () => {
    const tabs = [{ id: "inactive-tab", connectionId: "sql-connection", database: "analytics", mode: "query" as const }];

    expect(activeTabExternalSqlFileTarget(tabs, null, () => ({ db_type: "postgres" }))).toEqual(unassociatedExternalSqlFileTarget());
    expect(activeTabExternalSqlFileTarget(tabs, "missing-tab", () => ({ db_type: "postgres" }))).toEqual(unassociatedExternalSqlFileTarget());
  });

  it.each(["mq", "zookeeper", "plugin", "redis"] as const)("does not reuse a non-SQL %s tab target", (dbType) => {
    const tabs = [{ id: "active-tab", connectionId: "non-sql-connection", database: "invalid", catalog: "invalid", schema: "invalid", mode: "query" as const }];

    expect(activeTabExternalSqlFileTarget(tabs, "active-tab", () => ({ db_type: dbType }))).toEqual(unassociatedExternalSqlFileTarget());
  });

  it.each(["plugin-workbench", "plugin-filesystem"] as const)("does not reuse a SQL connection borrowed by a %s tab", (mode) => {
    const tabs = [{ id: "plugin-tab", connectionId: "sql-connection", database: "invalid", mode }];

    expect(activeTabExternalSqlFileTarget(tabs, "plugin-tab", () => ({ db_type: "postgres" }))).toEqual(unassociatedExternalSqlFileTarget());
  });

  it("keeps same-named databases in different catalogs distinct", () => {
    rememberExternalSqlFileTarget("/work/hive.sql", { connectionId: "saved-connection", database: "sales", catalog: "hive" });
    rememberExternalSqlFileTarget("/work/iceberg.sql", { connectionId: "saved-connection", database: "sales", catalog: "iceberg" });

    expect(resolveExternalSqlFileTarget("/work/hive.sql", () => true, unassociatedExternalSqlFileTarget()).catalog).toBe("hive");
    expect(resolveExternalSqlFileTarget("/work/iceberg.sql", () => true, unassociatedExternalSqlFileTarget()).catalog).toBe("iceberg");
  });

  it("restores the schema the file was saved from", () => {
    // Reopening a .sql file used to drop the schema, leaving the tab on the
    // connection default: sidebar locate then looked for the table in the wrong
    // namespace and silently did nothing (issue #7648).
    rememberExternalSqlFileTarget("/work/report.sql", { connectionId: "saved-connection", database: "dbx_test", schema: "analytics" });

    expect(resolveExternalSqlFileTarget("/work/report.sql", () => true, unassociatedExternalSqlFileTarget())).toEqual({
      connectionId: "saved-connection",
      database: "dbx_test",
      catalog: undefined,
      schema: "analytics",
    });
  });

  it("treats historical records without a schema as unset", () => {
    localStorage.setItem(EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY, JSON.stringify([{ path: "/work/legacy.sql", connectionId: "saved-connection", database: "sales", updatedAt: 1 }]));

    expect(resolveExternalSqlFileTarget("/work/legacy.sql", () => true, unassociatedExternalSqlFileTarget()).schema).toBeUndefined();
  });

  it("treats historical records without catalog as the default catalog", () => {
    localStorage.setItem(EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY, JSON.stringify([{ path: "/work/legacy.sql", connectionId: "saved-connection", database: "sales", updatedAt: 1 }]));

    expect(resolveExternalSqlFileTarget("/work/legacy.sql", () => true, unassociatedExternalSqlFileTarget())).toEqual({
      connectionId: "saved-connection",
      database: "sales",
      catalog: undefined,
    });
  });

  it("keeps a new file path unassociated", () => {
    expect(resolveExternalSqlFileTarget("/work/new.sql", () => true, unassociatedExternalSqlFileTarget())).toEqual({
      connectionId: "",
      database: "",
      catalog: undefined,
    });
  });

  it("falls back when the saved connection no longer exists", () => {
    rememberExternalSqlFileTarget("/work/report.sql", { connectionId: "deleted-connection", database: "analytics" });

    expect(resolveExternalSqlFileTarget("/work/report.sql", () => false, unassociatedExternalSqlFileTarget())).toEqual({
      connectionId: "",
      database: "",
      catalog: undefined,
    });
  });

  it("moves and removes saved targets when a managed file is renamed or deleted", () => {
    rememberExternalSqlFileTarget("C:\\work\\draft.sql", { connectionId: "saved-connection", database: "sales" });

    moveExternalSqlFileTarget("C:/work/draft.sql", "C:/work/report.sql");
    expect(resolveExternalSqlFileTarget("C:/work/draft.sql", () => true, unassociatedExternalSqlFileTarget())).toEqual(unassociatedExternalSqlFileTarget());
    expect(resolveExternalSqlFileTarget("C:/work/report.sql", () => true, unassociatedExternalSqlFileTarget())).toMatchObject({
      connectionId: "saved-connection",
      database: "sales",
    });

    forgetExternalSqlFileTarget("C:/work/report.sql");
    expect(resolveExternalSqlFileTarget("C:/work/report.sql", () => true, unassociatedExternalSqlFileTarget())).toEqual(unassociatedExternalSqlFileTarget());
  });

  it("ignores malformed persisted state", () => {
    localStorage.setItem(EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY, "not-json");

    expect(resolveExternalSqlFileTarget("/work/report.sql", () => true, { connectionId: "fallback", database: "default" })).toEqual({
      connectionId: "fallback",
      database: "default",
    });
  });

  it("keeps only the most recently saved targets", () => {
    for (let index = 0; index <= MAX_EXTERNAL_SQL_FILE_TARGETS; index += 1) {
      rememberExternalSqlFileTarget(`/work/report-${index}.sql`, { connectionId: `connection-${index}`, database: `database-${index}` });
    }

    expect(resolveExternalSqlFileTarget("/work/report-0.sql", () => true, { connectionId: "fallback", database: "default" })).toEqual({
      connectionId: "fallback",
      database: "default",
    });
    expect(resolveExternalSqlFileTarget(`/work/report-${MAX_EXTERNAL_SQL_FILE_TARGETS}.sql`, () => true, { connectionId: "fallback", database: "default" })).toEqual({
      connectionId: `connection-${MAX_EXTERNAL_SQL_FILE_TARGETS}`,
      database: `database-${MAX_EXTERNAL_SQL_FILE_TARGETS}`,
      catalog: undefined,
    });
  });
});
