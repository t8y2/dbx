import { describe, expect, it } from "vitest";
import { getConcurrentIndexAvailability, concurrentIndexNamesInStatements, normalizeUnsupportedConcurrentIndexes } from "@/lib/table/concurrentIndexAvailability";

describe("getConcurrentIndexAvailability (Plan A scope guards)", () => {
  const base = {
    hasOriginal: false,
    isPrimary: false,
    markedForDrop: false,
    isPartitionedParent: false,
    partitionStatusKnown: true,
    supportsIndexConcurrent: true,
    supportsCreateIndex: true,
  };

  it("enables Concurrent for a new index on a normal non-partitioned PostgreSQL table", () => {
    expect(getConcurrentIndexAvailability(base)).toEqual({ enabled: true });
  });

  it("disables Concurrent when editing an existing index", () => {
    expect(getConcurrentIndexAvailability({ ...base, hasOriginal: true })).toEqual({
      enabled: false,
      reason: "existing",
    });
  });

  it("disables Concurrent on a partitioned parent table", () => {
    expect(getConcurrentIndexAvailability({ ...base, isPartitionedParent: true })).toEqual({
      enabled: false,
      reason: "partitioned",
    });
  });

  it("fails closed when the partition status could not be verified", () => {
    expect(getConcurrentIndexAvailability({ ...base, partitionStatusKnown: false })).toEqual({
      enabled: false,
      reason: "unknown",
    });
  });

  it("disables Concurrent for primary indexes and drop-marked rows", () => {
    expect(getConcurrentIndexAvailability({ ...base, isPrimary: true })).toEqual({
      enabled: false,
      reason: "primary",
    });
    expect(getConcurrentIndexAvailability({ ...base, markedForDrop: true })).toEqual({
      enabled: false,
      reason: "markedForDrop",
    });
  });

  it("disables Concurrent when the engine does not advertise the capability (non-PostgreSQL)", () => {
    expect(getConcurrentIndexAvailability({ ...base, supportsIndexConcurrent: false })).toEqual({
      enabled: false,
      reason: "unsupported",
    });
    expect(getConcurrentIndexAvailability({ ...base, supportsCreateIndex: false })).toEqual({
      enabled: false,
      reason: "unsupported",
    });
  });
});

describe("concurrentIndexNamesInStatements", () => {
  it("extracts unquoted names from CREATE [UNIQUE] INDEX CONCURRENTLY statements", () => {
    expect(
      concurrentIndexNamesInStatements([
        'CREATE INDEX CONCURRENTLY "idx_users_email" ON "public"."users" ("email");',
        'CREATE UNIQUE INDEX CONCURRENTLY "uniq_users_name" ON "public"."users" ("name");',
        'CREATE INDEX "plain_idx" ON "public"."users" ("id");',
        'CREATE INDEX CONCURRENTLY "orders"."idx_orders_id" ON "orders"."orders" ("id");',
      ]),
    ).toEqual(["idx_users_email", "uniq_users_name", "idx_orders_id"]);
  });

  it("returns an empty list when no concurrent statements are present", () => {
    expect(concurrentIndexNamesInStatements([])).toEqual([]);
    expect(concurrentIndexNamesInStatements(['CREATE INDEX "idx" ON "public"."t" ("c");'])).toEqual([]);
  });
});

describe("normalizeUnsupportedConcurrentIndexes", () => {
  const enabled = () => ({ enabled: true });
  const unavailable = (reason: string) => ({ enabled: false, reason });

  it("keeps Concurrent on drafts whose availability is enabled", () => {
    const indexes = [
      { id: "a", concurrently: true },
      { id: "b", concurrently: false },
    ];
    expect(normalizeUnsupportedConcurrentIndexes(indexes, enabled)).toEqual({ indexes, invalidatedIds: [] });
  });

  it("preserves transiently unavailable intent while clearing definitively unsupported flags", () => {
    const indexes = [
      { id: "a", concurrently: true },
      { id: "b", concurrently: true },
      { id: "c", concurrently: false },
    ];
    const result = normalizeUnsupportedConcurrentIndexes(indexes, (index) => (index.id === "a" ? unavailable("existing") : unavailable("unknown")));
    expect(result.indexes).toEqual([
      { id: "a", concurrently: false },
      { id: "b", concurrently: true },
      { id: "c", concurrently: false },
    ]);
    expect(result.invalidatedIds).toEqual(["a", "b"]);
  });

  it("clears Concurrent when the table is confirmed partitioned", () => {
    const indexes = [{ id: "a", concurrently: true }];
    const result = normalizeUnsupportedConcurrentIndexes(indexes, () => unavailable("partitioned"));
    expect(result.indexes).toEqual([{ id: "a", concurrently: false }]);
    expect(result.invalidatedIds).toEqual(["a"]);
  });
});
