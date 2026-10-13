// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MONGO_COMPARE_CONFIG_KEY, mongoCompareConfigSnapshot, useMongoCompareConfigs } from "../useMongoCompareConfigs";

const snapshot = () =>
  mongoCompareConfigSnapshot({
    source: { connectionId: "source", database: "db", collection: "a", filter: '{"active":true}', password: "secret" },
    target: { connectionId: "target", database: "db", collection: "b" },
    matchFields: "customer.id,region",
    ignoredFields: "updatedAt",
    limit: 25000,
    batchMode: true,
    numericTypesEqual: true,
    pairs: [{ source: "a", target: "b", enabled: true, matchFields: "sku" }],
    results: [{ password: "secret" }],
  });
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Mongo comparison saved configurations", () => {
  it("round trips endpoint filters, mappings and rules without documents or credentials", () => {
    const configs = useMongoCompareConfigs();
    expect(configs.save("Production → Test", snapshot())).toBe(true);
    expect(useMongoCompareConfigs().configs.value[0]).toMatchObject(snapshot());
    const saved = localStorage.getItem(MONGO_COMPARE_CONFIG_KEY)!;
    expect(saved).not.toContain("secret");
    expect(saved).not.toContain("results");
    const changed = snapshot();
    changed.pairs[0].target = "changed";
    expect(configs.configs.value[0].pairs[0].target).toBe("b");
  });

  it("renames, duplicates and deletes a configuration without touching its original", () => {
    const configs = useMongoCompareConfigs();
    configs.save("First", snapshot());
    const original = configs.activeId.value;
    configs.save("Renamed", snapshot());
    expect(configs.configs.value).toHaveLength(1);
    configs.save("Copy", snapshot(), true);
    expect(configs.configs.value).toHaveLength(2);
    expect(configs.activeId.value).not.toBe(original);
    configs.remove();
    expect(configs.configs.value.map((item) => item.name)).toEqual(["Renamed"]);
    expect(configs.activeId.value).toBe("");
  });

  it("does not report a successful save or delete when storage fails", () => {
    const configs = useMongoCompareConfigs();
    configs.save("First", snapshot());
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    try {
      expect(configs.save("Second", snapshot(), true)).toBe(false);
      expect(configs.remove()).toBe(false);
      expect(configs.storageError.value).toBe(true);
      expect(configs.configs.value.map((item) => item.name)).toEqual(["First"]);
    } finally {
      setItem.mockRestore();
    }
  });

  it("handles corrupt storage and sanitizes malformed saved values", () => {
    localStorage.setItem(MONGO_COMPARE_CONFIG_KEY, "broken JSON");
    expect(useMongoCompareConfigs().storageError.value).toBe(true);
    localStorage.setItem(MONGO_COMPARE_CONFIG_KEY, JSON.stringify([null, { id: "a", name: "Valid", source: [], limit: -1, pairs: [null] }, { id: "a", name: "Duplicate" }]));
    const configs = useMongoCompareConfigs().configs.value;
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ limit: 10000, source: { connectionId: "" }, pairs: [{ source: "", target: "" }] });
  });
});
