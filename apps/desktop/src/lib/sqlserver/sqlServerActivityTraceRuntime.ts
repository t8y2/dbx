import { reactive } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import type { QueryResult } from "@/types/database";
import {
  SQLSERVER_TRACE_DEFAULT_DURATION_MINUTES,
  SQLSERVER_TRACE_DEFAULT_MAX_EVENTS,
  SQLSERVER_TRACE_MAX_DURATION_MINUTES,
  SQLSERVER_TRACE_READ_BATCH_SIZE,
  SQLSERVER_TRACE_STALE_GRACE_MINUTES,
  buildCleanupSqlServerTraceSessionsSql,
  buildCreateSqlServerTraceSessionSql,
  buildDropSqlServerTraceSessionSql,
  buildListSqlServerTraceSessionsSql,
  buildReadSqlServerTraceEventsSql,
  buildSqlServerTraceCapabilitiesSql,
  buildSqlServerTraceSessionName,
  buildStopSqlServerTraceSessionSql,
  isValidSqlServerTraceSessionName,
  missingSqlServerTraceCapabilities,
  normalizeSqlServerTraceDurationMinutes,
  normalizeSqlServerTraceMaxEvents,
  parseSqlServerTraceCapabilities,
  parseSqlServerTraceEvents,
  sqlServerTraceCapabilityProblem,
  staleSqlServerTraceSessionNames,
  type SqlServerTraceEvent,
  type SqlServerTraceCapabilityProblem,
} from "@/lib/sqlserver/sqlServerActivityTrace";

export type SqlServerTraceStatus = "idle" | "starting" | "running" | "paused" | "stopping" | "stopped" | "error";
export type SqlServerTraceAutoStopReason = "duration" | "events";

export interface SqlServerActivityTraceState {
  status: SqlServerTraceStatus;
  selectedDatabase: string;
  includeStatements: boolean;
  maxEvents: number;
  durationMinutes: number;
  events: SqlServerTraceEvent[];
  selectedEvent: SqlServerTraceEvent | null;
  sqlFilter: string;
  loginFilter: string;
  clientFilter: string;
  sessionFilter: string;
  error: string;
  sessionName: string;
  startedAt: number | null;
  elapsedSeconds: number;
  polling: boolean;
  autoStopReason: SqlServerTraceAutoStopReason | null;
  autoStopRevision: number;
  capabilityProblem: SqlServerTraceCapabilityProblem | null;
  capabilityVersion: string;
  missingCapabilities: string[];
}

interface SqlServerTraceCursor {
  timestamp: string;
  counts: Map<string, number>;
}

interface PendingSqlServerTraceSession {
  connectionId: string;
  database: string;
  sessionName: string;
  expiresAt: number;
}

interface PollOptions {
  final?: boolean;
  allowWhileStopping?: boolean;
}

