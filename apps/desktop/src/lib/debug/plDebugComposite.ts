import type { PlDebugArgument, PlDebugTargetSignature } from "./plDebugProtocol";

export type CompositeReference = { owner: string; packageName: string | null; typeName: string };
export type ObjectArgument = { name: string; state: "value"; value: CompositeValue } | { name: string; state: "default" };
export type ObjectInput = { type: CompositeReference; constructorId: string; arguments: ObjectArgument[] };
export type CompositeRoot = { kind: "record"; value: Array<{ name: string; value: CompositeValue }> } | { kind: "collection"; value: Array<{ index: string; value: CompositeValue }> | null } | { kind: "object"; value: ObjectInput | null };
export type CompositeTimezoneValue = { kind: "timestamp_tz"; value: { local: string; offset: string; region: string | null } | null } | { kind: "timestamp_ltz"; value: { instant: string } | null };
export type CompositeBinaryValue = { kind: "blob" | "raw"; value: { encoding: "base64"; data: string } | null };
export type CompositeValue = CompositeRoot | CompositeTimezoneValue | CompositeBinaryValue | { kind: "number" | "text" | "date" | "timestamp" | "clob" | "nclob" | "binary_float" | "binary_double"; value: string | null } | { kind: "boolean"; value: boolean | null };
export interface CompositeShape {
  reference?: CompositeReference;
  type: string;
  booleanAlternative?: boolean;
}

export function compositeNode(signature: PlDebugTargetSignature, shape: CompositeShape) {
  const ref = shape.reference;
  return ref ? signature.typeGraph?.nodes.find((node) => node.reference.owner === ref.owner && (node.reference.packageName ?? null) === (ref.packageName ?? null) && node.reference.typeName === ref.typeName) : undefined;
}

export const normalizedCompositeReference = (reference: CompositeReference): CompositeReference => ({ owner: reference.owner, packageName: reference.packageName ?? null, typeName: reference.typeName });

export function compositeObjectAssignable(signature: PlDebugTargetSignature, actual: CompositeReference, declared: CompositeReference): boolean {
  if ((actual.packageName ?? null) !== null || (declared.packageName ?? null) !== null) return false;
  let node = compositeNode(signature, { reference: actual, type: "EXT" });
  const seen = new Set<string>();
  while (node?.definition.TYPECODE === "OBJECT") {
    const key = JSON.stringify([node.reference.owner, node.reference.typeName]);
    if (seen.has(key)) return false;
    seen.add(key);
    if (node.reference.owner === declared.owner && node.reference.typeName === declared.typeName) return true;
    const owner = node.definition.SUPERTYPE_OWNER;
    const typeName = node.definition.SUPERTYPE_NAME;
    if (!owner || !typeName) return false;
    node = compositeNode(signature, { reference: { owner, packageName: null, typeName }, type: "EXT" });
  }
  return false;
}

export function compositeObjectTypes(signature: PlDebugTargetSignature, shape: CompositeShape) {
  return signature.typeGraph?.nodes.filter((node) => shape.reference && compositeObjectAssignable(signature, node.reference, shape.reference) && node.constructorCalls?.state === "resolved" && (!node.objectAccess || node.objectAccess.state === "type_only_verified")) ?? [];
}

export function compositeArgumentShape(signature: PlDebugTargetSignature | undefined, argument: PlDebugArgument | undefined): CompositeShape | undefined {
  const reference = signature?.typeBindings?.find((binding) => binding.sequence === argument?.sequence)?.reference;
  return reference ? { reference, type: argument!.type } : undefined;
}

export function compositeChildShape(row: Record<string, string | null>, prefix: "ATTR_TYPE_" | "ELEM_TYPE_"): CompositeShape {
  const owner = row[`${prefix}OWNER`];
  return {
    type: owner || row[`${prefix}PACKAGE`] ? (row[`${prefix}NAME`] ?? "") : canonicalPlDebugScalarType(row[`${prefix}NAME`] ?? ""),
    ...(owner ? { reference: { owner, packageName: row[`${prefix}PACKAGE`] ?? null, typeName: row[`${prefix}NAME`]! } } : {}),
    booleanAlternative: row[`${prefix}NAME`] === "NUMBER" && row.PRECISION === "1" && row.SCALE === "0",
  };
}

export function canonicalPlDebugScalarType(type: string): string {
  if (type === "TIMESTAMP WITH TZ") return "TIMESTAMP WITH TIME ZONE";
  if (type === "TIMESTAMP WITH LOCAL TZ") return "TIMESTAMP WITH LOCAL TIME ZONE";
  return type;
}

function compositeLeafKind(type: string): Exclude<CompositeValue["kind"], CompositeRoot["kind"]> {
  type = canonicalPlDebugScalarType(type);
  if (type === "TIMESTAMP WITH TIME ZONE") return "timestamp_tz";
  if (type === "TIMESTAMP WITH LOCAL TIME ZONE") return "timestamp_ltz";
  if (["NUMBER", "INTEGER", "PLS_INTEGER", "BINARY_INTEGER", "SIMPLE_INTEGER", "PL/SQL PLS INTEGER", "PL/SQL BINARY INTEGER"].includes(type)) return "number";
  if (type === "BOOLEAN" || type === "PL/SQL BOOLEAN") return "boolean";
  if (type === "DATE") return "date";
  if (type === "TIMESTAMP") return "timestamp";
  if (type === "CLOB") return "clob";
  if (type === "NCLOB") return "nclob";
  if (type === "BLOB") return "blob";
  if (type === "RAW") return "raw";
  if (type === "BINARY_FLOAT") return "binary_float";
  if (type === "BINARY_DOUBLE") return "binary_double";
  return "text";
}

