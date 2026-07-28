import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isSystemDatabaseName } from "@/lib/database/visibleDatabases";
import type { DatabaseType } from "@/types/database";

export const DATABASE_BACKUP_SCHEDULES_STORAGE_KEY = "dbx-database-backup-schedules";
export const DATABASE_BACKUP_RUNS_STORAGE_KEY = "dbx-database-backup-runs";
export const DATABASE_BACKUP_CONFIG_CHANGED_EVENT = "dbx:database-backup-config-changed";
export const MAX_DATABASE_BACKUP_HISTORY = 200;

export type DatabaseBackupFrequency = "hourly" | "daily" | "weekly";
export type DatabaseBackupRunStatus = "running" | "success" | "failed" | "cancelled";
export type DatabaseBackupRunTrigger = "manual" | "scheduled";
export type DatabaseBackupTableFilterMode = "all" | "include" | "exclude";

const CONSISTENT_BACKUP_DATABASE_TYPES = new Set(["mysql", "postgres"]);

export function supportsScheduledDatabaseBackup(databaseType: string | undefined): boolean {
  return !!databaseType && CONSISTENT_BACKUP_DATABASE_TYPES.has(databaseType);
}

export function resolveScheduledDatabaseBackupTargets(configuredDatabases: readonly string[], availableDatabases: readonly string[], databaseType?: DatabaseType): string[] {
  const available = [...new Set(availableDatabases.map((database) => database.trim()).filter(Boolean))];
  if (configuredDatabases.length === 0) return available.filter((database) => !isSystemDatabaseName(databaseType, database));

  const missing = configuredDatabases.filter((database) => !available.includes(database));
  if (missing.length > 0) {
    throw new Error(`Configured backup databases are unavailable: ${missing.join(", ")}`);
  }
  return [...configuredDatabases];
}

export interface DatabaseBackupTableScope {
  includedTables: string[];
  selectedTables?: string[];
  excludedTables?: string[];
}

export function normalizeDatabaseBackupTablePatterns(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]+/) : [];
  return [...new Set(values.map((pattern) => stringValue(pattern).trim()).filter(Boolean))];
}

function tablePatternRegex(pattern: string, caseSensitive: boolean): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, caseSensitive ? "u" : "iu");
}

export function databaseBackupTableMatchesPattern(table: string, patterns: readonly string[], database = "", schema = "", caseSensitive = true): boolean {
  const candidates = [table];
  if (schema) candidates.push(`${schema}.${table}`);
  if (database && schema && database !== schema) candidates.push(`${database}.${schema}.${table}`);
  return patterns.some((pattern) => {
    const matcher = tablePatternRegex(pattern, caseSensitive);
    return candidates.some((candidate) => matcher.test(candidate));
  });
}

export function databaseBackupTableNamesAreCaseSensitive(databaseType: DatabaseType | undefined, mysqlLowerCaseTableNames: unknown): boolean {
  if (databaseType !== "mysql") return true;
  const value = typeof mysqlLowerCaseTableNames === "number" ? mysqlLowerCaseTableNames : typeof mysqlLowerCaseTableNames === "string" ? Number(mysqlLowerCaseTableNames.trim()) : Number.NaN;
  return value !== 1 && value !== 2;
}

export function resolveScheduledDatabaseBackupTableScope(mode: DatabaseBackupTableFilterMode, patterns: readonly string[], availableTables: readonly string[], database = "", schema = "", caseSensitive = true): DatabaseBackupTableScope {
  const available = [...new Set(availableTables.map((table) => table.trim()).filter(Boolean))];
  if (mode === "all") return { includedTables: available };

  const normalizedPatterns = normalizeDatabaseBackupTablePatterns(patterns);
  const matching = available.filter((table) => databaseBackupTableMatchesPattern(table, normalizedPatterns, database, schema, caseSensitive));
  if (mode === "include") return { includedTables: matching, selectedTables: matching };

  const matchingSet = new Set(matching);
  return {
    includedTables: available.filter((table) => !matchingSet.has(table)),
    excludedTables: matching,
  };
}

export interface DatabaseBackupSchedule {
  id: string;
  name: string;
  enabled: boolean;
  connectionId: string;
  databases: string[];
  tableFilterMode: DatabaseBackupTableFilterMode;
  tablePatterns: string[];
  destinationDirectory: string;
  frequency: DatabaseBackupFrequency;
  intervalHours: number;
  timeOfDay: string;
  weekday: number;
  includeStructure: boolean;
  includeData: boolean;
  includeObjects: boolean;
  dropTableIfExists: boolean;
  retentionCount: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastRunStatus?: Exclude<DatabaseBackupRunStatus, "running">;
}

