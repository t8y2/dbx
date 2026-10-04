// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_KEY = "dbx-data-compare-configs";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    sourceConnectionId: "src",
    sourceDatabase: "app",
    sourceSchema: "public",
    selectedSourceTables: ["users", "orders"],
    targetConnectionId: "dst",
    targetDatabase: "app_copy",
    targetSchema: "public",
    targetTable: "users",
    detailPreviewLimit: "100",
    keyColumnsByTable: { users: ["user_id"] },
    ...overrides,
  };
}

describe("useDataCompareConfig", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("creates a config and persists the whole selection", async () => {
    const { useDataCompareConfig } = await import("../useDataCompareConfig");
    const state = useDataCompareConfig();

    const created = state.createConfig("Nightly", snapshot());

    expect(state.activeConfigId.value).toBe(created.id);
    expect(state.activeConfig.value?.name).toBe("Nightly");
    const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "[]") as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.selectedSourceTables).toEqual(["users", "orders"]);
    expect(stored[0]!.keyColumnsByTable).toEqual({ users: ["user_id"] });
  });

  it("keeps config names unique instead of silently overwriting", async () => {
    const { useDataCompareConfig } = await import("../useDataCompareConfig");
    const state = useDataCompareConfig();

    state.createConfig("Same", snapshot());
    state.createConfig("Same", snapshot());

    expect(state.configs.value.map((config) => config.name)).toEqual(["Same (1)", "Same"]);
    state.renameConfig(state.configs.value[1]!.id, "Same (1)");
    expect(state.configs.value.map((config) => config.name)).toEqual(["Same (1)", "Same (1) (1)"]);
  });

  it("drops the active selection when the active config is deleted", async () => {
    const { useDataCompareConfig } = await import("../useDataCompareConfig");
    const state = useDataCompareConfig();
    const created = state.createConfig("One", snapshot());

    state.deleteConfig(created.id);

    expect(state.configs.value).toHaveLength(0);
    expect(state.activeConfigId.value).toBe("");
    expect(state.activeConfig.value).toBeNull();
  });

  it("duplicates a config under a new id without sharing mutable arrays", async () => {
    const { useDataCompareConfig } = await import("../useDataCompareConfig");
    const state = useDataCompareConfig();
    const created = state.createConfig("Base", snapshot());

    const copy = state.duplicateConfig(created.id);

    expect(copy?.id).not.toBe(created.id);
    expect(copy?.name).toBe("Base (1)");
    expect(state.activeConfigId.value).toBe(copy?.id);
    copy!.selectedSourceTables.push("logs");
    expect(created.selectedSourceTables).toEqual(["users", "orders"]);
  });

  it("updates a config in place and bumps updatedAt", async () => {
    const { useDataCompareConfig } = await import("../useDataCompareConfig");
    const state = useDataCompareConfig();
    const created = state.createConfig("One", snapshot());
    created.updatedAt = 1;

    state.updateConfig(created.id, { selectedSourceTables: ["logs"], keyColumnsByTable: {} });

    const updated = state.configs.value.find((config) => config.id === created.id);
    expect(updated?.selectedSourceTables).toEqual(["logs"]);
    expect(updated?.keyColumnsByTable).toEqual({});
    expect(updated?.updatedAt).toBeGreaterThan(1);
  });

  it("sanitizes stored configs and preserves an explicitly cleared match-column list", async () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify([{ name: "Valid", id: "a", selectedSourceTables: ["t", 5], keyColumnsByTable: { t: [], u: "bad" } }, { id: "no-name", name: "" }, "not-an-object"]));

    const { useDataCompareConfig } = await import("../useDataCompareConfig");
    const state = useDataCompareConfig();

    expect(state.configs.value).toHaveLength(1);
    expect(state.configs.value[0]!.selectedSourceTables).toEqual(["t"]);
    expect(state.configs.value[0]!.keyColumnsByTable).toEqual({ t: [] });
    expect(state.configs.value[0]!.detailPreviewLimit).toBe("");
  });

  it("recovers from unreadable stored JSON", async () => {
    localStorage.setItem(CONFIG_KEY, "{not json");

    const { useDataCompareConfig } = await import("../useDataCompareConfig");
    const state = useDataCompareConfig();

    expect(state.configs.value).toEqual([]);
    expect(state.activeConfig.value).toBeNull();
  });
});
