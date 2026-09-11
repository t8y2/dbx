import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import { sqlSemanticQueryBlockSources, type SqlSemanticGroupedSourceScope } from "@/lib/sql/semantic/model";
import { tokenizeSqlSemantic, tokenIsIdentifier, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticBuildOptions, SqlSemanticSpan, SqlSemanticToken } from "@/lib/sql/semantic/types";

export interface SqlAliasHighlightGroup {
  declaration: SqlSemanticSpan;
  qualifiers: SqlSemanticSpan[];
  references: SqlSemanticSpan[];
}

interface QueryBlock {
  start: number;
  end: number;
  depth: number;
  parent?: QueryBlock;
  aliases: Map<string, SqlAliasHighlightGroup | null>;
  sources: SqlSemanticSpan[];
}

const SET_OPERATORS = new Set(["union", "intersect", "except"]);
// MySQL aliases and SQL Server default collations compare identifiers case-insensitively.
const CASE_INSENSITIVE_ALIAS_DIALECTS = new Set(["mysql", "sqlserver", "sqlite"]);
export const MAX_ALIAS_HIGHLIGHT_SQL_LENGTH = 128 * 1024;

function lastBlock(blocks: QueryBlock[], predicate: (block: QueryBlock) => boolean): QueryBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (predicate(blocks[index])) return blocks[index];
  }
  return undefined;
}

/** Input is a single statement; all returned spans are relative to that statement. */
export function sqlAliasHighlightGroups(sql: string, options: SqlSemanticBuildOptions = {}): SqlAliasHighlightGroup[] {
  if (sql.length > MAX_ALIAS_HIGHLIGHT_SQL_LENGTH) return [];
  const dialect = sqlSemanticDialectFor(options);
  const allTokens = tokenizeSqlSemantic(sql, dialect.id, {
    mysqlDashCommentRequiresWhitespace: dialect.id === "mysql",
    mysqlBackslashEscape: dialect.id === "mysql",
    mysqlDoubleQuoteIsString: dialect.id === "mysql",
  });
  if (allTokens.some((token) => token.closed === false)) return [];
  const tokens = allTokens.filter((token) => token.kind !== "comment");
  if (tokens.length > 20_000) return [];
  let parentheses = 0;
  for (const token of tokens) {
    if (token.text === "(") parentheses++;
    if (token.text === ")" && --parentheses < 0) return [];
  }
  if (parentheses !== 0) return [];
  const tokensByStart = new Map(tokens.map((token) => [token.span.start, token]));
  const nameOf = (token: SqlSemanticToken) => {
    const name = dialect.normalizeIdentifier(unquoteSqlSemanticIdentifier(token), token.kind === "quoted_identifier");
    // These dialects compare even quoted identifiers case-insensitively for ASCII letters.
    // Keep the spelling normalizer unchanged, and preserve other dialects' quote and case semantics.
    return CASE_INSENSITIVE_ALIAS_DIALECTS.has(dialect.id) ? name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : name;
  };
  const blocks: QueryBlock[] = [];
  const groups: SqlAliasHighlightGroup[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== "word" || token.normalized !== "select") continue;
    if (blocks.length >= 128) return [];
    let end = index + 1;
    while (end < tokens.length) {
      const next = tokens[end];
      if (next.depth < token.depth || next.text === ";" || (next.depth === token.depth && next.kind === "word" && SET_OPERATORS.has(next.normalized))) break;
      end++;
    }
    const groupedScopes: SqlSemanticGroupedSourceScope[] = [];
    const sources = sqlSemanticQueryBlockSources(tokens.slice(index, end), options, groupedScopes);
    const scopes = [
      { start: index, end, depth: token.depth, sources },
      ...groupedScopes.map((scope) => ({
        start: tokens.findIndex((candidate) => candidate.span.start >= scope.span.start),
        end: tokens.findIndex((candidate) => candidate.span.start >= scope.span.end),
        depth: scope.depth,
        sources: scope.sources,
      })),
    ];
    for (const scope of scopes) {
      if (scope.start < 0 || scope.end <= scope.start) continue;
      if (blocks.length >= 128) return [];
      const block: QueryBlock = { start: scope.start, end: scope.end, depth: scope.depth, aliases: new Map(), sources: [] };
      for (const source of scope.sources) {
        // Only exclude the source name itself; table-function arguments can reference aliases.
        if (source.qualifiedName) block.sources.push(source.qualifiedName.span);
        if (!source.aliasSpan) {
          // An unaliased local table also hides an outer alias with the same name.
          const parts = source.qualifiedName?.parts;
          const localName = parts?.[parts.length - 1];
          const localToken = localName && tokensByStart.get(localName.span.start);
          if (localToken) block.aliases.set(nameOf(localToken), null);
          continue;
        }
        const declaration = tokensByStart.get(source.aliasSpan.start);
        if (!declaration) continue;
        const key = nameOf(declaration);
        const group: SqlAliasHighlightGroup = { declaration: source.aliasSpan, qualifiers: [], references: [] };
        if (block.aliases.has(key)) block.aliases.set(key, null);
        else block.aliases.set(key, group);
      }
      blocks.push(block);
    }
  }

  // Group scopes can be discovered before their nested SELECTs. Establish containment only
  // after collecting all scopes so inner names never leak into the enclosing query.
  blocks.sort((left, right) => left.start - right.start || right.end - left.end);
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    block.parent = lastBlock(blocks.slice(0, index), (candidate) => candidate.depth < block.depth && candidate.start <= block.start && candidate.end >= block.end);
  }

  for (let index = 0; index + 2 < tokens.length; index++) {
    const qualifier = tokens[index];
    const column = tokens[index + 2];
    if (!tokenIsIdentifier(qualifier) || tokens[index + 1].text !== "." || (column.text !== "*" && !tokenIsIdentifier(column))) continue;
    // Do not mistake schema.table.column or a qualified function call for alias.column.
    if (tokens[index - 1]?.text === "." || tokens[index + 3]?.text === "." || tokens[index + 3]?.text === "(") continue;
    const block = lastBlock(blocks, (candidate) => candidate.start <= index && index < candidate.end);
    if (!block || block.sources.some((span) => span.start <= qualifier.span.start && column.span.end <= span.end)) continue;
    const key = nameOf(qualifier);
    let owner: QueryBlock | undefined = block;
    while (owner && !owner.aliases.has(key)) owner = owner.parent;
    const group = owner?.aliases.get(key);
    if (!group) continue;
    group.qualifiers.push(qualifier.span);
    group.references.push({ start: qualifier.span.start, end: column.span.end });
  }
  for (const block of blocks) {
    // Keep unreferenced declarations too: the caller still highlights the declaration itself
    // when the cursor sits on it. Only shadowed (null) entries produce no spans at all.
    for (const group of block.aliases.values()) if (group) groups.push(group);
  }
  return groups;
}
