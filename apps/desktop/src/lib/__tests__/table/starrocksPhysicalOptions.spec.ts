import { describe, expect, it } from "vitest";
import { buildStarRocksDialectOptions, emptyStarRocksPhysicalOptions, hasStarRocksPhysicalOptions, isStarRocksHashColumn, isStarRocksTimeColumn, restoreStarRocksPhysicalOptions } from "@/lib/table/starrocksPhysicalOptions";
import { getStarRocksCapabilities } from "@/lib/table/starrocksCapabilities";

describe("StarRocks physical options", () => {
  it("leaves partitioning off and bucket sizing automatic by default", () => {
    const draft = emptyStarRocksPhysicalOptions();
    expect(hasStarRocksPhysicalOptions(draft)).toBe(false);
    expect(buildStarRocksDialectOptions(draft)).toEqual({ starrocks: { partition: undefined, timePartition: undefined, distribution: "auto", distributionColumnIds: [], sortColumnIds: [], bucketCount: undefined } });
  });
  it("round trips drafts without sharing selected arrays and sends stable IDs", () => {
    const saved = { ...emptyStarRocksPhysicalOptions(), timePartitionEnabled: true, partitionColumnId: "time-id", distribution: "hash" as const, distributionColumnIds: ["user-id"], bucketCount: "8" };
    const restored = restoreStarRocksPhysicalOptions(saved);
    restored.distributionColumnIds.push("another-id");
    expect(saved.distributionColumnIds).toEqual(["user-id"]);
    expect(hasStarRocksPhysicalOptions(restored)).toBe(true);
    expect(buildStarRocksDialectOptions(restored).starrocks).toEqual({
      partition: undefined,
      timePartition: { columnId: "time-id", granularity: "month", additionalColumnIds: [], interval: undefined },
      distribution: "hash",
      distributionColumnIds: ["user-id", "another-id"],
      sortColumnIds: [],
      bucketCount: 8,
    });
  });
  it("does not send inactive choices after switching modes", () => {
    const draft = { ...emptyStarRocksPhysicalOptions(), partitionColumnId: "time-id", distributionColumnIds: ["user-id"], distribution: "random" as const };
    expect(buildStarRocksDialectOptions(draft).starrocks).toMatchObject({ timePartition: undefined, distributionColumnIds: [] });
  });
  it.each(["0", "-1", "1.5", "bad", "2147483648", "Infinity"])("sends invalid bucket count %s for backend rejection", (bucketCount) => {
    expect(buildStarRocksDialectOptions({ ...emptyStarRocksPhysicalOptions(), bucketCount }).starrocks?.bucketCount).toBe(0);
  });
  it.each(["date", "DATETIME"])("allows %s time partitions", (dataType) => expect(isStarRocksTimeColumn({ dataType })).toBe(true));
  it.each(["timestamp", "datetime(6)", "varchar(255)", "int"])("rejects %s time partitions", (dataType) => expect(isStarRocksTimeColumn({ dataType })).toBe(false));
  it.each(["json", "array<int>", "float", "decimal(18,2)", "varbinary(10)"])("does not offer %s as a hash key", (dataType) => expect(isStarRocksHashColumn({ dataType })).toBe(false));
  it.each(["bigint(20)", "varchar(255)", "date", "datetime"])("offers %s as a hash key", (dataType) => expect(isStarRocksHashColumn({ dataType })).toBe(true));
  it("gates modern layouts using the actual product version", () => {
    for (const version of [undefined, "5.1.0", "3.0.0"]) {
      expect(getStarRocksCapabilities(version).timePartitioning).toBe(false);
      expect(getStarRocksCapabilities(version).randomDistribution).toBe(false);
    }
    expect(getStarRocksCapabilities("3.5.0")).toMatchObject({ timePartitioning: true, randomDistribution: true });
  });
});

describe("StarRocks partition strategies", () => {
  it("keeps named bounds associated with column IDs after selection reordering", () => {
    const draft = { ...emptyStarRocksPhysicalOptions(), partitionKind: "range" as const, partitionColumnIds: ["b", "a"], rangePartitions: [{ id: "p", name: "p1", lower: { a: "1", b: "2" }, upper: { a: "10", b: "20" } }] };
    expect(buildStarRocksDialectOptions(draft).starrocks?.partition).toEqual({ kind: "range", columnIds: ["b", "a"], partitions: [{ name: "p1", lower: ["2", "1"], upper: ["20", "10"] }] });
    expect(buildStarRocksDialectOptions(draft).starrocks?.timePartition).toBeUndefined();
  });
  it("preserves commas and quotes as list values rather than parsing SQL", () => {
    const draft = { ...emptyStarRocksPhysicalOptions(), partitionKind: "list" as const, partitionColumnIds: ["city"], listPartitions: [{ id: "p", name: "p1", values: [{ id: "v", fields: { city: "Xi'an, city" } }] }] };
    expect(buildStarRocksDialectOptions(draft).starrocks?.partition).toEqual({ kind: "list", columnIds: ["city"], partitions: [{ name: "p1", values: [["Xi'an, city"]] }] });
    const restored = restoreStarRocksPhysicalOptions(draft);
    restored.listPartitions[0]!.values[0]!.fields.city = "changed";
    expect(draft.listPartitions[0]!.values[0]!.fields.city).toBe("Xi'an, city");
  });
  it("generates mixed time dimensions and interval settings", () => {
    const draft = { ...emptyStarRocksPhysicalOptions(), partitionKind: "time" as const, partitionColumnId: "dt", partitionColumnIds: ["city"], timeInterval: "7", granularity: "day" as const };
    expect(buildStarRocksDialectOptions(draft).starrocks?.timePartition).toEqual({ columnId: "dt", additionalColumnIds: ["city"], interval: 7, granularity: "day" });
  });
});

it("preserves independent sort priority across draft restoration and serialization", () => {
  const draft = { ...emptyStarRocksPhysicalOptions(), sortColumnIds: ["time", "id"] };
  expect(hasStarRocksPhysicalOptions(draft)).toBe(true);
  const restored = restoreStarRocksPhysicalOptions(draft);
  restored.sortColumnIds.reverse();
  expect(draft.sortColumnIds).toEqual(["time", "id"]);
  expect(buildStarRocksDialectOptions(restored).starrocks?.sortColumnIds).toEqual(["id", "time"]);
});
