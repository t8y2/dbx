import * as api from "@/lib/backend/api";
import { createColumnDrafts } from "@/lib/table/tableStructureEditorState";
import type { QueryResult } from "@/types/database";
import type { DuplicateTableStructurePlan, DuplicateTableStructurePlanOptions } from "./dbAdminSql";

export interface OceanbaseTableClone {
  targetSchema: string;
  targetName: string;
  columnCount: number;
  indexNames: string[];
  exclusions: Array<{ kind: "constraint" | "partitioning" | "trigger" | "index"; name?: string; type?: string }>;
  steps: Array<{ kind: "table" | "primaryKey" | "index" | "comment" | "data"; name: string; sql: string }>;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

export class OceanbaseCloneValidationError extends Error {
  constructor(
    readonly key: string,
    readonly values: Record<string, string> = {},
  ) {
    super(key);
  }
}

export function oceanbaseCloneTargetName(input: string): string {
  const name = input.trim();
  if (/^[A-Za-z][A-Za-z0-9_$#]*$/.test(name)) return name.toUpperCase();
  if (/^"(?:[^"]|"")+"$/.test(name)) return name.slice(1, -1).replace(/""/g, '"');
  throw new OceanbaseCloneValidationError("invalidName");
}

function cloneIndexName(table: string, position: number): string {
  const prefix = table.replace(/[^A-Za-z0-9_$#]/g, "_").toUpperCase() || "TABLE";
  const suffix = `_IDX${position + 1}`;
  return `${prefix.slice(0, 30 - suffix.length)}${suffix}`;
}

/** Clone only the supported logical structure; every dictionary read must succeed before DDL. */
export async function buildOceanbaseTableClone(options: DuplicateTableStructurePlanOptions): Promise<DuplicateTableStructurePlan> {
  let sourceSchema = options.schema || "";
  const query = async (sql: string) => {
    const result = await api.executeQuery(options.connectionId, options.database, sql, sourceSchema, undefined, { catalog: options.catalog, maxRows: 10001 });
    if (result.execution_error) throw result.error?.detail ? new Error(result.error.detail) : new OceanbaseCloneValidationError("metadataRead");
    if (result.truncated === true || result.rows.length >= 10001 || result.has_more) throw new OceanbaseCloneValidationError("metadataTruncated");
    return result.rows;
  };
  if (!sourceSchema) {
    const current = await query("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL");
    if (current.length !== 1 || typeof current[0]?.[0] !== "string" || !current[0][0]) throw new OceanbaseCloneValidationError("currentSchema");
    sourceSchema = current[0][0];
  }
  const targetSchema = sourceSchema;
  const targetName = oceanbaseCloneTargetName(options.targetName);
  const where = `OWNER = ${literal(sourceSchema)} AND TABLE_NAME = ${literal(options.sourceName)}`;
  const columns = await api.getColumns(options.connectionId, options.database, sourceSchema, options.sourceName, options.catalog);
  const [constraints, indexes, triggers, comments, directions, conflicts, virtualColumns, excludedConstraints, tableFlags] = await Promise.all([
    api.listConstraints(options.connectionId, options.database, sourceSchema, options.sourceName, options.catalog),
    api.listIndexes(options.connectionId, options.database, sourceSchema, options.sourceName, options.catalog),
    api.listTriggers(options.connectionId, options.database, sourceSchema, options.sourceName, options.catalog),
    query(`SELECT COMMENTS FROM SYS.ALL_TAB_COMMENTS WHERE ${where} AND TABLE_TYPE = 'TABLE'`),
    query(`SELECT INDEX_NAME, COLUMN_NAME, COLUMN_POSITION, DESCEND FROM SYS.ALL_IND_COLUMNS WHERE TABLE_OWNER = ${literal(sourceSchema)} AND TABLE_NAME = ${literal(options.sourceName)} ORDER BY INDEX_NAME, COLUMN_POSITION`),
    query(`SELECT OBJECT_NAME FROM SYS.ALL_OBJECTS WHERE OWNER = ${literal(targetSchema)} AND OBJECT_NAME = ${literal(targetName)} AND OBJECT_TYPE <> 'INDEX' AND ROWNUM <= 1`),
    query(`SELECT COLUMN_NAME FROM SYS.ALL_TAB_COLS WHERE ${where} AND VIRTUAL_COLUMN = 'YES'`),
    query(`SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE, INDEX_NAME FROM SYS.ALL_CONSTRAINTS WHERE ${where} AND CONSTRAINT_TYPE IN ('U', 'R')`),
    query(`SELECT PARTITIONED, TEMPORARY FROM SYS.ALL_TABLES WHERE ${where}`),
  ]);
  if (tableFlags.length !== 1 || !["YES", "NO"].includes(String(tableFlags[0]?.[0])) || !["Y", "N"].includes(String(tableFlags[0]?.[1]))) throw new OceanbaseCloneValidationError("tableProperties");
  if (tableFlags[0]![1] === "Y") throw new OceanbaseCloneValidationError("temporaryTable");
  if (virtualColumns.length) throw new OceanbaseCloneValidationError("virtualColumns", { names: virtualColumns.map((row) => ident(String(row[0]))).join(", ") });
  if (!columns.length || comments.length !== 1) throw new OceanbaseCloneValidationError("sourceMetadata");
  if (conflicts.length) throw new OceanbaseCloneValidationError("targetExists", { name: `${ident(targetSchema)}.${ident(targetName)}` });
  const primaryKeys = constraints.filter((constraint) => constraint.constraint_type === "PRIMARY KEY");
  if (primaryKeys.length > 1 || (columns.some((column) => column.is_primary_key) && primaryKeys.length !== 1)) {
    throw new OceanbaseCloneValidationError("primaryKeyMetadata");
  }
  const target = `${ident(targetSchema)}.${ident(targetName)}`;
  const result = await api.buildCreateTableSql({
    databaseType: "oceanbase-oracle",
    schema: targetSchema,
    tableName: targetName,
    columns: createColumnDrafts(columns, "oceanbase-oracle").map((column, index) => ({
      ...column,
      id: `clone:column:${index}`,
      original: undefined,
      originalPosition: undefined,
      isPrimaryKey: false,
      comment: "",
    })),
    indexes: [],
    foreignKeys: [],
    triggers: [],
  });
  if (result.warnings.length || result.statements.length !== 1) throw result.warnings.length ? new Error(result.warnings.join("\n")) : new OceanbaseCloneValidationError("createColumns");
  const steps: OceanbaseTableClone["steps"] = [{ kind: "table", name: target, sql: result.statements[0]! }];
  for (const primaryKey of primaryKeys) {
    if (!primaryKey.columns.length || primaryKey.columns.some((name) => !columns.some((column) => column.name === name))) throw new OceanbaseCloneValidationError("primaryKeyMetadata");
    if (primaryKey.enabled !== true || primaryKey.valid !== true || primaryKey.deferrable !== false) throw new OceanbaseCloneValidationError("primaryKeyState");
    const markedColumns = columns.filter((column) => column.is_primary_key).map((column) => column.name);
    if (new Set(primaryKey.columns).size !== primaryKey.columns.length || markedColumns.length !== primaryKey.columns.length || markedColumns.some((name) => !primaryKey.columns.includes(name))) throw new OceanbaseCloneValidationError("primaryKeyMetadata");
    const sql = `ALTER TABLE ${target} ADD PRIMARY KEY (${primaryKey.columns.map(ident).join(", ")});`;
    steps.push({ kind: "primaryKey", name: primaryKey.columns.map(ident).join(", "), sql });
  }
  const exclusions: OceanbaseTableClone["exclusions"] = constraints.filter((constraint) => constraint.constraint_type !== "PRIMARY KEY").map((constraint) => ({ kind: "constraint", name: constraint.name, type: constraint.constraint_type }));
  if (tableFlags[0]![0] === "YES") exclusions.push({ kind: "partitioning" });
  const uniqueConstraintIndexes = new Set<string>();
  if (constraints.some((constraint) => constraint.constraint_type === "UNIQUE" && !excludedConstraints.some((row) => row[0] === constraint.name && row[1] === "U"))) throw new OceanbaseCloneValidationError("uniqueIndexMetadata");
  for (const row of excludedConstraints) {
    if (row[1] === "U") {
      if (typeof row[2] !== "string" || !row[2]) throw new OceanbaseCloneValidationError("uniqueIndexMetadata");
      uniqueConstraintIndexes.add(row[2]);
    }
    if (!exclusions.some((item) => item.kind === "constraint" && item.name === row[0])) exclusions.push({ kind: "constraint", name: String(row[0]), type: row[1] === "U" ? "UNIQUE" : "FOREIGN KEY" });
  }
  exclusions.push(...triggers.map((trigger) => ({ kind: "trigger" as const, name: trigger.name })));
  const columnNames = new Set(columns.map((column) => column.name));
  const normalIndexes = indexes.filter((index) => {
    if (index.is_primary || uniqueConstraintIndexes.has(index.name)) return false;
    if (index.index_type?.toUpperCase() !== "NORMAL" || index.key_is_expression?.some(Boolean)) {
      exclusions.push({ kind: "index", name: index.name, type: index.index_type ?? undefined });
      return false;
    }
    return true;
  });
  const newIndexNames = normalIndexes.map((_, index) => cloneIndexName(targetName, index));
  const visibility = normalIndexes.length ? await query(`SELECT INDEX_NAME, VISIBILITY FROM SYS.ALL_INDEXES WHERE TABLE_OWNER = ${literal(sourceSchema)} AND TABLE_NAME = ${literal(options.sourceName)}`) : [];
  if (newIndexNames.length) {
    const taken = await query(`SELECT OBJECT_NAME FROM SYS.ALL_OBJECTS WHERE OWNER = ${literal(targetSchema)} AND OBJECT_TYPE = 'INDEX' AND OBJECT_NAME IN (${newIndexNames.map(literal).join(", ")})`);
    if (taken.length) throw new OceanbaseCloneValidationError("indexExists", { names: taken.map((row) => ident(String(row[0]))).join(", ") });
  }
  normalIndexes.forEach((index, position) => {
    const indexVisibility = visibility.filter((row) => row[0] === index.name);
    if (indexVisibility.length !== 1 || !["VISIBLE", "INVISIBLE"].includes(String(indexVisibility[0]?.[1]))) throw new OceanbaseCloneValidationError("indexVisibility", { name: ident(index.name) });
    const keys = directions.filter((row) => row[0] === index.name);
    if (!keys.length || keys.length !== index.columns.length || keys.some((row, keyPosition) => Number(row[2]) !== keyPosition + 1 || row[1] !== index.columns[keyPosition] || !columnNames.has(String(row[1])) || !["ASC", "DESC"].includes(String(row[3])))) {
      throw new OceanbaseCloneValidationError("indexColumns", { name: ident(index.name) });
    }
    const name = `${ident(targetSchema)}.${ident(newIndexNames[position]!)}`;
    steps.push({ kind: "index", name, sql: `CREATE ${index.is_unique ? "UNIQUE " : ""}INDEX ${name} ON ${target} (${keys.map((row) => `${ident(String(row[1]))} ${row[3]}`).join(", ")})${indexVisibility[0]![1] === "INVISIBLE" ? " INVISIBLE" : ""};` });
  });
  const tableComment = comments[0]![0];
  if (tableComment != null) steps.push({ kind: "comment", name: target, sql: `COMMENT ON TABLE ${target} IS ${literal(String(tableComment))};` });
  for (const column of columns) {
    if (column.comment != null) steps.push({ kind: "comment", name: `${target}.${ident(column.name)}`, sql: `COMMENT ON COLUMN ${target}.${ident(column.name)} IS ${literal(column.comment)};` });
  }
  return { sql: steps.map((step) => step.sql).join("\n"), sourceColumns: columns, executeAsScript: false, oceanbaseClone: { targetSchema, targetName, columnCount: columns.length, indexNames: newIndexNames, exclusions, steps } };
}

export class OceanbaseTableCloneError extends Error {
  constructor(
    message: string,
    readonly targetSchema: string,
    readonly targetName: string,
    readonly execution?: { steps: OceanbaseTableClone["steps"]; failedPosition: number; rejected: boolean; notExecuted?: boolean; cause: unknown },
  ) {
    super(message);
  }
}

/** OB DDL commits independently. Stop at the first failure and preserve an actionable ledger. */
export async function executeOceanbaseTableClone(clone: OceanbaseTableClone, execute: (sql: string) => Promise<QueryResult>): Promise<QueryResult> {
  let result: QueryResult | undefined;
  for (const [position, step] of clone.steps.entries()) {
    let rejected = false;
    try {
      result = await execute(step.sql.replace(/;\s*$/, ""));
      if (result.execution_error) {
        rejected = true;
        throw result.error?.detail ? new Error(result.error.detail) : new OceanbaseCloneValidationError("executionFailed");
      }
    } catch (error) {
      throw new OceanbaseTableCloneError(error instanceof Error ? error.message : String(error), clone.targetSchema, clone.targetName, { steps: clone.steps, failedPosition: position, rejected, cause: error });
    }
  }
  return result!;
}

/** Called only after the structure has committed and data-copy production safety is confirmed. */
export async function executeOceanbaseTableCloneData(clone: OceanbaseTableClone, sql: string, execute: (sql: string) => Promise<QueryResult>): Promise<QueryResult> {
  const name = `${ident(clone.targetSchema)}.${ident(clone.targetName)}`;
  const step: OceanbaseTableClone["steps"][number] = { kind: "data", name, sql };
  try {
    return await executeOceanbaseTableClone({ ...clone, steps: [step] }, execute);
  } catch (error) {
    if (error instanceof OceanbaseTableCloneError && error.execution) {
      throw new OceanbaseTableCloneError(error.message, clone.targetSchema, clone.targetName, { ...error.execution, steps: [...clone.steps, step], failedPosition: clone.steps.length });
    }
    throw error;
  }
}

/** The structure committed, but preparation/protection failed before data execution. */
export function oceanbaseCloneDataPreparationError(clone: OceanbaseTableClone, cause: unknown): OceanbaseTableCloneError {
  const name = `${ident(clone.targetSchema)}.${ident(clone.targetName)}`;
  return new OceanbaseTableCloneError(cause instanceof Error ? cause.message : String(cause), clone.targetSchema, clone.targetName, {
    steps: [...clone.steps, { kind: "data", name, sql: "" }],
    failedPosition: clone.steps.length,
    rejected: false,
    notExecuted: true,
    cause,
  });
}
