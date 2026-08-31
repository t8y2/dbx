import type { JdbcMavenBundleInfo } from "@/types/database";
import { managedJdbcDriverPaths, type ManagedJdbcDriverDefinition } from "@/lib/database/managedJdbcDriver";
import managedJdbcAssets from "@/lib/database/managedJdbcAssets.json";

export const PRESTOSQL_DRIVER_DB_TYPE = "prestosql";
const PRESTOSQL_JDBC_ASSET = managedJdbcAssets.drivers.prestosql.bundles.driver;
export const PRESTOSQL_JDBC_DRIVER_VERSION = PRESTOSQL_JDBC_ASSET.artifact.version;
export const PRESTOSQL_JDBC_DRIVER_COORDINATE = PRESTOSQL_JDBC_ASSET.coordinate;
export const PRESTOSQL_JDBC_DRIVER_REPOSITORY = managedJdbcAssets.repository;
export const PRESTOSQL_MANAGED_JDBC_DRIVER: ManagedJdbcDriverDefinition = {
  id: PRESTOSQL_DRIVER_DB_TYPE,
  label: "PrestoSQL",
  version: PRESTOSQL_JDBC_DRIVER_VERSION,
  jre: "21",
  bundles: [
    {
      coordinate: PRESTOSQL_JDBC_DRIVER_COORDINATE,
      repositories: [PRESTOSQL_JDBC_DRIVER_REPOSITORY],
    },
  ],
};

export function prestoSqlBuiltinDriverPaths(bundles: JdbcMavenBundleInfo[]): string[] {
  return managedJdbcDriverPaths(PRESTOSQL_MANAGED_JDBC_DRIVER, bundles);
}
