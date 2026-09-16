import type { DatabaseType } from "@/types/database";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { resolveSqlSemanticNavigationTarget } from "@/lib/sql/semantic/references";
import type { SqlSemanticModel, SqlSemanticRowSource, SqlSemanticCursorIntent, SqlSemanticScope, SqlSemanticToken } from "@/lib/sql/semantic/types";
import { unquoteSqlSemanticIdentifier, tokenIsIdentifier } from "@/lib/sql/semantic/tokens";
import { quoteTableIdentifier } from "@/lib/table/tableSelectSql";
import { supportsColumnNameQuoting } from "@/lib/dataGrid/dataGridColumnNameCopy";

// ==================== Types ====================

export interface IntentionAction {
  kind: "expand_wildcard" | "qualify_identifier" | "unqualify_identifier" | "batch_qualify_identifiers";
  span: { start: number; end: number };
  replacement: string;
  /** batch_qualify_identifiers 专用：每个标识符的独立替换 */
  replacements?: Array<{ span: { start: number; end: number }; replacement: string }>;
  /** 自定义标签（多表限定场景显示 "Qualify with su" 等） */
  label?: string;
}

export interface IntentionActionContext {
  sql: string;
  cursor: number;
  databaseType?: DatabaseType;
  dialect?: "mysql" | "postgres" | "sqlserver";
  /** 选择区间，非空时优先走批量限定逻辑 */
  selection?: { from: number; to: number };
}

// SQL 关键字集合（小写），用于批量限定时跳过
const SQL_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "and",
  "or",
  "not",
  "in",
  "exists",
  "between",
  "like",
  "is",
  "null",
  "as",
  "on",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "outer",
  "cross",
  "group",
  "by",
  "order",
  "having",
  "limit",
  "offset",
  "union",
  "all",
  "distinct",
  "case",
  "when",
  "then",
  "else",
  "end",
  "asc",
  "desc",
  "insert",
  "into",
  "values",
  "update",
  "set",
  "delete",
  "create",
  "table",
  "drop",
  "alter",
  "add",
  "column",
  "primary",
  "key",
  "foreign",
  "references",
  "default",
  "constraint",
  "unique",
  "index",
  "with",
  "recursive",
  "returning",
  "intersect",
  "except",
  "using",
  "natural",
  "lateral",
  "window",
  "over",
  "partition",
]);

// 热循环中使用的正则常量，避免重复编译
const WHITESPACE_RE = /\s/;
const IDENT_START_RE = /[a-zA-Z_]/;
const IDENT_PART_RE = /[a-zA-Z0-9_$]/;

// ==================== Entry Point ====================

export function analyzeIntentionActions(ctx: IntentionActionContext): IntentionAction[] {
  // P0: 选中区间优先 → 批量限定
  if (ctx.selection && ctx.selection.from < ctx.selection.to) {
    return buildBatchQualifyActions(ctx);
  }

  const model = buildSqlSemanticModel(ctx.sql, ctx.cursor, {
    databaseType: ctx.databaseType,
    dialect: ctx.dialect,
  });

  const { cursorIntent } = model;

  switch (cursorIntent.kind) {
    case "star":
      return buildExpandWildcardActions(model, cursorIntent);

    case "column":
    case "alias_column":
    case "update_column":
    case "insert_column":
    case "join_condition":
      return buildQualifierActions(model, cursorIntent, ctx.sql, ctx.databaseType);

    case "keyword":
      if (cursorIntent.qualifierParts.length > 0 || cursorIntent.replacementRange.start < cursorIntent.replacementRange.end) {
        return buildQualifierActions(model, cursorIntent, ctx.sql, ctx.databaseType);
      }
      return [];

    default:
      return [];
  }
}

// ==================== Expand Wildcard ====================

/**
 * 查找光标所在的 SELECT scope（用于通配符展开和上下文准备）。
 */
