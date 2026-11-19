import type { FunctionInfo } from "@/types/database";
import type { SchemaDiffRoutineMapping } from "@/types/schemaDiff";
import type { DiffObjectKind, SchemaDiffObject } from "@/lib/schema/schemaDiff";
import { buildTextDiff } from "@/lib/common/textDiff";
import {
  areSchemaDiffTableMappingsEqual,
  availableSchemaDiffTargetTables,
  buildSchemaDiffTableMatches,
  pruneSchemaDiffTableMappings,
  reconcileSchemaDiffTableMappings,
  swapSchemaDiffTableMappings,
  updateSchemaDiffTableMapping,
  type SchemaDiffTableMatch,
  type SchemaDiffTableMappingUpdate,
} from "@/lib/schema/schemaDiffTableMapping";

export interface SchemaDiffRoutineTextDiffStats {
  added: number;
  removed: number;
  modified: number;
}

/** Unrestricted routine compare loads every definition; require explicit selection above this count. */
export const SCHEMA_DIFF_UNRESTRICTED_ROUTINE_LIMIT = 200;

export function isSchemaDiffUnrestrictedRoutineLoadTooLarge(routineCount: number, selectedRoutines: string[] | undefined): boolean {
  return selectedRoutines === undefined && routineCount > SCHEMA_DIFF_UNRESTRICTED_ROUTINE_LIMIT;
}

function countNonEmptyLines(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized) return 0;
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** Line-level add/remove/modify counts for routine DDL side-by-side comparison. */
export function summarizeSchemaDiffRoutineTextDiff(sourceDdl?: string | null, targetDdl?: string | null): SchemaDiffRoutineTextDiffStats {
  const source = sourceDdl ?? "";
  const target = targetDdl ?? "";
  if (!source && !target) return { added: 0, removed: 0, modified: 0 };
  // Source-only (create on target): count as additions. Target-only (drop on target): removals.
  if (source && !target) return { added: countNonEmptyLines(source), removed: 0, modified: 0 };
  if (!source && target) return { added: 0, removed: countNonEmptyLines(target), modified: 0 };

  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const row of buildTextDiff(source, target)) {
    if (row.kind === "added") added += 1;
    else if (row.kind === "removed") removed += 1;
    else if (row.kind === "modified") modified += 1;
  }
  return { added, removed, modified };
}

export type SchemaDiffRoutineMatch = SchemaDiffTableMatch & {
  sourceRoutine: string;
  targetRoutine?: string;
};

const ROUTINE_OBJECT_KINDS = new Set<DiffObjectKind>(["function"]);

/** Stable routine identity for overloaded functions: `name` or `name(args)`. */
export function schemaDiffRoutineKey(name: string, args = ""): string {
  const trimmedArgs = args.trim();
  return trimmedArgs ? `${name}(${trimmedArgs})` : name;
}

export function schemaDiffRoutineKeyFromFunction(fn: Pick<FunctionInfo, "name" | "arguments"> & Partial<Pick<FunctionInfo, "function_type">>, exactKind = false): string {
  if (exactKind || fn.function_type === "PACKAGE" || fn.function_type === "PACKAGE_BODY") {
    if (!["PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"].includes(fn.function_type ?? "")) throw new Error("An exact program key requires its supported object kind");
    return JSON.stringify([fn.function_type, fn.name, fn.arguments.trim()]);
  }
  return schemaDiffRoutineKey(fn.name, fn.arguments);
}

export function isSchemaDiffRoutineObjectKind(kind: DiffObjectKind): boolean {
  return ROUTINE_OBJECT_KINDS.has(kind);
}

export function isSchemaDiffRoutineObject(object: Pick<SchemaDiffObject, "objectKind">): boolean {
  return isSchemaDiffRoutineObjectKind(object.objectKind);
}

export function partitionSchemaDiffObjectsByResultTab(objects: SchemaDiffObject[]): { tableObjects: SchemaDiffObject[]; routineObjects: SchemaDiffObject[] } {
  const tableObjects: SchemaDiffObject[] = [];
  const routineObjects: SchemaDiffObject[] = [];
  for (const object of objects) {
    if (isSchemaDiffRoutineObject(object)) routineObjects.push(object);
    else tableObjects.push(object);
  }
  return { tableObjects, routineObjects };
}

/** Count objects that are not "none" (used for tab badges). */
export function countSchemaDiffActionableObjects(objects: SchemaDiffObject[]): number {
  return objects.filter((object) => object.operationType !== "none").length;
}

function toTableMappings(mappings: readonly SchemaDiffRoutineMapping[]) {
  return mappings.map((mapping) => ({ sourceTable: mapping.sourceRoutine, targetTable: mapping.targetRoutine }));
}

function fromTableMappings(mappings: { sourceTable: string; targetTable: string }[]): SchemaDiffRoutineMapping[] {
  return mappings.map((mapping) => ({ sourceRoutine: mapping.sourceTable, targetRoutine: mapping.targetTable }));
}

export function pruneSchemaDiffRoutineMappings(selectedRoutines: readonly string[], mappings: readonly SchemaDiffRoutineMapping[]): SchemaDiffRoutineMapping[] {
  return fromTableMappings(pruneSchemaDiffTableMappings(selectedRoutines, toTableMappings(mappings)));
}

