import { uuid } from "@/lib/common/utils";
import type { ConnectionConfig } from "@/types/database";
import type { NacosAdminConfig, NacosNamespaceScope } from "@/types/nacos";
import { applyNacosContentReplacePlan, rollbackNacosContentReplace, type NacosContentReplaceApi, type NacosContentReplacePlan, type NacosContentReplaceReport, type NacosContentRollbackReport } from "./nacosContentReplace";
import { getNacosReplaceHistory, saveNacosReplaceHistory } from "./nacosReplaceHistoryStorage";

export interface NacosReplaceHistoryEntry {
  version: 1;
  id: string;
  connectionId: string;
  target: string;
  createdAt: number;
  updatedAt: number;
  scope: { scope: NacosNamespaceScope; namespace: string; group: string; dataId: string };
  state: "applying" | "completed" | "rollingBack" | "rollbackCompleted";
  plan: NacosContentReplacePlan;
  report: NacosContentReplaceReport;
  rollback?: NacosContentRollbackReport;
  inFlight?: { key: string; phase: "apply" | "rollback" };
  uncertainItems?: Array<{ key: string; phase: "apply" | "rollback" }>;
}

export function nacosHistoryTarget(connection: Pick<ConnectionConfig, "id" | "host" | "port" | "external_config">): string {
  const config = connection.external_config as NacosAdminConfig | undefined;
  // Do not include authentication or transport secrets in the identity.
  return JSON.stringify([connection.host, connection.port, config?.serverAddr ?? "", config?.contextPath ?? "/nacos", config?.implementation ?? "nacos", config?.rnacosConsoleAddr ?? ""]);
}

export async function withNacosHistoryLock<T>(connectionId: string, action: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) throw new Error("nacos-history-storage-unavailable");
  return navigator.locks.request(`dbx-nacos-replace:${connectionId}`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("nacos-history-busy");
    return action();
  });
}

function updateCounts(entry: NacosReplaceHistoryEntry) {
  entry.report.replaced = entry.report.items.filter((item) => item.status === "replaced").length;
  entry.report.conflicts = entry.report.items.filter((item) => item.status === "conflict").length;
  entry.report.failed = entry.report.items.filter((item) => item.status === "failed").length;
  if (entry.rollback) {
    entry.rollback.restored = entry.rollback.items.filter((item) => item.status === "restored").length;
    entry.rollback.conflicts = entry.rollback.items.filter((item) => item.status === "conflict").length;
    entry.rollback.failed = entry.rollback.items.filter((item) => item.status === "failed").length;
  }
  entry.updatedAt = Date.now();
}

export function nacosHistoryRollbackCandidates(entry: NacosReplaceHistoryEntry) {
  const restored = new Set(entry.rollback?.items.filter((item) => item.status === "restored").map((item) => item.key));
  const uncertain = new Set(entry.uncertainItems?.map((item) => item.key));
  if (entry.inFlight) uncertain.add(entry.inFlight.key);
  return entry.report.items.filter((item) => item.status === "replaced" && !restored.has(item.key) && !uncertain.has(item.key));
}

export async function applyWithNacosHistory(connectionId: string, target: string, scope: NacosReplaceHistoryEntry["scope"], plan: NacosContentReplacePlan, api: NacosContentReplaceApi): Promise<NacosReplaceHistoryEntry> {
  const entry: NacosReplaceHistoryEntry = {
    version: 1,
    id: uuid(),
    connectionId,
    target,
    scope,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: "applying",
    plan,
    report: { search: plan.search, replacement: plan.replacement, totalReplacements: plan.totalReplacements, items: [], replaced: 0, conflicts: 0, failed: 0, cancelled: false },
  };
  await saveNacosReplaceHistory(entry);
  entry.report = await applyNacosContentReplacePlan(plan, {
    ...api,
    onBeforeItem: async (item) => {
      entry.inFlight = { key: item.key, phase: "apply" };
      await saveNacosReplaceHistory(entry);
    },
    onItemResult: async (item) => {
      entry.report.items.push(item);
      delete entry.inFlight;
      updateCounts(entry);
      await saveNacosReplaceHistory(entry);
    },
  });
  entry.state = "completed";
  updateCounts(entry);
  await saveNacosReplaceHistory(entry);
  return entry;
}

export async function rollbackFromNacosHistory(id: string, connectionId: string, target: string, api: NacosContentReplaceApi): Promise<NacosReplaceHistoryEntry> {
  const entry = await getNacosReplaceHistory(id, connectionId);
  if (!entry || entry.connectionId !== connectionId || entry.target !== target) throw new Error("nacos-history-target-mismatch");
  const candidates = nacosHistoryRollbackCandidates(entry);
  if (!candidates.length) return entry;
  entry.state = "rollingBack";
  entry.rollback ??= { restored: 0, conflicts: 0, failed: 0, items: [] };
  if (entry.inFlight) {
    entry.uncertainItems = [...(entry.uncertainItems ?? []), entry.inFlight];
    delete entry.inFlight;
  }
  await saveNacosReplaceHistory(entry);
  await rollbackNacosContentReplace(
    { ...entry.report, items: candidates },
    {
      ...api,
      onBeforeItem: async (item) => {
        entry.inFlight = { key: item.key, phase: "rollback" };
        await saveNacosReplaceHistory(entry);
      },
      onItemResult: async (item) => {
        entry.rollback!.items = entry.rollback!.items.filter((previous) => previous.key !== item.key);
        entry.rollback!.items.push(item);
        delete entry.inFlight;
        updateCounts(entry);
        await saveNacosReplaceHistory(entry);
      },
    },
  );
  entry.state = entry.uncertainItems?.length ? "rollingBack" : "rollbackCompleted";
  updateCounts(entry);
  await saveNacosReplaceHistory(entry);
  return entry;
}
