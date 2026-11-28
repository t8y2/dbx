import type { ManagedJdbcDriverDefinition } from "@/lib/database/managedJdbcDriver";

export const PHOENIX_COMPATIBILITY_RUNTIME_ID = "phoenix-5.0-hbase-2.0-compat";
export const PHOENIX_COMPATIBILITY_VERSION = "5.0.0-dbx.1";
export const PHOENIX_COMPATIBILITY_COORDINATE = "app.dbx.compat:phoenix-hbase-2.0:5.0.0-dbx.1";
export const PHOENIX_COMPATIBILITY_ARTIFACT_NAMES = ["phoenix-5.0.0-HBase-2.0-client.jar", "zookeeper-3.4.10.jar"] as const;
export const PHOENIX_COMPATIBILITY_LABEL_KEY = "connection.phoenixCompatibilityRuntime";

export const PHOENIX_COMPATIBILITY_MANAGED_DRIVER: ManagedJdbcDriverDefinition = {
  id: PHOENIX_COMPATIBILITY_RUNTIME_ID,
  label: "Phoenix 5.0 / HBase 2.0 (DBX compatibility build)",
  labelKey: PHOENIX_COMPATIBILITY_LABEL_KEY,
  version: PHOENIX_COMPATIBILITY_VERSION,
  jre: "21",
  requiredPluginCapabilities: ["jdbc.external-classpath-isolation-v1"],
  bundles: [{ coordinate: PHOENIX_COMPATIBILITY_COORDINATE, repositories: [], compatibilityRuntimeId: PHOENIX_COMPATIBILITY_RUNTIME_ID, requiredArtifactNames: PHOENIX_COMPATIBILITY_ARTIFACT_NAMES }],
};