export interface DatabaseBackupFile {
  database: string;
  schema: string;
  displayName: string;
  filePath: string;
}

export interface DatabaseBackupRun {
  id: string;
  scheduleId: string;
  scheduleName: string;
  connectionId: string;
  connectionName: string;
  trigger: DatabaseBackupRunTrigger;
  status: DatabaseBackupRunStatus;
  startedAt: string;
  completedAt?: string;
  files: DatabaseBackupFile[];
  error?: string;
}

type UnknownRecord = Record<string, unknown>;

function recordValue(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numberValue)));
}

function validIsoDate(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback;
  return value;
}

export function normalizeDatabaseBackupTime(value: unknown): string {
  const text = stringValue(value).trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : "02:00";
}

export function normalizeDatabaseBackupRetention(value: unknown): number {
  return boundedInteger(value, 10, 1, 100);
}

export function normalizeDatabaseBackupSchedule(value: unknown, now = new Date()): DatabaseBackupSchedule | null {
  const input = recordValue(value);
  const id = stringValue(input.id).trim();
  const connectionId = stringValue(input.connectionId).trim();
  const destinationDirectory = stringValue(input.destinationDirectory).trim();
  if (!id || !connectionId || !destinationDirectory) return null;

  const nowIso = now.toISOString();
  const frequency: DatabaseBackupFrequency = input.frequency === "daily" || input.frequency === "weekly" ? input.frequency : "hourly";
  const schedule: DatabaseBackupSchedule = {
    id,
    name: stringValue(input.name).trim() || "Database backup",
    enabled: booleanValue(input.enabled, true),
    connectionId,
    databases: Array.isArray(input.databases) ? [...new Set(input.databases.map((database) => stringValue(database).trim()).filter(Boolean))] : [],
    tableFilterMode: input.tableFilterMode === "include" || input.tableFilterMode === "exclude" ? input.tableFilterMode : "all",
    tablePatterns: normalizeDatabaseBackupTablePatterns(input.tablePatterns),
    destinationDirectory,
    frequency,
    intervalHours: boundedInteger(input.intervalHours, 6, 1, 168),
    timeOfDay: normalizeDatabaseBackupTime(input.timeOfDay),
    weekday: boundedInteger(input.weekday, 1, 0, 6),
    includeStructure: booleanValue(input.includeStructure, true),
    includeData: booleanValue(input.includeData, true),
    includeObjects: booleanValue(input.includeObjects, true),
    dropTableIfExists: booleanValue(input.dropTableIfExists, false),
    retentionCount: normalizeDatabaseBackupRetention(input.retentionCount),
    createdAt: validIsoDate(input.createdAt, nowIso),
    updatedAt: validIsoDate(input.updatedAt, nowIso),
    nextRunAt: validIsoDate(input.nextRunAt, ""),
    lastRunAt: typeof input.lastRunAt === "string" && Number.isFinite(Date.parse(input.lastRunAt)) ? input.lastRunAt : undefined,
    lastRunStatus: input.lastRunStatus === "success" || input.lastRunStatus === "failed" || input.lastRunStatus === "cancelled" ? input.lastRunStatus : undefined,
  };

  if (!schedule.nextRunAt) schedule.nextRunAt = nextDatabaseBackupRunAt(schedule, now).toISOString();
  return schedule;
}