export function reconcileSchemaDiffRoutineMappings(selectedRoutines: readonly string[], targetRoutines: readonly string[], mappings: readonly SchemaDiffRoutineMapping[], ignoreNameCase = false): SchemaDiffRoutineMapping[] {
  return fromTableMappings(reconcileSchemaDiffTableMappings(selectedRoutines, targetRoutines, toTableMappings(mappings), ignoreNameCase));
}

export function buildSchemaDiffRoutineMatches(selectedRoutines: readonly string[], targetRoutines: readonly string[], mappings: readonly SchemaDiffRoutineMapping[], ignoreNameCase = false): SchemaDiffRoutineMatch[] {
  return buildSchemaDiffTableMatches(selectedRoutines, targetRoutines, toTableMappings(mappings), ignoreNameCase).map((match) => ({
    ...match,
    sourceRoutine: match.sourceTable,
    targetRoutine: match.targetTable,
  }));
}

export function updateSchemaDiffRoutineMapping(mappings: readonly SchemaDiffRoutineMapping[], sourceRoutine: string, targetRoutine: string, ignoreNameCase = false): SchemaDiffTableMappingUpdate & { routineMappings: SchemaDiffRoutineMapping[] } {
  const update = updateSchemaDiffTableMapping(toTableMappings(mappings), sourceRoutine, targetRoutine, ignoreNameCase);
  return {
    ...update,
    routineMappings: fromTableMappings(update.mappings),
  };
}

export function availableSchemaDiffTargetRoutines(sourceRoutine: string, targetRoutines: readonly string[], mappings: readonly SchemaDiffRoutineMapping[], ignoreNameCase = false): string[] {
  return availableSchemaDiffTargetTables(sourceRoutine, targetRoutines, toTableMappings(mappings), ignoreNameCase);
}

export function swapSchemaDiffRoutineMappings(mappings: readonly SchemaDiffRoutineMapping[]): SchemaDiffRoutineMapping[] {
  return fromTableMappings(swapSchemaDiffTableMappings(toTableMappings(mappings)));
}

export function areSchemaDiffRoutineMappingsEqual(left: readonly SchemaDiffRoutineMapping[], right: readonly SchemaDiffRoutineMapping[]): boolean {
  return areSchemaDiffTableMappingsEqual(toTableMappings(left), toTableMappings(right));
}

export function reconcileSchemaDiffSelectedRoutines(selectedRoutines: string[], availableRoutines: string[]): string[] {
  const available = new Set(availableRoutines);
  return selectedRoutines.filter((routine) => available.has(routine));
}

/** Same-name (identity) mappings only — rename rematch is not wired through prepareSchemaDiff yet. */
export function isSchemaDiffRoutineIdentityMapping(mapping: SchemaDiffRoutineMapping, ignoreNameCase = false): boolean {
  if (ignoreNameCase) {
    return mapping.sourceRoutine.toLocaleLowerCase() === mapping.targetRoutine.toLocaleLowerCase();
  }
  return mapping.sourceRoutine === mapping.targetRoutine;
}

export function identitySchemaDiffRoutineMappings(mappings: readonly SchemaDiffRoutineMapping[], ignoreNameCase = false): SchemaDiffRoutineMapping[] {
  return mappings.filter((mapping) => isSchemaDiffRoutineIdentityMapping(mapping, ignoreNameCase));
}

export interface FilteredSchemaDiffFunctions {
  sourceFunctions: FunctionInfo[];
  targetFunctions: FunctionInfo[];
}

/**
 * Apply visual routine selection + same-name mappings before prepareSchemaDiff.
 * When `selectedRoutines` is undefined, both sides keep all listed functions.
 * Non-identity (rename) mappings are ignored until backend rematch lands.
 */
export function filterSchemaDiffFunctions(sourceFunctions: FunctionInfo[], targetFunctions: FunctionInfo[], selectedRoutines: string[] | undefined, routineMappings: SchemaDiffRoutineMapping[] = [], exactKind = false): FilteredSchemaDiffFunctions {
  if (selectedRoutines === undefined) {
    return { sourceFunctions, targetFunctions };
  }

  const selectedSet = new Set(selectedRoutines);
  const typed = exactKind || [...sourceFunctions, ...targetFunctions].some((fn) => fn.function_type === "PACKAGE" || fn.function_type === "PACKAGE_BODY");
  const key = (fn: FunctionInfo) => schemaDiffRoutineKeyFromFunction(fn, typed);
  const filteredSource = sourceFunctions.filter((fn) => selectedSet.has(key(fn)));
  const targetByKey = new Map(targetFunctions.map((fn) => [key(fn), fn]));
  const targetKeys = [...targetByKey.keys()];
  const mappings = reconcileSchemaDiffRoutineMappings(filteredSource.map(key), targetKeys, identitySchemaDiffRoutineMappings(routineMappings));
  const selectedTargetKeys = new Set(mappings.map((mapping) => mapping.targetRoutine));
  if (typed) {
    for (const target of targetFunctions) {
      const targetPackage = target.function_type === "PACKAGE" || target.function_type === "PACKAGE_BODY";
      if (
        selectedSet.has(key(target)) ||
        filteredSource.some((source) => {
          const sourcePackage = source.function_type === "PACKAGE" || source.function_type === "PACKAGE_BODY";
          return source.name === target.name && source.arguments.trim() === target.arguments.trim() && source.function_type !== target.function_type && !(sourcePackage && targetPackage);
        })
      )
        selectedTargetKeys.add(key(target));
    }
  }

  return {
    sourceFunctions: filteredSource,
    targetFunctions: targetFunctions.filter((fn) => selectedTargetKeys.has(key(fn))),
  };
}
