import type { ConnectionConfig } from "@/types/database";

/**
 * GBase 8a / 8s / 8c share one picker entry and one version toggle, but they are
 * different engines with different SQL dialects: 8a is the MySQL-based `gbase` type,
 * 8s is Informix-derived (`gbase8s`) and 8c is PostgreSQL-shaped (`gbase8c`), the same
 * split as OceanBase MySQL/Oracle mode. The toggle therefore switches `db_type` too.
 */
export const GBASE_PROFILES = ["gbase8a", "gbase8s", "gbase8c"] as const;

export type GbaseProfile = (typeof GBASE_PROFILES)[number];

export function isGbaseProfile(value: string | undefined | null): value is GbaseProfile {
  return GBASE_PROFILES.includes(value as GbaseProfile);
}

export function gbaseProfileFromConfig(config: Pick<ConnectionConfig, "db_type" | "driver_profile">): GbaseProfile {
  if (config.db_type === "gbase8c" || config.driver_profile === "gbase8c") return "gbase8c";
  if (config.db_type === "gbase8s" || config.driver_profile === "gbase8s") return "gbase8s";
  return "gbase8a";
}
