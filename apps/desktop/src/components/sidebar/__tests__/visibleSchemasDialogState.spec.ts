import { describe, expect, it } from "vitest";
import { addVisibleSchemas, initialVisibleSchemaSelection, resolveVisibleSchemaSaveAction, selectVisibleSchemas } from "../visibleSchemasDialogState";

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

  it("keeps an explicitly empty normal-mode filter empty", () => {
    expect([...initialVisibleSchemaSelection(schemaNames, undefined)]).toEqual(schemaNames);
    expect([...initialVisibleSchemaSelection(schemaNames, [])]).toEqual([]);
  });

  it("keeps draft-mode empty or absent selections as all selected", () => {
    expect([...initialVisibleSchemaSelection(schemaNames, undefined, true)]).toEqual(schemaNames);
    expect([...initialVisibleSchemaSelection(schemaNames, [], true)]).toEqual(schemaNames);
  });

  it("normalizes configured schemas against the available list", () => {
    expect([...initialVisibleSchemaSelection(schemaNames, ["missing", "audit", "audit"])]).toEqual(["audit"]);
  });

  it("skips persistence when an unchanged filter is saved", () => {
    expect(resolveVisibleSchemaSaveAction(new Set(["audit", "public"]), schemaNames, ["public", "audit"])).toEqual({ type: "none" });
  });

  it("stores changed partial selections in stable schema order", () => {
    expect(resolveVisibleSchemaSaveAction(new Set(["audit", "public"]), schemaNames, ["sales"])).toEqual({
      type: "set",
      schemaNames: ["public", "audit"],
    });
  });

  it("represents a full selection as show-all and avoids redundant tree refreshes", () => {
    const selected = new Set(schemaNames);
    expect(resolveVisibleSchemaSaveAction(selected, schemaNames, undefined)).toEqual({ type: "none" });
    expect(resolveVisibleSchemaSaveAction(selected, schemaNames, ["public"])).toEqual({ type: "clear" });
  });
});
