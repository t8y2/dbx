// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_KEY = "dbx-schema-diff-configs";
const HISTORY_KEY = "dbx-schema-diff-history";

function storedConfig(compareCharset?: boolean) {
  return {
    id: "saved",
    name: "Saved",
    createdAt: 1,
    updatedAt: 1,
    sourceConnectionId: "source",
    sourceDatabase: "app",
    sourceSchema: "",
    targetConnectionId: "target",
    targetDatabase: "app_copy",
    targetSchema: "",
    options: {
      tables: true,
      ...(compareCharset === undefined ? {} : { compareCharset }),
    },
  };
}

describe("schema diff charset option persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("migrates legacy saved configs and history entries to comparison enabled", async () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify([storedConfig()]));
    localStorage.setItem(HISTORY_KEY, JSON.stringify([storedConfig()]));

    const { useSchemaDiffConfig } = await import("../useSchemaDiffConfig");
    const state = useSchemaDiffConfig();

    expect(state.configs.value[0].options.compareCharset).toBe(true);
    expect(state.recentConfigs.value[0].options.compareCharset).toBe(true);
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "[]")[0].options.compareCharset).toBe(true);
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]")[0].options.compareCharset).toBe(true);
  });

  it("preserves and persists an explicitly disabled value", async () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify([storedConfig(false)]));

    const { useSchemaDiffConfig } = await import("../useSchemaDiffConfig");
    const state = useSchemaDiffConfig();
    state.activeConfigId.value = "saved";

    expect(state.activeConfig.value?.options.compareCharset).toBe(false);
    state.updateActiveConfigOptions({ ...state.activeConfig.value!.options, compareCharset: false });
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "[]")[0].options.compareCharset).toBe(false);
  });

  it("migrates legacy imported configs before persisting them", async () => {
    const { useSchemaDiffConfig } = await import("../useSchemaDiffConfig");
    const state = useSchemaDiffConfig();

    expect(state.importConfigs(JSON.stringify(storedConfig()), "replace")).toEqual({ imported: 1, renamed: 0 });
    expect(state.configs.value[0].options.compareCharset).toBe(true);
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "[]")[0].options.compareCharset).toBe(true);
  });
});
