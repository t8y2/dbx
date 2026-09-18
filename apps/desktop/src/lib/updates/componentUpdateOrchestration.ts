import { safeLocalStorageGet, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";

const PENDING_COMPONENT_UPDATES_STORAGE_KEY = "dbx:updates:pending-components-after-restart";

export const COMPONENT_UPDATE_CATEGORIES = ["drivers", "jdbc", "mcp", "plugins"] as const;

export type ComponentUpdateCategory = (typeof COMPONENT_UPDATE_CATEGORIES)[number];

export type PendingComponentUpdatePlan = { kind: "auto" } | { kind: "manual"; categories: ComponentUpdateCategory[] };

export interface PendingComponentUpdates {
  fromVersion: string;
  targetVersion: string;
  plan: PendingComponentUpdatePlan;
}

export type UpdateAllAction = "none" | "download-app" | "defer-components" | "update-components";

function normalizeVersion(version: string): string {
  return version.trim().replace(/^[vV]/, "");
}

function isComponentUpdateCategory(value: unknown): value is ComponentUpdateCategory {
  return typeof value === "string" && COMPONENT_UPDATE_CATEGORIES.includes(value as ComponentUpdateCategory);
}

function normalizeManualCategories(value: unknown): ComponentUpdateCategory[] | null {
  if (!Array.isArray(value) || !value.every(isComponentUpdateCategory)) return null;
  return [...new Set(value)];
}

function normalizePendingComponentUpdatePlan(plan: PendingComponentUpdatePlan): PendingComponentUpdatePlan | null {
  if (plan.kind === "auto") return plan;
  const categories = normalizeManualCategories(plan.categories);
  return categories ? { kind: "manual", categories } : null;
}

function parsePendingComponentUpdatePlan(value: unknown): PendingComponentUpdatePlan | null {
  if (value === undefined) return { kind: "auto" };
  if (!value || typeof value !== "object") return null;
  const plan = value as { kind?: unknown; categories?: unknown };
  if (plan.kind === "auto") return { kind: "auto" };
  if (plan.kind !== "manual") return null;
  const categories = normalizeManualCategories(plan.categories);
  return categories ? { kind: "manual", categories } : null;
}

function parsePendingComponentUpdates(raw: string | null): PendingComponentUpdates | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Omit<PendingComponentUpdates, "plan">> & { plan?: unknown };
    const fromVersion = typeof parsed.fromVersion === "string" ? parsed.fromVersion.trim() : "";
    const targetVersion = typeof parsed.targetVersion === "string" ? parsed.targetVersion.trim() : "";
    const plan = parsePendingComponentUpdatePlan(parsed.plan);
    return fromVersion && plan ? { fromVersion, targetVersion, plan } : null;
  } catch {
    return null;
  }
}

export function markPendingComponentUpdatesAfterAppUpdate(fromVersion: string, targetVersion: string, plan: PendingComponentUpdatePlan = { kind: "auto" }): boolean {
  const normalizedFromVersion = fromVersion.trim();
  if (!normalizedFromVersion) return false;
  const normalizedPlan = normalizePendingComponentUpdatePlan(plan);
  if (!normalizedPlan) return false;
  const existing = parsePendingComponentUpdates(safeLocalStorageGet(PENDING_COMPONENT_UPDATES_STORAGE_KEY));
  if (normalizedPlan.kind === "auto" && existing?.plan.kind === "manual" && normalizeVersion(existing.fromVersion) === normalizeVersion(normalizedFromVersion)) return true;
  return safeLocalStorageSet(
    PENDING_COMPONENT_UPDATES_STORAGE_KEY,
    JSON.stringify({
      fromVersion: normalizedFromVersion,
      targetVersion: targetVersion.trim(),
      plan: normalizedPlan,
    } satisfies PendingComponentUpdates),
  );
}

export function clearPendingComponentUpdatesAfterAppUpdate() {
  safeLocalStorageRemove(PENDING_COMPONENT_UPDATES_STORAGE_KEY);
}

export function takePendingComponentUpdatesAfterAppRestart(currentVersion: string): PendingComponentUpdates | null {
  const pending = parsePendingComponentUpdates(safeLocalStorageGet(PENDING_COMPONENT_UPDATES_STORAGE_KEY));
  if (!pending) {
    clearPendingComponentUpdatesAfterAppUpdate();
    return null;
  }
  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  if (!normalizedCurrentVersion || normalizedCurrentVersion === normalizeVersion(pending.fromVersion)) return null;
  clearPendingComponentUpdatesAfterAppUpdate();
  return pending;
}

export function resolveUpdateAllAction(options: { hasAppUpdate: boolean; appUpdateCanInstall: boolean; appUpdatePrepared: boolean; hasComponentUpdates: boolean }): UpdateAllAction {
  if (!options.hasAppUpdate || !options.appUpdateCanInstall) return options.hasComponentUpdates ? "update-components" : "none";
  return options.appUpdatePrepared ? "defer-components" : "download-app";
}

export function runPendingComponentUpdatePlan<T>(pending: PendingComponentUpdates, updates: { installCategories: (categories: ComponentUpdateCategory[]) => Promise<T>; autoUpdateEnabledComponents: () => Promise<T> }): Promise<T> {
  return pending.plan.kind === "manual" ? updates.installCategories(pending.plan.categories) : updates.autoUpdateEnabledComponents();
}
