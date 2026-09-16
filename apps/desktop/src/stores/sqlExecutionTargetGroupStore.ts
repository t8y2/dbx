import { defineStore } from "pinia";
import { ref } from "vue";
import { uuid } from "@/lib/common/utils";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { dedupeMultiDbExecutionTargets, executionTargetGroupNameKey, normalizeMultiDbExecutionTarget, type MultiDbExecutionTarget, type SqlExecutionTargetDatabaseTypeResolver, type SqlExecutionTargetGroup } from "@/types/sqlExecution";
import type { DatabaseType } from "@/types/database";

const STORAGE_KEY = "dbx-sql-execution-target-groups";
const STORAGE_VERSION = 1;

interface PersistedTargetGroupState {
  version: number;
  groups: SqlExecutionTargetGroup[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeGroup(value: Partial<SqlExecutionTargetGroup>): SqlExecutionTargetGroup | undefined {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const databaseType = value.databaseType;
  if (!value.id || !name || !databaseType || !Array.isArray(value.targets)) return undefined;
  const targets = dedupeMultiDbExecutionTargets(value.targets);
  if (targets.length === 0) return undefined;
  const createdAt = typeof value.createdAt === "string" && value.createdAt ? value.createdAt : nowIso();
  const updatedAt = typeof value.updatedAt === "string" && value.updatedAt ? value.updatedAt : createdAt;
  return {
    id: value.id,
    name,
    databaseType,
    targets,
    createdAt,
    updatedAt,
    lastUsedAt: typeof value.lastUsedAt === "string" && value.lastUsedAt ? value.lastUsedAt : undefined,
  };
}

function sortGroups(groups: readonly SqlExecutionTargetGroup[]): SqlExecutionTargetGroup[] {
  return [...groups].sort((a, b) => {
    const aTime = a.lastUsedAt ?? a.updatedAt;
    const bTime = b.lastUsedAt ?? b.updatedAt;
    const timeDiff = bTime.localeCompare(aTime);
    if (timeDiff !== 0) return timeDiff;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function readGroups(): SqlExecutionTargetGroup[] {
  const raw = safeLocalStorageGet(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedTargetGroupState> | SqlExecutionTargetGroup[];
    const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed.groups) ? parsed.groups : [];
    const groups: SqlExecutionTargetGroup[] = [];
    const names = new Set<string>();
    for (const value of values) {
      const group = normalizeGroup(value);
      if (!group) continue;
      const nameKey = executionTargetGroupNameKey(group.name);
      if (names.has(nameKey)) continue;
      names.add(nameKey);
      groups.push(group);
    }
    return sortGroups(groups);
  } catch (error) {
    console.warn("[DBX][sql-execution-target-groups:load] invalid persisted state", error);
    return [];
  }
}

function writeGroups(groups: readonly SqlExecutionTargetGroup[]): void {
  const state: PersistedTargetGroupState = {
    version: STORAGE_VERSION,
    groups: sortGroups(groups),
  };
  safeLocalStorageSet(STORAGE_KEY, JSON.stringify(state));
}

export const useSqlExecutionTargetGroupStore = defineStore("sqlExecutionTargetGroup", () => {
  const groups = ref<SqlExecutionTargetGroup[]>(readGroups());

  function hasName(name: string, exceptId?: string): boolean {
    const key = executionTargetGroupNameKey(name);
    return groups.value.some((group) => group.id !== exceptId && executionTargetGroupNameKey(group.name) === key);
  }

  function assertGroupName(name: string, exceptId?: string): string {
    const normalized = name.trim();
    if (!normalized) throw new Error("目标组名称不能为空");
    if (hasName(normalized, exceptId)) throw new Error("目标组名称已存在");
    return normalized;
  }

  function assertTargets(targets: readonly MultiDbExecutionTarget[], expectedDatabaseType?: DatabaseType, resolveDatabaseType?: SqlExecutionTargetDatabaseTypeResolver): MultiDbExecutionTarget[] {
    const normalized = dedupeMultiDbExecutionTargets(targets);
    if (normalized.length === 0) throw new Error("目标组至少需要一个执行目标");
    if (expectedDatabaseType && resolveDatabaseType) {
      const mismatched = normalized.find((target) => resolveDatabaseType(target) !== expectedDatabaseType);
      if (mismatched) throw new Error("目标组只能包含同一种数据库类型的执行目标");
    }
    return normalized;
  }

  function persist(): void {
    groups.value = sortGroups(groups.value);
    writeGroups(groups.value);
  }

  function createGroup(input: { name: string; databaseType: DatabaseType; targets: readonly MultiDbExecutionTarget[]; resolveDatabaseType: SqlExecutionTargetDatabaseTypeResolver }): SqlExecutionTargetGroup {
    const timestamp = nowIso();
    const group: SqlExecutionTargetGroup = {
      id: uuid(),
      name: assertGroupName(input.name),
      databaseType: input.databaseType,
      targets: assertTargets(input.targets, input.databaseType, input.resolveDatabaseType),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    groups.value = [...groups.value, group];
    persist();
    return group;
  }

  function updateGroup(id: string, input: { name?: string; targets?: readonly MultiDbExecutionTarget[]; resolveDatabaseType: SqlExecutionTargetDatabaseTypeResolver }): SqlExecutionTargetGroup | undefined {
    const existing = groups.value.find((group) => group.id === id);
    if (!existing) return undefined;
    const updated: SqlExecutionTargetGroup = {
      ...existing,
      ...(input.name !== undefined ? { name: assertGroupName(input.name, id) } : {}),
      ...(input.targets !== undefined ? { targets: assertTargets(input.targets, existing.databaseType, input.resolveDatabaseType) } : {}),
      updatedAt: nowIso(),
    };
    groups.value = groups.value.map((group) => (group.id === id ? updated : group));
    persist();
    return updated;
  }

  function deleteGroup(id: string): void {
    groups.value = groups.value.filter((group) => group.id !== id);
    persist();
  }

  function markGroupUsed(id: string): SqlExecutionTargetGroup | undefined {
    const existing = groups.value.find((group) => group.id === id);
    if (!existing) return undefined;
    const updated = { ...existing, lastUsedAt: nowIso() };
    groups.value = groups.value.map((group) => (group.id === id ? updated : group));
    persist();
    return updated;
  }

  function getGroup(id: string): SqlExecutionTargetGroup | undefined {
    return groups.value.find((group) => group.id === id);
  }

  function getGroupsByDatabaseType(databaseType?: DatabaseType): SqlExecutionTargetGroup[] {
    return sortGroups(databaseType ? groups.value.filter((group) => group.databaseType === databaseType) : groups.value);
  }

  function replaceTargets(id: string, targets: readonly MultiDbExecutionTarget[], resolveDatabaseType: SqlExecutionTargetDatabaseTypeResolver): SqlExecutionTargetGroup | undefined {
    return updateGroup(id, { targets, resolveDatabaseType });
  }

  function cloneGroup(id: string, name: string, targets: readonly MultiDbExecutionTarget[] | undefined, resolveDatabaseType: SqlExecutionTargetDatabaseTypeResolver): SqlExecutionTargetGroup | undefined {
    const existing = getGroup(id);
    if (!existing) return undefined;
    return createGroup({
      name,
      databaseType: existing.databaseType,
      targets: targets ?? existing.targets,
      resolveDatabaseType,
    });
  }

  function normalizeTarget(target: MultiDbExecutionTarget): MultiDbExecutionTarget | undefined {
    return normalizeMultiDbExecutionTarget(target);
  }

  return {
    groups,
    createGroup,
    updateGroup,
    replaceTargets,
    cloneGroup,
    deleteGroup,
    markGroupUsed,
    getGroup,
    getGroupsByDatabaseType,
    normalizeTarget,
  };
});

export { STORAGE_KEY as SQL_EXECUTION_TARGET_GROUPS_STORAGE_KEY };
