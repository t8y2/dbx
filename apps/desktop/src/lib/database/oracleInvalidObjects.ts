import type { DatabaseType, QueryResult } from "@/types/database";
import { formatError } from "@/lib/backend/errorUtils";

export interface OracleObjectIdentity { schema: string; name: string; object_type: string }
export interface OracleInvalidObject extends OracleObjectIdentity { status: string | null; object_id: string | null; last_ddl_time: string | null }
export interface OracleCompileError { sequence: number; line: number; position: number; text: string; attribute: string | null; message_number: string | null }
export interface OracleSourceLine { line: number; text: string }
export interface OracleReadSection<T> { state: "available" | "empty" | "unavailable" | "denied" | "error"; rows: T[]; message?: string }
export interface OracleObjectInspection { object: OracleInvalidObject | null; errors: OracleReadSection<OracleCompileError>; source: OracleReadSection<OracleSourceLine> }
export type OracleMetadataQuery = (sql: string) => Promise<QueryResult>;
export type OracleCompileOutcome = "valid" | "invalid" | "unknown" | "unavailable" | "changed" | "cancelled" | "failed" | "unsupported";
export interface OracleCompileResult {
  outcome: OracleCompileOutcome;
  statement_sent: boolean;
  object: OracleInvalidObject | null;
  errors: OracleReadSection<OracleCompileError>;
  execution_error?: string;
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const dictionaryKind = (kind: string) => kind.replaceAll("_", " ");
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export const oracleObjectKey = (object: OracleObjectIdentity) => JSON.stringify([object.schema, object.name, object.object_type]);
export const supportsOracleInvalidObjects = (databaseType?: DatabaseType) => databaseType === "oracle" || databaseType === "oceanbase-oracle";

function rows(result: QueryResult): Record<string, string | number | boolean | null>[] {
  if (result.execution_error) throw new Error(result.error ? formatError(result.error) : String(result.rows[0]?.[0] ?? "Metadata query failed"));
  if (result.truncated || result.has_more || result.large_value_cells?.length) throw new Error("Metadata is truncated; refine the filter or read the complete source before continuing.");
  return result.rows.map((values) => Object.fromEntries(result.columns.map((column, index) => [column.toUpperCase(), values[index] ?? null])));
}

function text(value: unknown): string | null { return value == null ? null : String(value); }
function objectRow(row: Record<string, unknown>): OracleInvalidObject {
  if (row.OWNER == null || row.OBJECT_NAME == null || row.OBJECT_TYPE == null) throw new Error("Incomplete object identity in dictionary response");
  return { schema: String(row.OWNER), name: String(row.OBJECT_NAME), object_type: String(row.OBJECT_TYPE).replaceAll(" ", "_"), status: text(row.STATUS), object_id: text(row.OBJECT_ID), last_ddl_time: text(row.LAST_DDL_TIME) };
}
const objectColumns = "OWNER, OBJECT_NAME, OBJECT_TYPE, STATUS, TO_CHAR(OBJECT_ID) AS OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME";
function predicate(target: OracleObjectIdentity, objectNames = false): string {
  return `OWNER = ${literal(target.schema)} AND ${objectNames ? "OBJECT_NAME" : "NAME"} = ${literal(target.name)} AND ${objectNames ? "OBJECT_TYPE" : "TYPE"} = ${literal(dictionaryKind(target.object_type))}`;
}

export async function listOracleInvalidObjects(query: OracleMetadataQuery, schema = "", objectType = "", offset = 0): Promise<{ objects: OracleInvalidObject[]; has_more: boolean }> {
  const start = Math.max(0, Math.floor(offset));
  const filter = `STATUS = 'INVALID'${schema ? ` AND OWNER = ${literal(schema)}` : ""}${objectType ? ` AND OBJECT_TYPE = ${literal(dictionaryKind(objectType))}` : ""}`;
  const result = rows(await query(`SELECT * FROM (SELECT ${objectColumns}, ROW_NUMBER() OVER (ORDER BY OWNER, OBJECT_NAME, OBJECT_TYPE) AS DBX_RN FROM ALL_OBJECTS WHERE ${filter}) WHERE DBX_RN BETWEEN ${start + 1} AND ${start + 101} ORDER BY DBX_RN`));
  // Unknown states are never promoted to INVALID, even if an old Agent returns a stale row.
  return { objects: result.slice(0, 100).map(objectRow).filter((item) => item.status === "INVALID"), has_more: result.length > 100 };
}

export async function readOracleObject(query: OracleMetadataQuery, target: OracleObjectIdentity): Promise<OracleInvalidObject | null> {
  const result = rows(await query(`SELECT ${objectColumns} FROM ALL_OBJECTS WHERE ${predicate(target, true)}`));
  if (result.length > 1) throw new Error("Object identity is ambiguous; refresh the object list");
  return result.length ? objectRow(result[0]) : null;
}

async function section<T>(read: () => Promise<T[]>, empty: OracleReadSection<T>["state"] = "empty"): Promise<OracleReadSection<T>> {
  try { const result = await read(); return { state: result.length ? "available" : empty, rows: result }; }
  catch (cause) { const value = message(cause); return { state: /ORA-01031|insufficient privilege|access denied/i.test(value) ? "denied" : /ORA-00942/i.test(value) ? "unavailable" : "error", rows: [], message: value }; }
}

export function readOracleCompileErrors(query: OracleMetadataQuery, target: OracleObjectIdentity): Promise<OracleReadSection<OracleCompileError>> {
  return section(async () => rows(await query(`SELECT SEQUENCE, LINE, POSITION, TEXT, ATTRIBUTE, MESSAGE_NUMBER FROM ALL_ERRORS WHERE ${predicate(target)} ORDER BY SEQUENCE`)).map((row) => ({ sequence: Number(row.SEQUENCE), line: Number(row.LINE), position: Number(row.POSITION), text: String(row.TEXT ?? ""), attribute: text(row.ATTRIBUTE), message_number: text(row.MESSAGE_NUMBER) })));
}

export function readOracleObjectSourceLines(query: OracleMetadataQuery, target: OracleObjectIdentity): Promise<OracleReadSection<OracleSourceLine>> {
  return section(async () => rows(await query(`SELECT LINE, TEXT FROM ALL_SOURCE WHERE ${predicate(target)} ORDER BY LINE`)).flatMap((row) => {
    // OB can return a whole unit in one TEXT cell; Oracle commonly returns one row per line.
    const parts = String(row.TEXT ?? "").replaceAll("\r\n", "\n").split("\n");
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    return parts.map((part, index) => ({ line: Number(row.LINE) + index, text: part }));
  }), "unavailable");
}

export async function inspectOracleObject(query: OracleMetadataQuery, target: OracleObjectIdentity): Promise<OracleObjectInspection> {
  const object = await readOracleObject(query, target);
  if (!object) return { object: null, errors: { state: "unavailable", rows: [] }, source: { state: "unavailable", rows: [] } };
  const [errors, source] = await Promise.all([readOracleCompileErrors(query, target), readOracleObjectSourceLines(query, target)]);
  return { object, errors, source };
}

export function oracleCompileSql(databaseType: DatabaseType, target: OracleObjectIdentity): string | null {
  if (!supportsOracleInvalidObjects(databaseType) || !target.schema || !target.name) return null;
  const type = target.object_type;
  // OB 4.2.5 explicitly documents ALTER TYPE as unsupported. Do not substitute CREATE.
  if (databaseType === "oceanbase-oracle" && ["TYPE", "TYPE_BODY", "VIEW"].includes(type)) return null;
  const name = `${identifier(target.schema)}.${identifier(target.name)}`;
  if (type === "TYPE" || type === "PACKAGE") return `ALTER ${type} ${name} COMPILE SPECIFICATION`;
  if (type === "TYPE_BODY" || type === "PACKAGE_BODY") return `ALTER ${type.replace("_BODY", "")} ${name} COMPILE BODY`;
  if (["PROCEDURE", "FUNCTION", "TRIGGER", "VIEW"].includes(type)) return `ALTER ${type} ${name} COMPILE`;
  return null;
}

export async function compileOracleObject(options: {
  databaseType: DatabaseType;
  target: OracleInvalidObject;
  query: OracleMetadataQuery;
  execute: (sql: string) => Promise<boolean>;
  cancelled?: () => boolean;
}): Promise<OracleCompileResult> {
  const { target, query } = options;
  const result: OracleCompileResult = { outcome: "unknown", statement_sent: false, object: null, errors: { state: "unavailable", rows: [] } };
  const sql = oracleCompileSql(options.databaseType, target);
  if (!sql) return { ...result, outcome: "unsupported" };
  if (options.cancelled?.()) return { ...result, outcome: "cancelled" };
  try {
    const current = await readOracleObject(query, target);
    result.object = current;
    if (!current) return { ...result, outcome: "unavailable" };
    if (!target.object_id || !target.last_ddl_time || current.object_id !== target.object_id || current.last_ddl_time !== target.last_ddl_time || current.status !== target.status) return { ...result, outcome: "changed" };
    if (options.cancelled?.()) return { ...result, outcome: "cancelled" };
    try {
      result.statement_sent = true;
      if (!(await options.execute(sql))) return { ...result, statement_sent: false, outcome: "cancelled" };
    } catch (cause) { result.execution_error = message(cause); }
    // A cancellation request can race with DDL completion. Always read back after sending.
    result.object = null;
    result.object = await readOracleObject(query, target);
    result.errors = await readOracleCompileErrors(query, target);
    if (!result.object) result.outcome = "unavailable";
    else if (result.object.object_id !== target.object_id) result.outcome = "changed";
    else if (result.execution_error) result.outcome = "failed";
    else if (result.object.status === "INVALID" || result.errors.rows.some((error) => error.attribute === "ERROR")) result.outcome = "invalid";
    else if (result.object.status === "VALID" && ["available", "empty"].includes(result.errors.state) && result.errors.rows.every((error) => error.attribute === "WARNING")) result.outcome = "valid";
    if (options.cancelled?.()) result.outcome = "cancelled";
    return result;
  } catch (cause) { return { ...result, outcome: options.cancelled?.() ? "cancelled" : "failed", execution_error: [result.execution_error, message(cause)].filter(Boolean).join("\n") }; }
}
