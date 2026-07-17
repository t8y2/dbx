import type { AiConfig } from "@/stores/settingsStore";
import { uuid } from "@/lib/common/utils";
import type { ColumnInfo, ConnectionConfig, DatabaseType, ForeignKeyInfo, IndexInfo, QueryResult, QueryTab } from "@/types/database";
import * as api from "@/lib/backend/api";
import { currentLocale, type Locale } from "@/i18n";
import { aiTableMentionKey, type AiTableMention } from "@/lib/ai/aiTableMentions";
import { aiSkillForAction } from "@/lib/ai/aiSkills";
import { isSchemaAware } from "@/lib/database/databaseCapabilities";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

import type { AgentEvent } from "@/lib/backend/tauri";

const VECTOR_DB_TYPES: ReadonlySet<DatabaseType> = new Set([
  "qdrant",
  "milvus",
  "weaviate",
  "chromadb",
  // If modifying this, also update is_vector_db() in crates/dbx-core/src/agent_tools.rs.
]);

export function isVectorDbType(dbType: DatabaseType): boolean {
  return VECTOR_DB_TYPES.has(dbType);
}

function dbLabel(dbType: DatabaseType): string {
  const labels: Partial<Record<DatabaseType, string>> = {
    qdrant: "Qdrant",
    milvus: "Milvus",
    weaviate: "Weaviate",
    chromadb: "ChromaDB",
  };
  return labels[dbType] || dbType;
}

export type AiAction = "general" | "generate" | "explain" | "optimize" | "fix" | "convert" | "sampleData" | "query" | "exploreSchema" | "executeAndExplain";
export type AiAssistantMode = "ask" | "agent";

/** Actions shown in the Ask mode menu: SQL-producing, never auto-run. */
export const ASK_ACTIONS: AiAction[] = ["general", "generate", "explain", "optimize", "fix", "convert", "sampleData"];

/**
 * Actions shown in the Agent mode menu: task-oriented, drive tool use.
 * `generate` is shared with Ask so users can still request SQL-only output without execution.
 */
export const AGENT_ACTIONS: AiAction[] = ["general", "query", "exploreSchema", "executeAndExplain", "generate"];

export function defaultActionForMode(_mode: AiAssistantMode): AiAction {
  return "general";
}

export function isValidActionForMode(action: AiAction, mode: AiAssistantMode): boolean {
  return (mode === "agent" ? AGENT_ACTIONS : ASK_ACTIONS).includes(action);
}

function isChineseLocale(locale: Locale): boolean {
  return locale === "zh-CN" || locale === "zh-TW";
}

export interface AiSchemaTable {
  schema?: string;
  name: string;
  tableType: string;
  comment?: string | null;
  columns: ColumnInfo[];
  indexes?: IndexInfo[];
  foreignKeys?: ForeignKeyInfo[];
}

export interface AiSqlFileContext {
  id: string;
  name: string;
  sql: string;
  truncated?: boolean;
}

export interface AiContext {
  connectionId: string;
  connectionName: string;
  databaseType: DatabaseType;
  database: string;
  currentSql: string;
  lastError?: string;
  lastResultPreview?: string;
  tables: AiSchemaTable[];
  sqlFiles: AiSqlFileContext[];
  schemaScope?: "focused_table" | "database";
  truncated: boolean;
}

export interface AiRequestInput {
  config: AiConfig;
  action: AiAction;
  mode?: AiAssistantMode;
  instruction: string;
  context: AiContext;
  allowWriteSql?: boolean;
}

function buildAgentRequest(input: AiRequestInput, history?: api.AiMessage[]): { messages: api.AiMessage[]; systemPrompt: string; taskContract: api.AiTaskContract; maxTokens: number } {
  const isZh = isChineseLocale(currentLocale());
  const systemPrompt = buildSystemPrompt(input.action, input.context, input.mode);
  const userPrompt = buildUserPrompt(input.action, input.context, input.instruction, isZh);
  const taskContract: api.AiTaskContract = {
    action: input.action,
    mode: input.mode || "ask",
    userRequest: input.instruction.trim(),
  };

  const messages: api.AiMessage[] = [...(history || []), { role: "user", content: userPrompt }];

  const params = actionParams(input.action);
  const maxTokens = input.config.enableThinking ? Math.max(params.maxTokens, 8192) : params.maxTokens;
  return { messages, systemPrompt, taskContract, maxTokens };
}

