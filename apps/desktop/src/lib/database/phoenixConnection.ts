import type { ConnectionConfig, JdbcMavenBundleInfo } from "@/types/database";

export const PHOENIX_DRIVER_PROFILE = "phoenix";
export const PHOENIX_DIRECT_JDBC_URL = "jdbc:phoenix:localhost";
export const PHOENIX_DIRECT_JDBC_DRIVER_CLASS = "org.apache.phoenix.jdbc.PhoenixDriver";
export const PHOENIX_QUERY_SERVER_JDBC_URL = "jdbc:phoenix:thin:url=http://127.0.0.1:8765;serialization=PROTOBUF";
export const PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS = "org.apache.phoenix.queryserver.client.Driver";
export const PHOENIX_MAVEN_REPOSITORY = "https://repo.maven.apache.org/maven2/";
export const PHOENIX_DIRECT_MAVEN_COORDINATE = "org.apache.phoenix:phoenix-client-embedded-hbase-2.5:5.2.1";
export const PHOENIX_QUERY_SERVER_MAVEN_COORDINATE = "org.apache.phoenix:phoenix-queryserver-client:6.0.0";
export const PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE = "ch.qos.reload4j:reload4j:1.2.26";
export const PHOENIX_DRIVER_NOT_INSTALLED_ERROR = "Apache Phoenix JDBC driver is not installed. Install it from the Driver Manager, then retry.";
export const PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR = "DBX JDBC plugin is not installed. Install Apache Phoenix JDBC from the Driver Manager, then retry.";

export type PhoenixConnectionMode = "direct" | "query-server";

export type PhoenixConnectionFields = {
  connectionString: string;
  driverClass: string;
};

export type PhoenixConnectionFieldsByMode = Record<PhoenixConnectionMode, PhoenixConnectionFields>;

export type PhoenixRuntimeDriverApi = {
  jdbcPluginStatus: () => Promise<{ installed: boolean; compatible: boolean }>;
  listJdbcMavenBundles: () => Promise<JdbcMavenBundleInfo[]>;
};

export type PhoenixRuntimeDriverResult = {
  bundles: JdbcMavenBundleInfo[];
  paths: string[];
  runtimeSelectionId?: string;
};

type PhoenixConnectionConfig = Partial<Pick<ConnectionConfig, "connection_string" | "jdbc_driver_class">>;

export function phoenixConnectionDefaults(mode: PhoenixConnectionMode): PhoenixConnectionFields {
  if (mode === "query-server") {
    return {
      connectionString: PHOENIX_QUERY_SERVER_JDBC_URL,
      driverClass: PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS,
    };
  }
  return {
    connectionString: PHOENIX_DIRECT_JDBC_URL,
    driverClass: PHOENIX_DIRECT_JDBC_DRIVER_CLASS,
  };
}

export function phoenixConnectionModeForConfig(config: PhoenixConnectionConfig): PhoenixConnectionMode {
  const connectionString = config.connection_string?.trim().toLowerCase() || "";
  const driverClass = config.jdbc_driver_class?.trim().toLowerCase() || "";
  return connectionString.startsWith("jdbc:phoenix:thin:") || driverClass === PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS.toLowerCase() ? "query-server" : "direct";
}

export function createPhoenixConnectionFieldsByMode(config?: PhoenixConnectionConfig): PhoenixConnectionFieldsByMode {
  const fields: PhoenixConnectionFieldsByMode = {
    direct: phoenixConnectionDefaults("direct"),
    "query-server": phoenixConnectionDefaults("query-server"),
  };
  if (!config) return fields;

  const mode = phoenixConnectionModeForConfig(config);
  const defaults = phoenixConnectionDefaults(mode);
  fields[mode] = {
    connectionString: config.connection_string?.trim() || defaults.connectionString,
    driverClass: config.jdbc_driver_class?.trim() || defaults.driverClass,
  };
  return fields;
}

export function rememberPhoenixConnectionFields(fields: PhoenixConnectionFieldsByMode, mode: PhoenixConnectionMode, current: Partial<PhoenixConnectionFields>): PhoenixConnectionFieldsByMode {
  const defaults = phoenixConnectionDefaults(mode);
  return {
    ...fields,
    [mode]: {
      connectionString: current.connectionString?.trim() || defaults.connectionString,
      driverClass: current.driverClass?.trim() || defaults.driverClass,
    },
  };
}

export function isPhoenixDefaultDriverClass(value: string | undefined): boolean {
  const normalized = value?.trim() || "";
  return !normalized || normalized === PHOENIX_DIRECT_JDBC_DRIVER_CLASS || normalized === PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS;
}

export function phoenixMavenCoordinates(mode: PhoenixConnectionMode): string[] {
  return mode === "direct" ? [PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE] : [PHOENIX_QUERY_SERVER_MAVEN_COORDINATE];
}

