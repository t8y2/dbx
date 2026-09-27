export type MigrationState = "pending" | "running" | "succeeded" | "failed" | "not_required";
export type MigrationKeyStatus = "ready" | "will_create" | "unavailable" | "invalid" | "mismatch" | "missing_for_ciphertext";
export interface MigrationPreflight {
  migrationId: string;
  state: MigrationState;
  needsMigration: boolean;
  keyProviderAvailable: boolean;
  keyStatus?: MigrationKeyStatus;
  keyCreationAllowed?: boolean;
  databasePlaintextCount: number;
  connectionCount: number;
  pluginSecretCount: number;
  aiSecretCount: number;
  tunnelSecretCount: number;
  syncCredentialCount: number;
  legacyJsonFiles: { name: string; exists: boolean; bytes: number }[];
  backupRequired: boolean;
  backupPath?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  dataDir?: string;
  backupDir?: string;
  keyFileConfigured?: boolean;
  keyFileReadable?: boolean;
  persistentKeyConfigured?: boolean;
  keySource?: "explicit_file" | "explicit_env" | "managed_data_dir" | "platform_store" | "unavailable" | string;
}
export interface MigrationReport {
  migrationId: string;
  state: MigrationState;
  backupPath?: string | null;
  databasePlaintextCount: number;
  legacyJsonFiles: string[];
  verifiedSecretCount: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}