export async function runAiAction(input: AiRequestInput, history?: api.AiMessage[]): Promise<string> {
  const { messages, systemPrompt, taskContract, maxTokens } = buildAgentRequest(input, history);
  return api.aiComplete({
    config: input.config,
    systemPrompt,
    messages,
    taskContract,
    maxTokens,
  });
}

export async function runAiStream(input: AiRequestInput, history: api.AiMessage[] | undefined, onDelta: (delta: string) => void, sessionId?: string, onReasoningDelta?: (delta: string) => void): Promise<void> {
  const { messages, systemPrompt, taskContract, maxTokens } = buildAgentRequest(input, history);
  const sid = sessionId || uuid();

  await api.aiStream(
    sid,
    {
      config: input.config,
      systemPrompt,
      messages,
      taskContract,
      maxTokens,
    },
    (chunk) => {
      if (!chunk.done) {
        if (chunk.reasoning_delta) onReasoningDelta?.(chunk.reasoning_delta);
        if (chunk.delta) onDelta(chunk.delta);
      }
    },
  );
}

export async function runAgentStream(input: AiRequestInput, history: api.AiMessage[] | undefined, onEvent: (event: AgentEvent) => void, sessionId?: string): Promise<string> {
  const { messages, systemPrompt, taskContract, maxTokens } = buildAgentRequest(input, history);
  const sid = sessionId || uuid();

  return api.aiAgentStream(
    sid,
    {
      config: input.config,
      systemPrompt,
      messages,
      taskContract,
      maxTokens,
    },
    input.context.connectionId,
    input.context.database,
    input.context.databaseType,
    onEvent,
    input.mode || "ask",
    input.allowWriteSql || false,
  );
}

export function buildUserPrompt(action: AiAction, context: AiContext, instruction: string, isZh: boolean): string {
  const userRequest = instruction.trim() || (isZh ? "（无额外说明）" : "(No extra instruction provided.)");
  if (isVectorDbType(context.databaseType)) {
    // Vector databases: skip SQL action instructions, only send the user's request
    return userRequest;
  }
  const skill = aiSkillForAction(action);
  const skillInstruction = isZh ? skill.userInstruction.zh : skill.userInstruction.en;
  return [`Action: ${action}`, skillInstruction, "", "User request:", userRequest].join("\n");
}

function actionParams(action: AiAction): { maxTokens: number } {
  switch (action) {
    case "explain":
    case "query":
    case "exploreSchema":
    case "executeAndExplain":
      return { maxTokens: 3200 };
    case "sampleData":
      return { maxTokens: 2400 };
    default:
      return { maxTokens: 2400 };
  }
}

