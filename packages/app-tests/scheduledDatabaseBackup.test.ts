import assert from "node:assert/strict";
import { test } from "vitest";
import {
  databaseBackupFilePath,
  databaseBackupRunsToPrune,
  databaseBackupScheduleIsDue,
  databaseBackupTableNamesAreCaseSensitive,
  nextDatabaseBackupRunAt,
  normalizeDatabaseBackupSchedule,
  normalizeDatabaseBackupTablePatterns,
  resolveScheduledDatabaseBackupTableScope,
  resolveScheduledDatabaseBackupTargets,
  supportsScheduledDatabaseBackup,
  type DatabaseBackupRun,
  type DatabaseBackupSchedule,
} from "../../apps/desktop/src/lib/backup/scheduledDatabaseBackup.ts";

function schedule(overrides: Partial<DatabaseBackupSchedule> = {}): DatabaseBackupSchedule {
  return {
    id: "schedule-1",
    name: "Nightly backup",
    enabled: true,
    connectionId: "connection-1",
    databases: [],
    tableFilterMode: "all",
    tablePatterns: [],
    destinationDirectory: "C:\\backups",
    frequency: "daily",
    intervalHours: 6,
    timeOfDay: "02:00",
    weekday: 1,
    includeStructure: true,
    includeData: true,
    includeObjects: true,
    dropTableIfExists: false,
    retentionCount: 2,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    nextRunAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

function run(id: string, startedAt: string): DatabaseBackupRun {
  return {
    id,
    scheduleId: "schedule-1",
    scheduleName: "Nightly backup",
    connectionId: "connection-1",
    connectionName: "Postgres",
    trigger: "scheduled",
    status: "success",
    startedAt,
    completedAt: startedAt,
    files: [],
  };
}

test("daily backup advances to the next configured local time", () => {
  const after = new Date(2026, 6, 16, 3, 30, 0);
  const next = nextDatabaseBackupRunAt(schedule(), after);

  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 6);
  assert.equal(next.getDate(), 17);
  assert.equal(next.getHours(), 2);
  assert.equal(next.getMinutes(), 0);
});

test("weekly backup selects the next matching weekday", () => {
  const after = new Date(2026, 6, 16, 12, 0, 0);
  const next = nextDatabaseBackupRunAt(schedule({ frequency: "weekly", weekday: 1, timeOfDay: "08:15" }), after);

  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 8);
  assert.equal(next.getMinutes(), 15);
  assert.ok(next.getTime() > after.getTime());
});

test("normalization deduplicates databases and bounds schedule values", () => {
  const normalized = normalizeDatabaseBackupSchedule({
    ...schedule(),
    databases: ["app", "app", " analytics "],
    intervalHours: 999,
    retentionCount: 0,
    timeOfDay: "invalid",
  });

  assert.ok(normalized);
  assert.deepEqual(normalized.databases, ["app", "analytics"]);
  assert.equal(normalized.intervalHours, 168);
  assert.equal(normalized.retentionCount, 1);
  assert.equal(normalized.timeOfDay, "02:00");
});

test("normalization migrates old schedules and deduplicates table patterns", () => {
  const legacy = { ...schedule(), tableFilterMode: undefined, tablePatterns: undefined };
  const normalizedLegacy = normalizeDatabaseBackupSchedule(legacy);
  const normalizedFiltered = normalizeDatabaseBackupSchedule({
    ...schedule(),
    tableFilterMode: "exclude",
    tablePatterns: [" audit_* ", "audit_*", "public.events"],
  });

  assert.equal(normalizedLegacy?.tableFilterMode, "all");
  assert.deepEqual(normalizedLegacy?.tablePatterns, []);
  assert.equal(normalizedFiltered?.tableFilterMode, "exclude");
  assert.deepEqual(normalizedFiltered?.tablePatterns, ["audit_*", "public.events"]);
});

test("due check respects enabled state and next run", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  assert.equal(databaseBackupScheduleIsDue(schedule({ nextRunAt: "2026-07-16T11:59:00.000Z" }), now), true);
  assert.equal(databaseBackupScheduleIsDue(schedule({ enabled: false, nextRunAt: "2026-07-16T11:59:00.000Z" }), now), false);
});

test("backup file names are unique and safe for schema-aware exports", () => {
  const path = databaseBackupFilePath("C:\\backups", "Nightly: prod", "app/private", new Date(2026, 6, 16, 2, 3, 4), "12345678-abcd");

  assert.equal(path, "C:\\backups\\dbx-backup__Nightly_ prod__20260716-020304__app_private__12345678.sql");
});

