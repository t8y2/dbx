import { describe, expect, it } from "vitest";
import { CLICKHOUSE_FUNCTION_REGISTRY, createClickHouseFunctionRegistry } from "@/lib/sql/clickhouse/functionRegistry";
import { CLICKHOUSE_FUNCTION_CATEGORY_MANIFEST, CLICKHOUSE_REGULAR_FUNCTIONS } from "@/lib/sql/clickhouse/regularFunctions";
import { CLICKHOUSE_TABLE_FUNCTIONS } from "@/lib/sql/clickhouse/tableFunctions";
import type { ClickHouseFunctionDefinition } from "@/lib/sql/clickhouse/functionTypes";

const toStartOfDay: ClickHouseFunctionDefinition = {
  name: "toStartOfDay",
  kind: "regular",
  category: "date-time",
  signatures: [{ parameterGroups: [["value", "time_zone?"]], returnType: "DateTime" }],
  aliases: ["startOfDay"],
};

describe("ClickHouse function registry", () => {
  it("looks up canonical names case-insensitively and preserves overloads", () => {
    const registry = createClickHouseFunctionRegistry([toStartOfDay]);

    expect(registry.get("TOSTARTOFDAY")).toEqual(toStartOfDay);
    expect(registry.search("tostart", 20)).toEqual([toStartOfDay]);
    expect(registry.search("startof", 20)).toEqual([toStartOfDay]);
  });

  it("rejects duplicate canonical names case-insensitively", () => {
    expect(() => createClickHouseFunctionRegistry([toStartOfDay, { ...toStartOfDay, name: "TOSTARTOFDAY" }])).toThrow(/duplicate/i);
  });

  it("rejects an invalid preferred signature index", () => {
    expect(() => createClickHouseFunctionRegistry([{ ...toStartOfDay, preferredSignature: 2 }])).toThrow(/preferred signature/i);
  });

  it("keeps the checked-in category manifest and inventory counts aligned", () => {
    for (const entry of CLICKHOUSE_FUNCTION_CATEGORY_MANIFEST) {
      expect(CLICKHOUSE_REGULAR_FUNCTIONS.filter((definition) => definition.category === entry.category)).toHaveLength(entry.minimumCount);
    }
  });

  it.each([
    ["arrayMap", "array"],
    ["toStartOfDay", "date-time"],
    ["JSONExtractString", "json"],
    ["cityHash64", "hash"],
    ["URLHierarchy", "url"],
    ["lagInFrame", "window"],
  ] as const)("contains %s with canonical casing and category %s", (name, category) => {
    expect(CLICKHOUSE_FUNCTION_REGISTRY.get(name)).toMatchObject({ name, category });
  });

  it("treats names shared with Object.prototype as ordinary ClickHouse functions", () => {
    expect(CLICKHOUSE_FUNCTION_REGISTRY.get("toString")?.signatures.length).toBeGreaterThan(0);
  });

  it("models window function aliases and exact argument lists", () => {
    for (const name of ["rank", "dense_rank", "denseRank", "percent_rank", "percentRank", "cume_dist"] as const) {
      expect(CLICKHOUSE_FUNCTION_REGISTRY.get(name)).toMatchObject({ kind: "window", signatures: [{ parameterGroups: [[]] }] });
    }
    expect(CLICKHOUSE_FUNCTION_REGISTRY.get("ntile")).toMatchObject({
      kind: "window",
      signatures: [{ parameterGroups: [["buckets"]] }],
    });
  });

  it.each(["numbers", "file", "url", "s3", "remote", "postgresql", "mysql"] as const)("contains the %s table function", (name) => {
    expect(CLICKHOUSE_TABLE_FUNCTIONS.some((definition) => definition.name === name && definition.kind === "table")).toBe(true);
  });
});
