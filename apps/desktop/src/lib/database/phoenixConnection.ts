import type { ConnectionConfig } from "@/types/database";
import type { JdbcProductProfileDefinition } from "@/lib/database/jdbcProductProfile";
import managedJdbcAssets from "@/lib/database/managedJdbcAssets.json";

export const PHOENIX_DRIVER_PROFILE = "phoenix";
export const PHOENIX_DIRECT_JDBC_URL = "jdbc:phoenix:localhost";
export const PHOENIX_DIRECT_JDBC_DRIVER_CLASS = "org.apache.phoenix.jdbc.PhoenixDriver";
export const PHOENIX_QUERY_SERVER_JDBC_URL = "jdbc:phoenix:thin:url=http://127.0.0.1:8765;serialization=PROTOBUF";
export const PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS = "org.apache.phoenix.queryserver.client.Driver";
const PHOENIX_JDBC_ASSETS = managedJdbcAssets.drivers.phoenix.bundles;
export const PHOENIX_MAVEN_REPOSITORY = managedJdbcAssets.repository;
export const PHOENIX_DIRECT_MAVEN_COORDINATE = PHOENIX_JDBC_ASSETS.direct.coordinate;
export const PHOENIX_QUERY_SERVER_MAVEN_COORDINATE = PHOENIX_JDBC_ASSETS.query_server.coordinate;
export const PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE = PHOENIX_JDBC_ASSETS.logging.coordinate;
export const PHOENIX_DRIVER_NOT_INSTALLED_ERROR = "Apache Phoenix JDBC driver is not installed. Install it from the Driver Manager, then retry.";
export const PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR = "DBX JDBC plugin is not installed. Install Apache Phoenix JDBC from the Driver Manager, then retry.";

export type PhoenixConnectionMode = "direct" | "query-server";

type PhoenixConnectionConfig = Partial<Pick<ConnectionConfig, "connection_string" | "jdbc_driver_class">>;

export const PHOENIX_JDBC_PRODUCT_PROFILE: JdbcProductProfileDefinition = {
  id: PHOENIX_DRIVER_PROFILE,
  label: "Apache Phoenix",
  icon: "phoenix",
  category: "analytics",
  port: 0,
  user: "",
  match: { dbType: "jdbc", driverProfile: PHOENIX_DRIVER_PROFILE },
  managedDriverId: PHOENIX_DRIVER_PROFILE,
  runtimeLabelKey: "connection.phoenixRuntimeOption",
  driverManagerHintPrefixKey: "connection.phoenixDriverManagerHintPrefix",
  driverManagerHintSuffixKey: "connection.phoenixDriverManagerHintSuffix",
  docsLabelKey: "connection.phoenixDocs",
  docsUrl: "https://phoenix.apache.org/docs/fundamentals/client-classpath-and-jdbc-url/",
  missingDriverError: PHOENIX_DRIVER_NOT_INSTALLED_ERROR,
  missingPluginError: PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR,
  modes: [
    {
      id: "direct",
      labelKey: "connection.phoenixDirectMode",
      hintKey: "connection.phoenixDirectModeHint",
      defaultConnectionString: PHOENIX_DIRECT_JDBC_URL,
      defaultDriverClass: PHOENIX_DIRECT_JDBC_DRIVER_CLASS,
      managedCoordinates: [PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE],
    },
    {
      id: "query-server",
      labelKey: "connection.phoenixQueryServerMode",
      hintKey: "connection.phoenixQueryServerModeHint",
      defaultConnectionString: PHOENIX_QUERY_SERVER_JDBC_URL,
      defaultDriverClass: PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS,
      managedCoordinates: [PHOENIX_QUERY_SERVER_MAVEN_COORDINATE],
    },
  ],
  detectMode: (config) => phoenixConnectionModeForConfig(config),
  isCompatibleRuntimePath: (path, mode) => isPhoenixRuntimePath(path, mode as PhoenixConnectionMode),
};

export function phoenixConnectionModeForConfig(config: PhoenixConnectionConfig): PhoenixConnectionMode {
  const connectionString = config.connection_string?.trim().toLowerCase() || "";
  const driverClass = config.jdbc_driver_class?.trim().toLowerCase() || "";
  return connectionString.startsWith("jdbc:phoenix:thin:") || driverClass === PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS.toLowerCase() ? "query-server" : "direct";
}

export function isPhoenixRuntimePath(path: string, mode: PhoenixConnectionMode): boolean {
  const parts = path.split(/[/\\]/);
  const fileName = parts[parts.length - 1] || path;
  return mode === "direct" ? /^phoenix-client-(?:embedded-)?hbase-.+\.jar$/i.test(fileName) : /^phoenix-queryserver-client-.+\.jar$/i.test(fileName);
}
