import type { DatabaseType } from "@/types/database";
import { supportsDriverManagement } from "./databaseCapabilities";

export interface AgentDriverInstallState {
  db_type: string;
  installed: boolean;
  update_available?: boolean;
}

function agentDriverInstallKey(dbType: DatabaseType | undefined, driverProfile?: string): string | undefined {
  if (dbType === "oracle") return "oracle";
  if (dbType === "mongodb") return "mongodb";
  if (dbType === "dameng") return "dameng";
  return driverProfile && driverProfile !== dbType ? driverProfile : dbType;
}

export function showAgentDriverInstallHint(dbType: DatabaseType | undefined, drivers: readonly AgentDriverInstallState[], driverProfile?: string): boolean {
  if (!supportsDriverManagement(dbType)) return false;
  const driverKey = agentDriverInstallKey(dbType, driverProfile);
  return drivers.find((driver) => driver.db_type === driverKey)?.installed !== true;
}

export function hasAgentDriverUpdate(dbType: DatabaseType | undefined, drivers: readonly AgentDriverInstallState[], driverProfile?: string): boolean {
  if (!supportsDriverManagement(dbType)) return false;
  const driverKey = agentDriverInstallKey(dbType, driverProfile);
  return drivers.find((driver) => driver.db_type === driverKey)?.update_available === true;
}

export function appendAgentDriverUpdateHint(message: string, hint: string): string {
  if (!message.trim()) return hint;
  if (message.includes(hint)) return message;
  return `${message}\n\n${hint}`;
}
