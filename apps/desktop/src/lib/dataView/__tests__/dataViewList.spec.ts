import { describe, expect, it } from "vitest";
import { filterDataViewSummaries } from "../dataViewList";
import type { DataViewSummary } from "@/types/dataView";

function summary(overrides: Partial<DataViewSummary> = {}): DataViewSummary {
  return {
    id: "view-1",
    name: "Revenue",
    description: "Monthly revenue by region",
    defaultDisplayMode: "table",
    queryCount: 1,
    ownerId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterDataViewSummaries", () => {
  it("returns all summaries for an empty or whitespace query", () => {
    const summaries = [summary({ id: "a" }), summary({ id: "b" })];
    expect(filterDataViewSummaries(summaries, "")).toBe(summaries);
    expect(filterDataViewSummaries(summaries, "   ")).toBe(summaries);
  });

  it("matches the name case-insensitively after trimming the query", () => {
    const summaries = [summary({ id: "a", name: "Revenue", description: null }), summary({ id: "b", name: "Customers", description: null })];
    expect(filterDataViewSummaries(summaries, "  rev").map((s) => s.id)).toEqual(["a"]);
    expect(filterDataViewSummaries(summaries, "CUSTOMERS").map((s) => s.id)).toEqual(["b"]);
  });

  it("matches the description when the name does not match", () => {
    const summaries = [summary({ id: "a", name: "Report A", description: "Monthly revenue by region" }), summary({ id: "b", name: "Report B", description: "Open ticket counts" })];
    expect(filterDataViewSummaries(summaries, "revenue").map((s) => s.id)).toEqual(["a"]);
  });

  it("treats a null description as no match", () => {
    const summaries = [summary({ id: "a", name: "Report A", description: null }), summary({ id: "b", name: "Report B", description: "revenue numbers" })];
    expect(filterDataViewSummaries(summaries, "revenue").map((s) => s.id)).toEqual(["b"]);
  });

  it("returns no summaries when nothing matches", () => {
    expect(filterDataViewSummaries([summary({ name: "Revenue" })], "zzz")).toEqual([]);
  });
});
