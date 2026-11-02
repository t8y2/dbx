import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, it, vi } from "vitest";
import { defaultRedisKeyGrouping } from "@/lib/redis/redisKeyGrouping";

beforeEach(() => {
  vi.resetModules();
  setActivePinia(createPinia());
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

it("persists presentation without reconnecting and keeps old config after failure", async () => {
  const saveConnections = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({ saveConnections }));
  const { useConnectionStore } = await import("../connectionStore");
  const store = useConnectionStore();
  store.addEphemeralConnection({ id: "group-test", name: "Redis", db_type: "redis", host: "localhost", port: 6379, username: "", password: "" });
  const config = { ...defaultRedisKeyGrouping(), enabled: true };
  await store.updateRedisKeyGrouping("group-test", config);
  expect(saveConnections).toHaveBeenCalledWith([expect.objectContaining({ redis_key_grouping: config })]);
  expect(store.connectedIds.has("group-test")).toBe(true);
  saveConnections.mockRejectedValueOnce(new Error("disk full"));
  await expect(store.updateRedisKeyGrouping("group-test", { ...config, enabled: false })).rejects.toThrow("disk full");
  expect(store.getConfig("group-test")?.redis_key_grouping?.enabled).toBe(true);
});
