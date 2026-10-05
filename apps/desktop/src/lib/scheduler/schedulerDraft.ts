// ---------------------------------------------------------------------------
// Task draft builders. Defaults follow ADR §2.5 (run mode concurrency =
// `forbid`, resident = `replace`, misfire = `coalesce`, retry maxAttempts = 1).
// The timezone default is the OS IANA name and is persisted explicitly with
// the trigger — the UI never keeps it as ephemeral-only state.
// ---------------------------------------------------------------------------

import { uuid } from "@/lib/common/utils";
import { defaultTimeZone, withStoredTriggerId } from "./schedulerProviders";
import type { SchedulerFormValues } from "./schedulerForm";
import { configFromFormValues, defaultFormValues } from "./schedulerForm";
import type { SchedulerTaskProviderDescriptor, SchedulerTaskTriggerContribution, TaskDefinition, TaskExecutionPolicy, TaskExecutionMode, TaskRunStatus, TaskTrigger, TaskTriggerType } from "./schedulerTypes";

export const TASK_TRIGGER_TYPES: readonly TaskTriggerType[] = ["manual", "once", "interval", "cron", "startup"];

/** Mode is provider-declared: a resident trigger forces the resident policy. */
export function modeForTrigger(trigger: SchedulerTaskTriggerContribution | undefined): TaskExecutionMode {
  return trigger?.mode === "resident" ? "resident" : "run";
}

export function defaultExecutionPolicy(mode: TaskExecutionMode): TaskExecutionPolicy {
  return {
    mode,
    timeoutSeconds: mode === "resident" ? null : 3600,
    concurrency: mode === "resident" ? "replace" : "forbid",
    retry: { maxAttempts: 1, backoffSeconds: 30, backoffStrategy: "fixed" },
    misfire: "coalesce",
    restart: mode === "resident" ? { enabled: true, maxRestarts: 20, backoffSeconds: 5, restartWindowSeconds: null } : null,
  };
}

export function defaultTrigger(type: TaskTriggerType): TaskTrigger {
  switch (type) {
    case "once":
      return { type, at: nextRoundedLocalTime(), timeZone: defaultTimeZone() };
    case "interval":
      return { type, seconds: 3600 };
    case "cron":
      return { type, expression: "0 2 * * *", timeZone: defaultTimeZone() };
    case "startup":
      return { type: "startup" };
    case "manual":
      return { type: "manual" };
  }
}

/** Next full hour as a local "YYYY-MM-DDTHH:mm" draft value for once triggers. */
function nextRoundedLocalTime(): string {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + 1);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export interface TaskDraftContext {
  provider: SchedulerTaskProviderDescriptor;
  trigger: SchedulerTaskTriggerContribution;
  /** Logical identity default name: provider · trigger · connection (ADR §2.1). */
  connectionName?: string;
}

/** New task draft for a discovered provider trigger; created disabled (same rule as Copy/Import). */
export function newTaskDraft(context: TaskDraftContext): TaskDefinition {
  const mode = modeForTrigger(context.trigger);
  const now = new Date().toISOString();
  const fields = context.trigger.fields ?? [];
  const values: SchedulerFormValues = defaultFormValues(fields);
  return {
    id: uuid(),
    name: defaultTaskName(context),
    providerType: "plugin",
    providerId: context.provider.providerId,
    target: { connectionId: "", pluginId: context.provider.pluginId, resourceId: null },
    trigger: defaultTrigger("manual"),
    execution: defaultExecutionPolicy(mode),
    configVersion: 1,
    config: withStoredTriggerId(configFromFormValues(fields, values), context.provider, context.trigger),
    enabled: false,
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    version: 1,
  };
}

/** `SSH Execute · prod-web-01` style identity name (plan §70). */
export function defaultTaskName(context: TaskDraftContext): string {
  const parts = [context.provider.label, context.trigger.label];
  if (context.connectionName) parts.push(context.connectionName);
  return parts.join(" · ");
}

export function draftFormValues(draft: TaskDefinition, trigger: SchedulerTaskTriggerContribution | undefined): SchedulerFormValues {
  const fields = trigger?.fields ?? [];
  return { ...defaultFormValues(fields), ...(configToFormValues(fields, draft.config) as SchedulerFormValues) };
}

function configToFormValues(fields: readonly import("@/types/database").PluginFormField[], config: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const stored = config?.[field.key];
    if (stored !== undefined && stored !== null) values[field.key] = stored;
  }
  return values;
}

/** Run status → badge variant mapping for list rendering. */
export function runStatusBadgeVariant(status: TaskRunStatus): "default" | "secondary" | "destructive" | "outline" {
  if (status === "success") return "default";
  if (status === "failed" || status === "timeout") return "destructive";
  if (status === "running" || status === "starting" || status === "queued") return "secondary";
  return "outline";
}

export const ACTIVE_RUN_STATUSES: readonly TaskRunStatus[] = ["queued", "starting", "running"];

export function isActiveRunStatus(status: TaskRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

/** Duration string between two RFC3339 instants, empty when incomplete. */
export function runDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt || !completedAt) return "";
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
