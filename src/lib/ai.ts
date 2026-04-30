import type { AiConfig } from "@/stores/settingsStore";
import type { ColumnInfo, ConnectionConfig, DatabaseType, QueryResult, QueryTab } from "@/types/database";
import * as api from "@/lib/tauri";

export type AiAction = "generate" | "explain" | "optimize" | "fix" | "convert" | "sampleData";

export interface AiSchemaTable {
  schema?: string;
  name: string;
  tableType: string;
  columns: ColumnInfo[];
}

export interface AiContext {
  connectionName: string;
  databaseType: DatabaseType;
  database: string;
  currentSql: string;
  lastError?: string;
  lastResultPreview?: string;
  tables: AiSchemaTable[];
  truncated: boolean;
}

export interface AiRequestInput {
  config: AiConfig;
  action: AiAction;
  instruction: string;
  context: AiContext;
}

const ACTION_INSTRUCTIONS: Record<AiAction, string> = {
  generate: "Generate a SQL query that satisfies the user's request.",
  explain: "Explain the current SQL clearly and point out risky operations or assumptions.",
  optimize: "Rewrite or suggest improvements for the current SQL. Prefer a complete improved SQL query first, followed by short notes.",
  fix: "Fix the current SQL using the provided error/result context. Return the corrected SQL first, followed by short notes if needed.",
  convert: "Convert the current SQL to the target dialect requested by the user. Return the converted SQL first.",
  sampleData: "Generate safe sample SQL statements or mock data for the current schema. Do not use real production data.",
};

export async function runAiAction(input: AiRequestInput, history?: api.AiMessage[]): Promise<string> {
  const systemPrompt = buildSystemPrompt(input.action, input.context);
  const userPrompt = [
    `Action: ${input.action}`,
    ACTION_INSTRUCTIONS[input.action],
    "",
    "User request:",
    input.instruction.trim() || "(No extra instruction provided.)",
  ].join("\n");

  const messages: api.AiMessage[] = [
    ...(history || []),
    { role: "user", content: userPrompt },
  ];

  return api.aiComplete({
    config: input.config,
    systemPrompt,
    messages,
    maxTokens: 2400,
    temperature: 0.15,
  });
}

export async function runAiStream(
  input: AiRequestInput,
  history: api.AiMessage[] | undefined,
  onDelta: (delta: string) => void,
): Promise<void> {
  const systemPrompt = buildSystemPrompt(input.action, input.context);
  const userPrompt = [
    `Action: ${input.action}`,
    ACTION_INSTRUCTIONS[input.action],
    "",
    "User request:",
    input.instruction.trim() || "(No extra instruction provided.)",
  ].join("\n");

  const messages: api.AiMessage[] = [
    ...(history || []),
    { role: "user", content: userPrompt },
  ];

  const sessionId = crypto.randomUUID();

  await api.aiStream(sessionId, {
    config: input.config,
    systemPrompt,
    messages,
    maxTokens: 2400,
    temperature: 0.15,
  }, (chunk) => {
    if (!chunk.done && chunk.delta) onDelta(chunk.delta);
  });
}

export function extractSql(text: string): string {
  const fenced = text.match(/```(?:sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

export function buildSystemPrompt(action: AiAction, context: AiContext): string {
  const schema = formatSchema(context);
  const resultPreview = context.lastResultPreview
    ? `\nLast result preview:\n${context.lastResultPreview}\n`
    : "";
  const lastError = context.lastError ? `\nLast error:\n${context.lastError}\n` : "";

  return [
    "You are DBX's built-in database assistant.",
    "Be precise, conservative, and adapt SQL to the active database dialect.",
    "Never invent tables or columns that are not present in the schema context unless the user explicitly asks for hypothetical examples.",
    "For destructive statements such as DROP, DELETE, TRUNCATE, ALTER, or UPDATE without a clear WHERE clause, warn briefly and prefer a safer SELECT preview when appropriate.",
    "When returning SQL, put the SQL in a fenced ```sql code block. Keep extra explanation short and practical.",
    action === "generate" ? "For generate actions, return the SQL first and avoid long explanations." : "",
    "",
    `Database type: ${context.databaseType}`,
    `Connection: ${context.connectionName}`,
    `Database: ${context.database}`,
    context.truncated ? "Schema context is truncated." : "Schema context is complete within the current budget.",
    "",
    `Current SQL:\n${context.currentSql.trim() || "(empty)"}`,
    lastError,
    resultPreview,
    `Schema:\n${schema}`,
  ].filter(Boolean).join("\n");
}

