const functionKinds = new Set(["FUNCTION", "PROCEDURE", "PACKAGE", "PACKAGE BODY", "TRIGGER", "TYPE", "TYPE BODY"]);

/** Keep the UI model's snake fields and Rust's camel wire fields at one boundary. */
export function mapFunctionInfoData(value: unknown, toWire = false): unknown {
  if (Array.isArray(value)) return value.map((item) => mapFunctionInfoData(item, toWire));
  if (!value || typeof value !== "object") return value;
  const raw = value as Record<string, unknown>;
  const result = { ...raw };
  if ("definition" in raw && "arguments" in raw && "name" in raw) {
    const kind = raw.functionType ?? raw.function_type;
    if (typeof kind !== "string" || !functionKinds.has(kind.toUpperCase().replaceAll("_", " "))) throw new Error("Unknown routine kind; reload comparison before selecting a plan");
    if (raw.functionType !== undefined && raw.function_type !== undefined && raw.functionType !== raw.function_type) throw new Error("Routine kind fields disagree; reload comparison");
    const dataType = raw.dataType ?? raw.data_type;
    if (typeof dataType !== "string") throw new Error("Routine return type metadata is missing; reload comparison");
    if (raw.dataType !== undefined && raw.data_type !== undefined && raw.dataType !== raw.data_type) throw new Error("Routine return type fields disagree; reload comparison");
    delete result.functionType;
    delete result.function_type;
    delete result.dataType;
    delete result.data_type;
    result[toWire ? "functionType" : "function_type"] = kind.toUpperCase().replaceAll("_", " ");
    result[toWire ? "dataType" : "data_type"] = dataType;
  }
  for (const key of ["source", "target", "functionDiffs", "sourceFunctions", "targetFunctions", "functions", "expected"]) {
    if (key in result) result[key] = mapFunctionInfoData(result[key], toWire);
  }
  return result;
}

export function functionInfoRequestArguments(operation: string, args: unknown[]): unknown[] {
  const mapped = [...args];
  if (operation === "prepareSchemaDiff" || operation === "generateSchemaSyncPlan") {
    mapped[0] = mapFunctionInfoData(mapped[0], true);
    if (operation === "generateSchemaSyncPlan") mapped[1] = mapFunctionInfoData(mapped[1], true);
  } else if (operation === "generateSchemaSyncSql") {
    mapped[3] = mapFunctionInfoData(mapped[3], true);
  } else if (operation === "validateSchemaDiffRoutines") {
    mapped[3] = mapFunctionInfoData(mapped[3], true);
  }
  return mapped;
}

export function functionInfoResponse(operation: string, value: unknown): unknown {
  return operation === "listFunctions" || operation === "prepareSchemaDiff" ? mapFunctionInfoData(value) : value;
}
