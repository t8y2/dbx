import type { DatabaseType } from "@/types/database";
import { supportsDriverManagement } from "./databaseCapabilities";

export interface AgentDriverInstallState {
  db_type: string;
  installed: boolean;
}

function agentDriverInstallKey(dbType: DatabaseType | undefined, driverProfile?: string): string | undefined {
  if (dbType === "oracle") return "oracle";
  return driverProfile && driverProfile !== dbType ? driverProfile : dbType;
}

export function showAgentDriverInstallHint(dbType: DatabaseType | undefined, drivers: readonly AgentDriverInstallState[], driverProfile?: string): boolean {
  if (!supportsDriverManagement(dbType)) return false;
  const driverKey = agentDriverInstallKey(dbType, driverProfile);
  return drivers.find((driver) => driver.db_type === driverKey)?.installed !== true;
}