test("retention pruning keeps the newest successful runs", () => {
  const runs = [run("new", "2026-07-16T03:00:00.000Z"), run("middle", "2026-07-16T02:00:00.000Z"), run("old", "2026-07-16T01:00:00.000Z")];

  assert.deepEqual(
    databaseBackupRunsToPrune(runs, "schedule-1", 2).map((item) => item.id),
    ["old"],
  );
});

test("all-database backups use the complete database list", () => {
  assert.deepEqual(resolveScheduledDatabaseBackupTargets([], ["visible", "hidden"]), ["visible", "hidden"]);
});

test("all-database MySQL backups exclude system databases", () => {
  assert.deepEqual(resolveScheduledDatabaseBackupTargets([], ["information_schema", "app", "mysql", "analytics", "performance_schema", "sys"], "mysql"), ["app", "analytics"]);
});

test("all-database PostgreSQL backups exclude template databases", () => {
  assert.deepEqual(resolveScheduledDatabaseBackupTargets([], ["template0", "postgres", "template1", "app"], "postgres"), ["postgres", "app"]);
});

test("explicit system database targets remain available", () => {
  assert.deepEqual(resolveScheduledDatabaseBackupTargets(["mysql"], ["mysql", "app"], "mysql"), ["mysql"]);
});

test("explicit backup databases fail when any configured target is missing", () => {
  assert.throws(() => resolveScheduledDatabaseBackupTargets(["app", "renamed"], ["app"]), /renamed/);
});

test("scheduled backups are limited to databases with consistent snapshot support", () => {
  assert.equal(supportsScheduledDatabaseBackup("postgres"), true);
  assert.equal(supportsScheduledDatabaseBackup("mysql"), true);
  assert.equal(supportsScheduledDatabaseBackup("sqlite"), false);
  assert.equal(supportsScheduledDatabaseBackup("sqlserver"), false);
});

test("table pattern input supports exact, wildcard, and qualified rules", () => {
  assert.deepEqual(normalizeDatabaseBackupTablePatterns(" orders, audit_*; public.events\norders "), ["orders", "audit_*", "public.events"]);

  const included = resolveScheduledDatabaseBackupTableScope("include", ["orders", "audit_*", "public.events"], ["orders", "audit_log", "events", "users"], "app", "public");
  assert.deepEqual(included, {
    includedTables: ["orders", "audit_log", "events"],
    selectedTables: ["orders", "audit_log", "events"],
  });
});

test("exclude table rules preserve all non-matching tables", () => {
  const excluded = resolveScheduledDatabaseBackupTableScope("exclude", ["audit_*", "private.*"], ["users", "audit_log", "sessions"], "app", "public");
  assert.deepEqual(excluded, {
    includedTables: ["users", "sessions"],
    excludedTables: ["audit_log"],
  });
});

test("MySQL table rules respect lower_case_table_names", () => {
  assert.equal(databaseBackupTableNamesAreCaseSensitive("mysql", 0), true);
  assert.equal(databaseBackupTableNamesAreCaseSensitive("mysql", "1"), false);
  assert.equal(databaseBackupTableNamesAreCaseSensitive("mysql", 2), false);
  assert.equal(databaseBackupTableNamesAreCaseSensitive("postgres", 1), true);
  assert.equal(databaseBackupTableNamesAreCaseSensitive("mysql", undefined), true);

  const caseSensitive = resolveScheduledDatabaseBackupTableScope("exclude", ["orders"], ["orders", "Orders"], "app", "app", true);
  assert.deepEqual(caseSensitive, {
    includedTables: ["Orders"],
    excludedTables: ["orders"],
  });

  const caseInsensitive = resolveScheduledDatabaseBackupTableScope("exclude", ["orders"], ["orders", "Orders"], "app", "app", false);
  assert.deepEqual(caseInsensitive, {
    includedTables: [],
    excludedTables: ["orders", "Orders"],
  });
});

test("retention never selects failed backup runs", () => {
  const failed = { ...run("failed", "2026-07-16T04:00:00.000Z"), status: "failed" as const };
  const successful = [run("new", "2026-07-16T03:00:00.000Z"), run("old", "2026-07-16T01:00:00.000Z")];

  assert.deepEqual(
    databaseBackupRunsToPrune([failed, ...successful], "schedule-1", 1).map((item) => item.id),
    ["old"],
  );
});
