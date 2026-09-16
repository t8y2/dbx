export interface DriverInstallProgress {
  operation_id?: string;
  step: string;
  downloaded?: number;
  total?: number;
  db_type?: string;
  /** Number of drivers completed so far during a batch upgrade (1-based). */
  completed?: number;
  /** Total drivers in the batch. */
  total_drivers?: number;
}

export interface DriverInstallProgressTargetState {
  installing: string | null;
  upgradingAll: boolean;
  progressMap: Record<string, DriverInstallProgress | null | undefined>;
}

export interface DriverInstallCancellationTargetState {
  activeOperationId: string | null;
  cancellableDbType: string | null;
  upgradingAll: boolean;
  progressMap: Record<string, DriverInstallProgress | null | undefined>;
}

export type DriverInstallProgressChannel = "agent" | "jdbc-plugin";

const AGENT_PROGRESS_STEPS = new Set(["driver", "jre", "jre-extract", "all-done"]);

/** Substring the backend uses for a user-cancelled driver install/upgrade. */
const AGENT_DOWNLOAD_CANCELED_ERROR = "Agent download canceled by user.";

/**
 * True when a driver-install error is a user cancel rather than a genuine
 * failure. Callers use this to close install modals silently and to avoid
 * reporting a cancelled driver/upgrade as failed.
 */
export function isDriverInstallCanceledError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String((error as { message?: string } | null)?.message ?? error ?? "");
  return message.includes(AGENT_DOWNLOAD_CANCELED_ERROR);
}

export function isDriverInstallProgressForOperation(progress: DriverInstallProgress, operationId: string | null): boolean {
  // Keep accepting legacy unscoped events, while preventing another active
  // install's terminal/progress event from mutating this dialog.
  return !progress.operation_id || progress.operation_id === operationId;
}

/** How an agent install promise settled relative to the dialog's state. */
export interface AgentInstallOperationContext {
  /** Operation id captured when the install promise was created. */
  operationId: string;
  /** Operation id the dialog is currently tracking (null once finished). */
  currentOperationId: string | null;
  /** Whether the user pressed Cancel on the dialog's tracked operation. */
  cancelRequested: boolean;
}

export type AgentInstallOutcome = { kind: "succeeded"; ownsState: boolean } | { kind: "cancelled"; ownsState: boolean } | { kind: "failed"; ownsState: boolean };

export type AgentInstallCancelRequestResult = { ok: true } | { ok: false; error: unknown };

/**
 * Classify the settlement of an agent install operation promise. When the
 * dialog no longer tracks the promise's operation id (the user cancelled and
 * immediately retried, so a newer operation owns the state), `ownsState` is
 * false and the stale promise must not finish/fail the new operation's UI.
 */
export function resolveAgentInstallOutcome(result: { ok: true } | { ok: false; error: unknown }, context: AgentInstallOperationContext): AgentInstallOutcome {
  const ownsState = context.currentOperationId === context.operationId;
  if (result.ok) return { kind: "succeeded", ownsState };
  if (isDriverInstallCanceledError(result.error) || context.cancelRequested) {
    return { kind: "cancelled", ownsState };
  }
  return { kind: "failed", ownsState };
}

export async function requestAgentInstallCancellation(request: () => Promise<void>): Promise<AgentInstallCancelRequestResult> {
  try {
    await request();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function driverInstallProgressChannel(progress: DriverInstallProgress): DriverInstallProgressChannel | null {
  if (progress.step === "jdbc-plugin" || progress.step === "jdbc-plugin-extract") return "jdbc-plugin";
  if (progress.db_type || AGENT_PROGRESS_STEPS.has(progress.step)) return "agent";
  // Legacy "done" events have no owner, so the operation promise must clear its own channel.
  return null;
}

export function updateDriverInstallProgress(current: DriverInstallProgress | null, incoming: DriverInstallProgress, channel: DriverInstallProgressChannel): DriverInstallProgress | null {
  if (driverInstallProgressChannel(incoming) !== channel) return current;
  if (incoming.step === "done" || incoming.step === "all-done") return null;
  return incoming;
}

/**
 * Update a per-driver progress map with an incoming event.
 * Returns the updated map (mutated in-place — returned for convenience).
 */
export function updatePerDriverProgress(progressMap: Record<string, DriverInstallProgress | null | undefined>, incoming: DriverInstallProgress): Record<string, DriverInstallProgress | null | undefined> {
  if (incoming.step === "all-done") {
    // Batch completion has no db_type, so it must be handled before routing.
    for (const key of Object.keys(progressMap)) {
      progressMap[key] = null;
    }
    return progressMap;
  }

  const dbType = incoming.db_type;
  if (!dbType) return progressMap;
  progressMap[dbType] = incoming.step === "done" ? null : incoming;
  return progressMap;
}

export function driverInstallProgressPercent(progress: DriverInstallProgress | null | undefined): number | null {
  if (!progress?.total || progress.total <= 0) return null;
  const percent = Math.round(((progress.downloaded ?? 0) / progress.total) * 100);
  return Math.min(100, Math.max(0, percent));
}

export function isDriverInstallProgressTarget(dbType: string, state: DriverInstallProgressTargetState): boolean {
  if (state.installing === dbType) return true;
  if (!state.upgradingAll) return false;
  // During batch upgrade, check the per-driver map — the driver is "active"
  // if it has a (non-null, non-"done") progress entry.
  const progress = state.progressMap[dbType];
  return progress !== null && progress !== undefined;
}

export function isDriverInstallCancellationTarget(dbType: string, state: DriverInstallCancellationTargetState): boolean {
  if (!state.activeOperationId) return false;
  if (!state.upgradingAll) return state.cancellableDbType === dbType;
  const progress = state.progressMap[dbType];
  return progress !== null && progress !== undefined;
}

export function addDriverInstallQueue(queue: string[], dbType: string, activeDbType: string | null): string[] {
  if (activeDbType === dbType || queue.includes(dbType)) return queue;
  return [...queue, dbType];
}

export function removeDriverInstallQueue(queue: string[], dbType: string): string[] {
  return queue.filter((queuedDbType) => queuedDbType !== dbType);
}

export function takeNextDriverInstallQueue(queue: string[], isInstallable: (dbType: string) => boolean): { next: string | null; queue: string[] } {
  const remaining = [...queue];
  while (remaining.length > 0) {
    const next = remaining.shift() ?? null;
    if (next && isInstallable(next)) {
      return { next, queue: remaining };
    }
  }
  return { next: null, queue: [] };
}
