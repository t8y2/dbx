import type { AiAction } from "@/lib/ai/ai";

export type AiSkillRiskPolicy = "readonly" | "readonly_preferred" | "confirmed_write" | "sample_write";
export type AiSkillContextNeed = "currentSql" | "schema" | "indexes" | "foreignKeys" | "lastError" | "lastResultPreview" | "databaseDialect";

export interface LocalizedAiSkillText {
  en: string;
  zh: string;
}

export interface LocalizedAiSkillLines {
  en: string[];
  zh: string[];
}

export interface AiSkillDefinition {
  id: string;
  action: AiAction;
  title: LocalizedAiSkillText;
  riskPolicy: AiSkillRiskPolicy;
  contextNeeds: AiSkillContextNeed[];
  userInstruction: LocalizedAiSkillText;
  systemRules: LocalizedAiSkillLines;
  outputContract: LocalizedAiSkillLines;
}

export const AI_SKILL_DEFINITIONS: AiSkillDefinition[] = [
  {
    id: "generate_sql",
    action: "generate",
    title: {
      en: "Generate SQL",
      zh: "生成 SQL",
    },
    riskPolicy: "readonly_preferred",
    contextNeeds: ["schema", "indexes", "foreignKeys", "databaseDialect"],
    userInstruction: {
      en: "Generate a SQL query that satisfies the user's request. Return the SQL in a ```sql code block first, followed by a brief note if needed. Use foreign key relationships from the schema to infer correct JOIN conditions.",
      zh: "根据用户请求生成 SQL。先在 ```sql 代码块中返回 SQL，必要时附简短说明。利用 Schema 中的外键关系推断正确的 JOIN 条件。",
    },
    systemRules: {
      en: ["Use foreign key relationships to infer JOIN conditions. Return the SQL first and avoid long explanations."],
      zh: ["利用外键关系推断 JOIN 条件。生成操作优先返回 SQL，避免长篇解释。"],
    },
    outputContract: {
      en: ["Output format: put only the final recommended SQL in the first ```sql code block; add at most 3 practical notes after it. If required information is missing, ask one clarifying question first."],
      zh: ["输出格式：第一个 ```sql 代码块只放最终推荐 SQL；SQL 后最多 3 条实用说明。信息不足时先提出一个澄清问题。"],
    },
  },
  {
    id: "explain_sql",
    action: "explain",
    title: {
      en: "Explain SQL",
      zh: "解释 SQL",
    },
    riskPolicy: "readonly",
    contextNeeds: ["currentSql", "schema", "indexes", "foreignKeys", "lastResultPreview"],
    userInstruction: {
      en: "Explain the current SQL step by step. Point out risky operations, implicit assumptions, and potential performance issues. Reference index and foreign key info from the schema when relevant.",
      zh: "逐步解释当前 SQL。指出危险操作、隐含假设和潜在性能问题。结合 Schema 中的索引和外键信息分析。",
    },
    systemRules: {
      en: ["Explain what the SQL does without changing it. Reference schema, indexes, foreign keys, result preview, and risky assumptions when relevant."],
      zh: ["解释当前 SQL 的作用，不要改写 SQL。必要时结合 Schema、索引、外键、结果预览和风险假设说明。"],
    },
    outputContract: {
      en: ["Output format: summarize the SQL purpose first, then explain execution logic, risks, and performance notes step by step."],
      zh: ["输出格式：先概括 SQL 目的，再按步骤解释执行逻辑、风险点和性能注意事项。"],
    },
  },
  {
    id: "optimize_sql",
    action: "optimize",
    title: {
      en: "Optimize SQL",
      zh: "优化 SQL",
    },
    riskPolicy: "readonly",
    contextNeeds: ["currentSql", "schema", "indexes", "foreignKeys"],
    userInstruction: {
      en: "Rewrite or suggest improvements for the current SQL. Return the improved SQL in a ```sql code block first, followed by short notes explaining the changes. Use the index information in the schema to suggest index-aware optimizations (e.g., avoid full table scans, leverage existing indexes).",
      zh: "重写或优化当前 SQL。先在 ```sql 代码块中返回优化后的 SQL，然后简要说明改动。利用 Schema 中的索引信息建议索引友好的优化（如避免全表扫描、利用现有索引）。",
    },
    systemRules: {
      en: ["Use the index information in the schema to suggest optimizations. Point out which conditions hit indexes and which cause full table scans."],
      zh: ["利用 Schema 中的索引信息建议优化。指出哪些查询条件可以命中索引、哪些会导致全表扫描。"],
    },
    outputContract: {
      en: ["Output format: provide the optimized SQL first, then explain the key changes in at most 3 notes."],
      zh: ["输出格式：先给优化后的 SQL，再用最多 3 条说明解释关键改动。"],
    },
  },
  {
    id: "fix_sql",
    action: "fix",
    title: {
      en: "Fix SQL",
      zh: "修复 SQL",
    },
    riskPolicy: "readonly_preferred",
    contextNeeds: ["currentSql", "schema", "lastError", "lastResultPreview", "databaseDialect"],
    userInstruction: {
      en: "Fix the current SQL using the provided error message and result context. Return the corrected SQL in a ```sql code block first, followed by a brief explanation of the root cause.",
      zh: "根据报错信息和结果上下文修复当前 SQL。先在 ```sql 代码块中返回修正后的 SQL，再简要说明根因。",
    },
    systemRules: {
      en: ["Carefully analyze the error message to identify the root cause. Return the corrected SQL first, then briefly explain."],
      zh: ["仔细分析错误信息，定位根因。先返回修正后的 SQL，再简要解释。"],
    },
    outputContract: {
      en: ["Output format: corrected SQL, error cause, change notes."],
      zh: ["输出格式：修复后的 SQL、错误原因、改动说明。"],
    },
  },
  {
    id: "convert_sql",
    action: "convert",
    title: {
      en: "Convert SQL Dialect",
      zh: "转换 SQL 方言",
    },
    riskPolicy: "readonly_preferred",
    contextNeeds: ["currentSql", "schema", "databaseDialect"],
    userInstruction: {
      en: "Convert the current SQL to the target dialect requested by the user. Return the converted SQL in a ```sql code block first. Note any syntax differences or incompatibilities.",
      zh: "将当前 SQL 转换为用户指定的目标方言。先在 ```sql 代码块中返回转换后的 SQL，再说明语法差异。",
    },
    systemRules: {
      en: ["Convert only to the target dialect requested by the user. Preserve the query intent and call out syntax that cannot be converted safely."],
      zh: ["只转换到用户指定的目标方言。保持查询意图，并指出无法安全转换的语法。"],
    },
    outputContract: {
      en: ["Output format: provide the converted SQL first, then note important target-dialect syntax differences or incompatibilities."],
      zh: ["输出格式：先给转换后的 SQL，再说明目标方言下的重要语法差异或不兼容点。"],
    },
  },
  {
    id: "sample_data",
    action: "sampleData",
    title: {
      en: "Generate Sample Data",
      zh: "生成样例数据",
    },
    riskPolicy: "sample_write",
    contextNeeds: ["schema", "databaseDialect"],
    userInstruction: {
      en: "Generate safe sample INSERT statements or mock data for the current schema. Do not use real production data. Return SQL in a ```sql code block.",
      zh: "为当前 Schema 生成安全的示例 INSERT 语句或模拟数据。不使用真实生产数据。在 ```sql 代码块中返回 SQL。",
    },
    systemRules: {
      en: ["Generate mock data only. Do not use or imply real production data, credentials, personal data, or secrets."],
      zh: ["只生成模拟数据。不要使用或暗示真实生产数据、凭据、个人数据或密钥。"],
    },
    outputContract: {
      en: ["Output format: provide safe sample SQL first, then explain which values are mock data."],
      zh: ["输出格式：先给安全的示例 SQL，再说明哪些值是模拟数据。"],
    },
  },
  {
    id: "query_data",
    action: "query",
    title: {
      en: "Query Data",
      zh: "查询数据",
    },
    riskPolicy: "readonly",
    contextNeeds: ["schema", "indexes", "foreignKeys", "databaseDialect"],
    userInstruction: {
      en: "Query or aggregate data per the user's request. Confirm structure via the schema or list_tables/get_columns, then call execute_query to run a read-only query and obtain real results, then answer based on the actual data. Do not stop after merely outputting SQL text.",
      zh: "根据用户请求查询或统计数据。先用 Schema 或 list_tables/get_columns 确认结构，然后调用 execute_query 执行只读查询获取真实结果，最后基于真实结果回答用户。不要只输出 SQL 文本就停止。",
    },
    systemRules: {
      en: ["You MUST obtain real data via the execute_query tool before answering; do not stop at SQL text only.", "If safe execution requirements are not met, explain why first, then provide a read-only preview or a clarifying question."],
      zh: ["必须通过 execute_query 工具获取真实数据后再回答，不要只生成 SQL 文本。", "如果安全执行条件不满足，先说明原因，再给只读预览或澄清问题。"],
    },
    outputContract: {
      en: ["Output format: lead with a one-sentence conclusion based on real data, then include the SQL used in a ```sql code block. When safe execution is not possible, state the reason and ask one clarifying question."],
      zh: ["输出格式：先给一句基于真实数据的结论，再附上所用的 SQL（放在 ```sql 代码块中）。无法安全执行时，说明原因并提出一个澄清问题。"],
    },
  },
  {
    id: "explore_schema",
    action: "exploreSchema",
    title: {
      en: "Inspect Schema",
      zh: "查看表结构",
    },
    riskPolicy: "readonly",
    contextNeeds: ["schema", "databaseDialect"],
    userInstruction: {
      en: "Help the user understand the database or table structure. Prefer the loaded schema context; call list_tables / get_columns for more complete or authoritative definitions, then clearly summarize the structure.",
      zh: "帮助用户了解数据库或表的结构。优先使用已加载的 Schema 上下文；需要更完整或权威的定义时调用 list_tables / get_columns，然后清晰总结结构。",
    },
    systemRules: {
      en: ["Never invent tables or columns not present in the schema context.", "Use get_columns for authoritative column definitions; do not guess."],
      zh: ["不要编造 Schema 中不存在的表或列。", "需要权威列定义时使用 get_columns，不要猜测。"],
    },
    outputContract: {
      en: ["Output format: summarize the key structural points first, then list relevant tables/columns and their purpose. If further exploration helps, include a read-only metadata query."],
      zh: ["输出格式：先概括结构要点，再列出相关表/列及其用途。如需进一步探索，附一个只读元数据查询。"],
    },
  },
  {
    id: "execute_and_explain",
    action: "executeAndExplain",
    title: {
      en: "Run & Explain",
      zh: "执行并解释",
    },
    riskPolicy: "readonly",
    contextNeeds: ["currentSql", "schema", "indexes", "foreignKeys", "lastResultPreview", "databaseDialect"],
    userInstruction: {
      en: "Execute the current SQL and explain the results. First call execute_query to run the current SQL, then explain the query meaning, data characteristics, and notable points based on the real results.",
      zh: "执行当前的 SQL 并解释结果。先调用 execute_query 运行当前 SQL，再基于真实结果解释查询含义、数据特征和值得注意的点。",
    },
    systemRules: {
      en: ["Only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN can be executed. If the current SQL is a write operation, do not execute; explain its impact instead.", "Base explanations on real execution results; do not speculate about data."],
      zh: ["只有 SELECT/WITH/SHOW/DESCRIBE/EXPLAIN 可执行。如果当前 SQL 是写操作，不要执行，改为解释其影响。", "解释要基于真实执行结果，不要凭空推测数据。"],
    },
    outputContract: {
      en: ["Output format: lead with an execution-result summary, then step through the key data and its meaning."],
      zh: ["输出格式：先给执行结果概要，再逐步解释关键数据和含义。"],
    },
  },
];

export function aiSkillForAction(action: AiAction): AiSkillDefinition {
  const skill = AI_SKILL_DEFINITIONS.find((item) => item.action === action);
  if (!skill) throw new Error(`Missing AI skill definition for action: ${action}`);
  return skill;
}
