import type { FunctionInfo } from "@/types/database";
import type { FunctionDiff, SchemaDiffPreparation, SchemaDiffPreparationOptions } from "@/lib/schema/schemaDiff";

export type FunctionInfoWire = Omit<FunctionInfo, "function_type" | "data_type"> & { functionType: string; dataType: string };
type FunctionDiffWire = Omit<FunctionDiff, "source" | "target"> & { source?: FunctionInfoWire; target?: FunctionInfoWire };
export type SchemaDiffPreparationWire = Omit<SchemaDiffPreparation, "functionDiffs"> & { functionDiffs?: FunctionDiffWire[] };

function routineField(value: FunctionInfo | FunctionInfoWire, camel: "functionType" | "dataType", snake: "function_type" | "data_type"): string {
  const raw = value as unknown as Record<string, unknown>;
  if (raw[camel] !== undefined && raw[snake] !== undefined && raw[camel] !== raw[snake]) throw new Error(`Conflicting routine metadata: ${camel}`);
  const field = raw[camel] ?? raw[snake];
  if (typeof field !== "string") throw new Error(`Missing routine metadata: ${camel}`);
  return field;
}

/** FunctionInfo is snake_case in the UI and camelCase in Rust's serde contract. */
export function functionInfoFromWire(value: FunctionInfo | FunctionInfoWire): FunctionInfo {
  const { functionType: _functionType, function_type: _function_type, dataType: _dataType, data_type: _data_type, ...rest } = value as FunctionInfo & FunctionInfoWire;
  return { ...rest, function_type: routineField(value, "functionType", "function_type"), data_type: routineField(value, "dataType", "data_type") };
}

function functionInfoToWire(value: FunctionInfo): FunctionInfoWire {
  const { function_type, data_type, ...rest } = functionInfoFromWire(value);
  return { ...rest, functionType: function_type, dataType: data_type };
}

export function functionDiffsToWire(diffs: FunctionDiff[]): FunctionDiffWire[] {
  return diffs.map(({ source, target, ...diff }) => ({ ...diff, ...(source ? { source: functionInfoToWire(source) } : {}), ...(target ? { target: functionInfoToWire(target) } : {}) }));
}

export function schemaDiffPreparationToWire(options: SchemaDiffPreparationOptions) {
  const { sourceFunctions, targetFunctions, ...rest } = options;
  return { ...rest, ...(sourceFunctions ? { sourceFunctions: sourceFunctions.map(functionInfoToWire) } : {}), ...(targetFunctions ? { targetFunctions: targetFunctions.map(functionInfoToWire) } : {}) };
}

export function schemaDiffPreparationFromWire(value: SchemaDiffPreparationWire): SchemaDiffPreparation {
  const { functionDiffs, ...rest } = value;
  return { ...rest, ...(functionDiffs ? { functionDiffs: functionDiffs.map(({ source, target, ...diff }) => ({ ...diff, ...(source ? { source: functionInfoFromWire(source) } : {}), ...(target ? { target: functionInfoFromWire(target) } : {}) })) } : {}) };
}