function findSelectScopeForCursor(model: SqlSemanticModel, cursorIntent: SqlSemanticCursorIntent) {
  return model.scopes.find((s) => {
    if (!s.clauseSpans.select) return false;
    const selectStart = s.clauseSpans.select.start;
    const nextClause = s.clauseSpans.from ?? s.clauseSpans.where ?? s.clauseSpans.having ?? s.clauseSpans.groupBy ?? s.clauseSpans.orderBy ?? s.clauseSpans.limit;
    const selectEnd = nextClause?.start ?? Infinity;
    return cursorIntent.replacementRange.start >= selectStart && cursorIntent.replacementRange.start < selectEnd;
  });
}

function buildExpandWildcardActions(model: SqlSemanticModel, cursorIntent: SqlSemanticCursorIntent): IntentionAction[] {
  const scope = findSelectScopeForCursor(model, cursorIntent);
  if (!scope || scope.rowSources.length === 0) return [];

  const rowSources = scope.rowSources.filter((rs) => rs.kind === "table" || rs.kind === "cte");

  if (rowSources.length === 0) return [];

  return [
    {
      kind: "expand_wildcard" as const,
      span: cursorIntent.replacementRange,
      replacement: "",
    },
  ];
}

export async function buildExpandWildcardReplacement(databaseType: DatabaseType | undefined, rowSources: SqlSemanticRowSource[], fetchColumns: (source: SqlSemanticRowSource) => Promise<string[]>): Promise<string> {
  const quote = supportsColumnNameQuoting(databaseType);
  const allColumns: string[] = [];

  for (const source of rowSources) {
    const columns = await fetchColumns(source);
    const rawName = source.alias ?? source.name;
    const qualifier = quote ? quoteTableIdentifier(databaseType, rawName) : rawName;

    for (const col of columns) {
      const quoted = quote ? quoteTableIdentifier(databaseType, col) : col;
      allColumns.push(rowSources.length > 1 ? `${qualifier}.${quoted}` : quoted);
    }
  }

  return allColumns.join(", ");
}

// ==================== Batch Qualify (P0) ====================

/**
 * 在选中区间内扫描独立标识符，为未限定的标识符批量添加表前缀。
 */
function buildBatchQualifyActions(ctx: IntentionActionContext): IntentionAction[] {
  const { sql, selection, databaseType, dialect } = ctx;
  if (!selection) return [];

  // 用选中区间起点构建语义模型
  const model = buildSqlSemanticModel(sql, selection.from, {
    databaseType,
    dialect,
  });

  // 检查是否为多表场景
  const scope = model.scopes.find((s) => s.rowSources.length > 0);
  const tableSources = scope?.rowSources.filter((rs) => rs.kind === "table" || rs.kind === "cte") ?? [];
  const isMultiTable = tableSources.length > 1;

  // 单表场景：解析统一表源
  let singleQualifier: string | null = null;
  if (!isMultiTable) {
    const tableTarget = resolveNavigationTarget(model, model.cursorIntent);
    if (!tableTarget) return [];
    const quote = supportsColumnNameQuoting(databaseType);
    singleQualifier = quote ? quoteTableIdentifier(databaseType, tableTarget.alias ?? tableTarget.name) : (tableTarget.alias ?? tableTarget.name);
  }

  // 扫描选中区间内的标识符
  const selectedText = sql.slice(selection.from, selection.to);
  const tokens = tokenizeSelectionIdentifiers(selectedText, databaseType);
  const replacements: NonNullable<IntentionAction["replacements"]> = [];
  const offset = selection.from;

  // 收集当前 scope 的 projection 别名，用于跳过
  const aliasNames = collectProjectionAliasNames(model);
  const quote = supportsColumnNameQuoting(databaseType);

  // 多表场景：一次性构建 column → qualifiers 映射，避免 N 次重复扫描全量 token
  const qualifierMap = isMultiTable ? buildColumnQualifierMap(model) : undefined;

  for (const token of tokens) {
    // 跳过已限定标识符
    if (token.qualified) continue;
    // 跳过 SQL 关键字
    if (SQL_KEYWORDS.has(token.text.toLowerCase())) continue;
    // 跳过 projection 别名（P1-2）
    if (aliasNames.has(token.text.toLowerCase())) continue;

    let qualifier: string;

    if (isMultiTable) {
      // 多表场景：为每个 token 独立解析表源（使用缓存的 qualifierMap）
      const tokenModel = buildSqlSemanticModel(sql, offset + token.start, {
        databaseType,
        dialect,
      });
      const tokenTarget = resolveNavigationTarget(tokenModel, tokenModel.cursorIntent, qualifierMap);
      if (!tokenTarget) continue; // 无法确定表源，跳过
      qualifier = quote ? quoteTableIdentifier(databaseType, tokenTarget.alias ?? tokenTarget.name) : (tokenTarget.alias ?? tokenTarget.name);
    } else {
      qualifier = singleQualifier!;
    }

    const quotedColumn = quote ? quoteTableIdentifier(databaseType, token.text) : token.text;
    replacements.push({
      span: { start: offset + token.start, end: offset + token.end },
      replacement: `${qualifier}.${quotedColumn}`,
    });
  }

  if (replacements.length === 0) return [];

  return [
    {
      kind: "batch_qualify_identifiers" as const,
      span: { start: selection.from, end: selection.to },
      replacement: "",
      replacements,
    },
  ];
}

