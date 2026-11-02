import { describe, expect, it } from "vitest";
import { buildInceptorCreateOptions, emptyTablePhysicalOptions, hasTablePhysicalOptions, pruneTablePhysicalOptions, restoreTablePhysicalOptions } from "@/lib/table/tablePhysicalOptions";

const columns = [
  { id: "first", name: "id" },
  { id: "second", name: "day" },
  { id: "third", name: "label" },
];

describe("table physical options", () => {
  it("restores a saved draft without sharing its column selections", () => {
    const saved = { physicalOptions: { partitionColumnIds: ["second"], distributionColumnIds: ["first"], bucketCount: "2", storageFormat: "ORC", transactional: true } };
    const restored = restoreTablePhysicalOptions(saved);
    expect(restored).toMatchObject({ partitionColumnIds: ["second"], distributionColumnIds: ["first"], bucketCount: "2", storageFormat: "ORC", transactional: true });
    expect(restored.partitionColumnIds).not.toBe(saved.physicalOptions.partitionColumnIds);
    expect(restored.distributionColumnIds).not.toBe(saved.physicalOptions.distributionColumnIds);
    expect(restoreTablePhysicalOptions({})).toEqual(emptyTablePhysicalOptions());
    expect(hasTablePhysicalOptions(restored)).toBe(true);
    expect(hasTablePhysicalOptions(emptyTablePhysicalOptions())).toBe(false);
  });

  it("uses the current column name after a selected column is renamed", () => {
    const draft = { ...emptyTablePhysicalOptions(), partitionColumnIds: ["second"], distributionColumnIds: ["first"], bucketCount: "2", storageFormat: "ORC", transactional: true };
    const renamed = columns.map((column) => (column.id === "second" ? { ...column, name: "event_day" } : column));
    expect(buildInceptorCreateOptions(draft, renamed)).toEqual({
      partitionColumns: ["event_day"],
      bucketColumns: ["id"],
      bucketCount: 2,
      storageFormat: "ORC",
      transactional: true,
    });
    expect(pruneTablePhysicalOptions(draft, new Set(["first", "third"]))).toMatchObject({ partitionColumnIds: [], distributionColumnIds: ["first"] });
  });

  it("keeps an invalid bucket count in the SQL builder's validation path", () => {
    const draft = { ...emptyTablePhysicalOptions(), distributionColumnIds: ["first"], bucketCount: "1.5" };
    expect(buildInceptorCreateOptions(draft, columns).bucketCount).toBe(0);
  });
});
