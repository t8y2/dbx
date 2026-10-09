import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";
import type { DatabaseType, QueryResult } from "@/types/database";

export type TypePart = "TYPE" | "TYPE_BODY";
export interface TypeTarget { schema: string; name: string }
export interface TypeDefinition { kind: TypePart; source: string; status: string | null; objectId: string; lastDdl: string }
export interface TypeReference { owner: string; name: string; kind: string; detail: string }
export interface TypeSnapshot { definitions: TypeDefinition[]; references: TypeReference[] }
export interface TypeWriteStep { kind: TypePart; sql: string; action: "create" | "replace" | "drop" }
export interface TypeWritePlan { target: TypeTarget; engine: DatabaseType; before: TypeSnapshot; steps: TypeWriteStep[] }
export interface TypeWriteResult { state: "complete" | "invalid" | "failed" | "changed" | "cancelled"; sent: TypeWriteStep[]; before: TypeSnapshot; after?: TypeSnapshot; errors: Record<string, unknown>[]; message?: string }
export interface TypeWriteIO {
  query: (sql: string) => Promise<QueryResult>;
  source: (kind: TypePart) => Promise<string>;
  execute: (sql: string) => Promise<QueryResult>;
  cancelled?: () => boolean;
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const qualified = (target: TypeTarget) => `${identifier(target.schema)}.${identifier(target.name)}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function dictionaryRows(result: QueryResult): Record<string, unknown>[] {
  if (result.execution_error) throw new Error(result.error?.message || String(result.rows[0]?.[0] ?? "Dictionary query failed"));
  if (result.truncated || result.has_more || result.large_value_cells?.length) throw new Error("Complete metadata is required; the dictionary result was truncated.");
  return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column.toUpperCase(), row[index]])));
}

function tokenName(token?: SqlSemanticToken): string {
  if (token?.kind === "word") return token.text.toUpperCase();
  if (token?.kind === "quoted_identifier" && token.quote === '"' && token.closed !== false) return token.text.slice(1, -1).replaceAll('""', '"');
  throw new Error("Expected an Oracle identifier in the type definition.");
}

/** Validate the header with the existing Oracle lexer; never infer the target from a regex. */
export function typeDefinitionSql(source: string, target: TypeTarget, kind: TypePart, replace: boolean): string {
  if (!target.schema || !target.name) throw new Error("An exact owner and name are required.");
  const statements = splitSqlStatementRanges(source, "oracle");
  if (statements.length !== 1) throw new Error("Provide exactly one complete type definition in each editor.");
  const sql = statements[0].sql.trim();
  const tokens = tokenizeSqlSemantic(sql, "oracle").filter((token) => token.kind !== "comment");
  if (tokens.some((token) => token.closed === false)) throw new Error("A quoted value in the definition is not closed.");
  let index = 0;
  const accept = (word: string) => { if (tokens[index]?.kind === "word" && tokens[index].normalized === word) { index++; return true; } return false; };
  if (!accept("create")) throw new Error("The definition must begin with CREATE TYPE.");
  if (accept("or") && !accept("replace")) throw new Error("Expected OR REPLACE.");
  if (!accept("type")) throw new Error("Only CREATE TYPE and CREATE TYPE BODY are supported here.");
  const body = accept("body");
  if (body !== (kind === "TYPE_BODY")) throw new Error("The definition kind does not match the selected target.");
  const first = tokenName(tokens[index++]);
  let name = first;
  if (tokens[index]?.text === ".") {
    index++;
    name = tokenName(tokens[index++]);
    if (first !== target.schema) throw new Error("The source owner differs from the exact target owner.");
  }
  if (name !== target.name) throw new Error("The source name differs from the exact target name.");
  const definitionStart = tokens[index]?.span.start;
  if (!(accept("as") || accept("is"))) throw new Error("Only complete AS/IS definitions are supported. FORCE, type evolution and edition changes require a separate plan.");
  if (!body && !["object", "table", "varray", "varying"].includes(tokens[index]?.normalized ?? "")) throw new Error("Expected an object, nested table or VARRAY definition.");
  if (definitionStart == null || !tokens[index]) throw new Error("The type definition is incomplete.");
  return `CREATE${replace ? " OR REPLACE" : ""} TYPE${body ? " BODY" : ""} ${qualified(target)} ${sql.slice(definitionStart).replace(/;\s*$/, "")};`;
}

export async function readTypeWriteSnapshot(io: Pick<TypeWriteIO, "query" | "source">, target: TypeTarget): Promise<TypeSnapshot> {
  if (!target.schema || !target.name) throw new Error("An exact owner and name are required.");
  const owner = literal(target.schema), name = literal(target.name);
  // DBA scope is intentional: ALL_* alone cannot prove that hidden cross-owner dependents do not exist.
  const objects = dictionaryRows(await io.query(`SELECT OBJECT_TYPE, STATUS, TO_CHAR(OBJECT_ID) AS OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME FROM DBA_OBJECTS WHERE OWNER = ${owner} AND OBJECT_NAME = ${name} AND OBJECT_TYPE IN ('TYPE', 'TYPE BODY') ORDER BY OBJECT_TYPE`));
  const definitions: TypeDefinition[] = [];
  for (const row of objects) {
    const kind = row.OBJECT_TYPE === "TYPE" ? "TYPE" : row.OBJECT_TYPE === "TYPE BODY" ? "TYPE_BODY" : null;
    if (!kind || !row.OBJECT_ID || !row.LAST_DDL_TIME || definitions.some((item) => item.kind === kind)) throw new Error("The dictionary did not return a unique complete type identity.");
    const source = await io.source(kind);
    if (!source.trim()) throw new Error("The original full definition is unavailable; no change can be prepared.");
    definitions.push({ kind, source, status: row.STATUS == null ? null : String(row.STATUS), objectId: String(row.OBJECT_ID), lastDdl: String(row.LAST_DDL_TIME) });
  }
  const references: TypeReference[] = [];
  const queries = [
    `SELECT OWNER, NAME, TYPE AS KIND, REFERENCED_TYPE AS DETAIL FROM DBA_DEPENDENCIES WHERE REFERENCED_OWNER = ${owner} AND REFERENCED_NAME = ${name} AND REFERENCED_TYPE IN ('TYPE', 'TYPE BODY') ORDER BY OWNER, NAME, TYPE, REFERENCED_TYPE`,
    `SELECT OWNER, TABLE_NAME AS NAME, 'TABLE COLUMN' AS KIND, COLUMN_NAME AS DETAIL FROM DBA_TAB_COLUMNS WHERE DATA_TYPE_OWNER = ${owner} AND DATA_TYPE = ${name} ORDER BY OWNER, TABLE_NAME, COLUMN_NAME`,
    `SELECT OWNER, TYPE_NAME AS NAME, 'COLLECTION' AS KIND, COLL_TYPE AS DETAIL FROM DBA_COLL_TYPES WHERE ELEM_TYPE_OWNER = ${owner} AND ELEM_TYPE_NAME = ${name} ORDER BY OWNER, TYPE_NAME`,
    `SELECT OWNER, TYPE_NAME AS NAME, 'SUBTYPE' AS KIND, TYPECODE AS DETAIL FROM DBA_TYPES WHERE SUPERTYPE_OWNER = ${owner} AND SUPERTYPE_NAME = ${name} ORDER BY OWNER, TYPE_NAME`,
    `SELECT OWNER, TABLE_NAME AS NAME, 'OBJECT TABLE' AS KIND, TABLE_TYPE AS DETAIL FROM DBA_OBJECT_TABLES WHERE TABLE_TYPE_OWNER = ${owner} AND TABLE_TYPE = ${name} ORDER BY OWNER, TABLE_NAME`,
  ];
  for (const sql of queries) {
    for (const row of dictionaryRows(await io.query(sql))) {
      if (row.OWNER == null || row.NAME == null || row.KIND == null) throw new Error("Dependency metadata is incomplete.");
      references.push({ owner: String(row.OWNER), name: String(row.NAME), kind: String(row.KIND), detail: String(row.DETAIL ?? "") });
    }
  }
  return { definitions, references };
}

export function prepareTypeWritePlan(engine: DatabaseType, target: TypeTarget, before: TypeSnapshot, sources: Partial<Record<TypePart, string>>, drop?: TypePart): TypeWritePlan {
  if (engine !== "oracle" && engine !== "oceanbase-oracle") throw new Error("This connection does not support Oracle type management.");
  const steps: TypeWriteStep[] = [];
  if (drop) {
    if (!before.definitions.some((item) => item.kind === drop)) throw new Error("The selected type does not exist in the snapshot.");
    steps.push({ kind: drop, action: "drop", sql: `DROP TYPE${drop === "TYPE_BODY" ? " BODY" : ""} ${qualified(target)}` });
  } else {
    for (const kind of ["TYPE", "TYPE_BODY"] as const) {
      const source = sources[kind];
      if (!source?.trim()) continue;
      const original = before.definitions.find((item) => item.kind === kind);
      if (source === original?.source) continue;
      steps.push({ kind, action: original ? "replace" : "create", sql: typeDefinitionSql(source, target, kind, !!original) });
    }
    if (steps.some((step) => step.kind === "TYPE_BODY") && !before.definitions.some((item) => item.kind === "TYPE") && !steps.some((step) => step.kind === "TYPE")) throw new Error("Create the type specification before its body.");
  }
  const dependent = before.references.filter((ref) => !(ref.owner === target.schema && ref.name === target.name && ref.kind === "TYPE BODY"));
  if (steps.some((step) => step.kind === "TYPE" && step.action !== "create") && dependent.length) throw new Error("Incoming dependencies block replacement or deletion of the type specification. Type evolution requires a separate plan; FORCE and CASCADE will not be used.");
  if (!steps.length) throw new Error("There are no definition changes to execute.");
  return { target: { ...target }, engine, before: { definitions: before.definitions.map((item) => ({ ...item })), references: before.references.map((item) => ({ ...item })) }, steps };
}

export async function executeTypeWritePlan(io: TypeWriteIO, plan: TypeWritePlan): Promise<TypeWriteResult> {
  const result: TypeWriteResult = { state: "failed", sent: [], before: plan.before, errors: [] };
  try {
    if (io.cancelled?.()) return { ...result, state: "cancelled" };
    const current = await readTypeWriteSnapshot(io, plan.target);
    if (JSON.stringify(current) !== JSON.stringify(plan.before)) return { ...result, state: "changed", after: current, message: "The definition or dependencies changed. Prepare a new preview." };
    for (const step of plan.steps) {
      if (io.cancelled?.()) return { ...result, state: "cancelled" };
      if (result.sent.length) {
        const latest = await readTypeWriteSnapshot(io, plan.target);
        if (JSON.stringify(latest) !== JSON.stringify(result.after)) return { ...result, state: "changed", after: latest, message: "The object changed between steps. Remaining steps were not sent." };
        if (io.cancelled?.()) return { ...result, state: "cancelled" };
      }
      let executionError: string | undefined;
      result.sent.push(step);
      try {
        const response = await io.execute(step.sql);
        if (response.execution_error) executionError = response.error?.message || String(response.rows[0]?.[0] ?? "Type DDL failed");
      } catch (error) { executionError = errorText(error); }
      // Sent DDL is not transactional. Read back even after a cancellation or execution failure.
      try {
        result.after = await readTypeWriteSnapshot(io, plan.target);
        result.errors = dictionaryRows(await io.query(`SELECT OWNER, NAME, TYPE, SEQUENCE, LINE, POSITION, TEXT, ATTRIBUTE FROM ALL_ERRORS WHERE OWNER = ${literal(plan.target.schema)} AND NAME = ${literal(plan.target.name)} AND TYPE IN ('TYPE', 'TYPE BODY') ORDER BY TYPE, SEQUENCE`));
      } catch (error) { result.message = [executionError, errorText(error)].filter(Boolean).join("\n"); return result; }
      if (executionError) return { ...result, message: executionError };
      if (io.cancelled?.()) return { ...result, state: "cancelled" };
      const actual = result.after.definitions.find((item) => item.kind === step.kind);
      if (step.action === "drop") {
        if (actual || (step.kind === "TYPE" && result.after.definitions.length)) return { ...result, message: "The object is still present after DROP." };
      } else {
        if (!actual || actual.status !== "VALID" || result.errors.some((row) => row.TYPE === step.kind.replaceAll("_", " ") && row.ATTRIBUTE !== "WARNING")) return { ...result, state: "invalid", message: "The saved definition was not confirmed VALID." };
      }
    }
    if (result.after?.definitions.some((item) => item.status !== "VALID") || result.errors.some((row) => row.ATTRIBUTE !== "WARNING")) return { ...result, state: "invalid", message: "The specification and body were not both confirmed VALID." };
    return { ...result, state: "complete" };
  } catch (error) { return { ...result, message: errorText(error) }; }
}
