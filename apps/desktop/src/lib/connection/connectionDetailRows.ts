import type { ConnectionConfig } from "@/types/database";
import { connectionDisplayUrlScheme } from "@/lib/connection/connectionPresentation";
import { redactConnectionStringSecrets } from "@/lib/connection/connectionStringRedaction";
import { encodeOceanBaseUrlUsername } from "@/lib/connection/connectionUrlBuilder";
import { encodeSpannerResourcePath } from "@/lib/connection/spannerResourcePath";
import { effectiveRedisDatabaseIndex } from "@/lib/redis/redisDatabaseIndex";

export type ConnectionDetailRow = {
  label: string;
  value: string;
  multiline?: boolean;
  values?: string[];
  action?: () => void;
  actionLabel?: string;
};

export type ConnectionDetailVisibleFilter = Pick<ConnectionDetailRow, "label" | "value" | "action" | "actionLabel">;

function clean(value: string | number | null | undefined): string {
  return String(value ?? "").trim();
}

export function isLocalFileConnection(config: Pick<ConnectionConfig, "db_type" | "port">): boolean {
  return config.db_type === "sqlite" || config.db_type === "duckdb" || config.db_type === "access" || (config.db_type === "h2" && config.port === 0);
}

function hostForDisplay(host: string): string {
  if (!host.includes(":") || host.startsWith("[") || host.includes("://") || host.includes(",")) return host;
  return `[${host}]`;
}

function databaseValue(config: ConnectionConfig): string {
  const database = clean(config.database);
  return config.db_type === "redis" && database ? effectiveRedisDatabaseIndex(database) : database;
}

export function connectionDetailUrl(config: ConnectionConfig): string {
  const explicit = clean(config.connection_string);
  if (explicit) return redactConnectionStringSecrets(explicit);

  const host = clean(config.host);
  if (!host) return "";
  if (host.includes("://")) return redactConnectionStringSecrets(host);

  if (isLocalFileConnection(config)) {
    if (config.db_type === "access") return `jdbc:ucanaccess://${host}`;
    return `${config.db_type}://${host}`;
  }

  const scheme = connectionDisplayUrlScheme(config);
  const port = Number(config.port) > 0 ? `:${config.port}` : "";
  const user = clean(config.username);
  const encodedUser = config.db_type === "mysql" && config.driver_profile?.trim().toLowerCase() === "oceanbase" ? encodeOceanBaseUrlUsername(user) : encodeURIComponent(user).replace(/%40/g, "@");
  const userInfo = user ? `${encodedUser}@` : "";
  const database = databaseValue(config);
  const encodedDatabase = config.db_type === "spanner" ? encodeSpannerResourcePath(database) : encodeURIComponent(database);
  const path = database ? `/${encodedDatabase}` : "";
  const params = clean(config.url_params);
  const query = params ? (params.startsWith("?") ? params : `?${params}`) : "";
  return redactConnectionStringSecrets(`${scheme}://${userInfo}${hostForDisplay(host)}${port}${path}${query}`);
}

export function connectionDetailRows(config: ConnectionConfig, translate: (key: string) => string, visibleFilter?: ConnectionDetailVisibleFilter): ConnectionDetailRow[] {
  const hostLabel = isLocalFileConnection(config) ? translate("connection.filePath") : translate("connection.host");
  const hostValue = clean(config.host);
  const productVersion = clean(config.database_info?.productVersion).replace(/^v?(\d+(?:\.\d+)*(?:[-+][\w.-]+)?)$/i, "v$1");
  const hostValues = hostValue.includes(",")
    ? hostValue
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean)
    : [];

  return [
    { label: translate("connection.name"), value: clean(config.name) },
    { label: "URL", value: connectionDetailUrl(config), multiline: true },
    ...(hostValues.length > 0 ? [{ label: hostLabel, value: hostValues[0]!, values: hostValues }] : [{ label: hostLabel, value: hostValue, multiline: isLocalFileConnection(config) }]),
    { label: "Port", value: Number(config.port) > 0 ? String(config.port) : "" },
    { label: translate("connection.database"), value: databaseValue(config) },
    { label: translate("connection.user"), value: clean(config.username) },
    { label: translate("connection.type"), value: config.driver_label || config.driver_profile || config.db_type },
    { label: translate("connection.databaseInfo.productVersion"), value: productVersion },
    ...(visibleFilter ? [visibleFilter] : []),
    { label: translate("connection.note"), value: clean(config.note), multiline: true },
  ].filter((row) => row.value);
}