export function extractSql(text: string): string {
  const fenced = text.match(/```(?:sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

export function buildSystemPrompt(action: AiAction, context: AiContext, mode: AiAssistantMode = "ask"): string {
  if (isVectorDbType(context.databaseType)) {
    return buildVectorSystemPrompt(context, mode);
  }
  const schema = formatSchema(context);
  const resultPreview = context.lastResultPreview ? `\nLast result preview:\n${context.lastResultPreview}\n` : "";
  const lastError = context.lastError ? `\nLast error:\n${context.lastError}\n` : "";
  const referencedSqlFiles = formatReferencedSqlFiles(context);
  const schemaScope = context.schemaScope ?? "database";

  const isZh = isChineseLocale(currentLocale());

  const lines: string[] = [...buildBasePromptLines(isZh), ...buildModePromptLines(mode, isZh), ...buildActionPromptLines(action, isZh)];

  if (schemaScope === "focused_table") {
    lines.push(
      isZh
        ? "Schema 上下文只覆盖当前打开的表；数据库中可能还有其他表。用户询问当前有哪些表、某表是否存在，或提到上下文中不存在的表时，不要直接断言不存在，优先生成只读元数据查询来核实。"
        : "Schema context covers only the currently opened table; the database may contain other tables. When the user asks what tables exist, whether a table exists, or mentions a table absent from context, do not conclude it is missing; prefer a read-only metadata query to verify.",
    );
  } else if (context.truncated) {
    lines.push(
      isZh
        ? "Schema 已截断：如果请求可能涉及未出现的表或字段，不要猜测。请让用户用 @table 指定相关表，或先生成只读探索/元数据查询。"
        : "Schema is truncated: if the request may involve tables or columns not shown, do not guess. Ask the user to mention the relevant @table, or generate a read-only exploration/metadata query first.",
    );
  }

  lines.push(
    isZh ? "返回 SQL 时放在 ```sql 代码块中。额外说明简短实用。" : "Put SQL in a fenced ```sql code block. Keep extra explanation short and practical.",
    "",
    `Database type: ${context.databaseType}`,
    `Connection: ${context.connectionName}`,
    `Database: ${context.database}`,
    schemaCoverageLine(context, isZh),
    "",
    `Current SQL:\n${context.currentSql.trim() || "(empty)"}`,
    referencedSqlFiles,
    lastError,
    resultPreview,
    `Schema:\n${schema}`,
  );

  return lines.filter(Boolean).join("\n");
}

function buildBasePromptLines(isZh: boolean): string[] {
  return [
    isZh ? "你是 DBX 内置的数据库助手。用中文回复。" : "You are DBX's built-in database assistant. Reply in English.",
    isZh ? "精确、保守，根据当前数据库方言生成 SQL。" : "Be precise, conservative, and adapt SQL to the active database dialect.",
    isZh ? "严格使用当前数据库方言；标识符引用、分页、日期函数、字符串拼接、LIMIT/TOP/OFFSET 语法必须匹配数据库类型。" : "Strictly use the active database dialect; identifier quoting, pagination, date functions, string concatenation, and LIMIT/TOP/OFFSET syntax must match the database type.",
    isZh
      ? '标识符引用必须匹配当前连接类型：MySQL/MariaDB 用反引号 `name`，PostgreSQL/SQLite/Oracle 等用双引号 "name"，SQL Server 用方括号 [name]；不要因为用户口头提到其他数据库而切换方言。'
      : 'Identifier quoting must match the active connection type: MySQL/MariaDB use backticks `name`, PostgreSQL/SQLite/Oracle and similar dialects use double quotes "name", and SQL Server uses brackets [name]. Do not switch dialects merely because the user mentions another database in prose.',
    isZh
      ? "对于普通数据查询，优先使用下面已加载的 Schema 上下文，不要为了重复确认已给出的结构而查询 information_schema 或系统表。但当用户询问某表的字段详情、列信息时，应使用 get_columns 工具获取最权威完整的定义。"
      : "For ordinary data queries, prefer the loaded schema context below. Do not query information_schema or system tables merely to rediscover structure already provided. However, when the user asks for detailed column/field information of a specific table, use the get_columns tool for the authoritative and complete definition.",
    isZh
      ? "例外：当用户明确询问当前有哪些表/Schema、某张表是否存在、或需要盘点数据库对象时，应生成符合当前方言的只读元数据查询（例如 SHOW TABLES、information_schema、sqlite_master 等）。"
      : "Exception: when the user explicitly asks what tables/schemas exist, whether a table exists, or asks for database object inventory, generate a read-only metadata query appropriate for the active dialect (for example SHOW TABLES, information_schema, sqlite_master).",
    isZh ? "表注释和列注释是语义别名；当用户用中文业务名描述表或字段时，优先根据注释匹配真实表名和字段名。" : "Table and column comments are semantic aliases; when the user describes tables or fields by business names, prefer matching those comments to the real table and column names.",
    isZh ? "当用户要求分析或查看某个表时，生成 SELECT 查询获取数据，而不是查询元数据。" : "When the user asks to 'analyze' or 'look at' a table, generate a SELECT query to retrieve data, not a metadata query.",
    isZh ? "不要编造 Schema 中不存在的表或列。" : "Never invent tables or columns that are not in the schema context.",
    isZh ? "用户输入中的 @schema.table 或 @table 表示用户明确提到的表；这些表已优先放入 Schema 上下文。" : "User input may contain @schema.table or @table mentions. Treat them as explicit table references; mentioned tables are prioritized in the schema context.",
    isZh ? "用户引用的 SQL 库文件是额外上下文；可参考其中的查询意图、业务过滤条件和 SQL 写法，但不要把它当作当前编辑器内容。" : "Referenced SQL library files are additional context. Use them for query intent, business filters, and SQL style, but do not treat them as the current editor content.",
    isZh ? "不要生成多语句 SQL，除非用户明确要求。不要在同一个回答里混合 SELECT 和写操作。" : "Do not generate multi-statement SQL unless the user explicitly asks for it. Do not mix SELECT statements and write operations in the same answer.",
    isZh ? "对于 DROP、DELETE、TRUNCATE、ALTER 或没有 WHERE 的 UPDATE，简要警告并优先提供安全的 SELECT 预览。" : "For destructive statements (DROP, DELETE, TRUNCATE, ALTER, UPDATE without WHERE), warn briefly and prefer a safer SELECT preview.",
    isZh ? "对于 UPDATE 或 DELETE，必须带 WHERE 并说明影响范围；生产库写操作只给建议，不主动建议执行。" : "For UPDATE or DELETE, require a WHERE clause and explain the affected scope; for production writes, provide guidance but do not proactively suggest execution.",
    isZh ? "当用户回复简短肯定词时（例如：需要、好、可以、对），直接执行你之前提议的动作，不要再反问确认。" : "When the user replies with a short affirmative (e.g.: Yes, OK, Sure, Do it), directly execute the action you previously proposed — do not ask for confirmation again.",
  ];
}

function buildVectorSystemPrompt(context: AiContext, mode: AiAssistantMode): string {
  const isZh = isChineseLocale(currentLocale());
  const schema = formatSchema(context);
  const resultPreview = context.lastResultPreview ? `\nLast result preview:\n${context.lastResultPreview}\n` : "";
  const lastError = context.lastError ? `\nLast error:\n${context.lastError}\n` : "";
  const referencedSqlFiles = formatReferencedSqlFiles(context);
  const lines: string[] = [
    isZh ? `你是 DBX 内置的向量数据库助手。当前连接的是 ${dbLabel(context.databaseType)} 数据库。用中文回复。` : `You are DBX's vector database assistant. Connected to ${dbLabel(context.databaseType)}. Reply in English.`,
    isZh ? "数据存储在集合（collections）中，每条记录包含唯一标识及可选的元数据负载（payload/metadata）。" : "Data is stored in collections. Each record has a unique identifier and optional metadata payload.",
    ...buildVectorModePromptLines(context, mode, isZh),
    "",
    `Database type: ${context.databaseType}`,
    `Connection: ${context.connectionName}`,
    `Database: ${context.database}`,
    schemaCoverageLine(context, isZh),
    "",
    `Current collection:\n${context.currentSql.trim() || "(none)"}`,
    referencedSqlFiles,
    lastError,
    resultPreview,
    "",
    `Schema:\n${schema}`,
  ];

  if (context.schemaScope === "focused_table") {
    lines.push(
      isZh
        ? "Schema 上下文只覆盖当前打开的集合；数据库中可能还有其他集合。用户询问当前有哪些集合或提到上下文中不存在的集合时，不要直接断言不存在，先用 list_collections 工具确认。"
        : "Schema context covers only the currently opened collection; the database may contain other collections. When the user asks what collections exist or mentions a collection absent from context, do not conclude it is missing; use list_collections to verify first.",
    );
  }

  return lines.filter(Boolean).join("\n");
}

