import { describe, expect, it } from "vitest";
import { supportsDataDictionary, supportsSchemaDiagram } from "@/lib/database/databaseFeatureSupport";

describe("supportsDataDictionary", () => {
  it("is available for relational engines, including ones without a diagram", () => {
    expect(supportsDataDictionary("mysql")).toBe(true);
    expect(supportsDataDictionary("oracle")).toBe(true);
    expect(supportsDataDictionary("postgres")).toBe(true);
    expect(supportsDataDictionary("doris")).toBe(true);
    expect(supportsSchemaDiagram("doris")).toBe(false);
  });

  it("is hidden for engines that cannot list table metadata", () => {
    expect(supportsDataDictionary("redis")).toBe(false);
    expect(supportsDataDictionary("plugin")).toBe(false);
  });
});
