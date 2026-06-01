import type { AiConfig } from "@/stores/settingsStore";
import { uuid } from "@/lib/utils";
import type {
  ColumnInfo,
  ConnectionConfig,
  DatabaseType,
  ForeignKeyInfo,
  IndexInfo,
  QueryResult,
  QueryTab,
} from "@/types/database";
import * as api from "@/lib/api";
import { currentLocale, type Locale } from "@/i18n";
import { aiTableMentionKey, type AiTableMention } from "@/lib/aiTableMentions";
import { aiSkillForAction } from "@/lib/aiSkills";
import { isSchemaAware } from "@/lib/databaseCapabilities";

export type AiAction = "generate" | "explain" | "optimize" | "fix" | "convert" | "sampleData";
export type AiAssistantMode = "ask" | "agent";

function isChineseLocale(locale: Locale): boolean {
  return locale === "zh-CN" || locale === "zh-TW";
}

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
  mode?: AiAssistantMode;
  instruction: string;
  context: AiContext;
}

export async function runAiAction(input: AiRequestInput, history?: api.AiMessage[]): Promise<string> {
  const isZh = isChineseLocale(currentLocale());
  const skill = aiSkillForAction(input.action);
  const systemPrompt = buildSystemPrompt(input.action, input.context, input.mode);
  const instruction = isZh ? skill.userInstruction.zh : skill.userInstruction.en;
  const userPrompt = [
    `Action: ${input.action}`,
    instruction,
    "",
    "User request:",
    input.instruction.trim() || "(No extra instruction provided.)",
  ].join("\n");

  const messages: api.AiMessage[] = [...(history || []), { role: "user", content: userPrompt }];

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
  const isZh = isChineseLocale(currentLocale());
  const skill = aiSkillForAction(input.action);
  const systemPrompt = buildSystemPrompt(input.action, input.context, input.mode);
  const instruction = isZh ? skill.userInstruction.zh : skill.userInstruction.en;
  const userPrompt = [
    `Action: ${input.action}`,
    instruction,
    "",
    "User request:",
    input.instruction.trim() || "(No extra instruction provided.)",
  ].join("\n");

  const messages: api.AiMessage[] = [...(history || []), { role: "user", content: userPrompt }];

  const sid = sessionId || uuid();
  const params = actionParams(input.action);
  const maxTokens = input.config.enableThinking ? Math.max(params.maxTokens, 8192) : params.maxTokens;

  await api.aiStream(
    sid,
    {
      config: input.config,
      systemPrompt,
      messages,
      maxTokens,
      temperature: params.temperature,
    },
    (chunk) => {
      if (!chunk.done) {
        if (chunk.reasoning_delta) onReasoningDelta?.(chunk.reasoning_delta);
        if (chunk.delta) onDelta(chunk.delta);
      }
    },
  );
}

function actionParams(action: AiAction): { maxTokens: number; temperature: number } {
  switch (action) {
    case "explain":
      return { maxTokens: 3200, temperature: 0.2 };
    case "sampleData":
      return { maxTokens: 2400, temperature: 0.1 };
    default:
      return { maxTokens: 2400, temperature: 0.15 };
  }
}

