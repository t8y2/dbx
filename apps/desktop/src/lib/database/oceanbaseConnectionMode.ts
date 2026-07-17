import type { ConnectionConfig, DatabaseType } from "@/types/database";

export type OceanbaseSubMode = "mysql" | "oracle";

export function oceanbaseSubModeFromConfig(config: Pick<ConnectionConfig, "db_type" | "driver_profile">): OceanbaseSubMode {
  return config.db_type === "oceanbase-oracle" || config.driver_profile === "oceanbase-oracle" ? "oracle" : "mysql";
}

export function oceanbaseModeConnectionPatch(mode: OceanbaseSubMode): {
  db_type: DatabaseType;
  driver_profile: string;
  driver_label: string;
} {
  if (mode === "oracle") {
    return {
      db_type: "oceanbase-oracle",
      driver_profile: "oceanbase-oracle",
      driver_label: "OceanBase Oracle Mode",
    };
  }
  return {
    db_type: "mysql",
    driver_profile: "oceanbase",
    driver_label: "OceanBase",
  };
}
