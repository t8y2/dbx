// Scheduler / Task Center wire types (ADR §2, frozen Wave-1 contract).
// These mirror the Rust serde shapes exactly: `camelCase` struct fields,
// kebab-case enum values, lowercase run states and the `type`-tagged trigger
// union. Manual maintenance first; generated types come later once the API
// is stable.

// ---------------------------------------------------------------------------
// Triggers (ADR §2.4)
// ---------------------------------------------------------------------------

export type TaskTrigger = { type: "manual" } | { type: "once"; at: string; timeZone: string } | { type: "interval"; seconds: number } | { type: "cron"; expression: string; timeZone: string } | { type: "startup" };

// ---------------------------------------------------------------------------
// Execution policy (ADR §2.5)
// ---------------------------------------------------------------------------

export type TaskExecutionMode = "run" | "resident";
export type TaskConcurrencyPolicy = "forbid" | "queue" | "replace" | "parallel";
export type TaskBackoffStrategy = "fixed" | "exponential";
export type TaskMisfirePolicy = "coalesce" | "fire-once" | "skip";

export interface TaskRetryPolicy {
  maxAttempts: number;
  backoffSeconds: number;
  backoffStrategy: TaskBackoffStrategy;
}

export interface TaskRestartPolicy {
  enabled: boolean;
  maxRestarts: number;
  backoffSeconds: number;
  restartWindowSeconds?: number;
}

export interface TaskExecutionPolicy {
  mode: TaskExecutionMode;
  timeoutSeconds?: number;
  concurrency: TaskConcurrencyPolicy;
  retry: TaskRetryPolicy;
  misfire: TaskMisfirePolicy;
  restart?: TaskRestartPolicy;
}

// ---------------------------------------------------------------------------
// Task definition (ADR §2.1)
// ---------------------------------------------------------------------------

export type TaskProviderType = "builtin" | "plugin";

export interface TaskTarget {
  connectionId?: string;
  pluginId?: string;
  resourceId?: string;
}

export type TaskRunStatus = "queued" | "starting" | "running" | "success" | "failed" | "cancelled" | "timeout" | "skipped";

export type TaskRunTrigger = "manual" | "scheduled" | "startup" | "retry" | "restart";

export type TaskLastRunStatus = TaskRunStatus;

export interface TaskDefinition {
  id: string;
  name: string;
  providerType: TaskProviderType;
  providerId: string;
  target: TaskTarget;
  trigger: TaskTrigger;
  execution: TaskExecutionPolicy;
  /** Schema version of the provider config; lives on the definition (ADR §14 D2). */
  configVersion: number;
  /** Provider-opaque config; must not embed a `configVersion` key or secrets. */
  config: unknown;
  enabled: boolean;
  /** RFC3339 UTC timestamps; written by the scheduler, not clients. */
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: TaskLastRunStatus | null;
  /** Optimistic-locking version; saves must echo the stored value. */
  version: number;
}

// ---------------------------------------------------------------------------
// Runs (ADR §2.6) / logs (§7.3) / artifacts / resident sessions (§2.7)
// ---------------------------------------------------------------------------

export interface TaskRun {
  id: string;
  taskId: string;
  status: TaskRunStatus;
  trigger: TaskRunTrigger;
  /** Starts at 1; retries create a new run with attempt + 1. */
  attempt: number;
  workerId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  progressPercent: number | null;
  artifactsCount: number;
  createdAt: string;
}

export interface TaskLogEntry {
  seq: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export interface TaskLogPage {
  entries: TaskLogEntry[];
  nextSeq: number;
  eof: boolean;
}

export interface TaskArtifact {
  name: string;
  uri: string;
  contentType?: string;
  size?: number;
  checksum?: string;
}

export type ResidentState = "stopped" | "starting" | "running" | "stopping" | "crashed" | "degraded";

export interface ResidentSession {
  id: string;
  taskId: string;
  runId: string;
  pluginId: string;
  sessionId: string;
  state: ResidentState;
  heartbeatAt: string | null;
  restartCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Query payloads
// ---------------------------------------------------------------------------

export interface SchedulerRunListQuery {
  taskId?: string;
  status?: TaskRunStatus;
  limit?: number;
  /** Return runs older than this run id. */
  before?: string;
  /** Return runs newer than this run id. */
  after?: string;
}

export interface SchedulerLogQuery {
  afterSeq?: number;
  limit?: number;
  level?: TaskLogEntry["level"];
  stream?: TaskLogEntry["stream"];
}

export type SchedulerResidentAction = "start" | "stop" | "restart";

export interface SchedulerResidentActionResult {
  accepted: boolean;
  runId?: string;
}

// ---------------------------------------------------------------------------
// Error codes (ADR §7.5, frozen) and the Desktop error-string convention:
// backend failures reject with `"<code>: <message>"`.
// ---------------------------------------------------------------------------

export type SchedulerErrorCode = "task_not_found" | "run_not_found" | "provider_not_found" | "provider_unavailable" | "invalid_config" | "invalid_trigger" | "version_conflict" | "run_already_active" | "permission_denied" | "scheduler_unavailable";
