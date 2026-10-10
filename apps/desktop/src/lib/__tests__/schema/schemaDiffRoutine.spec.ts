import { describe, expect, it } from "vitest";
import {
  countSchemaDiffActionableObjects,
  filterSchemaDiffFunctions,
  isSchemaDiffUnrestrictedRoutineLoadTooLarge,
  partitionSchemaDiffObjectsByResultTab,
  SCHEMA_DIFF_UNRESTRICTED_ROUTINE_LIMIT,
  schemaDiffRoutineKey,
  schemaDiffRoutineKeyFromFunction,
  summarizeSchemaDiffRoutineTextDiff,
} from "@/lib/schema/schemaDiffRoutine";
import { convertToSchemaDiffObjects, selectSchemaDiffInput, type FunctionDiff, type SchemaDiffObject } from "@/lib/schema/schemaDiff";
import type { FunctionInfo } from "@/types/database";

function fn(name: string, args = "", definition = "body"): FunctionInfo {
  return { name, function_type: "FUNCTION", data_type: "void", definition, arguments: args };
}

function obj(partial: Partial<SchemaDiffObject> & Pick<SchemaDiffObject, "id" | "objectKind" | "operationType" | "name">): SchemaDiffObject {
  return {
    selected: true,
    ...partial,
  };
}