export function extractSql(text: string): string {
  const fenced = text.match(/```(?:sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

export function buildSystemPrompt(action: AiAction, context: AiContext, mode: AiAssistantMode = "ask"): string {
  const schema = formatSchema(context);
  const resultPreview = context.lastResultPreview ? `\nLast result preview:\n${context.lastResultPreview}\n` : "";
  const lastError = context.lastError ? `\nLast error:\n${context.lastError}\n` : "";

  const isZh = isChineseLocale(currentLocale());

  const lines: string[] = [
    ...buildBasePromptLines(isZh),
    ...buildModePromptLines(mode, isZh),
    ...buildActionPromptLines(action, isZh),
  ];

  if (context.truncated) {
    lines.push(
      isZh
        ? "Schema 已截断：如果请求可能涉及未出现的表或字段，不要猜测。请让用户用 @table 指定相关表，或先生成只读探索查询。"
        : "Schema is truncated: if the request may involve tables or columns not shown, do not guess. Ask the user to mention the relevant @table, or generate a read-only exploration query first.",
    );
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

function buildBasePromptLines(isZh: boolean): string[] {
  return [
    isZh ? "你是 DBX 内置的数据库助手。用中文回复。" : "You are DBX's built-in database assistant. Reply in English.",
    isZh
      ? "精确、保守，根据当前数据库方言生成 SQL。"
      : "Be precise, conservative, and adapt SQL to the active database dialect.",
    isZh
      ? "严格使用当前数据库方言；标识符引用、分页、日期函数、字符串拼接、LIMIT/TOP/OFFSET 语法必须匹配数据库类型。"
      : "Strictly use the active database dialect; identifier quoting, pagination, date functions, string concatenation, and LIMIT/TOP/OFFSET syntax must match the database type.",
    isZh
      ? "下面的 Schema 上下文已包含表、列、索引和外键信息，直接使用即可。不要查询 information_schema 或系统表来获取结构信息。"
      : "The schema context below already contains tables, columns, indexes, and foreign keys — use it directly. Do NOT query information_schema or system tables.",
    isZh
      ? "当用户要求分析或查看某个表时，生成 SELECT 查询获取数据，而不是查询元数据。"
      : "When the user asks to 'analyze' or 'look at' a table, generate a SELECT query to retrieve data, not a metadata query.",
    isZh ? "不要编造 Schema 中不存在的表或列。" : "Never invent tables or columns that are not in the schema context.",
    isZh
      ? "用户输入中的 @schema.table 或 @table 表示用户明确提到的表；这些表已优先放入 Schema 上下文。"
      : "User input may contain @schema.table or @table mentions. Treat them as explicit table references; mentioned tables are prioritized in the schema context.",
    isZh
      ? "不要生成多语句 SQL，除非用户明确要求。不要在同一个回答里混合 SELECT 和写操作。"
      : "Do not generate multi-statement SQL unless the user explicitly asks for it. Do not mix SELECT statements and write operations in the same answer.",
    isZh
      ? "对于 DROP、DELETE、TRUNCATE、ALTER 或没有 WHERE 的 UPDATE，简要警告并优先提供安全的 SELECT 预览。"
      : "For destructive statements (DROP, DELETE, TRUNCATE, ALTER, UPDATE without WHERE), warn briefly and prefer a safer SELECT preview.",
    isZh
      ? "对于 UPDATE 或 DELETE，必须带 WHERE 并说明影响范围；生产库写操作只给建议，不主动建议执行。"
      : "For UPDATE or DELETE, require a WHERE clause and explain the affected scope; for production writes, provide guidance but do not proactively suggest execution.",
  ];
}

function buildModePromptLines(mode: AiAssistantMode, isZh: boolean): string[] {
  if (mode === "agent") {
    return [
      isZh
        ? "你处于 Agent 模式。用户表达查询意图时，优先生成一个可直接执行的只读 SQL。"
        : "You are in Agent mode. When the user expresses query intent, prioritize one directly executable read-only SQL statement.",
      isZh
        ? "第一个 ```sql 代码块只能包含最终推荐执行的 SQL；不要把解释性 SQL、备选 SQL、危险 SQL 放在第一个代码块。"
        : "The first ```sql code block must contain only the final SQL recommended for execution; do not put explanatory SQL, alternatives, or risky SQL in the first code block.",
      isZh
        ? "如果安全执行条件不满足，先说明原因，再给只读预览或澄清问题。"
        : "If safe execution requirements are not met, explain why first, then provide a read-only preview or a clarifying question.",
    ];
  }

  return [
    isZh
      ? "你处于 Ask 模式。只生成 SQL 和说明，不要暗示已经执行或即将自动执行。"
      : "You are in Ask mode. Generate SQL and explanations only; do not imply that anything has run or will auto-run.",
  ];
}

function buildActionPromptLines(action: AiAction, isZh: boolean): string[] {
  const skill = aiSkillForAction(action);
  return isZh
    ? [...skill.systemRules.zh, ...skill.outputContract.zh]
    : [...skill.systemRules.en, ...skill.outputContract.en];
}