export function nextDatabaseBackupRunAt(schedule: Pick<DatabaseBackupSchedule, "frequency" | "intervalHours" | "timeOfDay" | "weekday">, after = new Date()): Date {
  if (schedule.frequency === "hourly") {
    return new Date(after.getTime() + boundedInteger(schedule.intervalHours, 6, 1, 168) * 60 * 60 * 1000);
  }

  const [hours, minutes] = normalizeDatabaseBackupTime(schedule.timeOfDay).split(":").map(Number);
  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setHours(hours!, minutes!, 0, 0);

  if (schedule.frequency === "daily") {
    if (next.getTime() <= after.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }

  const weekday = boundedInteger(schedule.weekday, 1, 0, 6);
  let daysAhead = (weekday - next.getDay() + 7) % 7;
  if (daysAhead === 0 && next.getTime() <= after.getTime()) daysAhead = 7;
  next.setDate(next.getDate() + daysAhead);
  return next;
}

export function databaseBackupScheduleIsDue(schedule: DatabaseBackupSchedule, now = new Date()): boolean {
  return schedule.enabled && Date.parse(schedule.nextRunAt) <= now.getTime();
}

function normalizeDatabaseBackupFile(value: unknown): DatabaseBackupFile | null {
  const input = recordValue(value);
  const filePath = stringValue(input.filePath).trim();
  if (!filePath) return null;
  return {
    database: stringValue(input.database).trim(),
    schema: stringValue(input.schema).trim(),
    displayName: stringValue(input.displayName).trim() || stringValue(input.database).trim(),
    filePath,
  };
}

export function normalizeDatabaseBackupRun(value: unknown): DatabaseBackupRun | null {
  const input = recordValue(value);
  const id = stringValue(input.id).trim();
  const scheduleId = stringValue(input.scheduleId).trim();
  const startedAt = validIsoDate(input.startedAt, "");
  if (!id || !scheduleId || !startedAt) return null;
  const status: DatabaseBackupRunStatus = input.status === "success" || input.status === "failed" || input.status === "cancelled" ? input.status : "failed";
  return {
    id,
    scheduleId,
    scheduleName: stringValue(input.scheduleName).trim() || "Database backup",
    connectionId: stringValue(input.connectionId).trim(),
    connectionName: stringValue(input.connectionName).trim(),
    trigger: input.trigger === "scheduled" ? "scheduled" : "manual",
    status,
    startedAt,
    completedAt: typeof input.completedAt === "string" && Number.isFinite(Date.parse(input.completedAt)) ? input.completedAt : undefined,
    files: Array.isArray(input.files) ? input.files.map(normalizeDatabaseBackupFile).filter((file): file is DatabaseBackupFile => !!file) : [],
    error: stringValue(input.error).trim() || undefined,
  };
}

function parseStoredArray(key: string): unknown[] {
  const stored = safeLocalStorageGet(key);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function readDatabaseBackupSchedules(): DatabaseBackupSchedule[] {
  return parseStoredArray(DATABASE_BACKUP_SCHEDULES_STORAGE_KEY)
    .map((schedule) => normalizeDatabaseBackupSchedule(schedule))
    .filter((schedule): schedule is DatabaseBackupSchedule => !!schedule);
}

export function writeDatabaseBackupSchedules(schedules: readonly DatabaseBackupSchedule[]) {
  safeLocalStorageSet(DATABASE_BACKUP_SCHEDULES_STORAGE_KEY, JSON.stringify(schedules));
}

export function readDatabaseBackupRuns(): DatabaseBackupRun[] {
  return parseStoredArray(DATABASE_BACKUP_RUNS_STORAGE_KEY)
    .map(normalizeDatabaseBackupRun)
    .filter((run): run is DatabaseBackupRun => !!run)
    .slice(0, MAX_DATABASE_BACKUP_HISTORY);
}

export function writeDatabaseBackupRuns(runs: readonly DatabaseBackupRun[]) {
  safeLocalStorageSet(DATABASE_BACKUP_RUNS_STORAGE_KEY, JSON.stringify(runs.slice(0, MAX_DATABASE_BACKUP_HISTORY)));
}

export function databaseBackupRunsToPrune(runs: readonly DatabaseBackupRun[], scheduleId: string, retentionCount: number): DatabaseBackupRun[] {
  return runs
    .filter((run) => run.scheduleId === scheduleId && run.status === "success")
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(normalizeDatabaseBackupRetention(retentionCount));
}

export function sanitizeDatabaseBackupFileSegment(value: string): string {
  const printableValue = Array.from(value, (character) => (character.charCodeAt(0) < 32 ? "_" : character)).join("");
  const sanitized = printableValue
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return sanitized || "database";
}

export function databaseBackupTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

export function joinDatabaseBackupPath(directory: string, fileName: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/, "")}${separator}${fileName}`;
}

export function databaseBackupFilePath(directory: string, scheduleName: string, fileStem: string, startedAt: Date | string, runId: string): string {
  const fileName = `dbx-backup__${sanitizeDatabaseBackupFileSegment(scheduleName)}__${databaseBackupTimestamp(startedAt)}__${sanitizeDatabaseBackupFileSegment(fileStem)}__${sanitizeDatabaseBackupFileSegment(runId).slice(0, 8)}.sql`;
  return joinDatabaseBackupPath(directory, fileName);
}
