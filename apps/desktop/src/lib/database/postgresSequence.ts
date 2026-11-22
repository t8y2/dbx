import type { QueryResult } from "@/types/database";

export interface PostgresSequenceIdentity {
  schema: string;
  name: string;
}

export type PostgresSequenceDataType = "smallint" | "integer" | "bigint";

export interface PostgresSequenceParameters {
  dataType: PostgresSequenceDataType;
  startValue: string;
  minValue: string;
  maxValue: string;
  increment: string;
  cacheSize: string;
  cycle: boolean;
}

export interface PostgresSequenceMetadata extends PostgresSequenceIdentity, PostgresSequenceParameters {
  oid: string;
  canReadState: boolean;
  canAlter: boolean;
}

export interface PostgresSequenceState {
  /** The sequence's stored value, which can include numbers reserved by CACHE. Not session-local currval. */
  lastValue: string;
  /** When false, the next nextval returns lastValue without first adding the increment. */
  isCalled: boolean;
}

export interface PostgresSequenceDraft extends Omit<PostgresSequenceParameters, "dataType"> {
  /** Empty unless the user explicitly requests a restart. Never initialize from lastValue. */
  restartWith: string;
}

export type PostgresSequenceErrorCode =
  | "invalidIdentity"
  | "invalidInteger"
  | "outOfRange"
  | "invalidIncrement"
  | "invalidCacheSize"
  | "invalidBounds"
  | "invalidStartValue"
  | "invalidRestartValue"
  | "unsupportedVersion"
  | "unsupportedDataType"
  | "missingSequence"
  | "invalidMetadata"
  | "invalidState";

export class PostgresSequenceValidationError extends Error {
  constructor(
    public readonly code: PostgresSequenceErrorCode,
    public readonly field?: string,
  ) {
    super(code);
    this.name = "PostgresSequenceValidationError";
  }
}

type SequenceQueryResult = Pick<QueryResult, "columns" | "rows">;
const BIGINT_MIN = -9223372036854775808n;
const BIGINT_MAX = 9223372036854775807n;
const TYPE_BOUNDS: Record<PostgresSequenceDataType, readonly [bigint, bigint]> = {
  smallint: [-32768n, 32767n],
  integer: [-2147483648n, 2147483647n],
  bigint: [BIGINT_MIN, BIGINT_MAX],
};

function validateIdentifier(value: string) {
  if (typeof value !== "string" || !value.length || value.includes("\0")) throw new PostgresSequenceValidationError("invalidIdentity");
}

function quoteIdentifier(value: string): string {
  validateIdentifier(value);
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  validateIdentifier(value);
  // E strings are independent of the connection's standard_conforming_strings setting.
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function qualifiedName(identity: PostgresSequenceIdentity): string {
  return `${quoteIdentifier(identity.schema)}.${quoteIdentifier(identity.name)}`;
}

export function buildPostgresSequenceVersionSql(): string {
  return "SELECT pg_catalog.current_setting('server_version_num')::text AS server_version_num;";
}

/** pg_sequence and typed sequences were introduced in PostgreSQL 10. Check before querying that catalog. */
export function parsePostgresSequenceVersion(result: SequenceQueryResult): number {
  const row = singleRow(result, "unsupportedVersion");
  const value = row.get("server_version_num");
  if (typeof value !== "string" || !/^\d{6,10}$/.test(value)) throw new PostgresSequenceValidationError("unsupportedVersion");
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 100000 || version > 2147483647) throw new PostgresSequenceValidationError("unsupportedVersion");
  return version;
}

/** Parameters can be inspected without SELECT on the sequence relation. State is read separately if permitted. */
export function buildPostgresSequenceMetadataSql(identity: PostgresSequenceIdentity): string {
  return `SELECT c.oid::text AS oid,
       n.nspname AS sequence_schema, c.relname AS sequence_name,
       CASE s.seqtypid WHEN 21 THEN 'smallint' WHEN 23 THEN 'integer' WHEN 20 THEN 'bigint' END AS data_type,
       s.seqstart::text AS start_value, s.seqmin::text AS min_value,
       s.seqmax::text AS max_value, s.seqincrement::text AS increment,
       s.seqcache::text AS cache_size, s.seqcycle AS cycle,
       (pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND pg_catalog.has_sequence_privilege(c.oid, 'SELECT')) AS can_read_state,
       (pg_catalog.has_schema_privilege(n.oid, 'USAGE') AND pg_catalog.pg_has_role(c.relowner, 'USAGE')) AS can_alter
FROM pg_catalog.pg_sequence s
JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S' AND n.nspname = ${quoteLiteral(identity.schema)} AND c.relname = ${quoteLiteral(identity.name)};`;
}

/** A read must not call nextval, setval or currval: none is a side-effect-free, global state inspector. */
export function buildPostgresSequenceStateSql(identity: PostgresSequenceIdentity): string {
  return `SELECT last_value::text AS last_value, is_called FROM ${qualifiedName(identity)};`;
}

function singleRow(result: SequenceQueryResult, error: PostgresSequenceErrorCode): Map<string, unknown> {
  if (result.rows.length !== 1 || new Set(result.columns).size !== result.columns.length) throw new PostgresSequenceValidationError(error);
  return new Map(result.columns.map((name, index) => [name, result.rows[0]![index]]));
}

function readString(row: Map<string, unknown>, field: string, error: PostgresSequenceErrorCode): string {
  const value = row.get(field);
  if (typeof value !== "string" || !value.length) throw new PostgresSequenceValidationError(error, field);
  return value;
}

function readBoolean(row: Map<string, unknown>, field: string, error: PostgresSequenceErrorCode): boolean {
  const value = row.get(field);
  if (value === true || value === "true" || value === "t") return true;
  if (value === false || value === "false" || value === "f") return false;
  throw new PostgresSequenceValidationError(error, field);
}