function formatSchema(context: AiContext): string {
  if (!context.tables.length) return "(No table schema loaded.)";

  return context.tables
    .map((table) => {
      const name = table.schema ? `${table.schema}.${table.name}` : table.name;
      const lines: string[] = [`${name} (${table.tableType})`];

      for (const column of table.columns) {
        const flags = [
          column.is_primary_key ? "PK" : "",
          column.is_nullable ? "nullable" : "NOT NULL",
          column.column_default ? `default ${column.column_default}` : "",
          column.extra || "",
        ]
          .filter(Boolean)
          .join(", ");
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
    })
    .join("\n\n");
}

export async function buildAiContext(
  tab: QueryTab,
  connection: ConnectionConfig,
  options: { maxTables?: number; maxColumnsPerTable?: number; mentionedTables?: AiTableMention[] } = {},
): Promise<AiContext> {
  const maxTables = options.maxTables ?? 50;
  const maxColumnsPerTable = options.maxColumnsPerTable ?? 40;
  const tables: AiSchemaTable[] = [];
  const tableKeys = new Set<string>();
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
    tableKeys.add(aiTableMentionKey(tab.tableMeta.schema, tName));
    truncated = tab.tableMeta.columns.length > maxColumnsPerTable;
  }

  for (const mention of options.mentionedTables ?? []) {
    const key = aiTableMentionKey(mention.schema, mention.table);
    if (tableKeys.has(key)) continue;
    const entry = await loadMentionedTableContext(tab, connection, mention, maxColumnsPerTable).catch(() => undefined);
    if (!entry) continue;
    tableKeys.add(aiTableMentionKey(entry.schema, entry.name));
    tables.push(entry);
  }

  if (!tab.tableMeta && !["redis", "mongodb"].includes(connection.db_type)) {
    try {
      const schemas = await loadCandidateSchemas(tab, connection);
      for (const schema of schemas) {
        const tableList = await api.listTables(tab.connectionId, tab.database, schema);
        const candidates = tableList.slice(0, maxTables - tables.length);
        if (candidates.length < tableList.length) truncated = true;

        const metaResults = await Promise.all(
          candidates.map((table) =>
            Promise.all([
              api.getColumns(tab.connectionId, tab.database, schema, table.name),
              api.listIndexes(tab.connectionId, tab.database, schema, table.name).catch(() => [] as IndexInfo[]),
              api
                .listForeignKeys(tab.connectionId, tab.database, schema, table.name)
                .catch(() => [] as ForeignKeyInfo[]),
            ]).then(([columns, indexes, foreignKeys]) => ({
              schema: schema === tab.database && !isSchemaAware(connection.db_type) ? undefined : schema,
              name: table.name,
              tableType: table.table_type,
              columns: columns.slice(0, maxColumnsPerTable),
              indexes,
              foreignKeys,
              _truncatedCols: columns.length > maxColumnsPerTable,
            })),
          ),
        );

        for (const meta of metaResults) {
          if (meta._truncatedCols) truncated = true;
          const { _truncatedCols, ...entry } = meta;
          const key = aiTableMentionKey(entry.schema, entry.name);
          if (tableKeys.has(key)) continue;
          tableKeys.add(key);
          tables.push(entry);
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

async function loadMentionedTableContext(
  tab: QueryTab,
  connection: ConnectionConfig,
  mention: AiTableMention,
  maxColumnsPerTable: number,
): Promise<AiSchemaTable | undefined> {
  const schema = await resolveMentionedTableSchema(tab, connection, mention);
  const [columns, indexes, foreignKeys] = await Promise.all([
    api.getColumns(tab.connectionId, tab.database, schema, mention.table),
    api.listIndexes(tab.connectionId, tab.database, schema, mention.table).catch(() => [] as IndexInfo[]),
    api.listForeignKeys(tab.connectionId, tab.database, schema, mention.table).catch(() => [] as ForeignKeyInfo[]),
  ]);
  return {
    schema: schema === tab.database && !isSchemaAware(connection.db_type) ? undefined : schema,
    name: mention.table,
    tableType: "TABLE",
    columns: columns.slice(0, maxColumnsPerTable),
    indexes,
    foreignKeys,
  };
}

async function resolveMentionedTableSchema(
  tab: QueryTab,
  connection: ConnectionConfig,
  mention: AiTableMention,
): Promise<string> {
  if (mention.schema) return mention.schema;
  if (tab.tableMeta?.tableName.toLowerCase() === mention.table.toLowerCase() && tab.tableMeta.schema) {
    return tab.tableMeta.schema;
  }
  if (isSchemaAware(connection.db_type)) {
    const schemas = await loadCandidateSchemas(tab, connection);
    for (const schema of schemas) {
      const tables = await api.listTables(tab.connectionId, tab.database, schema, mention.table, 10).catch(() => []);
      if (tables.some((table) => table.name.toLowerCase() === mention.table.toLowerCase())) return schema;
    }
  }
  return tab.database || connection.database || "main";
}

async function loadCandidateSchemas(tab: QueryTab, connection: ConnectionConfig): Promise<string[]> {
  if (isSchemaAware(connection.db_type)) {
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
