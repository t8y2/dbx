import type { DatabaseBackupExecutionConfig, DatabaseBackupRun, DatabaseBackupSchedule } from "./scheduledDatabaseBackup";

export interface DatabaseBackupSnapshot {
  schedules: DatabaseBackupSchedule[];
  runs: DatabaseBackupRun[];
  migrated: boolean;
  heartbeat: string | null;
  destinationRoot: string | null;
}

export type DatabaseBackupCommand =
  | { action: "snapshot" }
  | { action: "preview"; schedule: DatabaseBackupSchedule }
  | { action: "save"; schedule: DatabaseBackupSchedule }
  | { action: "deleteSchedule"; id: string }
  | { action: "migrate"; migration: { schedules: DatabaseBackupSchedule[]; runs: DatabaseBackupRun[] } }
  | { action: "run"; request: { scheduleId?: string; config?: DatabaseBackupExecutionConfig; displayName?: string; timeZone?: string } }
  | { action: "cancel"; id: string }
  | { action: "rename"; id: string; name: string }
  | { action: "deleteRuns"; ids: string[] };

export interface DatabaseBackupBackgroundStatus {
  enabled: boolean;
  platform: string;
}
