import { describe, expect, it } from "vitest";
import { dataGridColumnSourceText } from "@/lib/dataGrid/columnSourceText";

describe("dataGridColumnSourceText", () => {
  it("qualifies the source column with schema and table", () => {
    expect(dataGridColumnSourceText({ schema: "public", tableName: "users", sourceColumn: "email" })).toBe("public.users.email");
  });

  it("omits a missing schema", () => {
    expect(dataGridColumnSourceText({ tableName: "users", sourceColumn: "email" })).toBe("users.email");
  });

  it("returns nothing when the result column has no source table", () => {
    expect(dataGridColumnSourceText(undefined)).toBeUndefined();
    expect(dataGridColumnSourceText({ sourceColumn: "email" })).toBeUndefined();
  });
});
