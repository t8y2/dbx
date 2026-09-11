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
import type { SchemaDiffObject } from "@/lib/schema/schemaDiff";
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
