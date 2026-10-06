// ---------------------------------------------------------------------------
// Scheduler / Task Center contract types (docs/adr/scheduler-task-contract.md §2).
//
// Hand-maintained per ADR §13 ("TS 类型先手工维护"); once the API surface
// stabilizes these move to a generated module. Field names are camelCase and
// enum values use the exact serde spellings the backend persists — do not
// "normalize" them here: these strings round-trip through scheduler SQLite.
// ---------------------------------------------------------------------------

import type { PluginFormField } from "@/types/database";

/** ADR §2.2 kebab-case. */
export type TaskProviderType = "builtin" | "plugin";

/** ADR §2.3. */
export interface TaskTarget {
  connectionId?: string | null;
  /** Extra connections for providers declaring `allowMultipleConnections`. */
  additionalConnectionIds?: string[];
  pluginId?: string | null;
  resourceId?: string | null;
}

/** Trigger type tag (ADR §2.4, serde `#[serde(tag = "type")]` camelCase). */
export type TaskTriggerType = "manual" | "once" | "interval" | "cron" | "startup";

export interface TaskTriggerManual {
  type: "manual";
}

export interface TaskTriggerOnce {
  type: "once";
  /** RFC3339, or local "YYYY-MM-DDTHH:mm" interpreted in `timeZone`. */
  at: string;
  timeZone: string;
}

export interface TaskTriggerInterval {
  type: "interval";
  seconds: number;
}

export interface TaskTriggerCron {
  type: "cron";
  /** Standard 5-field cron (minute hour day-of-month month day-of-week). */
  expression: string;
  timeZone: string;
}

export interface TaskTriggerStartup {
  type: "startup";
}

export type TaskTrigger = TaskTriggerManual | TaskTriggerOnce | TaskTriggerInterval | TaskTriggerCron | TaskTriggerStartup;

/** ADR §2.5 kebab-case. */
export type TaskExecutionMode = "run" | "resident";
export type TaskConcurrencyPolicy = "forbid" | "queue" | "replace" | "parallel";
export type TaskBackoffStrategy = "fixed" | "exponential";
export type TaskMisfirePolicy = "coalesce" | "fire-once" | "skip";

export interface TaskRetryPolicy {
  /** 1 = no retry. */
  maxAttempts: number;
  backoffSeconds: number;
  backoffStrategy: TaskBackoffStrategy;
}

export interface TaskRestartPolicy {
  enabled: boolean;
  maxRestarts: number;
  backoffSeconds: number;
  /** None = process lifetime. */
  restartWindowSeconds?: number | null;
}

export interface TaskExecutionPolicy {
  mode: TaskExecutionMode;
  timeoutSeconds?: number | null;
  concurrency: TaskConcurrencyPolicy;
  retry: TaskRetryPolicy;
  misfire: TaskMisfirePolicy;
  /** Only meaningful in resident mode. */
  restart?: TaskRestartPolicy | null;
}

/** ADR §2.6 lowercase. */
export type TaskRunStatus = "queued" | "starting" | "running" | "success" | "failed" | "cancelled" | "timeout" | "skipped";
export type TaskRunTrigger = "manual" | "scheduled" | "startup" | "retry" | "restart";

/** ADR §2.1. */
export interface TaskDefinition {
  id: string;
  name: string;
  providerType: TaskProviderType;
  /** Namespaced provider id, e.g. `dbx.database-backup`. */
  providerId: string;
  target: TaskTarget;
  trigger: TaskTrigger;
  execution: TaskExecutionPolicy;
  /** Schema version of `config`; first generation is always 1. */
  configVersion: number;
  /** Provider-opaque config; must not contain secrets or a `configVersion` key. */
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRunStatus?: TaskRunStatus | null;
  /** Optimistic locking; save must echo it back and a stale value yields `version_conflict`. */
  version: number;
}

/** ADR §2.6. */
export interface TaskRun {
  id: string;
  taskId: string;
  status: TaskRunStatus;
  trigger: TaskRunTrigger;
  attempt: number;
  workerId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  exitCode?: number | null;
  /** Machine code, ADR §5.4 vocabulary. */
  errorCode?: string | null;
  errorMessage?: string | null;
  progressPercent?: number | null;
  artifactsCount: number;
  createdAt: string;
}

