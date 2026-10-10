import { describe, expect, it } from "vitest";
import { functionInfoRequestArguments, functionInfoResponse } from "../functionInfoTransport";
import { convertToSchemaDiffObjects, selectSchemaDiffInput } from "@/lib/schema/schemaDiff";
import type { SchemaDiffPreparation } from "@/lib/schema/schemaDiff";
import type { FunctionInfo } from "@/types/database";

const wire = { name: "P_ADD", functionType: "PROCEDURE", dataType: "", arguments: "", definition: 'CREATE PROCEDURE "P_ADD" AS BEGIN NULL; END;', schema: "Mixed Owner", status: "VALID", dependencies: ['"Other"."Q"'] };

describe("production FunctionInfo transport boundary", () => {
  it("uses real camelCase metadata to keep blocked PROCEDURE identity and selection closed", () => {
    const result = functionInfoResponse("prepareSchemaDiff", {
      diffs: [],
      syncSql: "",
      functionDiffs: [{ name: wire.name, type: "added", source: wire }],
      routineSteps: [{ name: wire.name, routineType: "PROCEDURE", operation: "added", blockedReason: "Incomplete source", dependencies: [] }],
    }) as SchemaDiffPreparation;
    const objects = convertToSchemaDiffObjects(result.diffs, result.functionDiffs, [], [], [], undefined, result.routineSteps);
    expect(objects[0]?.routineType).toBe("PROCEDURE");
    expect(objects[0]?.blockedReason).toBe("Incomplete source");
    expect(objects[0]?.selected).toBe(false);
    expect(selectSchemaDiffInput(result, objects).functionDiffs).toEqual([]);
  });
  it("preserves full source and metadata through both list and nested wire round trips", () => {
    const [model] = functionInfoResponse("listFunctions", [wire]) as FunctionInfo[];
    expect(model).toMatchObject({ function_type: "PROCEDURE", data_type: "", definition: wire.definition, schema: wire.schema, dependencies: wire.dependencies });
    expect(functionInfoRequestArguments("prepareSchemaDiff", [{ sourceFunctions: [model], targetFunctions: [model] }])[0]).toEqual({ sourceFunctions: [wire], targetFunctions: [wire] });
    const diffs = [{ name: wire.name, type: "modified", source: model, target: model }];
    for (const operation of ["generateSchemaSyncSql", "validateSchemaDiffRoutines"]) expect(functionInfoRequestArguments(operation, ["c", "d", "s", diffs])[3]).toEqual([{ name: wire.name, type: "modified", source: wire, target: wire }]);
    expect(functionInfoRequestArguments("generateSchemaSyncPlan", [{ functionDiffs: diffs }, { functions: [model] }])).toEqual([{ functionDiffs: [{ name: wire.name, type: "modified", source: wire, target: wire }] }, { functions: [wire] }]);
  });
  it("rejects missing, unknown and conflicting kind instead of guessing FUNCTION", () => {
    for (const functionType of [undefined, "NOT_A_PROCEDURE", ""]) expect(() => functionInfoResponse("listFunctions", [{ ...wire, functionType }])).toThrow("Unknown routine kind");
    expect(() => functionInfoResponse("listFunctions", [{ ...wire, function_type: "FUNCTION" }])).toThrow("disagree");
    expect(() => convertToSchemaDiffObjects([], [{ name: "X", type: "added", source: { ...wire, function_type: "" } as unknown as FunctionInfo }])).toThrow("Unknown routine kind");
  });
  it("preserves supported non-Oracle routine kinds and non-function responses", () => {
    for (const functionType of ["FUNCTION", "PROCEDURE", "PACKAGE", "PACKAGE BODY", "TRIGGER", "TYPE", "TYPE BODY"]) expect((functionInfoResponse("listFunctions", [{ ...wire, functionType }]) as FunctionInfo[])[0]?.function_type).toBe(functionType);
    const value = { dataType: "NUMBER", definition: "unrelated" };
    expect(functionInfoResponse("getObjectSource", value)).toBe(value);
  });
  it("keeps same-name TYPE and TYPE BODY independently blocked and selectable", () => {
    const result = functionInfoResponse("prepareSchemaDiff", {
      diffs: [],
      syncSql: "",
      functionDiffs: ["TYPE", "TYPE BODY"].map((functionType) => ({ name: "Mixed.Type", type: "added", source: { ...wire, name: "Mixed.Type", functionType } })),
      routineSteps: ["TYPE", "TYPE BODY"].map((routineType) => ({ name: "Mixed.Type", routineType, operation: "added", blockedReason: "Incomplete source", dependencies: [] })),
    }) as SchemaDiffPreparation;
    const objects = convertToSchemaDiffObjects(result.diffs, result.functionDiffs, [], [], [], undefined, result.routineSteps);
    expect(objects.map((object) => object.routineType)).toEqual(["TYPE", "TYPE BODY"]);
    expect(new Set(objects.map((object) => object.id)).size).toBe(2);
    expect(objects.every((object) => object.blockedReason === "Incomplete source" && !object.selected)).toBe(true);
    expect(selectSchemaDiffInput(result, objects).functionDiffs).toEqual([]);
  });
});