interface SelectionToken {
  /** 在选中区间内的起始偏移 */
  start: number;
  /** 在选中区间内的结束偏移 */
  end: number;
  /** 剥离引号后的标识符文本 */
  text: string;
  /** 是否已限定（含 "." 分隔符） */
  qualified: boolean;
}

/**
 * 在选中文本中扫描独立标识符，处理各种引号包裹方式。
 */
function tokenizeSelectionIdentifiers(text: string, databaseType?: DatabaseType): SelectionToken[] {
  const tokens: SelectionToken[] = [];
  const doubleQuoteIsIdentifier = usesDoubleQuoteIdentifier(databaseType);
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // 跳过单行注释 --
    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }

    // 跳过多行注释 /* */
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }

    // 跳过字符串字面量（单引号包裹，支持 '' 转义）
    if (ch === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 跳过双引号字符串字面量（当数据库不使用双引号作为标识符引用时）
    if (ch === '"' && !doubleQuoteIsIdentifier) {
      const end = text.indexOf('"', i + 1);
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    // 跳过空白和标点（逗号、括号等）
    if (WHITESPACE_RE.test(ch) || ch === "," || ch === "(" || ch === ")" || ch === ";" || ch === "*" || ch === "+" || ch === "-" || ch === "/" || ch === "=") {
      i++;
      continue;
    }

    // 标识符起始：字母、下划线、反引号、双引号、方括号
    const identStart = i;
    let parts: string[] = [];
    let qualified = false;

    // 循环读取 qualified.identifier 形式
    while (i < text.length) {
      const part = readIdentifierPart(text, i, databaseType, doubleQuoteIsIdentifier);
      if (!part) break;

      parts.push(part.text);
      i = part.end;

      // 检查后面是否紧跟 "."
      if (text[i] === ".") {
        qualified = true;
        i++;
        continue;
      }
      break;
    }

    if (parts.length > 0) {
      // 取最后一个 part 作为列名（去掉引号后的文本）
      const lastPart = parts[parts.length - 1];
      if (lastPart.length > 0) {
        tokens.push({
          start: identStart,
          end: i,
          text: lastPart,
          qualified,
        });
      }
    } else {
      i++;
    }
  }

  return tokens;
}

/**
 * 判断当前数据库是否使用双引号作为标识符引用。
 * PostgreSQL/Oracle/DB2 等使用双引号，MySQL/SQL Server 中双引号是字符串字面量。
 */
function usesDoubleQuoteIdentifier(databaseType?: DatabaseType): boolean {
  if (!databaseType) return true;
  return quoteTableIdentifier(databaseType, "x").startsWith('"');
}

/**
 * 读取一个标识符分段（可能被引号包裹），返回剥离引号后的文本和结束位置。
 * `doubleQuoteIsIdentifier` 参数用于避免在热循环中重复调用 `usesDoubleQuoteIdentifier`。
 */
