import type { JdbcMavenBundleInfo } from "@/types/database";
import { managedJdbcDriverPaths, type ManagedJdbcDriverDefinition } from "@/lib/database/managedJdbcDriver";

export const PRESTOSQL_DRIVER_DB_TYPE = "prestosql";
export const PRESTOSQL_JDBC_DRIVER_VERSION = "350";
export const PRESTOSQL_JDBC_DRIVER_COORDINATE = `io.prestosql:presto-jdbc:${PRESTOSQL_JDBC_DRIVER_VERSION}`;
export const PRESTOSQL_JDBC_DRIVER_REPOSITORY = "https://repo.maven.apache.org/maven2/";
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
