import type { ConnectionConfig, InstalledPlugin } from "@/types/database";

export const S3_SYNC_PLUGIN_ID = "io.github.t8y2.s3";
export const S3_SYNC_CONNECTION_PROVIDER_ID = "io.github.t8y2.s3.connection";
export const DEFAULT_S3_SYNC_REMOTE_PATH = "DBX/sync/snapshot.json";

export function hasS3SyncPlugin(plugins: readonly InstalledPlugin[]): boolean {
  return plugins.some((plugin) => plugin.manifest.id === S3_SYNC_PLUGIN_ID && plugin.compatibility.compatible);
}

export function s3SyncConnections(connections: readonly ConnectionConfig[]): ConnectionConfig[] {
  return connections
    .filter((connection) => connection.db_type === "plugin" && connection.plugin_id === S3_SYNC_PLUGIN_ID && connection.plugin_connection_provider === S3_SYNC_CONNECTION_PROVIDER_ID && connection.plugin_connection_type === "s3")
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function fixedS3Bucket(connection?: ConnectionConfig): string {
  return connection?.database?.trim() || "";
}

export function s3SyncObjectUri(bucket: string, remotePath: string): string {
  const normalizedBucket = bucket.trim();
  const normalizedPath = remotePath.trim().split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return normalizedBucket && normalizedPath ? `s3://${normalizedBucket}/${normalizedPath}` : "";
}
