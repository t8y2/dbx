import { describe, expect, it } from "vitest";
import { findTableStatistics } from "@/lib/dataGrid/tableInfoOverview";
import type { ObjectStatistics } from "@/types/database";

const stats: ObjectStatistics[] = [
  { name: "orders", schema: "public", estimated_rows: 100, total_bytes: 4096 },
  { name: "orders", schema: "reporting", estimated_rows: 5, total_bytes: 1024 },
  { name: "users", schema: null, estimated_rows: 42, total_bytes: 2048 },
];

describe("findTableStatistics", () => {
  it("prefers an exact schema match", () => {
    expect(findTableStatistics(stats, "orders", "reporting")?.estimated_rows).toBe(5);
    expect(findTableStatistics(stats, "orders", "public")?.estimated_rows).toBe(100);
  });

  it("falls back to a name-only match when the schema differs", () => {
    expect(findTableStatistics(stats, "users", "public")?.estimated_rows).toBe(42);
  });

  it("matches by name when no schema is given", () => {
    expect(findTableStatistics(stats, "orders")?.estimated_rows).toBe(100);
  });

  it("matches case-insensitively when drivers report inconsistent casing", () => {
    const mixed: ObjectStatistics[] = [
      { name: "Orders", schema: "PUBLIC", estimated_rows: 7, total_bytes: 512 },
      { name: "Orders", schema: "reporting", estimated_rows: 9, total_bytes: 256 },
    ];
    expect(findTableStatistics(mixed, "orders", "public")?.estimated_rows).toBe(7);
    expect(findTableStatistics(mixed, "ORDERS", "REPORTING")?.estimated_rows).toBe(9);
    expect(findTableStatistics(mixed, "orders")?.estimated_rows).toBe(7);
  });

  it("returns undefined when the table has no statistics", () => {
    expect(findTableStatistics(stats, "missing", "public")).toBeUndefined();
    expect(findTableStatistics([], "orders")).toBeUndefined();
  });
});
