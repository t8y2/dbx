import type { S3SyncConfig } from "@/lib/backend/api";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export const DEFAULT_S3_REGION = "us-east-1";
export const DEFAULT_S3_OBJECT_KEY = "DBX/sync/snapshot.json";
export const DEFAULT_S3_AUTO_UPLOAD_INTERVAL_MINUTES = 30;

export const S3_AUTO_UPLOAD_STORAGE_KEYS = ["dbx-s3-endpoint", "dbx-s3-region", "dbx-s3-bucket", "dbx-s3-access-key-id", "dbx-s3-object-key", "dbx-s3-addressing-style", "dbx-s3-auto-upload-enabled", "dbx-s3-auto-upload-interval-minutes"] as const;

export interface S3AutoUploadConfig {
  enabled: boolean;
  intervalMinutes: number;
  s3Config: S3SyncConfig | null;
}

export function normalizedS3AutoUploadInterval(value: unknown): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return DEFAULT_S3_AUTO_UPLOAD_INTERVAL_MINUTES;
  return Math.max(1, Math.min(1440, Math.round(numberValue)));
}

export function readS3AutoUploadConfig(): S3AutoUploadConfig {
  const endpoint = safeLocalStorageGet("dbx-s3-endpoint")?.trim() || "";
  const region = safeLocalStorageGet("dbx-s3-region")?.trim() || DEFAULT_S3_REGION;
  const bucket = safeLocalStorageGet("dbx-s3-bucket")?.trim() || "";
  const accessKeyId = safeLocalStorageGet("dbx-s3-access-key-id")?.trim() || "";
  const objectKey = safeLocalStorageGet("dbx-s3-object-key")?.trim() || DEFAULT_S3_OBJECT_KEY;
  const addressingStyle = safeLocalStorageGet("dbx-s3-addressing-style");

  return {
    enabled: safeLocalStorageGet("dbx-s3-auto-upload-enabled") === "true",
    intervalMinutes: normalizedS3AutoUploadInterval(safeLocalStorageGet("dbx-s3-auto-upload-interval-minutes")),
    s3Config:
      bucket && accessKeyId
        ? {
            endpoint: endpoint || undefined,
            region,
            bucket,
            accessKeyId,
            objectKey,
            addressingStyle: addressingStyle === "path" || addressingStyle === "virtualHosted" ? addressingStyle : endpoint ? "path" : "virtualHosted",
          }
        : null,
  };
}

export function writeS3AutoUploadFields(config: S3SyncConfig, autoUpload: { enabled: boolean; intervalMinutes: unknown }) {
  safeLocalStorageSet("dbx-s3-endpoint", config.endpoint?.trim() || "");
  safeLocalStorageSet("dbx-s3-region", config.region.trim() || DEFAULT_S3_REGION);
  safeLocalStorageSet("dbx-s3-bucket", config.bucket.trim());
  safeLocalStorageSet("dbx-s3-access-key-id", config.accessKeyId?.trim() || "");
  safeLocalStorageSet("dbx-s3-object-key", config.objectKey?.trim() || DEFAULT_S3_OBJECT_KEY);
  safeLocalStorageSet("dbx-s3-addressing-style", config.addressingStyle || (config.endpoint?.trim() ? "path" : "virtualHosted"));
  safeLocalStorageSet("dbx-s3-auto-upload-enabled", String(autoUpload.enabled));
  safeLocalStorageSet("dbx-s3-auto-upload-interval-minutes", String(normalizedS3AutoUploadInterval(autoUpload.intervalMinutes)));
}
