import { describe, expect, it } from "vitest";
import { resolveSavedSqlExecutionTarget, savedSqlDefaultTargetForWrite, savedSqlExecutionTargetFromTab } from "@/lib/savedSql/savedSqlExecutionTarget";

const savedTarget = {
  connectionId: "saved-connection",
  database: "saved_database",
  schema: "saved_schema",
  catalog: "saved_catalog",
};

describe("saved SQL execution targets", () => {
  it("uses the saved target by default", () => {
    expect(
      resolveSavedSqlExecutionTarget(savedTarget, "saved", {
        connectionId: "current-connection",
        database: "current_database",
        schema: "current_schema",
        catalog: "current_catalog",
      }),
    ).toEqual(savedTarget);
  });

  it("uses the current tab target when requested", () => {
    expect(
      resolveSavedSqlExecutionTarget(savedTarget, "current", {
        connectionId: "current-connection",
        database: "current_database",
        schema: "current_schema",
        catalog: "current_catalog",
      }),
    ).toEqual({
      connectionId: "current-connection",
      database: "current_database",
      schema: "current_schema",
      catalog: "current_catalog",
    });
  });

  it("falls back to the saved target when no current tab is available", () => {
    expect(resolveSavedSqlExecutionTarget(savedTarget, "current")).toEqual(savedTarget);
    expect(savedSqlExecutionTargetFromTab(undefined)).toBeUndefined();
  });

  it("uses the current execution target when a file is saved", () => {
    expect(
      savedSqlDefaultTargetForWrite({
        connectionId: "runtime-connection",
        database: "runtime_database",
        schema: "runtime_schema",
        catalog: "runtime_catalog",
      }),
    ).toEqual({
      connectionId: "runtime-connection",
      database: "runtime_database",
      schema: "runtime_schema",
      catalog: "runtime_catalog",
    });
  });

  it("inherits currentTarget database when saved file database is empty", () => {
    const unassociatedTarget = { connectionId: "saved-connection", database: "", schema: undefined, catalog: undefined };
    expect(
      resolveSavedSqlExecutionTarget(unassociatedTarget, "saved", {
        connectionId: "saved-connection",
        database: "active_db",
        schema: "active_schema",
        catalog: "active_catalog",
      }),
    ).toEqual({
      connectionId: "saved-connection",
      database: "active_db",
      schema: "active_schema",
      catalog: "active_catalog",
    });
  });

  it("extracts candidate database from file name when saved database is empty", () => {
    const fileWithPrefix = {
      connectionId: "saved-connection",
      database: "",
      name: "aisp_aikf - 全量呼入数据.sql",
    };
    expect(resolveSavedSqlExecutionTarget(fileWithPrefix, "saved")).toEqual({
      connectionId: "saved-connection",
      database: "aisp_aikf",
      schema: undefined,
      catalog: undefined,
    });
  });

  it("uses fallbackDatabase when saved file database is empty and no candidate exists", () => {
    const emptyTarget = { connectionId: "saved-connection", database: "", name: "plain_query.sql" };
    expect(resolveSavedSqlExecutionTarget(emptyTarget, "saved", undefined, "default_db")).toEqual({
      connectionId: "saved-connection",
      database: "default_db",
      schema: undefined,
      catalog: undefined,
    });
  });
});
