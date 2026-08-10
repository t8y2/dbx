import type { DesktopSettings } from "@/stores/settingsStore";

export interface S3SyncConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  objectKey?: string;
  addressingStyle?: "path" | "virtualHosted";
}

export interface S3CredentialsStatus {
  hasSavedCredentials: boolean;
}

export interface S3SyncSummary {
  bucket: string;
  objectKey: string;
  bytes: number;
  exportedAt?: string;
  appVersion?: string;
}

export interface S3DownloadResult {
  summary: S3SyncSummary;
  editorSettings?: unknown;
  desktopSettings: DesktopSettings;
  applySummary: {
    encryptedSecretsPresent: boolean;
    secretsApplied: boolean;
  };
}
