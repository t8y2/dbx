import type { WebDavConfig } from "@/lib/backend/api";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const WEB_DAV_AUTO_UPLOAD_STORAGE_KEYS = ["dbx-webdav-endpoint", "dbx-webdav-username", "dbx-webdav-remote-path", "dbx-webdav-auto-upload-enabled", "dbx-webdav-auto-upload-interval-minutes"] as const;

export const DEFAULT_WEB_DAV_REMOTE_PATH = "DBX/sync/snapshot.json";
export const DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES = 30;

export interface WebDavAutoUploadConfig {
  enabled: boolean;
  intervalMinutes: number;
  webDavConfig: WebDavConfig | null;
}

export function normalizedWebDavAutoUploadInterval(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES;
  return Math.max(1, Math.min(1440, Math.round(numberValue)));
}

export function readWebDavAutoUploadConfig(): WebDavAutoUploadConfig {
  const endpoint = safeLocalStorageGet("dbx-webdav-endpoint")?.trim() || "";
  const username = safeLocalStorageGet("dbx-webdav-username")?.trim() || "";
  const remotePath = safeLocalStorageGet("dbx-webdav-remote-path")?.trim() || DEFAULT_WEB_DAV_REMOTE_PATH;

  return {
    enabled: safeLocalStorageGet("dbx-webdav-auto-upload-enabled") === "true",
    intervalMinutes: normalizedWebDavAutoUploadInterval(safeLocalStorageGet("dbx-webdav-auto-upload-interval-minutes")),
    webDavConfig: endpoint
      ? {
          endpoint,
          username: username || undefined,
          remotePath,
        }
      : null,
  };
}

export function writeWebDavAutoUploadFields(config: WebDavConfig, autoUpload: { enabled: boolean; intervalMinutes: unknown }) {
  safeLocalStorageSet("dbx-webdav-endpoint", config.endpoint.trim());
  safeLocalStorageSet("dbx-webdav-username", config.username?.trim() || "");
  safeLocalStorageSet("dbx-webdav-remote-path", config.remotePath?.trim() || DEFAULT_WEB_DAV_REMOTE_PATH);
  safeLocalStorageSet("dbx-webdav-auto-upload-enabled", String(autoUpload.enabled));
  safeLocalStorageSet("dbx-webdav-auto-upload-interval-minutes", String(normalizedWebDavAutoUploadInterval(autoUpload.intervalMinutes)));
}
