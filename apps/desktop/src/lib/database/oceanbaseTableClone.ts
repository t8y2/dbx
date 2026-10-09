import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { createColumnDrafts } from "@/lib/table/tableStructureEditorState";
import type { QueryResult } from "@/types/database";
import type { DuplicateTableStructurePlan, DuplicateTableStructurePlanOptions } from "./dbAdminSql";

export interface OceanbaseTableClone {
  targetSchema: string;
  targetName: string;
  copied: string[];
  excluded: string[];
  steps: Array<{ label: string; sql: string }>;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

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
    if (result.execution_error) throw new Error(result.error ? formatError(result.error) : "Unable to read clone metadata.");
    if (result.rows.length >= 10001 || result.has_more) throw new Error("Clone metadata was truncated. No DDL was executed.");
    return result.rows;
  };
  if (!sourceSchema) {
    const current = await query("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL");
    if (current.length !== 1 || typeof current[0]?.[0] !== "string" || !current[0][0]) throw new Error("Current schema is unavailable. No DDL was executed.");
    sourceSchema = current[0][0];
  }
  const targetSchema = options.targetSchema || sourceSchema;
  if (!options.targetName.trim()) throw new Error("Target table name is required.");
  const where = `OWNER = ${literal(sourceSchema)} AND TABLE_NAME = ${literal(options.sourceName)}`;
  const [columns, constraints, indexes, triggers, comments, directions, conflicts] = await Promise.all([
    options.sourceColumns ?? api.getColumns(options.connectionId, options.database, sourceSchema, options.sourceName, options.catalog),
    api.listConstraints(options.connectionId, options.database, sourceSchema, options.sourceName, options.catalog),
    api.listIndexes(options.connectionId, options.database, sourceSchema, options.sourceName, options.catalog),
    api.listTriggers(options.connectionId, options.database, sourceSchema, options.sourceName, options.catalog),
    query(`SELECT COMMENTS FROM SYS.ALL_TAB_COMMENTS WHERE ${where} AND TABLE_TYPE = 'TABLE'`),
    query(`SELECT INDEX_NAME, COLUMN_NAME, COLUMN_POSITION, DESCEND FROM SYS.ALL_IND_COLUMNS WHERE TABLE_OWNER = ${literal(sourceSchema)} AND TABLE_NAME = ${literal(options.sourceName)} ORDER BY INDEX_NAME, COLUMN_POSITION`),
    query(`SELECT OBJECT_NAME FROM SYS.ALL_OBJECTS WHERE OWNER = ${literal(targetSchema)} AND OBJECT_NAME = ${literal(options.targetName)} AND ROWNUM <= 1`),
  ]);
  if (!columns.length || comments.length !== 1) throw new Error("Source table metadata is missing or inaccessible. No DDL was executed.");
  if (conflicts.length) throw new Error(`Target already exists: ${ident(targetSchema)}.${ident(options.targetName)}. No DDL was executed.`);
  const primaryKeys = constraints.filter((constraint) => constraint.constraint_type === "PRIMARY KEY");
  if (primaryKeys.length > 1 || (columns.some((column) => column.is_primary_key) && primaryKeys.length !== 1)) {
    throw new Error("Source primary-key metadata is incomplete. No DDL was executed.");
  }
  const target = `${ident(targetSchema)}.${ident(options.targetName)}`;
  const result = await api.buildCreateTableSql({
    databaseType: "oceanbase-oracle", schema: targetSchema, tableName: options.targetName,
    columns: createColumnDrafts(columns, "oceanbase-oracle").map((column, index) => ({
      ...column, id: `clone:column:${index}`, original: undefined, originalPosition: undefined, isPrimaryKey: false, comment: "",
    })),
    indexes: [], foreignKeys: [], triggers: [],
  });
  if (result.warnings.length || result.statements.length !== 1) throw new Error(result.warnings.join("\n") || "Unable to generate complete OceanBase Oracle table columns.");
  const steps: OceanbaseTableClone["steps"] = [{ label: `TABLE ${target}`, sql: result.statements[0]! }];
  const copied = [`COLUMNS: ${columns.map((column) => ident(column.name)).join(", ")}`];
  for (const primaryKey of primaryKeys) {
    if (!primaryKey.columns.length || primaryKey.columns.some((name) => !columns.some((column) => column.name === name))) throw new Error("Source primary-key column order is unavailable.");
    if (primaryKey.enabled === false || primaryKey.valid === false || primaryKey.deferrable) throw new Error("Cloning disabled, unvalidated or deferrable primary keys is not supported.");
    const sql = `ALTER TABLE ${target} ADD PRIMARY KEY (${primaryKey.columns.map(ident).join(", ")});`;
    steps.push({ label: `PRIMARY KEY (${primaryKey.columns.map(ident).join(", ")})`, sql });
    copied.push(steps[steps.length - 1]!.label);
  }
  const excluded = constraints.filter((constraint) => constraint.constraint_type !== "PRIMARY KEY").map((constraint) => `${constraint.constraint_type}: ${ident(constraint.name)}`);
  excluded.push(...triggers.map((trigger) => `TRIGGER: ${ident(trigger.name)}`));
  const columnNames = new Set(columns.map((column) => column.name));
  const normalIndexes = indexes.filter((index) => {
    if (index.is_primary) return false;
    if (index.index_type?.toUpperCase() !== "NORMAL" || index.key_is_expression?.some(Boolean)) {
      excluded.push(`INDEX (${index.index_type || "unknown"}): ${ident(index.name)}`);
      return false;
    }
    return true;
  });
  const newIndexNames = normalIndexes.map((_, index) => cloneIndexName(options.targetName, index));
  if (newIndexNames.length) {
    const taken = await query(`SELECT OBJECT_NAME FROM SYS.ALL_OBJECTS WHERE OWNER = ${literal(targetSchema)} AND OBJECT_TYPE = 'INDEX' AND OBJECT_NAME IN (${newIndexNames.map(literal).join(", ")})`);
    if (taken.length) throw new Error(`Target index name already exists: ${taken.map((row) => ident(String(row[0]))).join(", ")}. Choose another target table name. No DDL was executed.`);
  }
  normalIndexes.forEach((index, position) => {
    const keys = directions.filter((row) => row[0] === index.name);
    if (!keys.length || keys.length !== index.columns.length || keys.some((row, keyPosition) => Number(row[2]) !== keyPosition + 1 || row[1] !== index.columns[keyPosition] || !columnNames.has(String(row[1])) || !["ASC", "DESC"].includes(String(row[3])))) {
      throw new Error(`Incomplete column order/direction for index ${ident(index.name)}. No DDL was executed.`);
    }
    const name = `${ident(targetSchema)}.${ident(newIndexNames[position]!)}`;
    steps.push({ label: `INDEX ${name}`, sql: `CREATE ${index.is_unique ? "UNIQUE " : ""}INDEX ${name} ON ${target} (${keys.map((row) => `${ident(String(row[1]))} ${row[3]}`).join(", ")});` });
    copied.push(`INDEX ${ident(index.name)} → ${name}`);
  });
  const tableComment = comments[0]![0];
  if (tableComment != null) steps.push({ label: `COMMENT ${target}`, sql: `COMMENT ON TABLE ${target} IS ${literal(String(tableComment))};` });
  for (const column of columns) {
    if (column.comment != null) steps.push({ label: `COMMENT ${target}.${ident(column.name)}`, sql: `COMMENT ON COLUMN ${target}.${ident(column.name)} IS ${literal(column.comment)};` });
  }
  copied.push(`COMMENTS: ${steps.filter((step) => step.label.startsWith("COMMENT ")).length}`);
  return { sql: steps.map((step) => step.sql).join("\n"), sourceColumns: columns, executeAsScript: false, oceanbaseClone: { targetSchema, targetName: options.targetName, copied, excluded, steps } };
}