function buildVectorModePromptLines(context: AiContext, mode: AiAssistantMode, isZh: boolean): string[] {
  if (mode === "agent") {
    return [isZh ? "你处于 Agent 模式。你有以下工具可用：list_collections、browse_collection。" : "You are in Agent mode. You have the following tools available: list_collections, browse_collection."];
  }
  return [
    isZh
      ? `你处于 Ask 模式。你只能使用 list_collections 确认集合清单；不要浏览集合数据。${dbLabel(context.databaseType)} 的查询格式为 REST API（METHOD /path + JSON body），具体格式因数据库类型而异。只生成查询请求文本和说明，不要暗示已经执行。`
      : `You are in Ask mode. You may only use list_collections to inspect collection names; do not browse collection data. ${dbLabel(context.databaseType)} uses a REST API query format (METHOD /path + JSON body) that varies by database type. Generate query strings and explanations only; do not imply execution.`,
  ];
}

function buildModePromptLines(mode: AiAssistantMode, isZh: boolean): string[] {
  if (mode === "agent") {
    return [
      isZh ? "你处于 Agent 模式。你有以下工具可用：list_tables、get_columns、execute_query、get_sample_data。" : "You are in Agent mode. You have the following tools available: list_tables, get_columns, execute_query, get_sample_data.",
      isZh
        ? "用户提出数据查询意图时，必须调用 execute_query 工具执行 SQL，不要只输出 SQL 文本后停止。先用 list_tables/get_columns 了解 schema，再调用 execute_query 获取真实结果，最后基于结果回答用户。"
        : "When the user expresses a data query intent, you MUST call the execute_query tool to run the SQL — do NOT just output SQL text and stop. Use list_tables/get_columns to understand the schema first, then call execute_query to get real results, then answer based on the actual data.",
      isZh
        ? "只有 SELECT、WITH、SHOW、DESCRIBE、EXPLAIN 可以通过 execute_query 执行。如果用户要求写入操作，先解释原因，不要执行。"
        : "Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN can be executed via execute_query. If the user requests a write operation, explain why it is blocked instead of executing.",
      isZh ? "如果安全执行条件不满足，先说明原因，再给只读预览或澄清问题。" : "If safe execution requirements are not met, explain why first, then provide a read-only preview or a clarifying question.",
    ];
  }

  return [isZh ? "你处于 Ask 模式。只生成 SQL 和说明，不要暗示已经执行或即将自动执行。" : "You are in Ask mode. Generate SQL and explanations only; do not imply that anything has run or will auto-run."];
}

