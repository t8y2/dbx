export const TIMEOUT_INHERITANCE_BACKUP_STORAGE_KEY = "dbx-timeout-inheritance-backup-v1";

export interface TimeoutInheritanceBackup {
  version: 1;
  globalConnectTimeoutSecs: number;
  globalQueryTimeoutSecs: number;
  connectSnapshots: Record<string, number>;
  querySnapshots: Record<string, number>;
}

function normalizeSnapshots(value: unknown, min: number): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const snapshots: Record<string, number> = {};
  for (const [id, timeout] of Object.entries(value)) {
    if (!id.trim() || typeof timeout !== "number" || !Number.isFinite(timeout)) continue;
    snapshots[id] = Math.min(300, Math.max(min, Math.round(timeout)));
  }
  return snapshots;
}

export function loadTimeoutInheritanceBackup(): TimeoutInheritanceBackup | null {
  try {
    const raw = localStorage.getItem(TIMEOUT_INHERITANCE_BACKUP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TimeoutInheritanceBackup>;
    if (parsed.version !== 1) return null;
    const globalConnectTimeoutSecs = Number(parsed.globalConnectTimeoutSecs);
    const globalQueryTimeoutSecs = Number(parsed.globalQueryTimeoutSecs);
    if (!Number.isFinite(globalConnectTimeoutSecs) || !Number.isFinite(globalQueryTimeoutSecs)) return null;
    return {
      version: 1,
      globalConnectTimeoutSecs: Math.min(300, Math.max(1, Math.round(globalConnectTimeoutSecs))),
      globalQueryTimeoutSecs: Math.min(300, Math.max(0, Math.round(globalQueryTimeoutSecs))),
      connectSnapshots: normalizeSnapshots(parsed.connectSnapshots, 1),
      querySnapshots: normalizeSnapshots(parsed.querySnapshots, 0),
    };
  } catch {
    return null;
  }
}

export function saveTimeoutInheritanceBackup(backup: TimeoutInheritanceBackup): void {
  try {
    localStorage.setItem(TIMEOUT_INHERITANCE_BACKUP_STORAGE_KEY, JSON.stringify(backup));
  } catch {
    // Settings persistence remains the primary source when local storage is unavailable.
  }
}
