import { describe, expect, it } from "vitest";
import { uniqueConstraintColumns } from "@/lib/table/uniqueConstraintColumns";

describe("uniqueConstraintColumns", () => {
  it("keeps columns of full single-column unique indexes and primary keys", () => {
    expect(
      uniqueConstraintColumns([
        { columns: ["id"], is_unique: true, filter: null },
        { columns: ["code"], is_unique: true, filter: null },
      ]),
    ).toEqual(new Set(["id", "code"]));
  });

  it("ignores non-unique indexes", () => {
    expect(uniqueConstraintColumns([{ columns: ["code"], is_unique: false, filter: null }]).size).toBe(0);
  });

  it("ignores composite unique indexes", () => {
    expect(uniqueConstraintColumns([{ columns: ["tenant_id", "code"], is_unique: true, filter: null }]).size).toBe(0);
  });

  it("ignores partial unique indexes", () => {
    expect(uniqueConstraintColumns([{ columns: ["code"], is_unique: true, filter: "(deleted_at IS NULL)" }]).size).toBe(0);
  });

  it("ignores expression keys", () => {
    expect(uniqueConstraintColumns([{ columns: ["lower(code)"], is_unique: true, filter: null, key_is_expression: [true] }]).size).toBe(0);
  });

  it("tolerates missing index metadata", () => {
    expect(uniqueConstraintColumns(undefined).size).toBe(0);
    expect(uniqueConstraintColumns(null).size).toBe(0);
    expect(uniqueConstraintColumns([]).size).toBe(0);
  });
});
