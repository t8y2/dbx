import type { ConnectionConfig } from "@/types/database";
import { PHOENIX_JDBC_PRODUCT_PROFILE } from "@/lib/database/phoenixConnection";
import { createJdbcProductProfileRegistry, ensureJdbcProductRuntimeDrivers, isJdbcProductRuntimeInstallError, jdbcProductProfileMatches, validateJdbcProductManagedDriver, type JdbcProductProfileDefinition, type JdbcProductRuntimeApi } from "@/lib/database/jdbcProductProfile";
import { managedJdbcDriverDefinition } from "@/lib/database/managedJdbcDrivers";

export const JDBC_PRODUCT_PROFILES = [PHOENIX_JDBC_PRODUCT_PROFILE] as const satisfies readonly JdbcProductProfileDefinition[];

const jdbcProductProfileRegistry = createJdbcProductProfileRegistry(JDBC_PRODUCT_PROFILES);
for (const profile of JDBC_PRODUCT_PROFILES) {
  validateJdbcProductManagedDriver(profile, managedJdbcDriverDefinition(profile.managedDriverId));
}

export function jdbcProductProfileDefinition(id: string): JdbcProductProfileDefinition | undefined {
  return jdbcProductProfileRegistry.byId.get(id);
}

export function jdbcProductProfileForConfig(config: Pick<ConnectionConfig, "db_type" | "driver_profile">): JdbcProductProfileDefinition | undefined {
  return JDBC_PRODUCT_PROFILES.find((profile) => jdbcProductProfileMatches(profile, config));
}

export function jdbcProductDriverProfiles() {
  return Object.fromEntries(
    JDBC_PRODUCT_PROFILES.map((profile) => [
      profile.id,
      {
        type: profile.match.dbType,
        port: profile.port,
        user: profile.user,
        label: profile.label,
        icon: profile.icon,
      },
    ]),
  );
}

export function jdbcProductPickerOptions() {
  return JDBC_PRODUCT_PROFILES.map((profile) => ({ value: profile.id, label: profile.label }));
}

export function jdbcProductIconTypes(): Record<string, string> {
  return Object.fromEntries(JDBC_PRODUCT_PROFILES.map((profile) => [profile.id, profile.icon]));
}

export function jdbcProductProfileIdsForCategory(category: string): string[] {
  return JDBC_PRODUCT_PROFILES.filter((profile) => profile.category === category).map((profile) => profile.id);
}

export function isRegisteredJdbcProductRuntimeInstallError(config: Pick<ConnectionConfig, "db_type" | "driver_profile">, message: string): boolean {
  const profile = jdbcProductProfileForConfig(config);
  return Boolean(profile && isJdbcProductRuntimeInstallError(profile, message));
}

export async function ensureRegisteredJdbcProductRuntimeDrivers(config: ConnectionConfig, api: JdbcProductRuntimeApi) {
  const profile = jdbcProductProfileForConfig(config);
  if (!profile) return undefined;
  return ensureJdbcProductRuntimeDrivers(profile, config, api);
}
