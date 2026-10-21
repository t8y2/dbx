import { describe, expect, it } from "vitest";
import { hasGbase8cConnectionDatabase } from "@/lib/connection/gbase8cDatabase";

describe("hasGbase8cConnectionDatabase", () => {
  it("accepts a filled database name, trimming it", () => {
    expect(hasGbase8cConnectionDatabase("  dbx_pg  ", undefined)).toBe(true);
  });

  it("rejects a missing or blank database", () => {
    expect(hasGbase8cConnectionDatabase(undefined, undefined)).toBe(false);
    expect(hasGbase8cConnectionDatabase("", undefined)).toBe(false);
    expect(hasGbase8cConnectionDatabase("  \t ", undefined)).toBe(false);
  });

  it("accepts a full connection string, which the agent prefers over host/port/database", () => {
    expect(hasGbase8cConnectionDatabase(undefined, "jdbc:gbase8c://db.example:5432/warehouse")).toBe(true);
  });

  it("still rejects a blank connection string", () => {
    expect(hasGbase8cConnectionDatabase(undefined, "   ")).toBe(false);
  });
});