export interface SqlServerActivityTraceRuntime {
  readonly tabId: string;
  readonly connectionId: string;
  readonly state: SqlServerActivityTraceState;
  start(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(reason?: SqlServerTraceAutoStopReason): Promise<void>;
  clearEvents(): void;
}

const PENDING_SESSIONS_STORAGE_KEY = "dbx:sqlserver-trace:pending-sessions:v1";
const runtimes = new Map<string, InternalSqlServerActivityTraceRuntime>();
const activeSessionNames = new Set<string>();
const staleCleanupTasks = new Map<string, Promise<number>>();

interface InternalSqlServerActivityTraceRuntime extends SqlServerActivityTraceRuntime {
  pollTimer?: ReturnType<typeof setInterval>;
  elapsedTimer?: ReturnType<typeof setInterval>;
  pollPromise?: Promise<void>;
  activeReadExecutionId?: string;
  generation: number;
  cursor?: SqlServerTraceCursor;
  startPromise?: Promise<void>;
  stopPromise?: Promise<void>;
}

function readPendingSessions(): PendingSqlServerTraceSession[] {
  try {
    const value = JSON.parse(safeLocalStorageGet(PENDING_SESSIONS_STORAGE_KEY) || "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is PendingSqlServerTraceSession =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as PendingSqlServerTraceSession).connectionId === "string" &&
        typeof (entry as PendingSqlServerTraceSession).database === "string" &&
        typeof (entry as PendingSqlServerTraceSession).sessionName === "string" &&
        isValidSqlServerTraceSessionName((entry as PendingSqlServerTraceSession).sessionName) &&
        Number.isFinite((entry as PendingSqlServerTraceSession).expiresAt),
    );
  } catch {
    return [];
  }
}

function writePendingSessions(sessions: PendingSqlServerTraceSession[]) {
  safeLocalStorageSet(PENDING_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
}

function registerPendingSession(runtime: InternalSqlServerActivityTraceRuntime, sessionName: string) {
  activeSessionNames.add(sessionName);
  const sessions = readPendingSessions().filter((entry) => entry.sessionName !== sessionName);
  sessions.push({
    connectionId: runtime.connectionId,
    database: runtime.state.selectedDatabase,
    sessionName,
    expiresAt: Date.now() + (normalizeSqlServerTraceDurationMinutes(runtime.state.durationMinutes) + SQLSERVER_TRACE_STALE_GRACE_MINUTES) * 60_000,
  });
  writePendingSessions(sessions);
}

function unregisterPendingSession(sessionName: string) {
  activeSessionNames.delete(sessionName);
  writePendingSessions(readPendingSessions().filter((entry) => entry.sessionName !== sessionName));
}

async function executeControlQuery(connectionId: string, database: string, sql: string, maxRows = 1): Promise<QueryResult> {
  return api.executeQuery(connectionId, database || "master", sql, undefined, uuid(), { maxRows });
}

export function cleanupStaleSqlServerTraceSessions(connectionId: string, database = "master"): Promise<number> {
  const existing = staleCleanupTasks.get(connectionId);
  if (existing) return existing;
  const task = (async () => {
    const now = Date.now();
    const pending = readPendingSessions().filter((entry) => entry.connectionId === connectionId && entry.expiresAt <= now && !activeSessionNames.has(entry.sessionName));
    const listResult = await executeControlQuery(connectionId, database, buildListSqlServerTraceSessionsSql(), 500);
    const expired = staleSqlServerTraceSessionNames(listResult, now);
    const names = [...new Set([...pending.map((entry) => entry.sessionName), ...expired])].filter((name) => !activeSessionNames.has(name));
    if (names.length === 0) return 0;
    await executeControlQuery(connectionId, database, buildCleanupSqlServerTraceSessionsSql(names));
    const cleanedNames = new Set(names);
    writePendingSessions(readPendingSessions().filter((entry) => !cleanedNames.has(entry.sessionName)));
    return names.length;
  })().finally(() => staleCleanupTasks.delete(connectionId));
  staleCleanupTasks.set(connectionId, task);
  return task;
}

function stopTimers(runtime: InternalSqlServerActivityTraceRuntime) {
  if (runtime.pollTimer) clearInterval(runtime.pollTimer);
  if (runtime.elapsedTimer) clearInterval(runtime.elapsedTimer);
  runtime.pollTimer = undefined;
  runtime.elapsedTimer = undefined;
}

function startTimers(runtime: InternalSqlServerActivityTraceRuntime) {
  stopTimers(runtime);
  runtime.pollTimer = setInterval(() => {
    if (runtime.state.status === "running") void pollEvents(runtime);
  }, 1000);
  runtime.elapsedTimer = setInterval(() => {
    if (!runtime.state.startedAt || (runtime.state.status !== "running" && runtime.state.status !== "paused")) return;
    runtime.state.elapsedSeconds = Math.max(0, Math.floor((Date.now() - runtime.state.startedAt) / 1000));
    if (runtime.state.elapsedSeconds >= normalizeSqlServerTraceDurationMinutes(runtime.state.durationMinutes) * 60) {
      void stopRuntime(runtime, "duration");
    }
  }, 1000);
}

function mergeIncrementalBatch(runtime: InternalSqlServerActivityTraceRuntime, batch: SqlServerTraceEvent[]): SqlServerTraceEvent[] {
  const cursor = runtime.cursor;
  const additions: SqlServerTraceEvent[] = [];
  const countsByTimestamp = new Map<string, Map<string, number>>();
  for (const event of batch) {
    const timestampCounts = countsByTimestamp.get(event.timestamp) ?? new Map<string, number>();
    const occurrence = (timestampCounts.get(event.key) ?? 0) + 1;
    timestampCounts.set(event.key, occurrence);
    countsByTimestamp.set(event.timestamp, timestampCounts);
    if (!cursor || event.timestamp > cursor.timestamp || (event.timestamp === cursor.timestamp && occurrence > (cursor.counts.get(event.key) ?? 0))) {
      additions.push({ ...event, key: `${event.key}\u0001${occurrence}` });
    }
  }
  const latestTimestamp = batch[batch.length - 1]?.timestamp;
  if (latestTimestamp) runtime.cursor = { timestamp: latestTimestamp, counts: countsByTimestamp.get(latestTimestamp) ?? new Map() };
  return additions;
}

async function cancelActiveRead(runtime: InternalSqlServerActivityTraceRuntime) {
  const executionId = runtime.activeReadExecutionId;
  if (!executionId) return;
  runtime.activeReadExecutionId = undefined;
  await api.cancelQuery(executionId).catch(() => false);
  await runtime.pollPromise?.catch(() => undefined);
}

async function cleanupSession(runtime: InternalSqlServerActivityTraceRuntime) {
  const name = runtime.state.sessionName;
  if (!name) return;
  try {
    await executeControlQuery(runtime.connectionId, runtime.state.selectedDatabase, buildStopSqlServerTraceSessionSql(name));
  } catch {
    // The session may already be stopped or the connection may be recovering.
  }
  try {
    await executeControlQuery(runtime.connectionId, runtime.state.selectedDatabase, buildDropSqlServerTraceSessionSql(name));
    runtime.state.sessionName = "";
    unregisterPendingSession(name);
  } catch (error) {
    runtime.state.error = error instanceof Error ? error.message : String(error);
  }
}

async function pollEvents(runtime: InternalSqlServerActivityTraceRuntime, options: PollOptions = {}) {
  if (!runtime.state.sessionName || runtime.state.polling) return;
  if (!options.allowWhileStopping && runtime.state.status !== "running") return;
  const generation = runtime.generation;
  const executionId = uuid();
  runtime.activeReadExecutionId = executionId;
  runtime.state.polling = true;
  let autoStopReason: SqlServerTraceAutoStopReason | undefined;
  const promise = api
    .executeQuery(runtime.connectionId, runtime.state.selectedDatabase, buildReadSqlServerTraceEventsSql(runtime.state.sessionName, runtime.cursor?.timestamp), undefined, executionId, { maxRows: SQLSERVER_TRACE_READ_BATCH_SIZE })
    .then((result) => {
      if (runtime.generation !== generation) return;
      const additions = mergeIncrementalBatch(runtime, parseSqlServerTraceEvents(result));
      const remaining = Math.max(0, normalizeSqlServerTraceMaxEvents(runtime.state.maxEvents) - runtime.state.events.length);
      if (remaining > 0) runtime.state.events.push(...additions.slice(0, remaining));
      if (!options.final && runtime.state.events.length >= normalizeSqlServerTraceMaxEvents(runtime.state.maxEvents)) {
        autoStopReason = "events";
      }
    })
    .catch(async (error) => {
      if (options.final || runtime.generation !== generation || runtime.state.status === "stopping") return;
      runtime.state.error = error instanceof Error ? error.message : String(error);
      runtime.state.status = "error";
      stopTimers(runtime);
      await cleanupSession(runtime);
    })
    .finally(() => {
      if (runtime.activeReadExecutionId === executionId) runtime.activeReadExecutionId = undefined;
      runtime.state.polling = false;
      if (runtime.pollPromise === promise) runtime.pollPromise = undefined;
    });
  runtime.pollPromise = promise;
  await promise;
  if (autoStopReason) void stopRuntime(runtime, autoStopReason);
}

async function startRuntime(runtime: InternalSqlServerActivityTraceRuntime) {
  const state = runtime.state;
  if (!state.selectedDatabase || state.status === "running" || state.status === "paused" || state.status === "starting" || state.status === "stopping") return;
  state.error = "";
  state.capabilityProblem = null;
  state.capabilityVersion = "";
  state.missingCapabilities = [];
  state.status = "starting";
  state.maxEvents = normalizeSqlServerTraceMaxEvents(state.maxEvents);
  state.durationMinutes = normalizeSqlServerTraceDurationMinutes(state.durationMinutes);
  state.events = [];
  state.selectedEvent = null;
  state.elapsedSeconds = 0;
  runtime.cursor = undefined;
  runtime.generation += 1;
  const generation = runtime.generation;
  try {
    await cleanupStaleSqlServerTraceSessions(runtime.connectionId, state.selectedDatabase);
    const capabilities = parseSqlServerTraceCapabilities(await executeControlQuery(runtime.connectionId, state.selectedDatabase, buildSqlServerTraceCapabilitiesSql(state.selectedDatabase)));
    const problem = sqlServerTraceCapabilityProblem(capabilities, state.includeStatements);
    if (problem) {
      state.capabilityProblem = problem;
      state.capabilityVersion = capabilities.productVersion;
      state.missingCapabilities = missingSqlServerTraceCapabilities(capabilities, state.includeStatements);
      throw new Error(problem);
    }
    const name = buildSqlServerTraceSessionName(Date.now() + (state.durationMinutes + SQLSERVER_TRACE_STALE_GRACE_MINUTES) * 60_000);
    state.sessionName = name;
    registerPendingSession(runtime, name);
    await executeControlQuery(
      runtime.connectionId,
      state.selectedDatabase,
      buildCreateSqlServerTraceSessionSql({
        sessionName: name,
        databaseId: capabilities.databaseId,
        maxEvents: state.maxEvents,
        includeStatements: state.includeStatements,
      }),
    );
    if (runtime.generation !== generation) {
      await cleanupSession(runtime);
      return;
    }
    state.startedAt = Date.now();
    state.status = "running";
    startTimers(runtime);
    void pollEvents(runtime);
  } catch (error) {
    if (!state.capabilityProblem) state.error = error instanceof Error ? error.message : String(error);
    state.status = "error";
    stopTimers(runtime);
    await cleanupSession(runtime);
  }
}

async function stopRuntime(runtime: InternalSqlServerActivityTraceRuntime, reason?: SqlServerTraceAutoStopReason, final = true) {
  if (runtime.stopPromise) return runtime.stopPromise;
  const promise = (async () => {
    if (!runtime.state.sessionName && runtime.state.status !== "starting") return;
    runtime.state.status = "stopping";
    stopTimers(runtime);
    runtime.generation += 1;
    await runtime.startPromise?.catch(() => undefined);
    await cancelActiveRead(runtime);
    if (final && runtime.state.sessionName) await pollEvents(runtime, { final: true, allowWhileStopping: true });
    await cleanupSession(runtime);
    runtime.state.status = runtime.state.sessionName ? "error" : "stopped";
    if (reason && !runtime.state.sessionName) {
      runtime.state.autoStopReason = reason;
      runtime.state.autoStopRevision += 1;
    }
  })().finally(() => {
    if (runtime.stopPromise === promise) runtime.stopPromise = undefined;
  });
  runtime.stopPromise = promise;
  await promise;
}

export function getSqlServerActivityTraceRuntime(tabId: string, connectionId: string, database = ""): SqlServerActivityTraceRuntime {
  const existing = runtimes.get(tabId);
  if (existing) return existing;
  const runtime: InternalSqlServerActivityTraceRuntime = {
    tabId,
    connectionId,
    generation: 0,
    state: reactive<SqlServerActivityTraceState>({
      status: "idle",
      selectedDatabase: database,
      includeStatements: false,
      maxEvents: SQLSERVER_TRACE_DEFAULT_MAX_EVENTS,
      durationMinutes: SQLSERVER_TRACE_DEFAULT_DURATION_MINUTES,
      events: [],
      selectedEvent: null,
      sqlFilter: "",
      loginFilter: "",
      clientFilter: "",
      sessionFilter: "",
      error: "",
      sessionName: "",
      startedAt: null,
      elapsedSeconds: 0,
      polling: false,
      autoStopReason: null,
      autoStopRevision: 0,
      capabilityProblem: null,
      capabilityVersion: "",
      missingCapabilities: [],
    }),
    start: () => {
      if (runtime.startPromise) return runtime.startPromise;
      const promise = startRuntime(runtime).finally(() => {
        if (runtime.startPromise === promise) runtime.startPromise = undefined;
      });
      runtime.startPromise = promise;
      return promise;
    },
    pause: () => {
      if (runtime.state.status !== "running") return;
      runtime.state.status = "paused";
      if (runtime.pollTimer) clearInterval(runtime.pollTimer);
      runtime.pollTimer = undefined;
    },
    resume: async () => {
      if (runtime.state.status !== "paused") return;
      runtime.state.status = "running";
      startTimers(runtime);
      await pollEvents(runtime);
    },
    stop: (reason) => stopRuntime(runtime, reason),
    clearEvents: () => {
      runtime.state.events = [];
      runtime.state.selectedEvent = null;
    },
  };
  runtimes.set(tabId, runtime);
  return runtime;
}

export async function disposeSqlServerActivityTrace(tabId: string): Promise<void> {
  const runtime = runtimes.get(tabId);
  if (!runtime) return;
  runtime.generation += 1;
  stopTimers(runtime);
  await cancelActiveRead(runtime);
  await runtime.startPromise?.catch(() => undefined);
  if (runtime.state.sessionName) await stopRuntime(runtime, undefined, false);
  if (runtimes.get(tabId) === runtime) runtimes.delete(tabId);
}

export async function disposeAllSqlServerActivityTraces(): Promise<void> {
  await Promise.all([...runtimes.keys()].map(disposeSqlServerActivityTrace));
}

export async function disposeSqlServerActivityTracesForConnection(connectionId: string, database?: string): Promise<void> {
  const tabIds = [...runtimes.values()].filter((runtime) => runtime.connectionId === connectionId && (!database || runtime.state.selectedDatabase === database)).map((runtime) => runtime.tabId);
  await Promise.all(tabIds.map(disposeSqlServerActivityTrace));
}

export function activeSqlServerActivityTraceRuntimeCount(): number {
  return runtimes.size;
}

export function hasSqlServerActivityTraceForConnection(connectionId: string, database?: string): boolean {
  return [...runtimes.values()].some((runtime) => runtime.connectionId === connectionId && (!database || runtime.state.selectedDatabase === database));
}

export function sqlServerTracePendingSessionLifetimeMs(): number {
  return (SQLSERVER_TRACE_MAX_DURATION_MINUTES + SQLSERVER_TRACE_STALE_GRACE_MINUTES) * 60_000;
}
