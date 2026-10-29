import { describe, expect, it } from "vitest";
import { countSelectedTableFilters, selectedTableFilters, TRANSFER_TABLE_FILTER_TYPES, transferTableFilterSupported } from "../transferTableFilters";

describe("transferTableFilters", () => {
  it("accepts the dialects the backend can page with a filter", () => {
    for (const dbType of TRANSFER_TABLE_FILTER_TYPES) {
      expect(transferTableFilterSupported(dbType), dbType).toBe(true);
    }
    // The issue that motivated the wider list: Dameng users could not filter.
    expect(transferTableFilterSupported("dameng")).toBe(true);
    expect(transferTableFilterSupported("oracle")).toBe(true);
    expect(transferTableFilterSupported("sqlserver")).toBe(true);
    expect(transferTableFilterSupported("sqlite")).toBe(true);
  });

  it("rejects sources whose reads do not page through SQL", () => {
    for (const dbType of ["mongodb", "redis", "mq", "hive", "clickhouse", "jdbc"]) {
      expect(transferTableFilterSupported(dbType), dbType).toBe(false);
    }
    expect(transferTableFilterSupported(undefined)).toBe(false);
    expect(transferTableFilterSupported(null)).toBe(false);
    expect(transferTableFilterSupported("")).toBe(false);
  });

  it("keeps only filters for selected tables and drops blank ones", () => {
    const filters = { orders: "id <= 90000", users: "   ", logs: "created_at > '2024-01-01'", legacy: "id > 0" };
    expect(selectedTableFilters(filters, new Set(["orders", "users", "logs"]))).toEqual({
      logs: "created_at > '2024-01-01'",
      orders: "id <= 90000",
    });
  });

  it("passes a plain array of selected tables too", () => {
    expect(selectedTableFilters({ b: "id = 1", a: "id = 2" }, ["a", "b"])).toEqual({ a: "id = 2", b: "id = 1" });
  });

  it("counts only the filters that will be sent", () => {
    const filters = { orders: "id <= 90000", users: "  ", logs: "id > 0" };
    expect(countSelectedTableFilters(filters, new Set(["orders", "users"]))).toBe(1);
    expect(countSelectedTableFilters(filters, new Set(["orders", "users", "logs"]))).toBe(2);
    expect(countSelectedTableFilters({}, new Set(["orders"]))).toBe(0);
  });
});
