import type { AgentDriverInfo } from "@/lib/backend/api";
import type { JdbcMavenBundleInfo, JdbcPluginStatus } from "@/types/database";
import { PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE, PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_DRIVER_PROFILE, PHOENIX_QUERY_SERVER_MAVEN_COORDINATE } from "@/lib/database/phoenixConnection";

export const PHOENIX_JDBC_DRIVER_VERSION = "5.2.1 / 6.0.0";

export const PHOENIX_MANAGED_MAVEN_COORDINATES = [PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE, PHOENIX_QUERY_SERVER_MAVEN_COORDINATE] as const;

export function isPhoenixBuiltinDriver(dbType: string): boolean {
  return dbType === PHOENIX_DRIVER_PROFILE;
}

export function phoenixBuiltinDriverBundles(bundles: JdbcMavenBundleInfo[]): JdbcMavenBundleInfo[] {
  const bundleByCoordinate = new Map(bundles.map((bundle) => [bundle.coordinate, bundle]));
  return PHOENIX_MANAGED_MAVEN_COORDINATES.map((coordinate) => bundleByCoordinate.get(coordinate)).filter((bundle): bundle is JdbcMavenBundleInfo => Boolean(bundle));
}

export function phoenixMissingMavenCoordinates(bundles: JdbcMavenBundleInfo[]): string[] {
  const installedCoordinates = new Set(bundles.map((bundle) => bundle.coordinate));
  return PHOENIX_MANAGED_MAVEN_COORDINATES.filter((coordinate) => !installedCoordinates.has(coordinate));
}

export function phoenixBuiltinDriverRow(bundles: JdbcMavenBundleInfo[], pluginStatus?: Pick<JdbcPluginStatus, "installed" | "compatible"> | null): AgentDriverInfo {
  const installedBundles = phoenixBuiltinDriverBundles(bundles);
  const installed = pluginStatus?.installed === true && pluginStatus.compatible && installedBundles.length === PHOENIX_MANAGED_MAVEN_COORDINATES.length;
  return {
    db_type: PHOENIX_DRIVER_PROFILE,
    label: "Apache Phoenix JDBC",
    version: PHOENIX_JDBC_DRIVER_VERSION,
    size: installedBundles.reduce((bundleTotal, bundle) => bundleTotal + bundle.artifacts.reduce((artifactTotal, artifact) => artifactTotal + Number(artifact.size || 0), 0), 0),
    installed,
    installed_version: installed ? PHOENIX_JDBC_DRIVER_VERSION : null,
    update_available: false,
    requires_java_runtime: true,
    jre: "21",
    jre_installed: true,
  };
}
