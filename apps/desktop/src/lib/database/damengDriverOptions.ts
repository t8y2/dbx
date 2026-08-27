import type { ConnectionConfig } from "@/types/database";

export const DAMENG_BUILTIN_DRIVER_PROFILE = "dm";
export const DAMENG_CUSTOM_DRIVER_PROFILE = "dm6-custom";
export const DAMENG_DEFAULT_JDBC_DRIVER_CLASS = "dm6.jdbc.driver.DmDriver";

export type DamengDriverMode = "builtin" | "custom";

type DamengDriverConfig = Partial<Pick<ConnectionConfig, "driver_profile" | "host" | "port" | "database" | "connection_string" | "jdbc_driver_paths">>;

export function damengDriverModeForConfig(config: DamengDriverConfig): DamengDriverMode {
  if (config.driver_profile === DAMENG_CUSTOM_DRIVER_PROFILE || config.jdbc_driver_paths?.some((path) => path.trim())) {
    return "custom";
  }
  return "builtin";
}

export function defaultDamengJdbcUrl(config: Pick<DamengDriverConfig, "host" | "port" | "database">): string {
  const host = config.host?.trim() || "127.0.0.1";
  const port = Number(config.port) > 0 ? Number(config.port) : 5236;
  const database = config.database?.trim();
  return `jdbc:dm6://${host}:${port}${database ? `/${database}` : ""}`;
}

export function damengCustomJdbcUrl(config: DamengDriverConfig): string {
  return config.connection_string?.trim() || defaultDamengJdbcUrl(config);
}
