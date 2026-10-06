// ---------------------------------------------------------------------------
// Scheduler API client (ADR §7). Command names and routes are frozen; this
// module is the single adaptation point between the UI and the backend, so if
// an argument name differs after integration only this file changes.
//
// Desktop → Tauri commands (ADR §7.2); browser → /api/scheduler/* routes
// (ADR §7.1). Backend errors carry a machine code prefix ("version_conflict:
// ...") on desktop and a JSON `{ code }` body on the web — `schedulerErrorCode`
// normalizes both for the ADR §7.5 vocabulary.
// ---------------------------------------------------------------------------

import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { apiUrl } from "@/lib/common/webPath";
import type { ResidentSession, TaskArtifact, TaskDefinition, TaskLogsPage, TaskRun, SchedulerErrorCode } from "./schedulerTypes";

async function tauriScheduler<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function webRequest<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(path), options);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      detail = (await res.text()) || detail;
    } catch {
      // keep the status text
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function web(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  return webRequest(method, path, body);
}

async function schedulerRequest<T>(tauriCommand: string, tauriArgs: Record<string, unknown> | undefined, webCall: () => Promise<unknown>): Promise<T> {
  if (isTauriRuntime(globalThis)) return tauriScheduler<T>(tauriCommand, tauriArgs);
  return (await webCall()) as T;
}

// ---------------------------------------------------------------------------
// Machine error codes (ADR §7.5). Every caller surfaces `version_conflict`
// distinctly, so keep this tolerant: unknown shapes degrade to undefined and
// the UI shows the raw message.
// ---------------------------------------------------------------------------

const SCHEDULER_ERROR_CODES: readonly SchedulerErrorCode[] = [
  "task_not_found",
  "run_not_found",
  "provider_not_found",
  "provider_unavailable",
  "invalid_config",
  "invalid_trigger",
  "version_conflict",
  "run_already_active",
  "permission_denied",
  "scheduler_unavailable",
  "worker_interrupted",
  "timeout",
  "connection_missing",
];

/** Extracts the ADR §7.5 machine code from a backend rejection, if present. */
export function schedulerErrorCode(error: unknown): SchedulerErrorCode | undefined {
  const structured = error instanceof Error && error.name === "BackendErrorException" ? (error as { backendError?: { code?: unknown } }).backendError?.code : undefined;
  const text = [typeof structured === "string" ? structured : "", error instanceof Error ? error.message : String(error)].filter(Boolean).join(" ").trim();
  for (const code of SCHEDULER_ERROR_CODES) {
    if (text === code || text.startsWith(`${code}:`) || text.startsWith(`${code} `) || text.includes(`"${code}"`) || text.includes(`'${code}'`)) return code;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function listTasks(): Promise<TaskDefinition[]> {
  return schedulerRequest("scheduler_list_tasks", {}, () => web("GET", "/api/scheduler/tasks"));
}

export function getTask(id: string): Promise<TaskDefinition> {
  return schedulerRequest("scheduler_get_task", { id }, () => web("GET", `/api/scheduler/tasks/${encodeURIComponent(id)}`));
}

/** Save is a CAS on `task.version`; a stale version rejects with `version_conflict`. */
export function saveTask(task: TaskDefinition): Promise<TaskDefinition> {
  return schedulerRequest("scheduler_save_task", { task }, () => web("PUT", `/api/scheduler/tasks/${encodeURIComponent(task.id)}`, task));
}

/** Create variant: both go through the frozen `schedulerSaveTask` command on desktop. */
export function createTask(task: Omit<TaskDefinition, "id" | "version"> & { id?: string; version?: number }): Promise<TaskDefinition> {
  const payload = { ...task, version: task.version ?? 1, configVersion: task.configVersion ?? 1 } as TaskDefinition;
  return schedulerRequest("scheduler_save_task", { task: payload }, () => web("POST", "/api/scheduler/tasks", payload));
}

export function deleteTask(id: string): Promise<void> {
  return schedulerRequest("scheduler_delete_task", { id }, () => web("DELETE", `/api/scheduler/tasks/${encodeURIComponent(id)}`)).then(() => undefined);
}

export function runTask(id: string): Promise<TaskRun> {
  return schedulerRequest("scheduler_run_task", { id }, () => web("POST", `/api/scheduler/tasks/${encodeURIComponent(id)}/run`, {}));
}

export function cancelRun(taskId: string, runId: string): Promise<void> {
  return schedulerRequest("scheduler_cancel_run", { taskId, runId }, () => web("POST", `/api/scheduler/tasks/${encodeURIComponent(taskId)}/cancel`, { runId })).then(() => undefined);
}

export function enableTask(id: string): Promise<TaskDefinition | void> {
  return schedulerRequest("scheduler_enable_task", { id }, () => web("POST", `/api/scheduler/tasks/${encodeURIComponent(id)}/enable`, {}));
}

export function disableTask(id: string): Promise<TaskDefinition | void> {
  return schedulerRequest("scheduler_disable_task", { id }, () => web("POST", `/api/scheduler/tasks/${encodeURIComponent(id)}/disable`, {}));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface SchedulerRunFilter {
  taskId?: string;
  status?: TaskRun["status"];
  limit?: number;
}

function runFilterQuery(filter: SchedulerRunFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.taskId) params.set("taskId", filter.taskId);
  if (filter.status) params.set("status", filter.status);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function listRuns(filter: SchedulerRunFilter = {}): Promise<TaskRun[]> {
  return schedulerRequest("scheduler_list_runs", { taskId: filter.taskId, status: filter.status, limit: filter.limit }, () => web("GET", `/api/scheduler/runs${runFilterQuery(filter)}`));
}

export function getRun(runId: string): Promise<TaskRun> {
  return schedulerRequest("scheduler_get_run", { runId }, () => web("GET", `/api/scheduler/runs/${encodeURIComponent(runId)}`));
}

export interface SchedulerLogQuery {
  afterSeq?: number;
  limit?: number;
  level?: TaskLogsPage["entries"][number]["level"];
  stream?: TaskLogsPage["entries"][number]["stream"];
}

function logQuery(search: URLSearchParams): string {
  const query = search.toString();
  return query ? `?${query}` : "";
}

/** Tail query (ADR §7.3): snapshot with afterSeq=0, then append with nextSeq. */
export function getRunLogs(runId: string, query: SchedulerLogQuery = {}): Promise<TaskLogsPage> {
  const params = new URLSearchParams();
  params.set("afterSeq", String(query.afterSeq ?? 0));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.level) params.set("level", query.level);
  if (query.stream) params.set("stream", query.stream);
  return schedulerRequest("scheduler_get_run_logs", { runId, afterSeq: query.afterSeq ?? 0, limit: query.limit, level: query.level, stream: query.stream }, () => web("GET", `/api/scheduler/runs/${encodeURIComponent(runId)}/logs${logQuery(params)}`));
}

export function listArtifacts(runId: string): Promise<TaskArtifact[]> {
  return schedulerRequest("scheduler_list_artifacts", { runId }, () => web("GET", `/api/scheduler/runs/${encodeURIComponent(runId)}/artifacts`));
}

// ---------------------------------------------------------------------------
// Resident sessions (ADR §2.7, web route GET /api/scheduler/resident)
// ---------------------------------------------------------------------------

/**
 * Active session list. The frozen desktop command roster (ADR §7.2) has no
 * dedicated list command, so prefer the natural counterpart of the frozen web
 * route and fall back to `schedulerResidentAction { action: "list" }` when the
 * backend exposes listing through the action command instead.
 */
export async function listResidentSessions(): Promise<ResidentSession[]> {
  if (!isTauriRuntime(globalThis)) return (await web("GET", "/api/scheduler/resident")) as ResidentSession[];
  try {
    return await tauriScheduler<ResidentSession[]>("scheduler_list_resident_sessions", {});
  } catch (listError) {
    if (schedulerErrorCode(listError) === undefined) {
      // Unknown-command rejections carry no scheduler machine code — retry
      // through the action command before giving up.
      try {
        return await tauriScheduler<ResidentSession[]>("scheduler_resident_action", { action: "list" });
      } catch {
        throw listError;
      }
    }
    throw listError;
  }
}

export type SchedulerResidentAction = "start" | "stop" | "restart";

export function residentAction(sessionId: string, action: SchedulerResidentAction): Promise<ResidentSession | void> {
  return schedulerRequest("scheduler_resident_action", { sessionId, action }, () => web("POST", `/api/scheduler/resident/${encodeURIComponent(sessionId)}/${action}`, {}));
}
