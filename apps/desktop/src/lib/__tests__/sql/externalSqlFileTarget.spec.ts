// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { EXTERNAL_SQL_FILE_TARGETS_STORAGE_KEY, MAX_EXTERNAL_SQL_FILE_TARGETS, rememberExternalSqlFileTarget, resolveExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";

describe("external SQL file targets", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores the saved data source across normalized file paths", () => {
    rememberExternalSqlFileTarget(" C:\\work\\report.sql ", { connectionId: "saved-connection", database: "analytics" });

    expect(resolveExternalSqlFileTarget("C:/work/report.sql", () => true, { connectionId: "fallback", database: "default" })).toEqual({
      connectionId: "saved-connection",
      database: "analytics",
    });
  });

  it("falls back when the saved connection no longer exists", () => {
    rememberExternalSqlFileTarget("/work/report.sql", { connectionId: "deleted-connection", database: "analytics" });

    expect(resolveExternalSqlFileTarget("/work/report.sql", () => false, { connectionId: "fallback", database: "default" })).toEqual({
      connectionId: "fallback",
      database: "default",
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
    });
  });
});
