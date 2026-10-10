import type { SyncSelection, WebDavConfig } from "@/lib/backend/api";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const WEB_DAV_BACKUP_SELECTION_STORAGE_KEY = "dbx-webdav-backup-selection";
export const SYNC_METHOD_STORAGE_KEY = "dbx-sync-method";
export const WEB_DAV_AUTO_UPLOAD_STORAGE_KEYS = ["dbx-webdav-endpoint", "dbx-webdav-username", "dbx-webdav-user-agent", "dbx-webdav-remote-path", "dbx-webdav-auto-upload-enabled", "dbx-webdav-auto-upload-interval-minutes", WEB_DAV_BACKUP_SELECTION_STORAGE_KEY] as const;

export const DEFAULT_WEB_DAV_REMOTE_PATH = "DBX/sync/snapshot.json";
export const DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES = 30;
export const MAX_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES = 365 * 24 * 60;

export type SyncMethod = "webdav" | "snippet" | "local";

export function readSyncMethod(): SyncMethod {
  const value = safeLocalStorageGet(SYNC_METHOD_STORAGE_KEY);
  return value === "snippet" || value === "local" ? value : "webdav";
}

export function writeSyncMethod(value: SyncMethod) {
  safeLocalStorageSet(SYNC_METHOD_STORAGE_KEY, value);
}

export interface WebDavAutoUploadConfig {
  enabled: boolean;
  intervalMinutes: number;
  webDavConfig: WebDavConfig | null;
}

export function normalizedWebDavAutoUploadInterval(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES;
  return Math.max(1, Math.min(MAX_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES, Math.round(numberValue)));
}

export interface WebDavAutoUploadIntervalUnits {
  minute: string;
  hour: string;
  day: string;
}

export interface FormattedWebDavAutoUploadInterval {
  interval: string;
  approximate: boolean;
}

export function formatWebDavAutoUploadInterval(value: unknown, locale: string, units: WebDavAutoUploadIntervalUnits): FormattedWebDavAutoUploadInterval {
  const minutes = normalizedWebDavAutoUploadInterval(value);
  const formatNumber = (number: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(number);
  const formatHours = (hourMinutes: number) => {
    const hours = hourMinutes / 60;
    const roundedHours = Math.round(hours * 100) / 100;
    return {
      interval: `${formatNumber(roundedHours)} ${units.hour}`,
      approximate: Math.abs(hours - roundedHours) > Number.EPSILON,
    };
  };

  if (minutes < 60) {
    return { interval: `${formatNumber(minutes)} ${units.minute}`, approximate: false };
  }
  if (minutes < 24 * 60) {
    return formatHours(minutes);
  }

  const days = Math.floor(minutes / (24 * 60));
  const remainingMinutes = minutes % (24 * 60);
  if (remainingMinutes === 0) {
    return { interval: `${formatNumber(days)} ${units.day}`, approximate: false };
  }
  const remainingHours = formatHours(remainingMinutes);
  return {
    interval: `${formatNumber(days)} ${units.day} ${remainingHours.interval}`,
    approximate: remainingHours.approximate,
  };
}

export function readWebDavAutoUploadConfig(): WebDavAutoUploadConfig {
  const endpoint = safeLocalStorageGet("dbx-webdav-endpoint")?.trim() || "";
  const username = safeLocalStorageGet("dbx-webdav-username")?.trim() || "";
  const userAgent = safeLocalStorageGet("dbx-webdav-user-agent")?.trim() || "";
  const remotePath = safeLocalStorageGet("dbx-webdav-remote-path")?.trim() || DEFAULT_WEB_DAV_REMOTE_PATH;

  return {
    enabled: safeLocalStorageGet("dbx-webdav-auto-upload-enabled") === "true",
    intervalMinutes: normalizedWebDavAutoUploadInterval(safeLocalStorageGet("dbx-webdav-auto-upload-interval-minutes")),
    webDavConfig: endpoint
      ? {
          endpoint,
          username: username || undefined,
          userAgent: userAgent || undefined,
          remotePath,
        }
      : null,
  };
}

export function writeWebDavAutoUploadFields(config: WebDavConfig, autoUpload: { enabled: boolean; intervalMinutes: unknown }) {
  safeLocalStorageSet("dbx-webdav-endpoint", config.endpoint.trim());
  safeLocalStorageSet("dbx-webdav-username", config.username?.trim() || "");
  safeLocalStorageSet("dbx-webdav-user-agent", config.userAgent?.trim() || "");
  safeLocalStorageSet("dbx-webdav-remote-path", config.remotePath?.trim() || DEFAULT_WEB_DAV_REMOTE_PATH);
  safeLocalStorageSet("dbx-webdav-auto-upload-enabled", String(autoUpload.enabled));
  safeLocalStorageSet("dbx-webdav-auto-upload-interval-minutes", String(normalizedWebDavAutoUploadInterval(autoUpload.intervalMinutes)));
}

export function readWebDavBackupSelection(): SyncSelection | undefined {
  const serialized = safeLocalStorageGet(WEB_DAV_BACKUP_SELECTION_STORAGE_KEY);
  if (!serialized) return undefined;
  try {
    const selection = JSON.parse(serialized) as SyncSelection;
    if (typeof selection !== "object" || selection === null || typeof selection.includeSecrets !== "boolean") return undefined;
    return selection;
  } catch {
    return undefined;
  }
}

export function writeWebDavBackupSelection(selection: SyncSelection) {
  safeLocalStorageSet(WEB_DAV_BACKUP_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("dbx:webdav-auto-upload-config-changed"));
}