function integer(value: string, field: string): string {
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value.trim())) throw new PostgresSequenceValidationError("invalidInteger", field);
  const compact = value.trim().replace(/^([+-]?)0+(?=\d)/, "$1");
  // Reject obviously oversized values before converting user input to a BigInt.
  if (compact.replace(/^[+-]/, "").length > 19) throw new PostgresSequenceValidationError("outOfRange", field);
  const parsed = BigInt(compact);
  if (parsed < BIGINT_MIN || parsed > BIGINT_MAX) throw new PostgresSequenceValidationError("outOfRange", field);
  return parsed.toString();
}

function validateParameters(parameters: PostgresSequenceParameters): PostgresSequenceParameters {
  if (!Object.prototype.hasOwnProperty.call(TYPE_BOUNDS, parameters.dataType)) throw new PostgresSequenceValidationError("unsupportedDataType");
  const normalized = {
    dataType: parameters.dataType,
    startValue: integer(parameters.startValue, "startValue"),
    minValue: integer(parameters.minValue, "minValue"),
    maxValue: integer(parameters.maxValue, "maxValue"),
    increment: integer(parameters.increment, "increment"),
    cacheSize: integer(parameters.cacheSize, "cacheSize"),
    cycle: parameters.cycle,
  };
  if (typeof normalized.cycle !== "boolean") throw new PostgresSequenceValidationError("invalidMetadata", "cycle");
  const [typeMin, typeMax] = TYPE_BOUNDS[parameters.dataType];
  for (const field of ["minValue", "maxValue", "startValue"] as const) {
    const value = BigInt(normalized[field]);
    if (value < typeMin || value > typeMax) throw new PostgresSequenceValidationError("outOfRange", field);
  }
  const min = BigInt(normalized.minValue);
  const max = BigInt(normalized.maxValue);
  if (min >= max) throw new PostgresSequenceValidationError("invalidBounds");
  if (BigInt(normalized.startValue) < min || BigInt(normalized.startValue) > max) throw new PostgresSequenceValidationError("invalidStartValue", "startValue");
  if (normalized.increment === "0") throw new PostgresSequenceValidationError("invalidIncrement", "increment");
  if (BigInt(normalized.cacheSize) < 1n) throw new PostgresSequenceValidationError("invalidCacheSize", "cacheSize");
  return normalized;
}

export function parsePostgresSequenceMetadata(result: SequenceQueryResult): PostgresSequenceMetadata {
  if (!result.rows.length) throw new PostgresSequenceValidationError("missingSequence");
  const row = singleRow(result, "invalidMetadata");
  const schema = readString(row, "sequence_schema", "invalidMetadata");
  const name = readString(row, "sequence_name", "invalidMetadata");
  validateIdentifier(schema);
  validateIdentifier(name);
  const oid = integer(readString(row, "oid", "invalidMetadata"), "oid");
  if (BigInt(oid) < 1n || BigInt(oid) > 4294967295n) throw new PostgresSequenceValidationError("invalidMetadata", "oid");
  return {
    schema,
    name,
    oid,
    ...validateParameters({
      dataType: readString(row, "data_type", "invalidMetadata") as PostgresSequenceDataType,
      startValue: readString(row, "start_value", "invalidMetadata"),
      minValue: readString(row, "min_value", "invalidMetadata"),
      maxValue: readString(row, "max_value", "invalidMetadata"),
      increment: readString(row, "increment", "invalidMetadata"),
      cacheSize: readString(row, "cache_size", "invalidMetadata"),
      cycle: readBoolean(row, "cycle", "invalidMetadata"),
    }),
    canReadState: readBoolean(row, "can_read_state", "invalidMetadata"),
    canAlter: readBoolean(row, "can_alter", "invalidMetadata"),
  };
}

export function parsePostgresSequenceState(result: SequenceQueryResult): PostgresSequenceState {
  const row = singleRow(result, "invalidState");
  return {
    lastValue: integer(readString(row, "last_value", "invalidState"), "lastValue"),
    isCalled: readBoolean(row, "is_called", "invalidState"),
  };
}

/** START changes the default restart value only; RESTART is always an explicit, independent operation. */
export function buildPostgresSequenceAlterSql(identity: PostgresSequenceIdentity, before: PostgresSequenceParameters, draft: PostgresSequenceDraft): string | null {
  const target = qualifiedName(identity);
  const previous = validateParameters(before);
  const next = validateParameters({ ...draft, dataType: before.dataType });
  const clauses: string[] = [];
  const numericClauses = { increment: "INCREMENT BY", minValue: "MINVALUE", maxValue: "MAXVALUE", startValue: "START WITH", cacheSize: "CACHE" } as const;
  for (const field of Object.keys(numericClauses) as Array<keyof typeof numericClauses>) {
    if (previous[field] !== next[field]) clauses.push(`${numericClauses[field]} ${next[field]}`);
  }
  if (previous.cycle !== next.cycle) clauses.push(next.cycle ? "CYCLE" : "NO CYCLE");
  if (typeof draft.restartWith !== "string") throw new PostgresSequenceValidationError("invalidInteger", "restartWith");
  if (draft.restartWith.trim()) {
    const restart = integer(draft.restartWith, "restartWith");
    if (BigInt(restart) < BigInt(next.minValue) || BigInt(restart) > BigInt(next.maxValue)) throw new PostgresSequenceValidationError("invalidRestartValue", "restartWith");
    clauses.push(`RESTART WITH ${restart}`);
  }
  return clauses.length ? `ALTER SEQUENCE ${target}\n  ${clauses.join("\n  ")};` : null;
}
