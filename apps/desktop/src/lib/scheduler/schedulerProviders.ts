// ---------------------------------------------------------------------------
// Task provider discovery (plan §46–50). Providers come from installed plugin
// manifests (`task-provider` contributions) plus nothing else — the UI must not
// hardcode `io.dbx.ssh.tasks`, `io.dbx.files.tasks` or any other provider id.
// `dbx.database-backup` arrives through the same discovery channel once the
// builtin registry is exposed over the API; until then it is described purely
// structurally (provider id + trigger ids), never by business fields.
// ---------------------------------------------------------------------------

import type { InstalledPlugin, PluginFormField } from "@/types/database";
import { CONSISTENT_BACKUP_DATABASE_TYPES } from "@/lib/backup/scheduledDatabaseBackup";
import type { SchedulerTaskProviderDescriptor, SchedulerTaskTriggerContribution, TaskDefinition, TaskHealth, TaskProviderType, TaskTrigger } from "./schedulerTypes";

interface ContributionLike {
  type?: unknown;
  id?: unknown;
  label?: unknown;
  connection_providers?: unknown;
  allow_multiple_connections?: unknown;
  capabilities?: unknown;
  triggers?: unknown;
}

function isTaskProviderContribution(contribution: ContributionLike): boolean {
  return contribution.type === "task-provider" && typeof contribution.id === "string" && typeof (contribution as { label?: unknown }).label === "string";
}

/** Manifests keep snake_case on the wire (`allow_multiple_connections`). */
function allowsMultipleConnections(raw: unknown): boolean {
  return raw === true;
}

function normalizeTriggers(raw: unknown): SchedulerTaskTriggerContribution[] {
  if (!Array.isArray(raw)) return [];
  const triggers: SchedulerTaskTriggerContribution[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const trigger = item as Partial<SchedulerTaskTriggerContribution>;
    if (typeof trigger.id !== "string" || typeof trigger.label !== "string") continue;
    triggers.push({
      id: trigger.id,
      label: trigger.label,
      mode: trigger.mode === "resident" ? "resident" : "run",
      risk: trigger.risk === "medium" || trigger.risk === "high" ? trigger.risk : "low",
      fields: Array.isArray(trigger.fields) ? (trigger.fields as PluginFormField[]) : [],
    });
  }
  return triggers;
}

function normalizeCapabilities(raw: unknown): SchedulerTaskProviderDescriptor["capabilities"] {
  if (!Array.isArray(raw)) return [];
  const known = ["run", "resident", "cancel", "logs", "progress", "artifacts"] as const;
  return raw.filter((item): item is (typeof known)[number] => typeof item === "string" && (known as readonly string[]).includes(item));
}

/**
 * The builtin database-backup provider (ADR §8), described structurally —
 * provider id + supported connection types + the single run trigger — the same
 * shape a plugin contribution produces. Migration moves every legacy backup
 * schedule onto this provider id, so the task center must recognize it even
 * with no plugins installed. It is excluded from the create dialog: new backup
 * schedules are still created in the backup settings during the migration
 * window (plan §41–45).
 */
export function builtinTaskProviders(label: string): SchedulerTaskProviderDescriptor[] {
  return [
    {
      providerId: "dbx.database-backup",
      label,
      pluginId: "dbx",
      connectionProviders: [...CONSISTENT_BACKUP_DATABASE_TYPES],
      capabilities: ["run", "cancel", "logs", "progress", "artifacts"],
      triggers: [{ id: "backup", label, mode: "run", risk: "low", fields: [] }],
      builtin: true,
    },
  ];
}

/**
 * Reads every installed plugin manifest and returns the task providers it
 * declares. Unreadable contributions are skipped: a malformed third-party
 * manifest must not break the whole task center.
 */
export function discoverTaskProviders(plugins: readonly InstalledPlugin[] | undefined): SchedulerTaskProviderDescriptor[] {
  const providers: SchedulerTaskProviderDescriptor[] = [];
  for (const plugin of plugins ?? []) {
    for (const contribution of plugin.manifest?.contributions ?? []) {
      if (!contribution || typeof contribution !== "object") continue;
      const candidate = contribution as ContributionLike;
      if (!isTaskProviderContribution(candidate)) continue;
      const providerId = candidate.id as string;
      const label = candidate.label as string;
      providers.push({
        providerId,
        label: label.length > 0 ? label : providerId,
        pluginId: plugin.manifest.id,
        // Contributions keep the manifest's snake_case on the wire, like every
        // other plugin contribution (`database_type`, `filesystem_provider`).
        connectionProviders: Array.isArray(candidate.connection_providers) ? candidate.connection_providers.filter((id): id is string => typeof id === "string") : [],
        allowMultipleConnections: allowsMultipleConnections(candidate.allow_multiple_connections),
        capabilities: normalizeCapabilities(candidate.capabilities),
        triggers: normalizeTriggers(candidate.triggers),
      });
    }
  }
  return providers;
}