function readIdentifierPart(text: string, start: number, databaseType?: DatabaseType, doubleQuoteIsIdentifier?: boolean): { text: string; end: number } | null {
  const ch = text[start];

  // MySQL 反引号
  if (ch === "`") {
    const end = text.indexOf("`", start + 1);
    if (end === -1) return null;
    return { text: text.slice(start + 1, end), end: end + 1 };
  }

  // 双引号：仅在数据库使用双引号作为标识符引用时处理
  const dqIsIdent = doubleQuoteIsIdentifier ?? usesDoubleQuoteIdentifier(databaseType);
  if (ch === '"' && dqIsIdent) {
    const end = text.indexOf('"', start + 1);
    if (end === -1) return null;
    return { text: text.slice(start + 1, end), end: end + 1 };
  }

  // SQL Server 方括号
  if (ch === "[") {
    const end = text.indexOf("]", start + 1);
    if (end === -1) return null;
    return { text: text.slice(start + 1, end), end: end + 1 };
  }

  // 普通标识符：字母、数字、下划线
  if (IDENT_START_RE.test(ch)) {
    let i = start;
    while (i < text.length && IDENT_PART_RE.test(text[i])) i++;
    return { text: text.slice(start, i), end: i };
  }

  return null;
}

/**
 * 收集当前模型所有 scope 中的 projection 别名（小写），用于跳过别名列。
 */
function collectProjectionAliasNames(model: SqlSemanticModel): Set<string> {
  const names = new Set<string>();
  for (const scope of model.scopes) {
    for (const proj of scope.projections) {
      if (proj.alias) {
        names.add(proj.alias.toLowerCase());
      }
    }
  }
  return names;
}

/**
 * 收集所有行源的表名和别名（小写），用于跳过表别名。
 * 表别名不是列名，不应提供限定操作。
 */
function collectTableAliasNames(model: SqlSemanticModel): Set<string> {
  const names = new Set<string>();
  for (const rs of model.rowSources) {
    if (rs.alias) names.add(rs.alias.toLowerCase());
    names.add(rs.name.toLowerCase());
  }
  return names;
}

/**
 * 将 token 标准化为小写无引号文本，用于跨引号风格的统一比较。
 */
function normalizeIdentifierToken(token: SqlSemanticToken): string {
  return unquoteSqlSemanticIdentifier(token).toLowerCase();
}

/**
 * 提取 qualifier 的完整文本（处理 schema.table.column 三段式标识符）。
 * 当 tokens[i] 前面还有 `schema.` 时，返回 `schema.table`，否则返回 `table`。
 */
function extractQualifier(tokens: readonly SqlSemanticToken[], i: number): string {
  // 检查是否为 3-part: schema.table.column → qualifier = schema.table
  if (i >= 2 && tokens[i - 1]?.text === "." && tokenIsIdentifier(tokens[i - 2])) {
    return `${normalizeIdentifierToken(tokens[i - 2])}.${normalizeIdentifierToken(tokens[i])}`;
  }
  return normalizeIdentifierToken(tokens[i]);
}

/**
 * 扫描 SQL 中的 `qualifier.column` 模式，收集引用指定列名的不同限定符。
 * 支持 2-part (table.column) 和 3-part (schema.table.column) 标识符。
 */
function collectColumnQualifiers(model: SqlSemanticModel, columnName: string): Set<string> {
  const target = columnName.toLowerCase();
  const qualifiers = new Set<string>();
  const tokens = model.tokens;
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokenIsIdentifier(tokens[i]) && tokens[i + 1]?.text === "." && tokenIsIdentifier(tokens[i + 2])) {
      if (normalizeIdentifierToken(tokens[i + 2]) === target) {
        qualifiers.add(extractQualifier(tokens, i));
      }
    }
  }
  return qualifiers;
}

/**
 * 一次性构建 `column → qualifiers` 映射，避免批量场景中 N 次重复扫描全量 token。
 * 支持 2-part (table.column) 和 3-part (schema.table.column) 标识符。
 */
function buildColumnQualifierMap(model: SqlSemanticModel): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const tokens = model.tokens;
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokenIsIdentifier(tokens[i]) && tokens[i + 1]?.text === "." && tokenIsIdentifier(tokens[i + 2])) {
      const col = normalizeIdentifierToken(tokens[i + 2]);
      const qual = extractQualifier(tokens, i);
      let set = map.get(col);
      if (!set) {
        set = new Set();
        map.set(col, set);
      }
      set.add(qual);
    }
  }
  return map;
}

