import type { ConnectionConfig } from "@/types/database";
import { CONNECTION_PROFILES, type ConnectionProfileDefinition } from "@/types/generated/connectionProfiles";
import { databaseManifestEntry, supportsDatabaseCompareMode, type DatabaseCompareMode } from "@/lib/database/databaseDriverManifest";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

export type { DatabaseCompareMode } from "@/lib/database/databaseDriverManifest";

export function supportsDatabaseCompare(connection: ConnectionConfig | undefined, mode: DatabaseCompareMode): boolean {
  if (!connection) return false;
  const type = effectiveDatabaseTypeForConnection(connection);
  return supportsDatabaseCompareMode(type, mode);
}

const profiles: Readonly<Record<string, ConnectionProfileDefinition>> = CONNECTION_PROFILES;

export function compareConnectionType(connection: ConnectionConfig): { value: string; label: string } {
  const profile = connection.driver_profile;
  const definition = profile ? profiles[profile] : undefined;
  if (profile && definition && definition.type === connection.db_type) {
    return { value: profile, label: definition.label };
  }
  // JDBC remains a distinct connection type, with a product-specific profile
  // when present. Native legacy configs without a profile fall back to db_type.
  if (connection.db_type === "jdbc" && profile) {
    return {
      value: `jdbc:${profile}`,
      label: connection.driver_label || `${databaseManifestEntry(effectiveDatabaseTypeForConnection(connection))?.label || profile} (JDBC)`,
    };
  }
  return { value: connection.db_type, label: databaseManifestEntry(connection.db_type)?.label || connection.driver_label || connection.db_type };
}
