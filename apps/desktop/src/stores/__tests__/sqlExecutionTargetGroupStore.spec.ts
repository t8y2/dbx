import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSqlExecutionTargetGroupStore } from "@/stores/sqlExecutionTargetGroupStore";
import { SQL_EXECUTION_TARGET_GROUPS_STORAGE_KEY } from "@/stores/sqlExecutionTargetGroupStore";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  return data;
}

const targets = [
  { connectionId: "conn-1", database: "app", schema: "public" },
  { connectionId: "conn-2", database: "app", schema: "public" },
] as const;

const resolveDatabaseType = () => "postgres" as const;

describe("sqlExecutionTargetGroupStore", () => {
  beforeEach(() => {
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("deduplicates targets and persists reusable target references", () => {
    const store = useSqlExecutionTargetGroupStore();
    const group = store.createGroup({
      name: "Production",
      databaseType: "postgres",
      targets: [...targets, targets[0]],
      resolveDatabaseType,
    });

    expect(group.targets).toHaveLength(2);
    expect(group.targets[0]).toEqual(targets[0]);
    expect(JSON.parse(globalThis.localStorage.getItem(SQL_EXECUTION_TARGET_GROUPS_STORAGE_KEY) || "{}")).not.toHaveProperty("password");

    setActivePinia(createPinia());
    const reloaded = useSqlExecutionTargetGroupStore();
    expect(reloaded.getGroup(group.id)?.targets).toEqual([...targets]);
  });

  it("rejects duplicate names case-insensitively and supports update/clone/delete", () => {
    const store = useSqlExecutionTargetGroupStore();
    const group = store.createGroup({ name: "Shared", databaseType: "mysql", targets: [targets[0]], resolveDatabaseType: () => "mysql" });

    expect(() => store.createGroup({ name: " shared ", databaseType: "mysql", targets: [targets[1]], resolveDatabaseType: () => "mysql" })).toThrow("目标组名称已存在");
    const updated = store.updateGroup(group.id, { name: "Shared App", targets: [targets[1]], resolveDatabaseType: () => "mysql" });
    expect(updated?.name).toBe("Shared App");
    expect(updated?.targets).toEqual([targets[1]]);

    const clone = store.cloneGroup(group.id, "Shared Copy", undefined, () => "mysql");
    expect(clone?.id).not.toBe(group.id);
    expect(clone?.targets).toEqual([targets[1]]);

    store.deleteGroup(group.id);
    expect(store.getGroup(group.id)).toBeUndefined();
    expect(store.getGroup(clone!.id)).toBeDefined();
  });

  it("rejects a mixed effective database type at the store boundary", () => {
    const store = useSqlExecutionTargetGroupStore();
    expect(() =>
      store.createGroup({
        name: "Mixed",
        databaseType: "postgres",
        targets,
        resolveDatabaseType: (target) => (target.connectionId === "conn-1" ? "postgres" : "mysql"),
      }),
    ).toThrow("目标组只能包含同一种数据库类型");
  });
});