/**
 * 检查取消限定后列名是否会产生歧义。
 * 1. 扫描 SQL 中的 qualifier.column 模式，检查同一列名是否被 2+ 个不同限定符引用
 * 2. 检查 rowSources 的 columns（CTE/子查询场景），列名是否出现在 2+ 个行源中
 */
function isColumnAmbiguous(model: SqlSemanticModel, columnName: string): boolean {
  const target = columnName.toLowerCase();

  // 1. 检查 rowSources 的 columns（CTE/子查询有列信息时）
  let sourcesWithColumn = 0;
  for (const rs of model.rowSources) {
    if (rs.columns?.some((c) => c.toLowerCase() === target)) {
      sourcesWithColumn++;
    }
  }
  if (sourcesWithColumn >= 2) return true;

  // 2. 扫描 token 中的 qualifier.column 模式，收集不同限定符
  const qualifiers = collectColumnQualifiers(model, columnName);
  // 2+ 个不同限定符引用同一列名 → 取消限定后会产生歧义
  return qualifiers.size >= 2;
}

// ==================== Qualify / Unqualify Identifier ====================

/**
 * 查找光标所在位置对应的完整标识符 token。
 * trailingIdentifier 为自动补全设计，replacementRange 只到光标位置。
 * 意图操作需要完整 token 的范围和文本。
 */
function findFullIdentifierToken(model: SqlSemanticModel, range: { start: number; end: number }): { prefix: string; replacementRange: { start: number; end: number } } | null {
  for (const token of model.tokens) {
    if (tokenIsIdentifier(token) && token.span.start === range.start && token.span.end > range.end) {
      return {
        prefix: unquoteSqlSemanticIdentifier(token),
        replacementRange: { start: token.span.start, end: token.span.end },
      };
    }
  }
  return null;
}