/** Trigger id = `<provider id>/<trigger id>` (ADR §2.2). */
export function triggerId(providerId: string, trigger: SchedulerTaskTriggerContribution): string {
  return `${providerId}/${trigger.id}`;
}

export function splitTriggerId(fullTriggerId: string): { providerId: string; triggerId: string } {
  const separator = fullTriggerId.indexOf("/");
  if (separator < 0) return { providerId: fullTriggerId, triggerId: "" };
  return { providerId: fullTriggerId.slice(0, separator), triggerId: fullTriggerId.slice(separator + 1) };
}

export function findProvider(providers: readonly SchedulerTaskProviderDescriptor[], providerId: string | undefined | null): SchedulerTaskProviderDescriptor | undefined {
  if (!providerId) return undefined;
  return providers.find((provider) => provider.providerId === providerId);
}

export function findTrigger(provider: SchedulerTaskProviderDescriptor | undefined, fullTriggerId: string | undefined | null): SchedulerTaskTriggerContribution | undefined {
  const { triggerId } = splitTriggerId(fullTriggerId || "");
  if (!provider) return undefined;
  if (!triggerId && provider.triggers.length === 1) return provider.triggers[0];
  return provider.triggers.find((candidate) => candidate.id === triggerId);
}

// ---------------------------------------------------------------------------
// Health (ADR §2.8). UI-side projection for badges; the backend stays the
// source of truth and non-healthy tasks are never auto-deleted anywhere.
// ---------------------------------------------------------------------------

export interface TaskHealthContext {
  providers: readonly SchedulerTaskProviderDescriptor[];
  connectionIds: ReadonlySet<string>;
}

/**
 * Projects a task's health from what the UI can see:
 * - provider missing from discovery → `unavailable` (plugin uninstalled);
 * - trigger missing / execution mode mismatching the declared trigger mode → `invalid`;
 * - bound connection missing from the store → `warning`;
 * - otherwise → `healthy`.
 */
export function taskHealth(task: Pick<TaskDefinition, "providerId" | "providerType" | "trigger" | "execution" | "target" | "config">, context: TaskHealthContext): TaskHealth {
  const provider = findProvider(context.providers, task.providerId);
  if (!provider) return "unavailable";
  const { triggerId: localTriggerId } = splitTriggerId(taskTriggerIdOf(task));
  const declared = localTriggerId ? provider.triggers.find((candidate) => candidate.id === localTriggerId) : provider.triggers[0];
  if (provider.triggers.length > 0 && !declared) return "invalid";
  if (declared && declared.mode !== task.execution.mode) return "invalid";
  const connectionId = task.target?.connectionId;
  if (connectionId && !context.connectionIds.has(connectionId)) return "warning";
  return "healthy";
}

/**
 * The full trigger id a task was created with (`<providerId>/<triggerId>`).
 *
 * The frozen TaskDefinition has no trigger-id column (ADR §2.1), so for
 * providers that declare more than one trigger the editor persists the chosen
 * trigger id inside `config` under this reserved host key — the only
 * host-owned, non-provider key it ever writes. Single-trigger providers need
 * no key: their sole trigger is the answer.
 */
const TASK_TRIGGER_ID_KEY = "__triggerId";

export function storedTriggerId(config: Record<string, unknown> | undefined | null): string | undefined {
  const value = config?.[TASK_TRIGGER_ID_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function withStoredTriggerId(config: Record<string, unknown>, provider: SchedulerTaskProviderDescriptor | undefined, trigger: SchedulerTaskTriggerContribution | undefined): Record<string, unknown> {
  const next = { ...config };
  if (provider && trigger && provider.triggers.length > 1) next[TASK_TRIGGER_ID_KEY] = triggerId(provider.providerId, trigger);
  else delete next[TASK_TRIGGER_ID_KEY];
  return next;
}

/** Full trigger id of a task: stored key first, bare provider id otherwise. */
function taskTriggerIdOf(task: Pick<TaskDefinition, "providerId" | "config">): string {
  return storedTriggerId(task.config) || task.providerId;
}

// ---------------------------------------------------------------------------
// Cron / once display helpers. Timezones are IANA names persisted on the
// trigger itself (ADR §2.4: never kept in UI-local state, never inferred back).
// ---------------------------------------------------------------------------

export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Compact display form of a trigger for list rows ("Cron 0 2 * * * · Asia/Shanghai"). */
export function triggerSummary(trigger: TaskTrigger): string {
  switch (trigger.type) {
    case "manual":
      return "Manual";
    case "startup":
      return "Startup";
    case "interval": {
      const minutes = trigger.seconds / 60;
      return Number.isInteger(minutes) && minutes > 0 ? `Every ${minutes} min` : `Every ${trigger.seconds} s`;
    }
    case "once":
      return `Once · ${trigger.at}${trigger.timeZone ? ` · ${trigger.timeZone}` : ""}`;
    case "cron":
      return `Cron ${trigger.expression}${trigger.timeZone ? ` · ${trigger.timeZone}` : ""}`;
  }
}

export function providerTypeLabel(providerType: TaskProviderType): string {
  return providerType === "builtin" ? "Builtin" : "Plugin";
}
