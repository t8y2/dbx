import type { ConnectionConfig, JdbcDriverInfo, JdbcMavenBundleInfo } from "@/types/database";

export const JDBCX_DRIVER_PROFILE = "jdbcx";
export const JDBCX_JDBC_DRIVER_CLASS = "io.github.jdbcx.WrappedDriver";
export const JDBCX_DEFAULT_URL = "jdbcx:";

export type JdbcxRuntimeDriverApi = {
  listJdbcDrivers: () => Promise<JdbcDriverInfo[]>;
  listJdbcMavenBundles: () => Promise<JdbcMavenBundleInfo[]>;
  jdbcPluginStatus: () => Promise<{ installed: boolean; compatible: boolean }>;
  installJdbcPlugin: () => Promise<unknown>;
};

export type JdbcxRuntimeDriverResult = {
  bundles: JdbcMavenBundleInfo[];
  paths: string[];
};

export function isJdbcxRuntimePath(path: string): boolean {
  return /(?:^|[/\\])jdbcx-(?:driver|core)(?:-|\.)/i.test(path);
}

export async function ensureJdbcxRuntimeDrivers(config: ConnectionConfig, api: JdbcxRuntimeDriverApi, onInstalling?: (coordinates: string[]) => void): Promise<JdbcxRuntimeDriverResult | undefined> {
  if (config.db_type !== "jdbc" || config.driver_profile !== JDBCX_DRIVER_PROFILE) return undefined;

  config.connection_string = config.connection_string?.trim() || JDBCX_DEFAULT_URL;
  config.jdbc_driver_class = config.jdbc_driver_class?.trim() || JDBCX_JDBC_DRIVER_CLASS;
  const configuredPaths = (config.jdbc_driver_paths ?? []).map((path) => path.trim()).filter(Boolean);
  const pluginStatus = await api.jdbcPluginStatus();
  if (!pluginStatus.installed || !pluginStatus.compatible) {
    onInstalling?.([]);
    await api.installJdbcPlugin();
  }

  const [bundles, installedDrivers] = await Promise.all([api.listJdbcMavenBundles(), api.listJdbcDrivers()]);
  const installedPaths = installedDrivers.map((driver) => driver.path).filter(Boolean);
  if (![...configuredPaths, ...installedPaths].some(isJdbcxRuntimePath)) {
    throw new Error("JDBCX runtime is not installed. Install io.github.jdbcx:jdbcx-driver:<version> in Driver Store, then retry.");
  }

  // JDBCX discovers the delegate driver through JDBC ServiceLoader/Driver.acceptsURL.
  // Supplying the DBX driver-store classpath keeps this vendor-neutral: any Maven
  // bundle or local JAR imported by the user becomes available without URL-specific code.
  const paths = Array.from(new Set(installedPaths));
  config.jdbc_driver_paths = Array.from(new Set([...configuredPaths, ...paths]));
  return { bundles, paths };
}
