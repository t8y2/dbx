import type { JdbcMavenBundleInfo, JdbcPluginStatus } from "@/types/database";
import { PHOENIX_MANAGED_JDBC_DRIVER } from "@/lib/database/phoenixBuiltinDriver";
import { PRESTOSQL_MANAGED_JDBC_DRIVER } from "@/lib/database/prestoSqlBuiltinDriver";
import { createManagedJdbcDriverRegistry, installManagedJdbcDriver, managedJdbcDriverRow, uninstallManagedJdbcDriver, type ManagedJdbcDriverApi, type ManagedJdbcDriverDefinition, type ManagedJdbcDriverMutationResult } from "@/lib/database/managedJdbcDriver";

export const MANAGED_JDBC_DRIVERS = [PRESTOSQL_MANAGED_JDBC_DRIVER, PHOENIX_MANAGED_JDBC_DRIVER] as const satisfies readonly ManagedJdbcDriverDefinition[];

const managedJdbcDriverRegistry = createManagedJdbcDriverRegistry(MANAGED_JDBC_DRIVERS);

export function managedJdbcDriverDefinition(id: string): ManagedJdbcDriverDefinition | undefined {
  return managedJdbcDriverRegistry.byId.get(id);
}

export function isManagedJdbcDriver(id: string): boolean {
  return managedJdbcDriverRegistry.byId.has(id);
}

export function managedJdbcDriverRows(bundles: readonly JdbcMavenBundleInfo[], pluginStatus?: Pick<JdbcPluginStatus, "installed" | "compatible"> | null) {
  return MANAGED_JDBC_DRIVERS.map((definition) => managedJdbcDriverRow(definition, bundles, pluginStatus));
}

export async function installRegisteredManagedJdbcDriver(id: string, bundles: readonly JdbcMavenBundleInfo[], pluginStatus: Pick<JdbcPluginStatus, "installed" | "compatible"> | null | undefined, api: ManagedJdbcDriverApi): Promise<ManagedJdbcDriverMutationResult | undefined> {
  const definition = managedJdbcDriverDefinition(id);
  if (!definition) return undefined;
  return installManagedJdbcDriver(definition, bundles, pluginStatus, api);
}

export async function uninstallRegisteredManagedJdbcDriver(id: string, bundles: readonly JdbcMavenBundleInfo[], api: ManagedJdbcDriverApi): Promise<ManagedJdbcDriverMutationResult | undefined> {
  const definition = managedJdbcDriverDefinition(id);
  if (!definition) return undefined;
  return uninstallManagedJdbcDriver(definition, bundles, api);
}
