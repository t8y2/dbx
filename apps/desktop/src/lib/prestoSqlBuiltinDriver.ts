import type { AgentDriverInfo } from "@/lib/api";
import type { JdbcMavenBundleInfo } from "@/types/database";

export const PRESTOSQL_DRIVER_DB_TYPE = "prestosql";
export const PRESTOSQL_JDBC_DRIVER_VERSION = "350";
export const PRESTOSQL_JDBC_DRIVER_COORDINATE = `io.prestosql:presto-jdbc:${PRESTOSQL_JDBC_DRIVER_VERSION}`;
export const PRESTOSQL_JDBC_DRIVER_REPOSITORY = "https://repo.maven.apache.org/maven2/";

export function prestoSqlMavenBundle(bundles: JdbcMavenBundleInfo[]): JdbcMavenBundleInfo | undefined {
  return bundles.find((bundle) => bundle.coordinate === PRESTOSQL_JDBC_DRIVER_COORDINATE);
}

export function prestoSqlBuiltinDriverPaths(bundles: JdbcMavenBundleInfo[]): string[] {
  return (prestoSqlMavenBundle(bundles)?.artifacts ?? []).map((artifact) => artifact.path).filter(Boolean);
}

export function prestoSqlBuiltinDriverRow(bundles: JdbcMavenBundleInfo[]): AgentDriverInfo {
  const installedBundle = prestoSqlMavenBundle(bundles);
  return {
    db_type: PRESTOSQL_DRIVER_DB_TYPE,
    label: "PrestoSQL",
    version: PRESTOSQL_JDBC_DRIVER_VERSION,
    size: installedBundle ? installedBundle.artifacts.reduce((total, artifact) => total + Number(artifact.size || 0), 0) : 0,
    installed: Boolean(installedBundle),
    installed_version: installedBundle ? PRESTOSQL_JDBC_DRIVER_VERSION : null,
    update_available: false,
    requires_java_runtime: true,
    jre: "21",
    jre_installed: true,
  };
}
