import type { ConnectionConfig } from "@/types/database";

/**
 * The SunDB (科蓝 SUNDB) Agent bundles the vendor JDBC driver (vendored under
 * `agents/drivers/sundb/libs/`), so an empty `jdbc_driver_paths` resolves the
 * driver class on the Agent's own classpath. Callers may still point a
 * connection at a newer vendor JAR, which the Agent then loads in an isolated
 * URLClassLoader instead.
 */
export const SUNDB_DEFAULT_JDBC_DRIVER_CLASS = "csii.sundb.jdbc.SundbDriver";

type SundbDriverConfig = Partial<Pick<ConnectionConfig, "jdbc_driver_class">>;

export function sundbJdbcDriverClass(config: SundbDriverConfig): string {
  return config.jdbc_driver_class?.trim() || SUNDB_DEFAULT_JDBC_DRIVER_CLASS;
}