function buildQualifierActions(model: SqlSemanticModel, cursorIntentIn: SqlSemanticCursorIntent, sql: string, databaseType?: DatabaseType): IntentionAction[] {
  let cursorIntent = cursorIntentIn;

  // 修复：当光标在标识符中间时，trailingIdentifier 返回的 replacementRange 只到光标位置。
  // 扩展到完整 token 的范围和文本。
  const fullToken = findFullIdentifierToken(model, cursorIntent.replacementRange);
  if (fullToken) {
    cursorIntent = {
      ...cursorIntent,
      prefix: fullToken.prefix,
      replacementRange: fullToken.replacementRange,
    };
  }
  // 组合 qualifierParts + prefix 形成完整标识符分段
  // qualifierParts 仅含限定符（表别名），prefix 含列名
  let parts = cursorIntent.qualifierParts;
  if (cursorIntent.prefix) {
    parts = [...parts, cursorIntent.prefix];
  }

  // fallback：无 prefix 且无 qualifierParts 时从 SQL 文本提取
  if (parts.length === 0 && sql && cursorIntent.replacementRange.start < cursorIntent.replacementRange.end) {
    const text = sql.slice(cursorIntent.replacementRange.start, cursorIntent.replacementRange.end);
    if (text.length > 0) {
      parts = splitQualifiedIdentifier(text, databaseType);
    }
  }

  if (parts.length === 0) return [];

  const actions: IntentionAction[] = [];
  const lastPart = parts[parts.length - 1] ?? "";

  // P1-2: 跳过 projection 别名
  const aliasNames = collectProjectionAliasNames(model);
  if (aliasNames.has(lastPart.toLowerCase())) return [];

  // 跳过表别名（su 是别名不是列名，不应提供限定）
  const tableAliasNames = collectTableAliasNames(model);
  if (tableAliasNames.has(lastPart.toLowerCase())) return [];

  // 判断是否已限定：qualifierParts 非空，或 fallback 提取出多段
  const isQualified = cursorIntent.qualifierParts.length > 0 || parts.length > 1;

  if (isQualified) {
    // 检查取消限定后是否会产生歧义（多表 JOIN 同名列场景）
    if (isColumnAmbiguous(model, lastPart)) {
      return [];
    }

    // 已限定 → 提供取消限定
    // 扩展 span 覆盖完整限定标识符（如 `su`.`user_id` 而非仅 `user_id`）
    let span = cursorIntent.replacementRange;
    if (cursorIntent.qualifierParts.length > 0) {
      // 反向迭代查找 replacementRange 之前的 token（避免 filter 创建新数组）
      let ti = model.tokens.length - 1;
      while (ti >= 0) {
        const t = model.tokens[ti];
        if (t.span.end <= cursorIntent.replacementRange.start && t.kind !== "comment" && t.kind !== "string") break;
        ti--;
      }
      // 检查 replacementRange 前是否紧跟 "."
      if (ti >= 0 && model.tokens[ti].text === ".") {
        ti--;
        // 向前查找限定符标识符
        while (ti >= 0) {
          const token = model.tokens[ti];
          // 跳过 comment/string token
          if (token.kind === "comment" || token.kind === "string") {
            ti--;
            continue;
          }
          if (token.kind === "word" || token.kind === "quoted_identifier") {
            span = { start: token.span.start, end: cursorIntent.replacementRange.end };
            ti--;
            // 继续向前查找 schema.table.column 模式
            if (ti >= 0 && model.tokens[ti].text === ".") {
              ti--;
              continue;
            }
          }
          break;
        }
      }
    }
    const quote = supportsColumnNameQuoting(databaseType);
    const quotedColumn = quote ? quoteTableIdentifier(databaseType, lastPart) : lastPart;
    actions.push({
      kind: "unqualify_identifier",
      span,
      replacement: quotedColumn,
    });
    return actions;
  }

  // 未限定 → 提供限定
  const target = resolveNavigationTarget(model, cursorIntent);
  if (target) {
    const quote = supportsColumnNameQuoting(databaseType);
    const qualifier = quote ? quoteTableIdentifier(databaseType, target.alias ?? target.name) : (target.alias ?? target.name);
    const quotedColumn = quote ? quoteTableIdentifier(databaseType, lastPart) : lastPart;
    actions.push({
      kind: "qualify_identifier" as const,
      span: cursorIntent.replacementRange,
      replacement: `${qualifier}.${quotedColumn}`,
    });
    return actions;
  }

  // 多表场景：无法自动推断所属表时，提供所有候选表的限定选项
  const scope = findScopeContainingCursor(model, cursorIntent.replacementRange.start);
  if (scope) {
    const tableSources = scope.rowSources.filter((rs) => rs.kind === "table" || rs.kind === "cte");
    if (tableSources.length > 1) {
      const quote = supportsColumnNameQuoting(databaseType);
      const quotedColumn = quote ? quoteTableIdentifier(databaseType, lastPart) : lastPart;
      for (const source of tableSources) {
        const qualifierName = source.alias ?? source.name;
        const qualifier = quote ? quoteTableIdentifier(databaseType, qualifierName) : qualifierName;
        actions.push({
          kind: "qualify_identifier" as const,
          span: cursorIntent.replacementRange,
          replacement: `${qualifier}.${quotedColumn}`,
          label: `${qualifierName}.${lastPart}`,
        });
      }
    }
  }

  return actions;
}

/**
 * 将 qualified identifier 文本拆分为分段，正确处理各种引号包裹方式。
 * 例如: `su`.`user_id` → ["su", "user_id"]
 *       su.user_id → ["su", "user_id"]
 *       `user_id` → ["user_id"]
 */
function splitQualifiedIdentifier(text: string, databaseType?: DatabaseType): string[] {
  const parts: string[] = [];
  let i = 0;

  while (i < text.length) {
    const part = readIdentifierPart(text, i, databaseType);
    if (!part) {
      i++;
      continue;
    }
    parts.push(part.text);
    i = part.end;

    // 跳过 "." 分隔符
    if (text[i] === ".") {
      i++;
      continue;
    }
    break;
  }

  return parts.filter(Boolean);
}

/**
 * 查找包含光标位置的最内层 scope。
 *
 * 注意：clauseSpans 中每个子句的 end 只到下一个 token 的 start（非常窄），
 * 无法覆盖整个子句范围。因此优先使用 scope 的 statement span 判断光标归属，
 * 仅在 statement span 不可用时回退到 clauseSpans。
 */
