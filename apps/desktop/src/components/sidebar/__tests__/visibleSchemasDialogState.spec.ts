import { describe, expect, it } from "vitest";
import { addVisibleSchemas, initialVisibleSchemaSelection, selectVisibleSchemas } from "../visibleSchemasDialogState";

describe("visibleSchemasDialogState", () => {
  const schemaNames = ["public", "sales", "audit"];

  it("supports select all, clear, and filtered selection without mutating the previous set", () => {
    const selected = selectVisibleSchemas(schemaNames);
    const cleared = new Set<string>();
    const filtered = addVisibleSchemas(cleared, ["sales", "audit"]);

    expect([...selected]).toEqual(schemaNames);
    expect([...cleared]).toEqual([]);
    expect([...filtered]).toEqual(["sales", "audit"]);
    expect([...addVisibleSchemas(filtered, ["public", "sales"])]).toEqual(["sales", "audit", "public"]);
    expect([...filtered]).toEqual(["sales", "audit"]);
  });

  it("keeps draft empty or absent selections as all selected", () => {
    expect([...initialVisibleSchemaSelection(schemaNames, undefined)]).toEqual(schemaNames);
    expect([...initialVisibleSchemaSelection(schemaNames, [])]).toEqual(schemaNames);
  });

  it("normalizes configured schemas against the available list", () => {
    expect([...initialVisibleSchemaSelection(schemaNames, ["missing", "audit", "audit"])]).toEqual(["audit"]);
  });
});
