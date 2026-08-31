import type { DatabaseType } from "@/types/database";
import { supportsDriverManagement } from "@/lib/database/databaseCapabilities";

export interface AgentDriverInstallState {
  db_type: string;
  installed: boolean;
  installed_version?: string | null;
  update_available?: boolean;
}

export type AgentDriverInstallContext = {
  ssh?: boolean;
};

export function connectionUsesSsh(config: { transport_layers?: Array<{ type?: string; enabled?: boolean }> } | undefined): boolean {
  return (config?.transport_layers ?? []).some((layer) => layer.enabled !== false && layer.type === "ssh");
}

/** Returns whether a locally installed native Agent meets a required release. */
export function hasInstalledAgentVersion(drivers: readonly AgentDriverInstallState[], driverKey: string, minimumVersion: string): boolean {
  const installedVersion = drivers.find((driver) => driver.db_type === driverKey && driver.installed)?.installed_version;
  if (!installedVersion) return false;

  const parse = (version: string): number[] | null => {
    const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
  };
  const installed = parse(installedVersion);
  const minimum = parse(minimumVersion);
  if (!installed || !minimum) return false;
  return installed[0] > minimum[0] || (installed[0] === minimum[0] && (installed[1] > minimum[1] || (installed[1] === minimum[1] && installed[2] >= minimum[2])));
}

export function agentDriverInstallKey(dbType: DatabaseType | undefined, driverProfile?: string, context?: AgentDriverInstallContext): string | undefined {
  if (dbType === "sqlite") return context?.ssh ? "sqlite-worker" : undefined;
  if (dbType === "kyuubi" || dbType === "impala" || dbType === "argo") return "hive";
  if (dbType === "oracle") return "oracle";
  if (dbType === "h2") return "h2";
  if (dbType === "mongodb") return "mongodb";
  if (dbType === "dameng") return "dameng";
  if (dbType === "gbase") return driverProfile === "gbase8s" ? "gbase8s" : "gbase8a";
  if (dbType === "mq") {
    if (driverProfile === "kafka") return "kafka";
    if (driverProfile === "rocketmq") return "rocketmq";
    if (driverProfile === "rabbitmq") return "rabbitmq";
    return undefined;
  }
  return driverProfile && driverProfile !== dbType ? driverProfile : dbType;
}

function usesManagedAgentDriver(dbType: DatabaseType | undefined, driverProfile?: string, context?: AgentDriverInstallContext): boolean {
  if (dbType === "sqlite") return context?.ssh === true;
  if (supportsDriverManagement(dbType)) return true;
  if (dbType !== "mongodb") return false;
  const profile = driverProfile?.trim().toLowerCase();
  return profile === "mongodb-legacy" || profile === "mongodb_legacy" || profile === "legacy";
}

export function showAgentDriverInstallHint(dbType: DatabaseType | undefined, drivers: readonly AgentDriverInstallState[], driverProfile?: string, context?: AgentDriverInstallContext): boolean {
  if (!usesManagedAgentDriver(dbType, driverProfile, context)) return false;
  const driverKey = agentDriverInstallKey(dbType, driverProfile, context);
  if (!driverKey) return false;
  return drivers.find((driver) => driver.db_type === driverKey)?.installed !== true;
}

export function hasAgentDriverUpdate(dbType: DatabaseType | undefined, drivers: readonly AgentDriverInstallState[], driverProfile?: string, context?: AgentDriverInstallContext): boolean {
  if (!usesManagedAgentDriver(dbType, driverProfile, context)) return false;
  const driverKey = agentDriverInstallKey(dbType, driverProfile, context);
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
  if (message.includes("sqlite-worker")) return { target: "driver", driver: "sqlite-worker" };
  return { target: "driver", driver: agentDriverInstallKey(dbType, driverProfile, { ssh: dbType === "sqlite" }) };
}