export function isPhoenixManagedMavenCoordinate(coordinate: string): boolean {
  return [PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_QUERY_SERVER_MAVEN_COORDINATE, PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE].includes(coordinate);
}

export function phoenixManagedRuntimePaths(bundles: JdbcMavenBundleInfo[], mode: PhoenixConnectionMode): string[] {
  const requiredBundles = phoenixMavenCoordinates(mode).map((coordinate) => bundleForCoordinate(bundles, coordinate));
  if (requiredBundles.some((bundle) => !bundle)) return [];
  return requiredBundles.flatMap((bundle) => bundlePaths(bundle));
}

export function phoenixRuntimeSelectionId(mode: PhoenixConnectionMode): string {
  return `phoenix:${mode}`;
}

export function isPhoenixRuntimePath(path: string, mode: PhoenixConnectionMode): boolean {
  const parts = path.split(/[/\\]/);
  const fileName = parts[parts.length - 1] || path;
  return mode === "direct" ? /^phoenix-client-(?:embedded-)?hbase-.+\.jar$/i.test(fileName) : /^phoenix-queryserver-client-.+\.jar$/i.test(fileName);
}

function bundleForCoordinate(bundles: JdbcMavenBundleInfo[], coordinate: string): JdbcMavenBundleInfo | undefined {
  return bundles.find((bundle) => bundle.coordinate === coordinate);
}

function bundlePaths(bundle: JdbcMavenBundleInfo | undefined): string[] {
  return (bundle?.artifacts ?? []).map((artifact) => artifact.path).filter(Boolean);
}

function mavenBundleId(coordinate: string): string {
  return coordinate
    .trim()
    .split("")
    .map((character) => (/^[A-Za-z0-9.-]$/.test(character) ? character : "_"))
    .join("");
}

export function isPhoenixManagedMavenPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return [PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_QUERY_SERVER_MAVEN_COORDINATE, PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE].some((coordinate) => normalized.split("/").includes(mavenBundleId(coordinate)));
}

export function isPhoenixDriverInstallError(message: string): boolean {
  return message.includes(PHOENIX_DRIVER_NOT_INSTALLED_ERROR) || message.includes(PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR);
}

export async function ensurePhoenixRuntimeDrivers(config: ConnectionConfig, api: PhoenixRuntimeDriverApi): Promise<PhoenixRuntimeDriverResult | undefined> {
  if (config.db_type !== "jdbc" || config.driver_profile !== PHOENIX_DRIVER_PROFILE) return undefined;

  const mode = phoenixConnectionModeForConfig(config);
  const defaults = phoenixConnectionDefaults(mode);
  config.connection_string = config.connection_string?.trim() || defaults.connectionString;
  config.jdbc_driver_class = config.jdbc_driver_class?.trim() || defaults.driverClass;
  const configuredPaths = (config.jdbc_driver_paths ?? []).map((path) => path.trim()).filter(Boolean);

  const pluginStatus = await api.jdbcPluginStatus();
  if (!pluginStatus.installed || !pluginStatus.compatible) {
    throw new Error(PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR);
  }

  const bundles = await api.listJdbcMavenBundles();
  const managedCoordinates = [PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_QUERY_SERVER_MAVEN_COORDINATE, PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE];
  const managedPaths = new Set(managedCoordinates.flatMap((coordinate) => bundlePaths(bundleForCoordinate(bundles, coordinate))));
  const hasCustomPhoenixRuntime = configuredPaths.some((path) => isPhoenixRuntimePath(path, mode) && !managedPaths.has(path) && !isPhoenixManagedMavenPath(path));
  if (hasCustomPhoenixRuntime) {
    config.jdbc_driver_paths = configuredPaths;
    return { bundles, paths: configuredPaths };
  }

  const requiredCoordinates = phoenixMavenCoordinates(mode);
  const missingCoordinates = requiredCoordinates.filter((coordinate) => !bundleForCoordinate(bundles, coordinate));
  if (missingCoordinates.length > 0) {
    throw new Error(PHOENIX_DRIVER_NOT_INSTALLED_ERROR);
  }

  const requiredBundles = requiredCoordinates.map((coordinate) => bundleForCoordinate(bundles, coordinate));
  if (requiredBundles.some((bundle) => !bundle)) {
    throw new Error(PHOENIX_DRIVER_NOT_INSTALLED_ERROR);
  }

  const refreshedManagedPaths = new Set(managedCoordinates.flatMap((coordinate) => bundlePaths(bundleForCoordinate(bundles, coordinate))));
  const customPaths = configuredPaths.filter((path) => !refreshedManagedPaths.has(path) && !isPhoenixManagedMavenPath(path));
  const runtimePaths = phoenixManagedRuntimePaths(bundles, mode);
  const paths = Array.from(new Set([...customPaths, ...runtimePaths]));
  config.jdbc_driver_paths = paths;

  return {
    bundles,
    paths,
    runtimeSelectionId: phoenixRuntimeSelectionId(mode),
  };
}
