import { describe, expect, it } from "vitest";
import { decodeSelectableDatabaseValue, EMPTY_DATABASE_SELECT_VALUE, encodeSelectableDatabaseValue, TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE } from "@/lib/database/defaultDatabase";

describe("defaultDatabase selectable values", () => {
  it("encodes empty tree-schema databases with the default database sentinel", () => {
    expect(encodeSelectableDatabaseValue("postgres", "")).toBe(TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE);
    expect(decodeSelectableDatabaseValue("postgres", TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE)).toBe("");
  });

  it("encodes empty non-tree-schema databases with a non-empty sentinel", () => {
    expect(encodeSelectableDatabaseValue("access", "")).toBe(EMPTY_DATABASE_SELECT_VALUE);
    expect(decodeSelectableDatabaseValue("access", EMPTY_DATABASE_SELECT_VALUE)).toBe("");
  });

  it("preserves non-empty database names", () => {
    expect(encodeSelectableDatabaseValue("access", "653128SXB.mdb")).toBe("653128SXB.mdb");
    expect(decodeSelectableDatabaseValue("access", "653128SXB.mdb")).toBe("653128SXB.mdb");
  });
});
