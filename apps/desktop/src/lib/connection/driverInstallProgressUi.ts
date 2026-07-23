export interface DriverInstallProgress {
  step: string;
  downloaded?: number;
  total?: number;
  db_type?: string;
}

export interface DriverInstallProgressTargetState {
  installing: string | null;
  upgradingAll: boolean;
  progress: DriverInstallProgress | null;
}

export type DriverInstallProgressChannel = "agent" | "jdbc-plugin";

const AGENT_PROGRESS_STEPS = new Set(["driver", "jre", "jre-extract", "all-done"]);

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

export function driverInstallProgressPercent(progress: DriverInstallProgress | null): number | null {
  if (!progress?.total || progress.total <= 0) return null;
  const percent = Math.round(((progress.downloaded ?? 0) / progress.total) * 100);
  return Math.min(100, Math.max(0, percent));
}

export function isDriverInstallProgressTarget(dbType: string, state: DriverInstallProgressTargetState): boolean {
  if (state.installing === dbType) return true;
  return state.upgradingAll && state.progress?.db_type === dbType;
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
