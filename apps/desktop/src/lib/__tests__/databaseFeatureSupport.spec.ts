import { describe, expect, it } from "vitest";
import { supportsTransaction } from "@/lib/databaseFeatureSupport";

describe("supportsTransaction", () => {
  it("returns true for supported database types", () => {
    expect(supportsTransaction("postgres")).toBe(true);
    expect(supportsTransaction("mysql")).toBe(true);
  });

  it("returns false for unsupported database types", () => {
    expect(supportsTransaction("redis")).toBe(false);
    expect(supportsTransaction("mongodb")).toBe(false);
    expect(supportsTransaction("duckdb")).toBe(false);
    expect(supportsTransaction("qdrant")).toBe(false);
    expect(supportsTransaction("turso")).toBe(false);
    expect(supportsTransaction("sqlite")).toBe(false);
    expect(supportsTransaction("clickhouse")).toBe(false);
    expect(supportsTransaction("sqlserver")).toBe(false);
    expect(supportsTransaction("oracle")).toBe(false);
    expect(supportsTransaction("dameng")).toBe(false);
    expect(supportsTransaction("rqlite")).toBe(false);
    expect(supportsTransaction("agent")).toBe(false);
  });

  it("returns false for undefined or empty input", () => {
    expect(supportsTransaction(undefined)).toBe(false);
  });
});