/** ADR §2.7 lowercase. */
export type ResidentSessionState = "stopped" | "starting" | "running" | "stopping" | "crashed" | "degraded";

export interface ResidentSession {
  id: string;
  taskId: string;
  runId: string;
  pluginId: string;
  /** Plugin-side session id (returned by `task/start`). */
  sessionId: string;
  state: ResidentSessionState;
  heartbeatAt?: string | null;
  restartCount: number;
  createdAt: string;
  updatedAt: string;
}

/** ADR §2.8 lowercase. */
export type TaskHealth = "healthy" | "warning" | "invalid" | "unavailable";

/** ADR §5.1 / §3.2 task_artifacts columns. */
export interface TaskArtifact {
  name: string;
  uri: string;
  contentType?: string | null;
  size?: number | null;
  checksum?: string | null;
}

/** JSONL log line, ADR §5.3. */
export interface TaskLogEntry {
  seq: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  stream: "stdout" | "stderr" | "system";
  message: string;
}

/** ADR §7.3 log query response. */
export interface TaskLogsPage {
  entries: TaskLogEntry[];
  nextSeq: number;
  eof: boolean;
}

/** Reserved error codes, ADR §7.5 / §5.4. */
export type SchedulerErrorCode =
  | "task_not_found"
  | "run_not_found"
  | "provider_not_found"
  | "provider_unavailable"
  | "invalid_config"
  | "invalid_trigger"
  | "version_conflict"
  | "run_already_active"
  | "permission_denied"
  | "scheduler_unavailable"
  | "worker_interrupted"
  | "timeout"
  | "connection_missing";

// ---------------------------------------------------------------------------
// Plugin task-provider contribution (ADR §6.1). The contribution reuses the
// existing manifest form field system (`PluginFormField` from @/types/database)
// — the scheduler defines no second form DSL.
// ---------------------------------------------------------------------------

export type PluginTaskCapability = "run" | "resident" | "cancel" | "logs" | "progress" | "artifacts";
export type PluginTaskMode = "run" | "resident";
export type PluginTaskRisk = "low" | "medium" | "high";

export interface SchedulerTaskTriggerContribution {
  /** Unique inside the provider, e.g. `execute`. */
  id: string;
  label: string;
  mode: PluginTaskMode;
  risk?: PluginTaskRisk;
  fields?: PluginFormField[];
}

export interface SchedulerTaskProviderContribution {
  type: "task-provider";
  id: string;
  label: string;
  connectionProviders?: string[];
  capabilities?: PluginTaskCapability[];
  triggers?: SchedulerTaskTriggerContribution[];
}

/** Discovery result: one task provider with the plugin that declares it. */
export interface SchedulerTaskProviderDescriptor {
  providerId: string;
  label: string;
  /** Host plugin id that declares the provider (manifest id). */
  pluginId: string;
  connectionProviders: string[];
  /** One task may bind several connections (e.g. an SSH run-everywhere task). */
  allowMultipleConnections?: boolean;
  capabilities: PluginTaskCapability[];
  triggers: SchedulerTaskTriggerContribution[];
  /** Host builtin (dbx.database-backup); not offered in the create dialog. */
  builtin?: boolean;
}

// ---------------------------------------------------------------------------
// Events, ADR §7.4. Desktop: Tauri event `dbx-scheduler-event`; notifications
// only — clients must be able to rebuild state from the API.
// ---------------------------------------------------------------------------

export type SchedulerEventType = "task-changed" | "run-created" | "run-state" | "run-progress" | "run-log" | "resident-state";

export interface SchedulerEvent {
  type: SchedulerEventType;
  taskId?: string;
  runId?: string;
  /** `run-state`: new TaskRunStatus; `resident-state`: ResidentSessionState. */
  status?: string;
  state?: string;
  percent?: number;
  /** `run-log` appends. */
  entries?: TaskLogEntry[];
}

export const SCHEDULER_EVENT_NAME = "dbx-scheduler-event";
