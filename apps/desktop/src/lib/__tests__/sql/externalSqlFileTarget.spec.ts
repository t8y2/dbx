// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY, MAX_EXTERNAL_SQL_FILE_TARGETS, rememberExternalSqlFileTarget, resolveExternalSqlFileTarget, unassociatedExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";

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

  it("keeps same-named databases in different catalogs distinct", () => {
    rememberExternalSqlFileTarget("/work/hive.sql", { connectionId: "saved-connection", database: "sales", catalog: "hive" });
    rememberExternalSqlFileTarget("/work/iceberg.sql", { connectionId: "saved-connection", database: "sales", catalog: "iceberg" });

    expect(resolveExternalSqlFileTarget("/work/hive.sql", () => true, unassociatedExternalSqlFileTarget()).catalog).toBe("hive");
    expect(resolveExternalSqlFileTarget("/work/iceberg.sql", () => true, unassociatedExternalSqlFileTarget()).catalog).toBe("iceberg");
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