export function confirmOceanbaseTableClone(plan: DuplicateTableStructurePlan, t: (key: string, values?: Record<string, string>) => string): boolean {
  const clone = plan.oceanbaseClone;
  return !clone || window.confirm(t("contextMenu.oceanbaseClonePreview", {
    target: `${ident(clone.targetSchema)}.${ident(clone.targetName)}`,
    copied: clone.copied.join("\n"), excluded: clone.excluded.join("\n") || "—",
  }));
}

export class OceanbaseTableCloneError extends Error {}

/** OB DDL commits independently. Stop at the first failure and preserve an actionable ledger. */
export async function executeOceanbaseTableClone(clone: OceanbaseTableClone, execute: (sql: string) => Promise<QueryResult>): Promise<QueryResult> {
  const completed: string[] = [];
  let result: QueryResult | undefined;
  for (const step of clone.steps) {
    try {
      result = await execute(step.sql.replace(/;\s*$/, ""));
      if (result.execution_error) throw new Error(result.error ? formatError(result.error) : "DDL execution failed");
      completed.push(step.label);
    } catch (error) {
      const target = `${ident(clone.targetSchema)}.${ident(clone.targetName)}`;
      const recovery = completed.length ? `To discard this clone after checking its contents, run manually:\nDROP TABLE ${target};` : "Creation was not confirmed. Inspect the target and server error before retrying; do not delete an existing table.";
      throw new OceanbaseTableCloneError(`Clone stopped at ${step.label}: ${error instanceof Error ? error.message : String(error)}\n\nCompleted (committed):\n${completed.join("\n") || "None confirmed"}\n\nNo automatic rollback was attempted. The failed statement may have reached the server; inspect ${target} before retrying. ${recovery}\n\nFailed SQL:\n${step.sql}`);
    }
  }
  return result!;
}

export function showOceanbaseTableCloneFailure(error: unknown): void {
  if (error instanceof OceanbaseTableCloneError) window.alert(error.message);
}