function findScopeContainingCursor(model: SqlSemanticModel, cursor: number) {
  let best: SqlSemanticScope | undefined;
  for (const s of model.scopes) {
    if (s.rowSources.length === 0) continue;
    // 优先使用 statement span（覆盖整条语句，cursor 必在其中）
    if (cursor >= s.span.start && cursor <= s.span.end) {
      best = s; // 取最后一个匹配的（最内层）
      continue;
    }
    // 回退：检查 clauseSpans
    const spans = [s.clauseSpans.select, s.clauseSpans.from, s.clauseSpans.where, s.clauseSpans.having, s.clauseSpans.groupBy, s.clauseSpans.orderBy, s.clauseSpans.limit].filter(Boolean) as { start: number; end: number }[];
    if (spans.some((sp) => cursor >= sp.start && cursor <= sp.end)) {
      best = s;
    }
  }
  return best;
}

function resolveNavigationTarget(model: SqlSemanticModel, cursorIntent: SqlSemanticCursorIntent, qualifierMap?: Map<string, Set<string>>): { name: string; alias?: string } | null {
  // 1. 优先使用 semantic 的 targetSourceId
  if (cursorIntent.targetSourceId) {
    const source = model.rowSources.find((rs) => rs.id === cursorIntent.targetSourceId);
    if (source) return { name: source.name, alias: source.alias };
  }

  // 2. 尝试使用 resolveSqlSemanticNavigationTarget（适用于已限定标识符）
  try {
    const target = resolveSqlSemanticNavigationTarget(model, cursorIntent.qualifierParts);
    if (target) return { name: target.name, alias: target.alias };
  } catch {
    // ignore
  }

  // 3. 降级策略 — 查找包含光标的 scope
  const scope = findScopeContainingCursor(model, cursorIntent.replacementRange.start);
  if (scope) {
    const tableSources = scope.rowSources.filter((rs) => rs.kind === "table" || rs.kind === "cte");
    // 3a. 单表场景 → 直接返回
    if (tableSources.length === 1) {
      return { name: tableSources[0].name, alias: tableSources[0].alias };
    }

    // 3b. 多表场景 → 扫描 SQL 中同一列名的限定符引用
    // 如果列名在 SQL 中被恰好 1 个限定符引用，则可推断其所属表
    if (cursorIntent.prefix && tableSources.length > 1) {
      const qualifiers = qualifierMap?.get(cursorIntent.prefix.toLowerCase()) ?? collectColumnQualifiers(model, cursorIntent.prefix);
      if (qualifiers.size === 1) {
        const qualifier = [...qualifiers][0];
        // 支持 schema.table 形式的限定符匹配
        const source = tableSources.find((rs) => {
          const alias = rs.alias?.toLowerCase();
          const name = rs.name.toLowerCase();
          if (alias === qualifier || name === qualifier) return true;
          // 3-part: qualifier = "schema.table", match against metadataTarget
          const dotIdx = qualifier.indexOf(".");
          if (dotIdx > 0) {
            const qualTable = qualifier.slice(dotIdx + 1);
            return alias === qualTable || name === qualTable;
          }
          return false;
        });
        if (source) return { name: source.name, alias: source.alias };
      }
    }
  }

  return null;
}

// ==================== Expand Wildcard Context ====================

export function prepareExpandWildcardContext(sql: string, cursor: number, databaseType?: DatabaseType, dialect?: "mysql" | "postgres" | "sqlserver"): { rowSources: SqlSemanticRowSource[]; starSpan: { start: number; end: number } } | null {
  const model = buildSqlSemanticModel(sql, cursor, { databaseType, dialect });

  if (model.cursorIntent.kind !== "star") return null;

  const { cursorIntent } = model;

  const scope = findSelectScopeForCursor(model, cursorIntent);

  if (!scope) return null;

  const rowSources = scope.rowSources.filter((rs) => rs.kind === "table" || rs.kind === "cte");

  if (rowSources.length === 0) return null;

  const starSpan = cursorIntent.replacementRange.start === cursorIntent.replacementRange.end ? { start: cursorIntent.replacementRange.start, end: cursorIntent.replacementRange.end + 1 } : cursorIntent.replacementRange;

  return { rowSources, starSpan };
}
