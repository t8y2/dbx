import { describe, expect, it } from "vitest";
import { hasXuguConnectionDatabase, xuguDatabaseFromConnectionString } from "@/lib/connection/xuguDatabase";

describe("Xugu connection database validation", () => {
  it("accepts a database selected in the structured field", () => {
    expect(hasXuguConnectionDatabase("  XUGU_TEST_DB  ", undefined)).toBe(true);
  });

  it("rejects a missing or whitespace-only database", () => {
    expect(hasXuguConnectionDatabase(undefined, undefined)).toBe(false);
    expect(hasXuguConnectionDatabase("  \t ", undefined)).toBe(false);
  });

  it.each(["xugu://user:password@host:5138/XUGU_TEST_DB", "jdbc:xugu://host:5138/XUGU_TEST_DB"])("accepts a database encoded in a Xugu URL: %s", (url) => {
    expect(xuguDatabaseFromConnectionString(url)).toBe("XUGU_TEST_DB");
    expect(hasXuguConnectionDatabase(undefined, url)).toBe(true);
  });

  it("accepts a database in a native Xugu DSN, including quoted separators", () => {
    expect(xuguDatabaseFromConnectionString("IP=db.example;DB='shop;east';User=app")).toBe("shop;east");
    expect(xuguDatabaseFromConnectionString("IP=db.example;DB='sales''east';User=app")).toBe("sales'east");
  });

  it("rejects a missing or empty database in a native Xugu DSN", () => {
    expect(xuguDatabaseFromConnectionString("IP=db.example;User=app")).toBeUndefined();
    expect(xuguDatabaseFromConnectionString("IP=db.example;DB=;User=app")).toBeUndefined();
    expect(xuguDatabaseFromConnectionString("IP=db.example;DB='  ';User=app")).toBeUndefined();
  });

  it("does not treat another database's URL as a Xugu database", () => {
    expect(xuguDatabaseFromConnectionString("postgres://user:password@host:5432/app")).toBeUndefined();
    expect(hasXuguConnectionDatabase(undefined, "postgres://user:password@host:5432/app")).toBe(false);
  });
});
