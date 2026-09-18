import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const PENDING_COMPONENT_UPDATES_STORAGE_KEY = "dbx:updates:pending-components-after-restart";

export interface PendingComponentUpdates {
  fromVersion: string;
  targetVersion: string;
}

export type UpdateAllAction = "none" | "download-app" | "defer-components" | "update-components";

function normalizeVersion(version: string): string {
  return version.trim().replace(/^[vV]/, "");
}

function parsePendingComponentUpdates(raw: string | null): PendingComponentUpdates | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingComponentUpdates>;
    const fromVersion = typeof parsed.fromVersion === "string" ? parsed.fromVersion.trim() : "";
    const targetVersion = typeof parsed.targetVersion === "string" ? parsed.targetVersion.trim() : "";
    return fromVersion ? { fromVersion, targetVersion } : null;
  } catch {
    return null;
  }
}

export function markPendingComponentUpdatesAfterAppUpdate(fromVersion: string, targetVersion: string): boolean {
  const normalizedFromVersion = fromVersion.trim();
  if (!normalizedFromVersion) return false;
  return safeLocalStorageSet(
    PENDING_COMPONENT_UPDATES_STORAGE_KEY,
    JSON.stringify({
      fromVersion: normalizedFromVersion,
      targetVersion: targetVersion.trim(),
    } satisfies PendingComponentUpdates),
  );
}

export function clearPendingComponentUpdatesAfterAppUpdate() {
  safeLocalStorageRemove(PENDING_COMPONENT_UPDATES_STORAGE_KEY);
}

export function takePendingComponentUpdatesAfterAppRestart(currentVersion: string): PendingComponentUpdates | null {
  const pending = parsePendingComponentUpdates(safeLocalStorageGet(PENDING_COMPONENT_UPDATES_STORAGE_KEY));
  if (!pending) {
    clearPendingComponentUpdatesAfterAppUpdate();
    return null;
  }
  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  if (!normalizedCurrentVersion || normalizedCurrentVersion === normalizeVersion(pending.fromVersion)) return null;
  clearPendingComponentUpdatesAfterAppUpdate();
  return pending;
}

export function resolveUpdateAllAction(options: { hasAppUpdate: boolean; appUpdateCanInstall: boolean; appUpdatePrepared: boolean; hasComponentUpdates: boolean }): UpdateAllAction {
  if (!options.hasAppUpdate || !options.appUpdateCanInstall) return options.hasComponentUpdates ? "update-components" : "none";
  return options.appUpdatePrepared ? "defer-components" : "download-app";
}