function formatSchema(context: AiContext): string {
  if (!context.tables.length) return "(No table schema loaded.)";

  return context.tables.map((table) => {
    const name = table.schema ? `${table.schema}.${table.name}` : table.name;
    const columns = table.columns.map((column) => {
      const flags = [
        column.is_primary_key ? "primary key" : "",
        column.is_nullable ? "nullable" : "not null",
        column.column_default ? `default ${column.column_default}` : "",
        column.extra || "",
      ].filter(Boolean).join(", ");
      return `  - ${column.name}: ${column.data_type}${flags ? ` (${flags})` : ""}`;
    });
    return [`${name} (${table.tableType})`, ...columns].join("\n");
  }).join("\n\n");
}

export async function buildAiContext(
  tab: QueryTab,
  connection: ConnectionConfig,
  options: { maxTables?: number; maxColumnsPerTable?: number } = {},
): Promise<AiContext> {
  const maxTables = options.maxTables ?? 12;
  const maxColumnsPerTable = options.maxColumnsPerTable ?? 40;
  const tables: AiSchemaTable[] = [];
  let truncated = false;

  if (tab.tableMeta) {
    tables.push({
      schema: tab.tableMeta.schema,
      name: tab.tableMeta.tableName,
      tableType: "TABLE",
      columns: tab.tableMeta.columns.slice(0, maxColumnsPerTable),
    });
    truncated = tab.tableMeta.columns.length > maxColumnsPerTable;
  } else if (!["redis", "mongodb"].includes(connection.db_type)) {
    try {
      const schemas = await loadCandidateSchemas(tab, connection);
      for (const schema of schemas) {
        const tableList = await api.listTables(tab.connectionId, tab.database, schema);
        for (const table of tableList) {
          if (tables.length >= maxTables) {
            truncated = true;
            break;
          }
          const columns = await api.getColumns(tab.connectionId, tab.database, schema, table.name);
          tables.push({
            schema: schema === tab.database && connection.db_type !== "postgres" ? undefined : schema,
            name: table.name,
            tableType: table.table_type,
            columns: columns.slice(0, maxColumnsPerTable),
          });
          if (columns.length > maxColumnsPerTable) truncated = true;
        }
        if (tables.length >= maxTables) break;
      }
    } catch {
      truncated = true;
    }
  }

  return {
    connectionName: connection.name,
    databaseType: connection.db_type,
    database: tab.database,
    currentSql: tab.sql,
    lastError: extractLastError(tab.result),
    lastResultPreview: formatResultPreview(tab.result),
    tables,
    truncated,
  };
}

async function loadCandidateSchemas(tab: QueryTab, connection: ConnectionConfig): Promise<string[]> {
  if (connection.db_type === "postgres" || connection.db_type === "sqlserver") {
    const schemas = await api.listSchemas(tab.connectionId, tab.database);
    return prioritizeSchemas(schemas);
  }
  return [tab.database || connection.database || "main"];
}

function prioritizeSchemas(schemas: string[]): string[] {
  const preferred = ["public", "dbo", "main"];
  return [...schemas].sort((a, b) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 99) - (bi >= 0 ? bi : 99);
    return a.localeCompare(b);
  });
}

function extractLastError(result?: QueryResult): string | undefined {
  if (!result?.columns.includes("Error")) return undefined;
  return result.rows[0]?.[0] == null ? undefined : String(result.rows[0][0]);
}

function formatResultPreview(result?: QueryResult): string | undefined {
  if (!result || result.columns.includes("Error") || !result.rows.length) return undefined;
  const rows = result.rows.slice(0, 5).map((row) => {
    return result.columns.map((column, index) => `${column}=${JSON.stringify(row[index] ?? null)}`).join(", ");
  });
  return rows.join("\n");
}
