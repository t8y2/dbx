import { sqlSemanticDialectFor, type SqlSemanticDialectAdapter } from "@/lib/sql/semantic/dialect";
import { findActiveSqlStatementSpan, isSuppressedSqlSemanticContext, tokenIsIdentifier, tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type {
  SqlSemanticBuildOptions,
  SqlSemanticClauseSpans,
  SqlSemanticCursorIntent,
  SqlSemanticIdentifierPart,
  SqlSemanticModel,
  SqlSemanticProjection,
  SqlSemanticQualifiedName,
  SqlSemanticRowSource,
  SqlSemanticScope,
  SqlSemanticSpan,
  SqlSemanticStatement,
  SqlSemanticStatementKind,
  SqlSemanticToken,
} from "@/lib/sql/semantic/types";

const TABLE_INTRODUCERS = new Set(["from", "join", "straight_join", "update", "into", "using", "apply"]);
const TABLE_FUNCTION_NAMES = new Set(["table", "xmltable", "json_table", "the", "read_csv", "read_parquet", "read_json", "unnest"]);
const JOIN_MODIFIERS = new Set(["left", "right", "inner", "outer", "cross", "full", "natural"]);
const CLAUSE_BOUNDARIES = new Set(["where", "group", "having", "order", "limit", "offset", "union", "intersect", "except", "on", "set", "values", "returning"]);
const FROM_CLAUSE_BOUNDARIES = new Set([...CLAUSE_BOUNDARIES, "window", "qualify", "fetch", "for", "connect", "start", "model"].filter((item) => item !== "on"));
const ALIAS_BLACKLIST = new Set([...FROM_CLAUSE_BOUNDARIES, "on", "join", "straight_join", "left", "right", "inner", "outer", "cross", "full", "natural", "as", "select", "from", "with"]);
const TABLE_TARGET_MODIFIERS = new Set(["lateral", "only"]);
const TABLE_FUNCTION_INTRODUCERS = new Set(["from", "join", "straight_join", "apply"]);
const TOP_LEVEL_STATEMENT_WORDS = new Set(["select", "insert", "delete", "merge", "create", "alter", "drop", "truncate", "call", "exec", "execute", "grant", "revoke"]);
const SQLSERVER_UPDATE_STATISTICS_SCOPES = new Set(["all", "index", "table"]);

interface ParseState {
  dialect: SqlSemanticDialectAdapter;
  tokens: SqlSemanticToken[];
  statement: SqlSemanticStatement;
  cteSources: SqlSemanticRowSource[];
}

interface TrailingIdentifier {
  prefix: string;
  replacementRange: SqlSemanticSpan;
  qualifierParts: string[];
}

function significantTokens(tokens: readonly SqlSemanticToken[]): SqlSemanticToken[] {
  return tokens.filter((item) => item.kind !== "comment");
}

function tokenTextAt(sql: string, span: SqlSemanticSpan): string {
  return sql.slice(span.start, span.end);
}

function firstWord(tokens: readonly SqlSemanticToken[]): string {
  return tokens.find((item) => item.kind === "word")?.normalized ?? "";
}

function statementKind(tokens: readonly SqlSemanticToken[]): SqlSemanticStatementKind {
  const word = firstWord(tokens);
  if (word === "with" || word === "select") return "select";
  if (word === "insert") return "insert";
  if (word === "update") return "update";
  if (word === "delete") return "delete";
  if (word === "call" || word === "exec" || word === "execute") return "call";
  return "unknown";
}

function identifierPart(tokenValue: SqlSemanticToken, dialect: SqlSemanticDialectAdapter): SqlSemanticIdentifierPart {
  const quoted = tokenValue.kind === "quoted_identifier";
  const raw = unquoteSqlSemanticIdentifier(tokenValue);
  return {
    raw: tokenValue.text,
    name: dialect.normalizeIdentifier(raw, quoted),
    span: tokenValue.span,
    quote: tokenValue.quote,
  };
}

function readQualifiedName(tokens: readonly SqlSemanticToken[], startIndex: number, dialect: SqlSemanticDialectAdapter): { name: SqlSemanticQualifiedName; nextIndex: number } | null {
  const parts: SqlSemanticIdentifierPart[] = [];
  let index = startIndex;
  while (index < tokens.length) {
    const current = tokens[index];
    if (!tokenIsIdentifier(current)) break;
    parts.push(identifierPart(current, dialect));
    if (tokens[index + 1]?.text !== ".") {
      index += 1;
      break;
    }
    index += 2;
    if (dialect.id === "sqlserver") {
      while (tokens[index]?.text === ".") index += 1;
    }
  }
  if (parts.length === 0) return null;
  return {
    name: {
      parts,
      span: { start: parts[0]?.span.start ?? tokens[startIndex]?.span.start ?? 0, end: parts[parts.length - 1]?.span.end ?? tokens[startIndex]?.span.end ?? 0 },
    },
    nextIndex: index,
  };
}

function sqlServerMaintenanceTableTarget(tokens: readonly SqlSemanticToken[], target: number, introducer: string, dialect: SqlSemanticDialectAdapter): number {
  if (dialect.id !== "sqlserver" || introducer !== "update") return target;
  if (tokens[target]?.normalized === "statistics") return target + 1;
  // ASE accepts UPDATE {ALL | INDEX | TABLE} STATISTICS; these scope words
  // describe the maintenance operation and must never become table targets.
  if (SQLSERVER_UPDATE_STATISTICS_SCOPES.has(tokens[target]?.normalized ?? "") && tokens[target + 1]?.normalized === "statistics") return target + 2;
  return target;
}

function updateIntroducesMutationTarget(tokens: readonly SqlSemanticToken[], updateIndex: number): boolean {
  const update = tokens[updateIndex];
  if (update?.kind !== "word" || update.normalized !== "update") return false;
  for (let index = updateIndex - 1; index >= 0; index -= 1) {
    const item = tokens[index];
    if (!item || item.depth !== update.depth) continue;
    if (item.text === ";") break;
    if (item.kind === "word" && (item.normalized === "update" || TOP_LEVEL_STATEMENT_WORDS.has(item.normalized))) return false;
  }
  return true;
}

function commaContinuesTableList(tokens: readonly SqlSemanticToken[], commaIndex: number): boolean {
  const comma = tokens[commaIndex];
  if (comma?.text !== ",") return false;
  for (let index = commaIndex - 1; index >= 0; index -= 1) {
    const item = tokens[index];
    if (!item || item.depth !== comma.depth || item.kind !== "word") continue;
    if (item.normalized === "from") return true;
    if (item.normalized === "select" || item.normalized === "join" || TABLE_INTRODUCERS.has(item.normalized) || CLAUSE_BOUNDARIES.has(item.normalized)) return false;
  }
  return false;
}

/**
 * Finds concrete table-name tokens for visual highlighting without consulting
 * metadata. Only the final identifier in a qualified name is returned, so
 * schemas/catalogs and aliases keep the regular identifier color.
 */
export function sqlSemanticTableNameSpans(sql: string, options: SqlSemanticBuildOptions = {}): SqlSemanticSpan[] {
  const dialect = sqlSemanticDialectFor(options);
  const tokens = significantTokens(tokenizeSqlSemantic(sql, dialect.id));
  const spans: SqlSemanticSpan[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    const item = tokens[index];
    const introduced = item?.kind === "word" && TABLE_INTRODUCERS.has(item.normalized) && (item.normalized !== "update" || updateIntroducesMutationTarget(tokens, index));
    if (!introduced && !commaContinuesTableList(tokens, index)) continue;

    let target = index + 1;
    while (TABLE_TARGET_MODIFIERS.has(tokens[target]?.normalized ?? "")) target += 1;
    target = sqlServerMaintenanceTableTarget(tokens, target, item?.normalized ?? "", dialect);
    if (tokens[target]?.text === "(") continue;

    const qualified = readQualifiedName(tokens, target, dialect);
    const followedByParenthesis = qualified && tokens[qualified.nextIndex]?.text === "(";
    if (!qualified || tokens[target]?.depth !== item?.depth || (followedByParenthesis && (!introduced || TABLE_FUNCTION_INTRODUCERS.has(item.normalized)))) continue;
    const tablePart = qualified.name.parts[qualified.name.parts.length - 1];
    if (!tablePart) continue;
    const key = `${tablePart.span.start}:${tablePart.span.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push(tablePart.span);
  }

  return spans;
}

function sourceNameFromQualifiedName(name: SqlSemanticQualifiedName): { name: string; qualifierParts: string[] } {
  const parts = name.parts.map((part) => part.name);
  return {
    name: parts[parts.length - 1] ?? "",
    qualifierParts: parts.slice(0, -1),
  };
}

function findMatchingParenToken(tokens: readonly SqlSemanticToken[], openIndex: number): number {
  if (tokens[openIndex]?.text !== "(") return -1;
  const startDepth = tokens[openIndex]?.depth ?? 0;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const item = tokens[index];
    if (item?.text === ")" && item.depth === startDepth) return index;
  }
  return -1;
}

function splitTopLevelByComma(tokens: readonly SqlSemanticToken[]): SqlSemanticToken[][] {
  const groups: SqlSemanticToken[][] = [];
  let current: SqlSemanticToken[] = [];
  const baseDepth = tokens.reduce((min, item) => Math.min(min, item.depth), Number.POSITIVE_INFINITY);
  for (const item of tokens) {
    if (item.text === "," && item.depth === baseDepth) {
      groups.push(current);
      current = [];
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function projectionNameFromTokens(tokens: readonly SqlSemanticToken[], dialect: SqlSemanticDialectAdapter): SqlSemanticProjection | null {
  const useful = tokens.filter((item) => item.kind !== "comment");
  if (useful.length === 0) return null;
  let asIndex = -1;
  for (let index = useful.length - 1; index >= 0; index -= 1) {
    if (useful[index]?.kind === "word" && useful[index]?.normalized === "as") {
      asIndex = index;
      break;
    }
  }
  const aliasToken = asIndex >= 0 ? useful[asIndex + 1] : undefined;
  if (tokenIsIdentifier(aliasToken)) {
    const name = identifierPart(aliasToken, dialect).name;
    return {
      name,
      alias: name,
      aliasSpan: aliasToken.span,
      sourceExpression: useful.map((item) => item.text).join(" "),
      span: { start: useful[0]?.span.start ?? 0, end: useful[useful.length - 1]?.span.end ?? 0 },
    };
  }
  const lastIdentifier = [...useful].reverse().find(tokenIsIdentifier);
  if (!lastIdentifier) return null;
  const name = identifierPart(lastIdentifier, dialect).name;
  return {
    name,
    sourceExpression: useful.map((item) => item.text).join(" "),
    span: { start: useful[0]?.span.start ?? 0, end: useful[useful.length - 1]?.span.end ?? 0 },
  };
}

function parseSelectProjections(tokens: readonly SqlSemanticToken[], dialect: SqlSemanticDialectAdapter): SqlSemanticProjection[] {
  const baseDepth = tokens.reduce((min, item) => Math.min(min, item.depth), Number.POSITIVE_INFINITY);
  const selectDepth = Number.isFinite(baseDepth) ? baseDepth : 0;
  const selectIndex = tokens.findIndex((item) => item.depth === selectDepth && item.kind === "word" && item.normalized === "select");
  if (selectIndex < 0) return [];
  let fromIndex = tokens.findIndex((item, index) => index > selectIndex && item.depth === selectDepth && item.kind === "word" && item.normalized === "from");
  if (fromIndex < 0) fromIndex = tokens.length;
  const projectionTokens = tokens.slice(selectIndex + 1, fromIndex);
  return splitTopLevelByComma(projectionTokens)
    .map((group) => projectionNameFromTokens(group, dialect))
    .filter((projection): projection is SqlSemanticProjection => projection != null && projection.name !== "*");
}

function parseCteSources(state: ParseState): SqlSemanticRowSource[] {
  const tokens = state.tokens;
  const first = tokens.findIndex((item) => item.kind === "word" && item.normalized === "with");
  if (first < 0) return [];
  const sources: SqlSemanticRowSource[] = [];
  let index = first + 1;
  if (tokens[index]?.normalized === "recursive") index += 1;

  while (index < tokens.length) {
    while (tokens[index]?.text === ",") index += 1;
    const nameToken = tokens[index];
    if (!tokenIsIdentifier(nameToken)) break;
    const namePart = identifierPart(nameToken, state.dialect);
    index += 1;

    const explicitColumns: string[] = [];
    if (tokens[index]?.text === "(") {
      const close = findMatchingParenToken(tokens, index);
      if (close > index) {
        for (const part of splitTopLevelByComma(tokens.slice(index + 1, close))) {
          const identifier = part.find(tokenIsIdentifier);
          if (identifier) explicitColumns.push(identifierPart(identifier, state.dialect).name);
        }
        index = close + 1;
      }
    }

    if (tokens[index]?.normalized === "as") index += 1;
    if (tokens[index]?.text !== "(") break;
    const bodyOpen = index;
    const bodyClose = findMatchingParenToken(tokens, bodyOpen);
    const safeBodyClose = bodyClose < 0 ? tokens.length - 1 : bodyClose;
    const bodyTokens = tokens.slice(bodyOpen + 1, safeBodyClose);
    const bodyColumns = explicitColumns.length > 0 ? explicitColumns : parseSelectProjections(bodyTokens, state.dialect).map((projection) => projection.name);
    sources.push({
      id: `cte:${namePart.name}:${sources.length}`,
      kind: "cte",
      name: namePart.name,
      qualifierParts: [],
      sourceSpan: { start: nameToken.span.start, end: tokens[safeBodyClose]?.span.end ?? nameToken.span.end },
      columns: bodyColumns,
    });
    index = safeBodyClose + 1;

    if (tokens[index]?.text !== ",") break;
    index += 1;
  }
  return sources;
}

function correlationColumnsAfter(tokens: readonly SqlSemanticToken[], index: number, dialect: SqlSemanticDialectAdapter): { columns: string[]; nextIndex: number } | null {
  if (tokens[index]?.text !== "(") return null;
  const close = findMatchingParenToken(tokens, index);
  if (close < 0) return null;
  const columns = splitTopLevelByComma(tokens.slice(index + 1, close))
    .map((group) => group.find(tokenIsIdentifier))
    .filter((item): item is SqlSemanticToken => item != null)
    .map((item) => identifierPart(item, dialect).name);
  return { columns, nextIndex: close + 1 };
}

function aliasAfter(tokens: readonly SqlSemanticToken[], index: number, dialect: SqlSemanticDialectAdapter, options: { allowCorrelationColumns?: boolean } = {}): { alias?: string; aliasSpan?: SqlSemanticSpan; columns?: string[]; nextIndex: number } {
  let cursor = index;
  if (tokens[cursor]?.kind === "word" && tokens[cursor]?.normalized === "as") cursor += 1;
  const aliasToken = tokens[cursor];
  if (tokenIsIdentifier(aliasToken)) {
    const alias = identifierPart(aliasToken, dialect).name;
    if (!ALIAS_BLACKLIST.has(alias.toLowerCase())) {
      const columns = options.allowCorrelationColumns === false ? null : correlationColumnsAfter(tokens, cursor + 1, dialect);
      return { alias, aliasSpan: aliasToken.span, columns: columns?.columns, nextIndex: columns?.nextIndex ?? cursor + 1 };
    }
  }
  return { nextIndex: index };
}

function mergeColumnAliases(columns: readonly string[], aliases: readonly string[] | undefined): string[] {
  if (!aliases?.length) return [...columns];
  if (columns.length === 0) return [...aliases];
  return columns.map((column, index) => aliases[index] ?? column);
}

function consumeSqlServerTableHint(tokens: readonly SqlSemanticToken[], index: number, dialect: SqlSemanticDialectAdapter): number {
  if (dialect.id !== "sqlserver") return index;
  const openIndex = tokens[index]?.normalized === "with" && tokens[index + 1]?.text === "(" ? index + 1 : index;
  if (tokens[openIndex]?.text !== "(") return index;
  const close = findMatchingParenToken(tokens, openIndex);
  return close < 0 ? index : close + 1;
}

function parseSubquerySource(state: ParseState, openIndex: number, introducer: string, sourceIndex: number): { source: SqlSemanticRowSource; nextIndex: number } | null {
  const close = findMatchingParenToken(state.tokens, openIndex);
  if (close < 0) return null;
  const alias = aliasAfter(state.tokens, close + 1, state.dialect);
  if (!alias.alias) return null;
  const bodyTokens = state.tokens.slice(openIndex + 1, close);
  const columns = mergeColumnAliases(
    parseSelectProjections(bodyTokens, state.dialect).map((projection) => projection.name),
    alias.columns,
  );
  return {
    source: {
      id: `${introducer}:subquery:${sourceIndex}`,
      kind: "subquery",
      name: alias.alias,
      qualifierParts: [],
      alias: alias.alias,
      aliasSpan: alias.aliasSpan,
      sourceSpan: { start: state.tokens[openIndex]?.span.start ?? 0, end: state.tokens[alias.nextIndex - 1]?.span.end ?? alias.aliasSpan?.end ?? state.tokens[close]?.span.end ?? 0 },
      columns,
    },
    nextIndex: alias.nextIndex,
  };
}

function parseTableFunctionSource(state: ParseState, nameIndex: number, introducer: string, sourceIndex: number): { source: SqlSemanticRowSource; nextIndex: number } | null {
  const isMutationTarget = introducer === "update" || introducer === "into" || (state.statement.kind === "delete" && introducer === "from");
  if (isMutationTarget) return null;
  const qualified = readQualifiedName(state.tokens, nameIndex, state.dialect);
  if (!qualified || state.tokens[qualified.nextIndex]?.text !== "(") return null;
  const { name, qualifierParts } = sourceNameFromQualifiedName(qualified.name);
  if (state.dialect.id !== "postgres" && !TABLE_FUNCTION_NAMES.has(name.toLowerCase())) return null;
  const close = findMatchingParenToken(state.tokens, qualified.nextIndex);
  const safeClose = close < 0 ? qualified.nextIndex : close;
  let aliasIndex = safeClose + 1;
  if (state.dialect.id === "postgres" && state.tokens[aliasIndex]?.normalized === "with" && state.tokens[aliasIndex + 1]?.normalized === "ordinality") aliasIndex += 2;
  const alias = aliasAfter(state.tokens, aliasIndex, state.dialect);
  const sourceName = alias.alias ?? name;
  return {
    source: {
      id: `${introducer}:table_function:${sourceIndex}`,
      kind: "table_function",
      name: sourceName,
      qualifiedName: qualified.name,
      qualifierParts,
      alias: alias.alias,
      aliasSpan: alias.aliasSpan,
      sourceSpan: { start: qualified.name.span.start, end: state.tokens[alias.nextIndex - 1]?.span.end ?? alias.aliasSpan?.end ?? state.tokens[safeClose]?.span.end ?? qualified.name.span.end },
      columns: alias.columns,
      unresolved: close < 0,
    },
    nextIndex: alias.nextIndex,
  };
}

function parseTableSource(state: ParseState, nameIndex: number, introducer: string, sourceIndex: number): { source: SqlSemanticRowSource; nextIndex: number } | null {
  const qualified = readQualifiedName(state.tokens, nameIndex, state.dialect);
  if (!qualified) return null;
  const { name, qualifierParts } = sourceNameFromQualifiedName(qualified.name);
  const alias = aliasAfter(state.tokens, qualified.nextIndex, state.dialect, { allowCorrelationColumns: state.dialect.id !== "sqlserver" });
  const nextIndex = consumeSqlServerTableHint(state.tokens, alias.nextIndex, state.dialect);
  const cte = state.cteSources.find((source) => source.name.toLowerCase() === name.toLowerCase());
  const kind = cte ? "cte" : introducer === "update" || introducer === "into" || (state.statement.kind === "delete" && introducer === "from") ? "mutation_target" : "table";
  const source: SqlSemanticRowSource = {
    id: `${introducer}:${name}:${sourceIndex}`,
    kind,
    name,
    qualifiedName: qualified.name,
    qualifierParts,
    alias: alias.alias,
    aliasSpan: alias.aliasSpan,
    sourceSpan: { start: qualified.name.span.start, end: state.tokens[nextIndex - 1]?.span.end ?? alias.aliasSpan?.end ?? qualified.name.span.end },
    columns: cte?.columns ? mergeColumnAliases(cte.columns, alias.columns) : undefined,
    columnAliases: alias.columns,
    metadataTarget: {
      database: qualifierParts.length >= 2 ? qualifierParts[qualifierParts.length - 2] : undefined,
      schema: qualifierParts[qualifierParts.length - 1],
      table: name,
    },
  };
  return { source, nextIndex };
}

function isPostgresLateralSource(state: ParseState, target: number, introducer: string): boolean {
  if (state.dialect.id !== "postgres" || state.tokens[target]?.normalized !== "lateral" || (introducer !== "from" && introducer !== "join")) return false;
  const sourceIndex = target + 1;
  if (state.tokens[sourceIndex]?.text === "(") return true;
  const qualified = readQualifiedName(state.tokens, sourceIndex, state.dialect);
  return !!qualified && state.tokens[qualified.nextIndex]?.text === "(";
}

function parseRowSource(state: ParseState, target: number, introducer: string, sourceIndex: number): { source: SqlSemanticRowSource; nextIndex: number } | null {
  if (isPostgresLateralSource(state, target, introducer)) target += 1;
  if (state.tokens[target]?.text === "(") return parseSubquerySource(state, target, introducer, sourceIndex);
  return parseTableFunctionSource(state, target, introducer, sourceIndex) ?? parseTableSource(state, target, introducer, sourceIndex);
}

function parseRowSources(state: ParseState): SqlSemanticRowSource[] {
  const sources: SqlSemanticRowSource[] = [...state.cteSources];
  const rootDepth = state.tokens.reduce((min, item) => Math.min(min, item.depth), Number.POSITIVE_INFINITY);
  const sourceDepth = Number.isFinite(rootDepth) ? rootDepth : 0;
  let inSelectFromClause = false;
  for (let index = 0; index < state.tokens.length; index += 1) {
    const item = state.tokens[index];
    if (!item) continue;
    if (item.depth !== sourceDepth) continue;
    if (item.kind === "word") {
      if (state.statement.kind === "select" && item.normalized === "from") inSelectFromClause = true;
      else if (inSelectFromClause && FROM_CLAUSE_BOUNDARIES.has(item.normalized)) inSelectFromClause = false;
    }
    if (inSelectFromClause && item.text === ",") {
      const parsed = parseRowSource(state, index + 1, "from", sources.length);
      if (parsed) {
        sources.push(parsed.source);
        index = parsed.nextIndex - 1;
      }
      continue;
    }
    if (item.kind !== "word") continue;
    const normalized = item.normalized;
    if (!TABLE_INTRODUCERS.has(normalized)) continue;
    if (normalized === "update" && !updateIntroducesMutationTarget(state.tokens, index)) continue;
    if (JOIN_MODIFIERS.has(normalized)) continue;
    let target = index + 1;
    while (JOIN_MODIFIERS.has(state.tokens[target]?.normalized ?? "")) target += 1;
    target = sqlServerMaintenanceTableTarget(state.tokens, target, normalized, state.dialect);
    for (;;) {
      const parsed = parseRowSource(state, target, normalized, sources.length);
      if (!parsed) break;
      sources.push(parsed.source);
      index = parsed.nextIndex - 1;

      const separator = state.tokens[parsed.nextIndex];
      if (normalized !== "from" || separator?.text !== "," || separator.depth !== sourceDepth) break;
      target = parsed.nextIndex + 1;
    }
  }
  return dedupeSources(sources);
}

function dedupeSources(sources: SqlSemanticRowSource[]): SqlSemanticRowSource[] {
  const seen = new Set<string>();
  const result: SqlSemanticRowSource[] = [];
  for (const source of sources) {
    const key = `${source.kind}:${source.name}:${source.alias ?? ""}:${source.sourceSpan.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(source);
  }
  return result;
}

function clauseSpans(tokens: readonly SqlSemanticToken[]): SqlSemanticClauseSpans {
  const spans: SqlSemanticClauseSpans = {};
  const depth = tokens[0]?.depth ?? 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const item = tokens[index];
    if (!item || item.depth !== depth || item.kind !== "word") continue;
    const next = tokens[index + 1];
    const start = item.span.start;
    const end = next?.span.start ?? tokens[tokens.length - 1]?.span.end ?? item.span.end;
    if (item.normalized === "select") spans.select = { start, end };
    if (item.normalized === "from") spans.from = { start, end };
    if (item.normalized === "where") spans.where = { start, end };
    if (item.normalized === "having") spans.having = { start, end };
    if (item.normalized === "limit") spans.limit = { start, end };
    if (item.normalized === "group" && next?.normalized === "by") spans.groupBy = { start, end: next.span.end };
    if (item.normalized === "order" && next?.normalized === "by") spans.orderBy = { start, end: next.span.end };
    if (item.normalized === "set") spans.updateSet = { start, end };
  }
  return spans;
}

function trailingIdentifier(tokens: readonly SqlSemanticToken[], cursor: number, dialect: SqlSemanticDialectAdapter): TrailingIdentifier {
  const before = tokens.filter((item) => item.span.start < cursor && item.kind !== "comment" && item.kind !== "string");
  const last = before[before.length - 1];
  if (!last) return { prefix: "", replacementRange: { start: cursor, end: cursor }, qualifierParts: [] };
  if (last.span.end < cursor && last.text !== ".") {
    return { prefix: "", replacementRange: { start: cursor, end: cursor }, qualifierParts: [] };
  }

  let prefix = "";
  let replacementRange: SqlSemanticSpan = { start: cursor, end: cursor };
  let index = before.length - 1;
  let hasQualifier = false;
  if (tokenIsIdentifier(last) && cursor <= last.span.end) {
    const rawPrefix = tokenTextAt(last.text, { start: 0, end: Math.max(0, cursor - last.span.start) });
    prefix = last.kind === "quoted_identifier" ? unquoteSqlSemanticIdentifier({ ...last, text: rawPrefix.endsWith(last.quote ?? "") ? rawPrefix : rawPrefix + (last.quote === "[" ? "]" : (last.quote ?? "")) }) : rawPrefix;
    replacementRange = { start: last.span.start, end: cursor };
    index -= 1;
    if (before[index]?.text === ".") {
      hasQualifier = true;
      index -= 1;
    }
  } else if (last.text === ".") {
    hasQualifier = true;
    index -= 1;
  }

  const qualifierParts: string[] = [];
  if (hasQualifier) {
    while (index >= 0) {
      const identifier = before[index];
      if (!tokenIsIdentifier(identifier)) break;
      qualifierParts.unshift(identifierPart(identifier, dialect).name);
      if (before[index - 1]?.text !== ".") break;
      index -= 2;
    }
  }

  return { prefix, replacementRange, qualifierParts };
}

function previousWord(tokens: readonly SqlSemanticToken[], cursor: number): string {
  const before = tokens.filter((item) => item.span.end <= cursor && item.kind === "word");
  return before[before.length - 1]?.normalized ?? "";
}

function wordBeforePosition(tokens: readonly SqlSemanticToken[], position: number): string {
  const before = tokens.filter((item) => item.span.end <= position && item.kind === "word");
  return before[before.length - 1]?.normalized ?? "";
}

function isTableListContinuation(tokens: readonly SqlSemanticToken[], position: number): boolean {
  const before = tokens.filter((item) => item.span.end <= position && item.kind !== "comment");
  const commaIndex = before.length - 1;
  const comma = before[commaIndex];
  if (comma?.text !== ",") return false;
  const depth = comma.depth;
  for (let index = commaIndex - 1; index >= 0; index -= 1) {
    const token = before[index];
    if (!token || token.depth !== depth || token.kind !== "word") continue;
    if (TABLE_INTRODUCERS.has(token.normalized) || token.normalized === "from" || token.normalized === "join") return true;
    if (CLAUSE_BOUNDARIES.has(token.normalized) || token.normalized === "select") return false;
  }
  return false;
}

function hasWordBefore(tokens: readonly SqlSemanticToken[], cursor: number, word: string): boolean {
  return tokens.some((item) => item.span.end <= cursor && item.kind === "word" && item.normalized === word);
}

function isBeforeWord(tokens: readonly SqlSemanticToken[], cursor: number, word: string): boolean {
  const target = tokens.find((item) => item.span.start >= cursor && item.kind === "word" && item.normalized === word);
  return !!target;
}

function sourceForQualifier(sources: readonly SqlSemanticRowSource[], qualifierParts: readonly string[]): SqlSemanticRowSource | undefined {
  const qualifier = qualifierParts[qualifierParts.length - 1]?.toLowerCase();
  if (!qualifier) return undefined;
  return sources.find((source) => source.alias?.toLowerCase() === qualifier || source.name.toLowerCase() === qualifier);
}

function starQualifierParts(before: readonly SqlSemanticToken[], starIndex: number, dialect: SqlSemanticDialectAdapter): string[] {
  let index = starIndex - 1;
  if (before[index]?.text === ".") index -= 1;
  const qualifierParts: string[] = [];
  while (index >= 0) {
    const identifier = before[index];
    if (!tokenIsIdentifier(identifier)) break;
    qualifierParts.unshift(identifierPart(identifier, dialect).name);
    if (before[index - 1]?.text !== ".") break;
    index -= 2;
  }
  return qualifierParts;
}

function buildCursorIntent(tokens: readonly SqlSemanticToken[], cursor: number, sources: readonly SqlSemanticRowSource[], dialect: SqlSemanticDialectAdapter, suppressed: boolean, kind: SqlSemanticStatementKind): SqlSemanticCursorIntent {
  if (suppressed) {
    return { kind: "suppressed", prefix: "", replacementRange: { start: cursor, end: cursor }, qualifierParts: [], expectedObjectKinds: [], confidence: "high", fallbackReason: "comment_or_string" };
  }
  const trailing = trailingIdentifier(tokens, cursor, dialect);
  const previous = previousWord(tokens, cursor);
  const targetSource = sourceForQualifier(sources, trailing.qualifierParts);
  const before = tokens.filter((item) => item.span.end <= cursor);
  const last = before[before.length - 1];
  const wordBeforeReplacement = wordBeforePosition(tokens, trailing.replacementRange.start);
  const tableListContinuation = isTableListContinuation(tokens, trailing.replacementRange.start);

  if (last?.text === "*" || trailing.prefix === "*") {
    const starIndex = last?.text === "*" ? before.length - 1 : -1;
    const qualifierParts = starIndex >= 0 ? starQualifierParts(before, starIndex, dialect) : trailing.qualifierParts;
    const starTarget = sourceForQualifier(sources, qualifierParts);
    const replacementRange = last?.text === "*" ? { start: last.span.start, end: Math.min(cursor, last.span.end) } : trailing.replacementRange;
    return { kind: "star", prefix: "*", replacementRange, qualifierParts, targetSourceId: starTarget?.id, expectedObjectKinds: ["column"], confidence: "high" };
  }

  if (kind === "call") {
    return { kind: "routine", prefix: trailing.prefix, replacementRange: trailing.replacementRange, qualifierParts: trailing.qualifierParts, expectedObjectKinds: ["routine", "procedure", "function"], confidence: "high" };
  }

  if (kind === "insert" && hasWordBefore(tokens, cursor, "into") && !hasWordBefore(tokens, cursor, "values")) {
    const mutationTarget = sources.find((source) => source.kind === "mutation_target");
    return {
      kind: "insert_column",
      prefix: trailing.prefix,
      replacementRange: trailing.replacementRange,
      qualifierParts: trailing.qualifierParts,
      targetSourceId: mutationTarget?.id,
      expectedObjectKinds: ["column"],
      confidence: mutationTarget ? "medium" : "low",
      fallbackReason: mutationTarget ? undefined : "unresolved_insert_target",
    };
  }

  if (
    trailing.qualifierParts.length > 0 &&
    (previous === "from" ||
      previous === "join" ||
      TABLE_INTRODUCERS.has(previous) ||
      TABLE_INTRODUCERS.has(wordBeforeReplacement) ||
      (!!targetSource && !targetSource.alias && trailing.replacementRange.start <= targetSource.sourceSpan.end + 1 && TABLE_INTRODUCERS.has(wordBeforePosition(tokens, targetSource.sourceSpan.start))))
  ) {
    const role = dialect.qualifierRole(trailing.qualifierParts, "table");
    return { kind: role === "catalog" ? "catalog" : "table", prefix: trailing.prefix, replacementRange: trailing.replacementRange, qualifierParts: trailing.qualifierParts, expectedObjectKinds: ["table", "view"], confidence: "medium" };
  }

  if (trailing.qualifierParts.length > 0 && targetSource) {
    return { kind: "alias_column", prefix: trailing.prefix, replacementRange: trailing.replacementRange, qualifierParts: trailing.qualifierParts, targetSourceId: targetSource.id, expectedObjectKinds: ["column"], confidence: "high" };
  }

  if (TABLE_INTRODUCERS.has(previous) || TABLE_INTRODUCERS.has(wordBeforeReplacement) || previous === "from" || previous === "join" || wordBeforeReplacement === "from" || wordBeforeReplacement === "join" || tableListContinuation) {
    return { kind: previous === "join" ? "table" : "table", prefix: trailing.prefix, replacementRange: trailing.replacementRange, qualifierParts: trailing.qualifierParts, expectedObjectKinds: ["table", "view"], confidence: "high" };
  }

  if (previous === "call" || previous === "exec" || previous === "execute") {
    return { kind: "routine", prefix: trailing.prefix, replacementRange: trailing.replacementRange, qualifierParts: trailing.qualifierParts, expectedObjectKinds: ["routine", "procedure", "function"], confidence: "high" };
  }

  if (previous === "set") {
    return {
      kind: "update_column",
      prefix: trailing.prefix,
      replacementRange: trailing.replacementRange,
      qualifierParts: trailing.qualifierParts,
      expectedObjectKinds: ["column"],
      confidence: sources.length > 0 ? "medium" : "low",
      fallbackReason: sources.length > 0 ? undefined : "unresolved_update_target",
    };
  }

  if (["where", "on", "and", "or", "having", "by", "select"].includes(previous) && sources.length > 0 && !isBeforeWord(tokens, cursor, "from")) {
    return { kind: previous === "on" ? "join_condition" : "column", prefix: trailing.prefix, replacementRange: trailing.replacementRange, qualifierParts: trailing.qualifierParts, expectedObjectKinds: ["column"], confidence: "medium" };
  }

  return { kind: "keyword", prefix: trailing.prefix, replacementRange: trailing.replacementRange, qualifierParts: trailing.qualifierParts, expectedObjectKinds: [], confidence: "low", fallbackReason: "keyword_context" };
}

function buildScope(statement: SqlSemanticStatement, rowSources: SqlSemanticRowSource[], projections: SqlSemanticProjection[], tokens: SqlSemanticToken[]): SqlSemanticScope {
  return {
    id: "root",
    kind: statement.kind,
    span: statement.span,
    rowSources,
    projections,
    clauseSpans: clauseSpans(tokens),
  };
}

export function buildSqlSemanticModel(sql: string, cursor: number, options: SqlSemanticBuildOptions = {}): SqlSemanticModel {
  const safeCursor = Math.max(0, Math.min(cursor, sql.length));
  const dialect = sqlSemanticDialectFor(options);
  const allTokens = tokenizeSqlSemantic(sql, dialect.id);
  const statementSpan = findActiveSqlStatementSpan(sql, allTokens, safeCursor);
  const tokens = significantTokens(allTokens.filter((item) => item.span.end > statementSpan.start && item.span.start < statementSpan.end));
  const kind = statementKind(tokens);
  const statement: SqlSemanticStatement = {
    kind,
    span: statementSpan,
    text: sql.slice(statementSpan.start, statementSpan.end),
  };
  const suppressed = isSuppressedSqlSemanticContext(allTokens, safeCursor);
  const parseState: ParseState = { dialect, tokens, statement, cteSources: [] };
  parseState.cteSources = parseCteSources(parseState);
  const rowSources = parseRowSources(parseState);
  const projections = parseSelectProjections(tokens, dialect);
  const cursorIntent = buildCursorIntent(tokens, safeCursor, rowSources, dialect, suppressed, kind);
  const scopes = [buildScope(statement, rowSources, projections, tokens)];
  return {
    databaseType: options.databaseType,
    dialectId: dialect.id,
    sql,
    cursor: safeCursor,
    statement,
    tokens: allTokens,
    scopes,
    rowSources,
    projections,
    cursorIntent,
    diagnostics: [],
  };
}
