import type { ConnectionConfig } from "@/types/database";

/** Keep in sync with schema::is_native_mysql_browser_config; proxies keep their existing metadata contracts. */
export function usesLightweightMysqlBrowser(connection: Pick<ConnectionConfig, "db_type" | "driver_profile" | "database_info">): boolean {
  const profile = connection.driver_profile?.trim().toLowerCase();
  if (connection.db_type !== "mysql" || (profile && profile !== "mysql")) return false;
  const version = connection.database_info?.productVersion?.toLowerCase() ?? "";
  const comment = connection.database_info?.serverComment?.toLowerCase() ?? "";
  return !version.includes("mycat") && !comment.includes("mycat") && !version.includes("shardingsphere-proxy");
}
