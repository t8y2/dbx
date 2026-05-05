import type { AiConfig } from "@/stores/settingsStore";
import type { ColumnInfo, ConnectionConfig, DatabaseType, ForeignKeyInfo, IndexInfo, QueryResult, QueryTab } from "@/types/database";
import * as api from "@/lib/api";
import { currentLocale } from "@/i18n";

export type AiAction = "generate" | "explain" | "optimize" | "fix" | "convert" | "sampleData";

export interface AiSchemaTable {
  schema?: string;
  name: string;
  tableType: string;
  columns: ColumnInfo[];
  indexes?: IndexInfo[];
  foreignKeys?: ForeignKeyInfo[];
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

const ACTION_INSTRUCTIONS: Record<AiAction, { en: string; zh: string }> = {
  generate: {
    en: "Generate a SQL query that satisfies the user's request. Return the SQL in a ```sql code block first, followed by a brief note if needed. Use foreign key relationships from the schema to infer correct JOIN conditions.",
    zh: "根据用户请求生成 SQL。先在 ```sql 代码块中返回 SQL，必要时附简短说明。利用 Schema 中的外键关系推断正确的 JOIN 条件。",
  },
  explain: {
    en: "Explain the current SQL step by step. Point out risky operations, implicit assumptions, and potential performance issues. Reference index and foreign key info from the schema when relevant.",
    zh: "逐步解释当前 SQL。指出危险操作、隐含假设和潜在性能问题。结合 Schema 中的索引和外键信息分析。",
  },
  optimize: {
    en: "Rewrite or suggest improvements for the current SQL. Return the improved SQL in a ```sql code block first, followed by short notes explaining the changes. Use the index information in the schema to suggest index-aware optimizations (e.g., avoid full table scans, leverage existing indexes).",
    zh: "重写或优化当前 SQL。先在 ```sql 代码块中返回优化后的 SQL，然后简要说明改动。利用 Schema 中的索引信息建议索引友好的优化（如避免全表扫描、利用现有索引）。",
  },
  fix: {
    en: "Fix the current SQL using the provided error message and result context. Return the corrected SQL in a ```sql code block first, followed by a brief explanation of the root cause.",
    zh: "根据报错信息和结果上下文修复当前 SQL。先在 ```sql 代码块中返回修正后的 SQL，再简要说明根因。",
  },
  convert: {
    en: "Convert the current SQL to the target dialect requested by the user. Return the converted SQL in a ```sql code block first. Note any syntax differences or incompatibilities.",
    zh: "将当前 SQL 转换为用户指定的目标方言。先在 ```sql 代码块中返回转换后的 SQL，再说明语法差异。",
  },
  sampleData: {
    en: "Generate safe sample INSERT statements or mock data for the current schema. Do not use real production data. Return SQL in a ```sql code block.",
    zh: "为当前 Schema 生成安全的示例 INSERT 语句或模拟数据。不使用真实生产数据。在 ```sql 代码块中返回 SQL。",
  },
};

export async function runAiAction(input: AiRequestInput, history?: api.AiMessage[]): Promise<string> {
  const isZh = currentLocale() === "zh-CN";
  const systemPrompt = buildSystemPrompt(input.action, input.context);
  const instruction = isZh ? ACTION_INSTRUCTIONS[input.action].zh : ACTION_INSTRUCTIONS[input.action].en;
  const userPrompt = [
    `Action: ${input.action}`,
    instruction,
    "",
    "User request:",
    input.instruction.trim() || "(No extra instruction provided.)",
  ].join("\n");

  const messages: api.AiMessage[] = [
    ...(history || []),
    { role: "user", content: userPrompt },
  ];

  const params = actionParams(input.action);
  return api.aiComplete({
    config: input.config,
    systemPrompt,
    messages,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
  });
}

export async function runAiStream(
  input: AiRequestInput,
  history: api.AiMessage[] | undefined,
  onDelta: (delta: string) => void,
  sessionId?: string,
  onReasoningDelta?: (delta: string) => void,
): Promise<void> {
  const isZh = currentLocale() === "zh-CN";
  const systemPrompt = buildSystemPrompt(input.action, input.context);
  const instruction = isZh ? ACTION_INSTRUCTIONS[input.action].zh : ACTION_INSTRUCTIONS[input.action].en;
  const userPrompt = [
    `Action: ${input.action}`,
    instruction,
    "",
    "User request:",
    input.instruction.trim() || "(No extra instruction provided.)",
  ].join("\n");

  const messages: api.AiMessage[] = [
    ...(history || []),
    { role: "user", content: userPrompt },
  ];

  const sid = sessionId || crypto.randomUUID();
  const params = actionParams(input.action);

  await api.aiStream(sid, {
    config: input.config,
    systemPrompt,
    messages,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
  }, (chunk) => {
    if (!chunk.done) {
      if (chunk.reasoning_delta) onReasoningDelta?.(chunk.reasoning_delta);
      if (chunk.delta) onDelta(chunk.delta);
    }
  });
}

function actionParams(action: AiAction): { maxTokens: number; temperature: number } {
  switch (action) {
    case "explain": return { maxTokens: 3200, temperature: 0.2 };
    case "sampleData": return { maxTokens: 2400, temperature: 0.1 };
    default: return { maxTokens: 2400, temperature: 0.15 };
  }
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

  const isZh = currentLocale() === "zh-CN";

  const lines: string[] = [
    isZh
      ? "你是 DBX 内置的数据库助手。用中文回复。"
      : "You are DBX's built-in database assistant. Reply in English.",
    isZh
      ? "精确、保守，根据当前数据库方言生成 SQL。"
      : "Be precise, conservative, and adapt SQL to the active database dialect.",
    isZh
      ? "下面的 Schema 上下文已包含表、列、索引和外键信息，直接使用即可。不要查询 information_schema 或系统表来获取结构信息。"
      : "The schema context below already contains tables, columns, indexes, and foreign keys — use it directly. Do NOT query information_schema or system tables.",
    isZh
      ? "当用户要求分析或查看某个表时，生成 SELECT 查询获取数据，而不是查询元数据。"
      : "When the user asks to 'analyze' or 'look at' a table, generate a SELECT query to retrieve data, not a metadata query.",
    isZh
      ? "不要编造 Schema 中不存在的表或列。"
      : "Never invent tables or columns that are not in the schema context.",
    isZh
      ? "对于 DROP、DELETE、TRUNCATE、ALTER 或没有 WHERE 的 UPDATE，简要警告并优先提供安全的 SELECT 预览。"
      : "For destructive statements (DROP, DELETE, TRUNCATE, ALTER, UPDATE without WHERE), warn briefly and prefer a safer SELECT preview.",
  ];

  if (action === "optimize") {
    lines.push(isZh
      ? "利用 Schema 中的索引信息建议优化。指出哪些查询条件可以命中索引、哪些会导致全表扫描。"
      : "Use the index information in the schema to suggest optimizations. Point out which conditions hit indexes and which cause full table scans.");
  } else if (action === "generate") {
    lines.push(isZh
      ? "利用外键关系推断 JOIN 条件。生成操作优先返回 SQL，避免长篇解释。"
      : "Use foreign key relationships to infer JOIN conditions. Return the SQL first and avoid long explanations.");
  } else if (action === "fix") {
    lines.push(isZh
      ? "仔细分析错误信息，定位根因。先返回修正后的 SQL，再简要解释。"
      : "Carefully analyze the error message to identify the root cause. Return the corrected SQL first, then briefly explain.");
  }

  lines.push(
    isZh
      ? "返回 SQL 时放在 ```sql 代码块中。额外说明简短实用。"
      : "Put SQL in a fenced ```sql code block. Keep extra explanation short and practical.",
    "",
    `Database type: ${context.databaseType}`,
    `Connection: ${context.connectionName}`,
    `Database: ${context.database}`,
    context.truncated ? "Schema context is truncated." : "Schema context is complete.",
    "",
    `Current SQL:\n${context.currentSql.trim() || "(empty)"}`,
    lastError,
    resultPreview,
    `Schema:\n${schema}`,
  );

  return lines.filter(Boolean).join("\n");
}

function formatSchema(context: AiContext): string {
  if (!context.tables.length) return "(No table schema loaded.)";

  return context.tables.map((table) => {
    const name = table.schema ? `${table.schema}.${table.name}` : table.name;
    const lines: string[] = [`${name} (${table.tableType})`];

    for (const column of table.columns) {
      const flags = [
        column.is_primary_key ? "PK" : "",
        column.is_nullable ? "nullable" : "NOT NULL",
        column.column_default ? `default ${column.column_default}` : "",
        column.extra || "",
      ].filter(Boolean).join(", ");
      lines.push(`  - ${column.name}: ${column.data_type}${flags ? ` (${flags})` : ""}`);
    }

    if (table.indexes?.length) {
      for (const idx of table.indexes) {
        if (idx.is_primary) continue;
        const unique = idx.is_unique ? "UNIQUE " : "";
        lines.push(`  Index: ${unique}${idx.name}(${idx.columns.join(", ")})`);
      }
    }

    if (table.foreignKeys?.length) {
      for (const fk of table.foreignKeys) {
        lines.push(`  FK: ${fk.column} → ${fk.ref_table}.${fk.ref_column}`);
      }
    }

    return lines.join("\n");
  }).join("\n\n");
}

export async function buildAiContext(
  tab: QueryTab,
  connection: ConnectionConfig,
  options: { maxTables?: number; maxColumnsPerTable?: number } = {},
): Promise<AiContext> {
  const maxTables = options.maxTables ?? 50;
  const maxColumnsPerTable = options.maxColumnsPerTable ?? 40;
  const tables: AiSchemaTable[] = [];
  let truncated = false;

  if (tab.tableMeta) {
    const s = tab.tableMeta.schema ?? "";
    const tName = tab.tableMeta.tableName;
    const [indexes, foreignKeys] = await Promise.all([
      api.listIndexes(tab.connectionId, tab.database, s, tName).catch(() => [] as IndexInfo[]),
      api.listForeignKeys(tab.connectionId, tab.database, s, tName).catch(() => [] as ForeignKeyInfo[]),
    ]);
    tables.push({
      schema: tab.tableMeta.schema,
      name: tName,
      tableType: "TABLE",
      columns: tab.tableMeta.columns.slice(0, maxColumnsPerTable),
      indexes,
      foreignKeys,
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
          const [columns, indexes, foreignKeys] = await Promise.all([
            api.getColumns(tab.connectionId, tab.database, schema, table.name),
            api.listIndexes(tab.connectionId, tab.database, schema, table.name).catch(() => [] as IndexInfo[]),
            api.listForeignKeys(tab.connectionId, tab.database, schema, table.name).catch(() => [] as ForeignKeyInfo[]),
          ]);
          tables.push({
            schema: schema === tab.database && connection.db_type !== "postgres" ? undefined : schema,
            name: table.name,
            tableType: table.table_type,
            columns: columns.slice(0, maxColumnsPerTable),
            indexes,
            foreignKeys,
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