function schemaCoverageLine(context: AiContext, isZh: boolean): string {
  if (context.schemaScope === "focused_table") {
    if (isVectorDbType(context.databaseType)) {
      return isZh ? "Schema 上下文只覆盖当前打开的集合，不是完整的集合列表。" : "Schema context scope: focused collection only; not a complete collection list.";
    }
    return "Schema context scope: focused table only; not a complete database table list.";
  }
  return context.truncated ? "Schema context is truncated." : "Schema context is complete for the loaded database scope.";
}

function buildActionPromptLines(action: AiAction, isZh: boolean): string[] {
  const skill = aiSkillForAction(action);
  return isZh ? [...skill.systemRules.zh, ...skill.outputContract.zh] : [...skill.systemRules.en, ...skill.outputContract.en];
}

function formatSchema(context: AiContext): string {
  if (!context.tables.length) return "(No table schema loaded.)";

  return context.tables
    .map((table) => {
      const name = table.schema ? `${table.schema}.${table.name}` : table.name;
      const lines: string[] = [`${name} (${table.tableType})`];
      const tableComment = table.comment?.trim();
      if (tableComment) lines.push(`  Comment: ${tableComment}`);

      for (const column of table.columns) {
        const flags = [column.is_primary_key ? "PK" : "", column.is_nullable ? "nullable" : "NOT NULL", column.column_default ? `default ${column.column_default}` : "", column.extra || ""].filter(Boolean).join(", ");
        const columnComment = column.comment?.trim();
        lines.push(`  - ${column.name}: ${column.data_type}${flags ? ` (${flags})` : ""}${columnComment ? ` -- ${columnComment}` : ""}`);
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

function formatReferencedSqlFiles(context: AiContext): string {
  if (!context.sqlFiles.length) return "";

  return [
    "Referenced SQL library files:",
    ...context.sqlFiles.map((file) => {
      const sql = file.sql.trim() || "(empty)";
      const suffix = file.truncated ? " (truncated)" : "";
      return `File: ${file.name}${suffix}\nSQL:\n${sql}`;
    }),
  ].join("\n\n");
}

export async function buildAiContext(tab: QueryTab, connection: ConnectionConfig, options: { maxTables?: number; maxColumnsPerTable?: number; maxIndexesPerTable?: number; maxFksPerTable?: number; mentionedTables?: AiTableMention[]; sqlFiles?: AiSqlFileContext[] } = {}): Promise<AiContext> {
  const maxTables = options.maxTables ?? 50;
  const maxColumnsPerTable = options.maxColumnsPerTable ?? 40;
  const maxIndexesPerTable = options.maxIndexesPerTable ?? 10;
  const maxFksPerTable = options.maxFksPerTable ?? 10;
  const databaseType = aiDatabaseTypeForConnection(connection);
  const tables: AiSchemaTable[] = [];
  const tableKeys = new Set<string>();
  let truncated = false;
  let schemaScope: AiContext["schemaScope"] = "database";
  let currentCollectionName: string | undefined;

  if (tab.tableMeta) {
    schemaScope = "focused_table";
    const s = tab.tableMeta.schema ?? "";
    const tName = tab.tableMeta.tableName;
    const [indexes, foreignKeys] = await Promise.all([api.listIndexes(tab.connectionId, tab.database, s, tName).catch(() => [] as IndexInfo[]), api.listForeignKeys(tab.connectionId, tab.database, s, tName).catch(() => [] as ForeignKeyInfo[])]);
    const tableComment = await loadTableComment(tab.connectionId, tab.database, s, tName).catch(() => undefined);
    tables.push({
      schema: tab.tableMeta.schema,
      name: tName,
      tableType: "TABLE",
      comment: tableComment,
      columns: tab.tableMeta.columns.slice(0, maxColumnsPerTable),
      indexes: indexes.slice(0, maxIndexesPerTable),
      foreignKeys: foreignKeys.slice(0, maxFksPerTable),
    });
    tableKeys.add(aiTableMentionKey(tab.tableMeta.schema, tName));
    truncated = tab.tableMeta.columns.length > maxColumnsPerTable;
  }

  for (const mention of options.mentionedTables ?? []) {
    const key = aiTableMentionKey(mention.schema, mention.table);
    if (tableKeys.has(key)) continue;
    const entry = await loadMentionedTableContext(tab, connection, mention, maxColumnsPerTable, maxIndexesPerTable, maxFksPerTable).catch(() => undefined);
    if (!entry) continue;
    tableKeys.add(aiTableMentionKey(entry.schema, entry.name));
    tables.push(entry);
  }

  // Vector databases: load collections instead of SQL tables
  if (isVectorDbType(databaseType)) {
    try {
      const collections = await api.vectorListCollections(tab.connectionId, tab.database);

      // Find the currently opened collection (tab.sql is UUID for ChromaDB, name for others)
      const currentCollection = collections.find((c) => c.id === tab.sql || c.name === tab.sql);
      if (currentCollection) {
        schemaScope = "focused_table";
        currentCollectionName = currentCollection.name;
        tables.push({
          name: currentCollection.name,
          tableType: "COLLECTION",
          comment: currentCollection.dimension ? `${currentCollection.dimension}d vector` : undefined,
          columns: [],
        });
        tableKeys.add(aiTableMentionKey(undefined, currentCollection.name));
      }

      for (const col of collections.slice(0, maxTables)) {
        const key = aiTableMentionKey(undefined, col.name);
        if (tableKeys.has(key)) continue;
        tables.push({
          name: col.name,
          tableType: "COLLECTION",
          comment: col.dimension ? `${col.dimension}d vector` : undefined,
          columns: [],
        });
        tableKeys.add(key);
      }
      if (collections.length > maxTables) truncated = true;
    } catch {
      truncated = true;
    }
  }

  if (!tab.tableMeta && !["redis", "mongodb"].includes(connection.db_type) && !isVectorDbType(databaseType)) {
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
              api.listForeignKeys(tab.connectionId, tab.database, schema, table.name).catch(() => [] as ForeignKeyInfo[]),
            ]).then(([columns, indexes, foreignKeys]) => ({
              schema: schema === tab.database && !isSchemaAware(databaseType) ? undefined : schema,
              name: table.name,
              tableType: table.table_type,
              comment: table.comment,
              columns: columns.slice(0, maxColumnsPerTable),
              indexes: indexes.slice(0, maxIndexesPerTable),
              foreignKeys: foreignKeys.slice(0, maxFksPerTable),
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
    connectionId: tab.connectionId,
    connectionName: connection.name,
    databaseType,
    database: tab.database,
    currentSql: currentCollectionName ?? tab.sql,
    lastError: extractLastError(tab.result),
    lastResultPreview: formatResultPreview(tab.result),
    tables,
    sqlFiles: options.sqlFiles ?? [],
    schemaScope,
    truncated,
  };
}

async function loadMentionedTableContext(tab: QueryTab, connection: ConnectionConfig, mention: AiTableMention, maxColumnsPerTable: number, maxIndexesPerTable: number, maxFksPerTable: number): Promise<AiSchemaTable | undefined> {
  const databaseType = aiDatabaseTypeForConnection(connection);
  const schema = await resolveMentionedTableSchema(tab, connection, mention);
  const [columns, indexes, foreignKeys, tableComment] = await Promise.all([
    api.getColumns(tab.connectionId, tab.database, schema, mention.table),
    api.listIndexes(tab.connectionId, tab.database, schema, mention.table).catch(() => [] as IndexInfo[]),
    api.listForeignKeys(tab.connectionId, tab.database, schema, mention.table).catch(() => [] as ForeignKeyInfo[]),
    loadTableComment(tab.connectionId, tab.database, schema, mention.table).catch(() => undefined),
  ]);
  return {
    schema: schema === tab.database && !isSchemaAware(databaseType) ? undefined : schema,
    name: mention.table,
    tableType: "TABLE",
    comment: tableComment,
    columns: columns.slice(0, maxColumnsPerTable),
    indexes: indexes.slice(0, maxIndexesPerTable),
    foreignKeys: foreignKeys.slice(0, maxFksPerTable),
  };
}

async function loadTableComment(connectionId: string, database: string, schema: string, tableName: string): Promise<string | undefined> {
  const tables = await api.listTables(connectionId, database, schema, tableName, 10);
  return tables.find((table) => table.name.toLowerCase() === tableName.toLowerCase())?.comment?.trim() || undefined;
}

async function resolveMentionedTableSchema(tab: QueryTab, connection: ConnectionConfig, mention: AiTableMention): Promise<string> {
  if (mention.schema) return mention.schema;
  if (tab.tableMeta?.tableName.toLowerCase() === mention.table.toLowerCase() && tab.tableMeta.schema) {
    return tab.tableMeta.schema;
  }
  if (isSchemaAware(aiDatabaseTypeForConnection(connection))) {
    const schemas = await loadCandidateSchemas(tab, connection);
    for (const schema of schemas) {
      const tables = await api.listTables(tab.connectionId, tab.database, schema, mention.table, 10).catch(() => []);
      if (tables.some((table) => table.name.toLowerCase() === mention.table.toLowerCase())) return schema;
    }
  }
  return tab.database || connection.database || "main";
}

async function loadCandidateSchemas(tab: QueryTab, connection: ConnectionConfig): Promise<string[]> {
  if (isSchemaAware(aiDatabaseTypeForConnection(connection))) {
    const schemas = await api.listSchemas(tab.connectionId, tab.database);
    return prioritizeSchemas(schemas);
  }
  return [tab.database || connection.database || "main"];
}

function aiDatabaseTypeForConnection(connection: ConnectionConfig): DatabaseType {
  return effectiveDatabaseTypeForConnection(connection) ?? connection.db_type;
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
  const MAX_VALUE_CHARS = 200;
  const rows = result.rows.slice(0, 5).map((row) => {
    return result.columns
      .map((column, index) => {
        const raw = JSON.stringify(row[index] ?? null);
        const val = raw.length > MAX_VALUE_CHARS ? raw.slice(0, MAX_VALUE_CHARS) + "…" : raw;
        return `${column}=${val}`;
      })
      .join(", ");
  });
  return rows.join("\n");
}
