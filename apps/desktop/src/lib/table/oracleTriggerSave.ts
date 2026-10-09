import { prepareDisabledOracleTriggerReplacement } from "@/lib/table/oracleTriggerDefinition";
import type { QueryResult } from "@/types/database";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Execute = (sql: string) => Promise<QueryResult>;

export function oracleTriggerStateSql(schema: string, name: string): string {
  return `SELECT o.STATUS, t.STATUS, t.TABLE_OWNER, t.TABLE_NAME FROM SYS.ALL_OBJECTS o JOIN SYS.ALL_TRIGGERS t ON t.OWNER = o.OWNER AND t.TRIGGER_NAME = o.OBJECT_NAME WHERE o.OWNER = ${literal(schema)} AND o.OBJECT_NAME = ${literal(name)} AND o.OBJECT_TYPE = 'TRIGGER'`;
}

async function executeChecked(execute: Execute, sql: string): Promise<QueryResult> {
  const result = await execute(sql);
  if (result.execution_error) throw new Error(result.error?.detail || "Trigger SQL execution failed");
  return result;
}

export async function saveOracleTriggerDefinition(options: {
  schema: string;
  name: string;
  tableSchema: string;
  tableName: string;
  originalSource: string;
  source: string;
  execute: Execute;
  readSource: () => Promise<string>;
  preserveOriginal: (source: string, enabled: boolean) => void | Promise<void>;
  onMutationStarted?: () => void;
}): Promise<void> {
  const { schema, name, execute } = options;
  const replacement = prepareDisabledOracleTriggerReplacement(options.source, options);
  const readState = async () => {
    const result = await executeChecked(execute, oracleTriggerStateSql(schema, name));
    if (result.rows.length !== 1) throw new Error("Trigger metadata is missing or ambiguous; reload before saving");
    const row = result.rows[0];
    if (row[2] !== options.tableSchema || row[3] !== options.tableName) throw new Error("Trigger target differs from the selected table");
    if (row[1] !== "ENABLED" && row[1] !== "DISABLED") throw new Error("Trigger enabled state is unknown");
    return { valid: row[0] === "VALID", enabled: row[1] === "ENABLED" };
  };
  const before = await readState();
  if (await options.readSource() !== options.originalSource) throw new Error("Trigger definition changed since it was opened; reload before saving");
  // Preserve the exact definition before any non-transactional DDL. The new
  // definition stays disabled until compilation and its target are confirmed.
  await options.preserveOriginal(options.originalSource, before.enabled);
  options.onMutationStarted?.();
  await executeChecked(execute, replacement);
  const replaced = await readState();
  if (replaced.enabled) throw new Error("Replacement trigger is unexpectedly enabled; inspect its state before proceeding and use the saved definition for recovery");
  if (!replaced.valid) {
    const errors = await executeChecked(execute, `SELECT LINE, POSITION, TEXT FROM SYS.ALL_ERRORS WHERE OWNER = ${literal(schema)} AND NAME = ${literal(name)} AND TYPE = 'TRIGGER' ORDER BY SEQUENCE`);
    throw new Error(`Trigger replacement is INVALID and remains disabled. Restore the saved original definition after inspecting the database.\n${errors.rows.map((row) => `${row[0]}:${row[1]} ${row[2]}`).join("\n")}`);
  }
  if (before.enabled) await executeChecked(execute, `ALTER TRIGGER ${quote(schema)}.${quote(name)} ENABLE`);
  const after = await readState();
  if (!after.valid || after.enabled !== before.enabled) throw new Error("Trigger compilation or enabled state could not be confirmed; inspect the database and use the saved original definition for recovery");
}