describe("schemaDiffRoutine", () => {
  it("keeps type definitions, bodies, quoted identities, and ordered source separate", () => {
    const definition = 'CREATE TYPE "Dot.Type" UNDER BaseType (first NUMBER, second VARCHAR2(20)) NOT FINAL;';
    const source = [
      { ...fn("Dot.Type"), schema: "Owner.With Dot", function_type: "TYPE", definition },
      { ...fn("Dot.Type"), schema: "Owner.With Dot", function_type: "TYPE_BODY", definition: 'CREATE TYPE BODY "Dot.Type" AS MEMBER PROCEDURE run AS BEGIN NULL; END; END;' },
      { ...fn('Dot"Type'), schema: "Owner.With Dot", function_type: "TYPE" },
    ];
    const keys = source.map(schemaDiffRoutineKeyFromFunction);
    expect(keys).toEqual(['TYPE "Dot.Type"', 'TYPE BODY "Dot.Type"', 'TYPE "Dot""Type"']);
    const target = source.map((item) => ({ ...item, schema: "Destination" }));
    const filtered = filterSchemaDiffFunctions(source, target, [keys[1]!]);
    expect(filtered.sourceFunctions).toEqual([source[1]]);
    expect(filtered.targetFunctions).toEqual([target[1]]);
    const diffs: FunctionDiff[] = source.map((item) => ({ name: item.name, type: "added", source: item }));
    const objects = convertToSchemaDiffObjects([], diffs);
    expect(new Set(objects.map((item) => item.id)).size).toBe(3);
    expect(objects[0]!.sourceDdl).toBe(definition);
    expect(objects.map((item) => item.routineType)).toEqual(["TYPE", "TYPE BODY", "TYPE"]);
    objects.forEach((item, index) => {
      item.selected = index === 1;
    });
    expect(selectSchemaDiffInput({ diffs: [], functionDiffs: diffs, syncSql: "" }, objects).functionDiffs).toEqual([diffs[1]]);
    expect(summarizeSchemaDiffRoutineTextDiff(definition, definition.replace("first NUMBER, second VARCHAR2(20)", "second VARCHAR2(20), first NUMBER")).modified).toBeGreaterThan(0);
    expect(summarizeSchemaDiffRoutineTextDiff(definition, definition.replace("NOT FINAL", "FINAL")).modified).toBeGreaterThan(0);
  });

  it("keeps same-name package parts and trigger relations separate throughout selection", () => {
    const trigger = { tableOwner: "SRC", tableName: "T1", timing: "BEFORE EACH ROW", event: "UPDATE", status: "ENABLED", baseObjectType: "TABLE" };
    const source = [
      { ...fn("Shared"), schema: "SRC", function_type: "PACKAGE" },
      { ...fn("Shared"), schema: "SRC", function_type: "PACKAGE BODY" },
      { ...fn("Shared"), schema: "SRC", function_type: "TRIGGER", trigger },
      { ...fn("Shared"), schema: "SRC", function_type: "TRIGGER", trigger: { ...trigger, tableName: "T2" } },
      { ...fn("Shared"), schema: "SRC", function_type: "TRIGGER", trigger: { ...trigger, tableOwner: "OTHER" } },
    ];
    const keys = source.map(schemaDiffRoutineKeyFromFunction);
    expect(new Set(keys).size).toBe(5);
    const target = source.map((item) => ({ ...item, schema: "DST", trigger: item.trigger ? { ...item.trigger, tableOwner: item.trigger.tableOwner === "SRC" ? "DST" : item.trigger.tableOwner } : undefined }));
    const filtered = filterSchemaDiffFunctions(source, target, [keys[1]!, keys[3]!]);
    expect(filtered.sourceFunctions).toEqual([source[1], source[3]]);
    expect(filtered.targetFunctions).toEqual([target[1], target[3]]);
    const diffs: FunctionDiff[] = source.map((item) => ({ name: item.name, type: "added", source: item }));
    const objects = convertToSchemaDiffObjects([], diffs);
    expect(new Set(objects.map((item) => item.id)).size).toBe(5);
    objects.forEach((item, index) => {
      item.selected = index === 1 || index === 3;
    });
    expect(selectSchemaDiffInput({ diffs: [], functionDiffs: diffs, syncSql: "" }, objects).functionDiffs).toEqual([diffs[1], diffs[3]]);
  });

  it("builds stable routine keys for overloaded functions", () => {
    expect(schemaDiffRoutineKey("add")).toBe("add");
    expect(schemaDiffRoutineKey("add", "integer")).toBe("add(integer)");
    expect(schemaDiffRoutineKeyFromFunction(fn("add", "integer, text"))).toBe("add(integer, text)");
  });

  it("blocks unrestricted compare when routine count exceeds the soft limit", () => {
    expect(SCHEMA_DIFF_UNRESTRICTED_ROUTINE_LIMIT).toBe(200);
    expect(isSchemaDiffUnrestrictedRoutineLoadTooLarge(200, undefined)).toBe(false);
    expect(isSchemaDiffUnrestrictedRoutineLoadTooLarge(201, undefined)).toBe(true);
    expect(isSchemaDiffUnrestrictedRoutineLoadTooLarge(500, ["a"])).toBe(false);
  });

  it("filters selected source routines and same-name mapped targets", () => {
    const source = [fn("a"), fn("b", "int"), fn("c")];
    const target = [fn("a"), fn("b", "int"), fn("c"), fn("orphan")];
    const filtered = filterSchemaDiffFunctions(source, target, ["a", "b(int)"], [{ sourceRoutine: "b(int)", targetRoutine: "b(int)" }]);
    expect(filtered.sourceFunctions.map((item) => schemaDiffRoutineKeyFromFunction(item))).toEqual(["a", "b(int)"]);
    expect(filtered.targetFunctions.map((item) => schemaDiffRoutineKeyFromFunction(item))).toEqual(["a", "b(int)"]);
  });

  it("ignores non-identity rename mappings until backend rematch exists", () => {
    const source = [fn("a"), fn("b", "int"), fn("c")];
    const target = [fn("a"), fn("b_new", "int"), fn("c"), fn("orphan")];
    const filtered = filterSchemaDiffFunctions(source, target, ["a", "b(int)"], [{ sourceRoutine: "b(int)", targetRoutine: "b_new(int)" }]);
    expect(filtered.sourceFunctions.map((item) => schemaDiffRoutineKeyFromFunction(item))).toEqual(["a", "b(int)"]);
    // Without same-name target for b(int), only auto-matched "a" is kept on the target side.
    expect(filtered.targetFunctions.map((item) => schemaDiffRoutineKeyFromFunction(item))).toEqual(["a"]);
  });

  it("keeps all functions when selection is unrestricted", () => {
    const source = [fn("a")];
    const target = [fn("a"), fn("b")];
    expect(filterSchemaDiffFunctions(source, target, undefined)).toEqual({ sourceFunctions: source, targetFunctions: target });
  });

  it("partitions result objects into table and routine tabs", () => {
    const objects = [obj({ id: "t1", objectKind: "table", operationType: "modify", name: "t1" }), obj({ id: "f1", objectKind: "function", operationType: "create", name: "f1" }), obj({ id: "v1", objectKind: "view", operationType: "none", name: "v1" })];
    const { tableObjects, routineObjects } = partitionSchemaDiffObjectsByResultTab(objects);
    expect(tableObjects.map((item) => item.id)).toEqual(["t1", "v1"]);
    expect(routineObjects.map((item) => item.id)).toEqual(["f1"]);
    expect(countSchemaDiffActionableObjects(tableObjects)).toBe(1);
    expect(countSchemaDiffActionableObjects(routineObjects)).toBe(1);
  });

  it("summarizes routine DDL line diffs for create, delete, and modify", () => {
    expect(summarizeSchemaDiffRoutineTextDiff(undefined, undefined)).toEqual({ added: 0, removed: 0, modified: 0 });
    expect(summarizeSchemaDiffRoutineTextDiff("a\nb\nc", "")).toEqual({ added: 3, removed: 0, modified: 0 });
    expect(summarizeSchemaDiffRoutineTextDiff("", "x\ny")).toEqual({ added: 0, removed: 2, modified: 0 });

    const modified = summarizeSchemaDiffRoutineTextDiff("line1\nold\nline3", "line1\nnew\nline3\nextra");
    expect(modified.modified).toBeGreaterThanOrEqual(1);
    expect(modified.added).toBeGreaterThanOrEqual(1);
    expect(modified.removed).toBe(0);
  });
});
