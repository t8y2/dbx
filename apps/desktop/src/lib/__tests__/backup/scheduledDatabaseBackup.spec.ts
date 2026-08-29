import { describe, expect, it } from "vitest";
import { databaseBackupRunsToPrune, databaseBackupTableMatchesPattern, normalizeDatabaseBackupRun, resolveScheduledDatabaseBackupTableScope, type DatabaseBackupRun } from "../../backup/scheduledDatabaseBackup";

const startedAt = "2026-08-12T00:00:00.000Z";

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    scheduleName: "One-time backup",
    connectionId: "mysql-1",
    connectionName: "Local MySQL",
    trigger: "manual",
    source: "one-shot",
    status: "success",
    startedAt,
    files: [],
    ...overrides,
  };
}

describe("database backup run persistence", () => {
  it("accepts a one-shot run without a schedule id", () => {
    const normalized = normalizeDatabaseBackupRun(run());

    expect(normalized).toEqual(
      expect.objectContaining({
        id: "run-1",
        scheduleId: undefined,
        source: "one-shot",
        trigger: "manual",
      }),
    );
  });

  it("keeps legacy runs compatible and treats them as scheduled history", () => {
    const normalized = normalizeDatabaseBackupRun(run({ scheduleId: "schedule-1", source: undefined, scheduleName: "Nightly backup" }));

    expect(normalized).toEqual(expect.objectContaining({ scheduleId: "schedule-1", source: "scheduled", scheduleName: "Nightly backup" }));
  });

  it("does not include one-shot runs in schedule retention pruning", () => {
    const scheduledRuns = [run({ id: "scheduled-old", scheduleId: "schedule-1", source: "scheduled", startedAt: "2026-08-10T00:00:00.000Z" }), run({ id: "scheduled-new", scheduleId: "schedule-1", source: "scheduled", startedAt: "2026-08-11T00:00:00.000Z" })];
    const oneShotRun = run({ id: "one-shot", scheduleId: undefined, source: "one-shot", startedAt: "2026-08-12T00:00:00.000Z" });

    const normalizedRuns = [...scheduledRuns, oneShotRun].map((value) => normalizeDatabaseBackupRun(value)!).filter((value): value is DatabaseBackupRun => !!value);
    expect(databaseBackupRunsToPrune(normalizedRuns, "schedule-1", 1).map((value) => value.id)).toEqual(["scheduled-old"]);
  });
});

describe("database backup table pattern matching", () => {
  it("matches a fully-qualified db.schema.table pattern when the database and schema share the same name", () => {
    // Regression for #7314: PostgreSQL commonly has a schema with the same
    // name as its database, and the fully-qualified candidate was previously
    // suppressed whenever database === schema, silently breaking exclude
    // rules written as "db.schema.table".
    expect(databaseBackupTableMatchesPattern("vector_data", ["issue7314.issue7314.vector_data"], "issue7314", "issue7314")).toBe(true);
  });

  it("still matches a fully-qualified db.schema.table pattern when the database and schema differ", () => {
    expect(databaseBackupTableMatchesPattern("vector_data", ["mydb.myschema.vector_data"], "mydb", "myschema")).toBe(true);
  });

  it("excludes the matched table from the backup scope when database and schema share the same name", () => {
    const scope = resolveScheduledDatabaseBackupTableScope("exclude", ["issue7314.issue7314.vector_data"], ["vector_data", "keep_rows"], "issue7314", "issue7314");
    expect(scope.includedTables).toEqual(["keep_rows"]);
    expect(scope.excludedTables).toEqual(["vector_data"]);
  });
});
