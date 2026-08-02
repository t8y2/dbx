import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  DatabaseBackupConnectionQueue,
  databaseBackupAggregateExportStatus,
  databaseBackupFilePath,
  databaseBackupProgressPercent,
  databaseBackupRunsToPrune,
  databaseBackupScheduleIsDue,
  databaseBackupTableNamesAreCaseSensitive,
  nextDatabaseBackupRunAt,
  normalizeDatabaseBackupRun,
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

test("backup history normalization preserves an independent display name and progress", () => {
  const normalized = normalizeDatabaseBackupRun({
    ...run("named", "2026-07-16T03:00:00.000Z"),
    displayName: "Before migration",
    progressPercent: 125,
  });

  assert.equal(normalized?.displayName, "Before migration");
  assert.equal(normalized?.scheduleName, "Nightly backup");
  assert.equal(normalized?.progressPercent, 100);
});

test("backup progress combines databases, schema exports, and current objects", () => {
  assert.equal(
    databaseBackupProgressPercent({
      completedDatabases: 0,
      totalDatabases: 2,
      completedExports: 1,
      totalExports: 4,
      currentObjectIndex: 5,
      currentTotalObjects: 10,
    }),
    19,
  );
  assert.equal(
    databaseBackupProgressPercent({
      completedDatabases: 1,
      totalDatabases: 2,
      completedExports: 0,
      totalExports: 1,
      currentExportComplete: true,
    }),
    99,
  );
  assert.equal(
    databaseBackupProgressPercent({
      completedDatabases: 2,
      totalDatabases: 2,
      completedExports: 0,
      totalExports: 0,
      backupComplete: true,
    }),
    100,
  );
});

test("backup connection queue serializes two runs on the same connection", async () => {
  const queue = new DatabaseBackupConnectionQueue();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const events: string[] = [];

  const first = queue.run("connection-1", async () => {
    events.push("first:start");
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push("first:end");
  });
  await firstStarted.promise;
  const second = queue.run("connection-1", async () => {
    events.push("second:start");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("backup connection queue allows different connections to run in parallel", async () => {
  const queue = new DatabaseBackupConnectionQueue();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const events: string[] = [];

  const first = queue.run("connection-1", async () => {
    events.push("connection-1:start");
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  const second = queue.run("connection-2", async () => {
    events.push("connection-2:start");
    secondStarted.resolve();
    await releaseSecond.promise;
  });

  await Promise.all([firstStarted.promise, secondStarted.promise]);
  assert.deepEqual([...events].sort(), ["connection-1:start", "connection-2:start"]);
  releaseFirst.resolve();
  releaseSecond.resolve();
  await Promise.all([first, second]);
});

test("multi-schema child completion stays running until the aggregate finishes", () => {
  const childStatuses = ["Running", "Done", "Running", "Done"] as const;
  const aggregateStatuses = [...childStatuses.map((status) => databaseBackupAggregateExportStatus(status, false)), databaseBackupAggregateExportStatus("Done", true)];

  assert.deepEqual(aggregateStatuses, ["Running", "Running", "Running", "Running", "Done"]);
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

test("scheduled backup history translates stable backend errors inline", () => {
  const source = readFileSync("apps/desktop/src/components/backup/ScheduledDatabaseBackupSettings.vue", "utf8");

  assert.match(source, /\{\{ translateBackendError\(t, run\.error\) \}\}/);
  assert.doesNotMatch(source, /\{\{ run\.error \}\}/);
});

test("scheduled backup history exposes rename and overall percentage controls", () => {
  const source = readFileSync("apps/desktop/src/components/backup/ScheduledDatabaseBackupSettings.vue", "utf8");
  const scheduler = readFileSync("apps/desktop/src/composables/useScheduledDatabaseBackups.ts", "utf8");

  assert.match(source, /run\.displayName \|\| run\.scheduleName/);
  assert.match(source, /role="progressbar"/);
  assert.match(scheduler, /databaseBackupConnectionQueue\.run\(schedule\.connectionId/);
  assert.match(scheduler, /status: databaseBackupAggregateExportStatus\(progress\.status, false\)/);
  assert.match(scheduler, /overallPercent: progressPercent/);
});
