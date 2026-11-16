import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildNacosContentReplacePlan } from "../nacosContentReplace";
import { applyWithNacosHistory, rollbackFromNacosHistory, nacosHistoryTarget, withNacosHistoryLock } from "../nacosReplaceHistory";
import type { NacosReplaceHistoryEntry } from "../nacosReplaceHistory";
import type { NacosConfigItem, NacosConfigUpsert } from "@/types/nacos";

const storage = vi.hoisted(() => ({ saveNacosReplaceHistory: vi.fn(), getNacosReplaceHistory: vi.fn() }));
vi.mock("../nacosReplaceHistoryStorage", () => storage);
const saved = new Map<string, NacosReplaceHistoryEntry>();
const original: NacosConfigItem = { namespace: "public", group: "test", dataId: "one", content: "mysql-old", md5: "before" };
const target = "test-endpoint";
let current: NacosConfigItem;
const backend = {
  getConfig: vi.fn(async () => ({ ...current })),
  publishConfig: vi.fn(async (req: NacosConfigUpsert) => {
    current = { ...current, ...req, md5: req.content === original.content ? "before" : "after" };
  }),
};
beforeEach(() => {
  vi.clearAllMocks();
  saved.clear();
  current = { ...original };
  storage.saveNacosReplaceHistory.mockImplementation(async (entry: NacosReplaceHistoryEntry) => {
    saved.set(entry.id, structuredClone(entry));
  });
  storage.getNacosReplaceHistory.mockImplementation(async (id: string) => structuredClone(saved.get(id)));
});
function apply() {
  return applyWithNacosHistory("main", target, { scope: "allNamespaces", namespace: "public", group: "", dataId: "" }, buildNacosContentReplacePlan([original], "mysql-old", "mysql-new"), backend);
}
describe("durable Nacos batch journal", () => {
  it("saves snapshots before publishing and rolls back a reloaded historical batch", async () => {
    backend.publishConfig.mockImplementationOnce(async (req) => {
      const persisted = [...saved.values()][0];
      expect(persisted.plan.items[0].beforeContent).toBe("mysql-old");
      expect(persisted.inFlight).toEqual({ key: persisted.plan.items[0].key, phase: "apply" });
      current = { ...current, ...req, md5: "after" };
    });
    const entry = await apply();
    expect(saved.get(entry.id)?.state).toBe("completed");
    const restored = await rollbackFromNacosHistory(entry.id, "main", target, backend);
    expect(restored.rollback?.restored).toBe(1);
    expect(current.content).toBe("mysql-old");
    await rollbackFromNacosHistory(entry.id, "main", target, backend);
    expect(backend.publishConfig).toHaveBeenCalledTimes(2);
  });
  it("does not publish when initial backup storage fails", async () => {
    storage.saveNacosReplaceHistory.mockRejectedValueOnce(new Error("quota"));
    await expect(apply()).rejects.toThrow("quota");
    expect(backend.publishConfig).not.toHaveBeenCalled();
  });
  it("preserves an uncertain write and never treats it as a confirmed rollback candidate", async () => {
    storage.saveNacosReplaceHistory
      .mockImplementationOnce(async (entry) => {
        saved.set(entry.id, structuredClone(entry));
      })
      .mockImplementationOnce(async (entry) => {
        saved.set(entry.id, structuredClone(entry));
      })
      .mockRejectedValueOnce(new Error("quota"));
    await expect(apply()).rejects.toThrow("quota");
    const entry = [...saved.values()][0];
    expect(entry.inFlight?.phase).toBe("apply");
    await rollbackFromNacosHistory(entry.id, "main", target, backend);
    expect(backend.publishConfig).toHaveBeenCalledTimes(1);
  });
  it("rejects another connection or changed target before any rollback reads/writes", async () => {
    const entry = await apply();
    backend.getConfig.mockClear();
    backend.publishConfig.mockClear();
    await expect(rollbackFromNacosHistory(entry.id, "other", target, backend)).rejects.toThrow(/target/i);
    await expect(rollbackFromNacosHistory(entry.id, "main", "changed", backend)).rejects.toThrow(/target/i);
    expect(backend.getConfig).not.toHaveBeenCalled();
    expect(backend.publishConfig).not.toHaveBeenCalled();
  });
  it("records rollback conflicts without overwriting subsequent edits and permits retry", async () => {
    const entry = await apply();
    current = { ...current, content: "someone else's change", md5: "other" };
    const conflict = await rollbackFromNacosHistory(entry.id, "main", target, backend);
    expect(conflict.rollback?.conflicts).toBe(1);
    expect(backend.publishConfig).toHaveBeenCalledTimes(1);
    current = { ...current, content: "mysql-new", md5: "after" };
    expect((await rollbackFromNacosHistory(entry.id, "main", target, backend)).rollback?.restored).toBe(1);
  });
  it("stops a rollback when its durable checkpoint fails", async () => {
    const entry = await apply();
    backend.publishConfig.mockClear();
    storage.saveNacosReplaceHistory.mockRejectedValueOnce(new Error("quota"));
    await expect(rollbackFromNacosHistory(entry.id, "main", target, backend)).rejects.toThrow("quota");
    expect(backend.publishConfig).not.toHaveBeenCalled();
  });
  it("retains uncertain items across partial rollback retries without republishing already restored items", async () => {
    const configs = ["one", "two", "three"].map((dataId) => ({ ...original, dataId }));
    const rows = new Map(configs.map((item) => [item.dataId, item]));
    const live = {
      getConfig: async (key: { dataId: string }) => ({ ...rows.get(key.dataId)! }),
      publishConfig: vi.fn(async (req: NacosConfigUpsert) => {
        rows.set(req.dataId, { ...rows.get(req.dataId)!, ...req, md5: req.content === "mysql-old" ? "before" : "after" });
      }),
    };
    const entry = await applyWithNacosHistory("main", target, { scope: "allNamespaces", namespace: "public", group: "", dataId: "" }, buildNacosContentReplacePlan(configs, "mysql-old", "mysql-new"), live);
    let failOnce = true;
    storage.saveNacosReplaceHistory.mockImplementation(async (candidate) => {
      if (failOnce && candidate.state === "rollingBack" && candidate.rollback?.items.length === 2 && !candidate.inFlight) {
        failOnce = false;
        throw new Error("quota");
      }
      saved.set(candidate.id, structuredClone(candidate));
    });
    await expect(rollbackFromNacosHistory(entry.id, "main", target, live)).rejects.toThrow("quota");
    expect(saved.get(entry.id)?.rollback?.restored).toBe(1);
    expect(saved.get(entry.id)?.inFlight?.key).toBe(entry.plan.items[1].key);
    const retried = await rollbackFromNacosHistory(entry.id, "main", target, live);
    expect(retried.rollback?.restored).toBe(2);
    expect(retried.uncertainItems).toEqual([{ key: entry.plan.items[1].key, phase: "rollback" }]);
    await rollbackFromNacosHistory(entry.id, "main", target, live);
    expect(live.publishConfig).toHaveBeenCalledTimes(6);
  });
  it("binds target identity to endpoints but excludes credentials", () => {
    const connection = { id: "main", host: "localhost", port: 8848, external_config: { serverAddr: "http://localhost:8848", contextPath: "/nacos", auth: { password: "secret" } } };
    const identity = nacosHistoryTarget(connection);
    expect(identity).not.toContain("secret");
    expect(nacosHistoryTarget({ ...connection, external_config: { ...connection.external_config, serverAddr: "http://other:8848" } })).not.toBe(identity);
  });
  it("rejects an overlapping operation across tabs", async () => {
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, cb: (lock: null) => unknown) => cb(null) } });
    const action = vi.fn();
    await expect(withNacosHistoryLock("main", action)).rejects.toThrow(/busy/i);
    expect(action).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
