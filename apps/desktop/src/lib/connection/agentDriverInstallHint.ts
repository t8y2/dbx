import type { DatabaseType } from "@/types/database";
import { supportsDriverManagement } from "@/lib/database/databaseCapabilities";

export interface AgentDriverInstallState {
  db_type: string;
  installed: boolean;
  update_available?: boolean;
}

export function agentDriverInstallKey(dbType: DatabaseType | undefined, driverProfile?: string): string | undefined {
  if (dbType === "oracle") return "oracle";
  if (dbType === "mongodb") return "mongodb";
  if (dbType === "dameng") return "dameng";
  if (dbType === "gbase") return driverProfile === "gbase8s" ? "gbase8s" : "gbase8a";
  if (dbType === "mq") {
    if (driverProfile === "kafka") return "kafka";
    if (driverProfile === "rocketmq") return "rocketmq";
    return undefined;
  }
  return driverProfile && driverProfile !== dbType ? driverProfile : dbType;
}

export function showAgentDriverInstallHint(dbType: DatabaseType | undefined, drivers: readonly AgentDriverInstallState[], driverProfile?: string): boolean {
  if (!supportsDriverManagement(dbType)) return false;
  const driverKey = agentDriverInstallKey(dbType, driverProfile);
  if (!driverKey) return false;
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

export type DriverStoreTab = "agent" | "jdbc" | "storage" | "runtime";

export type DriverStoreFocus = { target: "driver"; driver?: string } | { target: "jre" } | { target: "tab"; tab: DriverStoreTab };

/** Maps a backend connect error to the Driver Store item that can fix it. */
export function driverStoreFocusForInstallError(message: string, dbType?: DatabaseType, driverProfile?: string): DriverStoreFocus | null {
  if (message.includes("JRE") && message.includes("not installed")) return { target: "jre" };
  if (!message.includes("is not installed") && !message.includes("reinstall it from the Driver Manager")) return null;
  return { target: "driver", driver: agentDriverInstallKey(dbType, driverProfile) };
}