export function emptyCompositeValue(signature: PlDebugTargetSignature, shape: CompositeShape): CompositeValue {
  const node = compositeNode(signature, shape);
  if (node) return node.definition.TYPECODE === "OBJECT" ? { kind: "object", value: null } : node.definition.TYPECODE === "PL/SQL RECORD" ? { kind: "record", value: [] } : { kind: "collection", value: [] };
  const kind = compositeLeafKind(shape.type);
  if (kind === "timestamp_tz") return { kind, value: { local: "", offset: "+00:00", region: null } };
  if (kind === "timestamp_ltz") return { kind, value: { instant: "" } };
  if (kind === "blob" || kind === "raw") return { kind, value: { encoding: "base64", data: "" } };
  return kind === "boolean" ? { kind, value: false } : { kind, value: "" };
}

export function compositeInputComplete(signature: PlDebugTargetSignature, shape: CompositeShape, value: CompositeValue, depth = 0): boolean {
  if (depth > 16) return false;
  const node = compositeNode(signature, shape);
  if (!node) {
    if (shape.reference) return false;
    if (value.kind === "record" || value.kind === "collection" || value.kind === "object") return false;
    const expected = compositeLeafKind(shape.type);
    if (value.kind !== expected && !(shape.booleanAlternative && value.kind === "boolean")) return false;
    if (value.value === null) return true;
    if (value.kind === "boolean") return typeof value.value === "boolean";
    if (value.kind === "timestamp_tz") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?$/.test(value.value.local) && /^[+-]\d{2}:\d{2}$/.test(value.value.offset) && (value.value.region === null || value.value.region.length > 0);
    if (value.kind === "timestamp_ltz") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(value.value.instant);
    if (value.kind === "blob" || value.kind === "raw") {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.value.data)) return false;
      return value.value.encoding === "base64" && btoa(atob(value.value.data)) === value.value.data;
    }
    if (value.kind === "binary_float") return /^[0-9a-fA-F]{8}$/.test(value.value);
    if (value.kind === "binary_double") return /^[0-9a-fA-F]{16}$/.test(value.value);
    return value.kind !== "number" || /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value.value);
  }
  if (node.definition.TYPECODE === "OBJECT") {
    if (value.kind !== "object") return false;
    if (node.objectAccess && node.objectAccess.state !== "type_only_verified") return false;
    if (value.value === null) return true;
    const input = value.value;
    if (!compositeObjectAssignable(signature, input.type, node.reference)) return false;
    const actual = compositeNode(signature, { reference: input.type, type: "EXT" });
    if (actual?.constructorCalls?.state !== "resolved" || (actual.objectAccess && actual.objectAccess.state !== "type_only_verified")) return false;
    const constructor = actual.constructorCalls.constructors.find((item) => item.id === input.constructorId);
    if (!constructor || input.arguments.length !== constructor.parameters.length) return false;
    const seen = new Set<string>();
    return input.arguments.every((argument) => {
      const formal = constructor.parameters.find((item) => item.name === argument.name);
      if (!formal || seen.has(argument.name)) return false;
      seen.add(argument.name);
      return argument.state === "default" ? formal.defaulted : compositeInputComplete(signature, compositeChildShape(formal.type, "ATTR_TYPE_"), argument.value, depth + 1);
    });
  }
  if (node.definition.TYPECODE === "PL/SQL RECORD") {
    if (value.kind !== "record") return false;
    const seen = new Set<string>();
    return value.value.every((field) => {
      const attribute = node.attributes.find((row) => row.ATTR_NAME === field.name);
      if (!attribute || seen.has(field.name)) return false;
      seen.add(field.name);
      return compositeInputComplete(signature, compositeChildShape(attribute, "ATTR_TYPE_"), field.value, depth + 1);
    });
  }
  if (value.kind !== "collection") return false;
  const definition = node.collections[0];
  if (!definition) return false;
  if (value.value === null) return !definition.INDEX_BY;
  const seen = new Set<string>();
  const entries = value.value;
  if (definition.COLL_TYPE === "VARYING ARRAY" && entries.some((entry) => entry.index.length > 4 || !/^[1-9][0-9]*$/.test(entry.index) || BigInt(entry.index) > BigInt(entries.length))) return false;
  return entries.every((entry) => {
    if (!entry.index || seen.has(entry.index) || (definition.INDEX_BY !== "VARCHAR2" && !/^-?(0|[1-9][0-9]*)$/.test(entry.index))) return false;
    if (definition.INDEX_BY !== "VARCHAR2") {
      if (entry.index.length > 11) return false;
      const index = BigInt(entry.index);
      if (entry.index === "-0" || index < -2147483648n || index > 2147483647n || (!definition.INDEX_BY && (index < 1n || index > 8192n))) return false;
      if (definition.COLL_TYPE === "VARYING ARRAY" && definition.UPPER_BOUND && index > BigInt(definition.UPPER_BOUND)) return false;
    }
    seen.add(entry.index);
    return compositeInputComplete(signature, compositeChildShape(definition, "ELEM_TYPE_"), entry.value, depth + 1);
  });
}
