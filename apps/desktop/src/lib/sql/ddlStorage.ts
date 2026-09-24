import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";
import type { DatabaseType } from "@/types/database";

type DdlRemoval = { start: number; end: number };
type DdlTokenRemoval = { startIndex: number; endIndex: number };

/**
 * Database types whose generated DDL carries physical storage attributes that the
 * "exclude storage attributes" preference strips. OceanBase Oracle emits its own
 * table options; `oracle` covers both the native Oracle agent and the JDBC Oracle
 * plugin, whose `DBMS_METADATA.GET_DDL` output is the same.
 */
export function supportsDdlStoragePreference(databaseType: DatabaseType | undefined): boolean {
  return databaseType === "oceanbase-oracle" || databaseType === "oracle";
}

/** Remove only known storage attributes from a DDL source, keeping the cached source intact. */
export function applyDdlStoragePreference(sql: string, databaseType: DatabaseType | undefined, excludeStorage = true): string {
  if (!excludeStorage) return sql;
  if (databaseType === "oceanbase-oracle") return stripOceanBaseOracleStorageOptions(sql);
  if (databaseType === "oracle") return stripOracleStorageAttributes(sql);
  return sql;
}

function tokenizeDdl(sql: string): SqlSemanticToken[] | null {
  const tokens = tokenizeSqlSemantic(sql, "oracle");
  return tokens.some((token) => token.closed === false) ? null : tokens;
}

function spliceRemovals(sql: string, removals: DdlRemoval[]): string {
  let result = sql;
  for (const { start, end } of removals.reverse()) result = result.slice(0, start) + result.slice(end);
  return result;
}

/** Characters that would merge into a neighbouring token if the gap between them went away. */
const TOKEN_CHARACTER = /[A-Za-z0-9_$#"]/;
/** Punctuation that reads better glued to the surviving text than separated by a space. */
const TIGHT_AFTER_REMOVAL = new Set([";", ","]);

/** Whether the two surviving characters need a space between them once a clause is out. */
function needsRemovalSeparator(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  if (TIGHT_AFTER_REMOVAL.has(after) || before === "(" || after === ")") return false;
  return TOKEN_CHARACTER.test(before) || TOKEN_CHARACTER.test(after);
}

/**
 * Splice out whole-token clause spans, absorbing the whitespace around each one and
 * merging neighbours, so a dropped clause leaves neither a blank line nor a double
 * space behind. Only inter-token whitespace is absorbed — strings, identifiers and
 * comments are never touched — and one space is kept wherever removing it would glue
 * the surviving tokens together.
 */
function spliceTightRemovals(sql: string, tokens: readonly SqlSemanticToken[], removals: DdlTokenRemoval[]): string {
  const merged: DdlRemoval[] = [];
  for (const { startIndex, endIndex } of removals) {
    const previousEnd = startIndex > 0 ? tokens[startIndex - 1]!.span.end : 0;
    const nextStart = endIndex + 1 < tokens.length ? tokens[endIndex + 1]!.span.start : sql.length;
    const start = /^\s*$/.test(sql.slice(previousEnd, tokens[startIndex]!.span.start)) ? previousEnd : tokens[startIndex]!.span.start;
    const end = /^\s*$/.test(sql.slice(tokens[endIndex]!.span.end, nextStart)) ? nextStart : tokens[endIndex]!.span.end;
    const last = merged[merged.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  let result = "";
  let cursor = 0;
  for (const { start, end } of merged) {
    result += sql.slice(cursor, start);
    if (needsRemovalSeparator(sql[start - 1], sql[end])) result += " ";
    cursor = end;
  }
  return result + sql.slice(cursor);
}

/** Index of the `)` closing the `(` at `openIndex`, or null when it is unclosed. */
function matchClosingParen(tokens: readonly SqlSemanticToken[], openIndex: number): number | null {
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === "(") i = matchClosingParen(tokens, i) ?? tokens.length;
    else if (token.text === ")") return i;
  }
  return null;
}

/** Remove only known OceanBase table storage options, keeping the cached source intact. */
function stripOceanBaseOracleStorageOptions(sql: string): string {
  const tokens = tokenizeDdl(sql);
  if (!tokens) return sql;
  const removals: DdlRemoval[] = [];
  let table = false;
  let options = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.depth !== 0) continue;
    if (token.text === ";") {
      table = options = false;
      continue;
    }
    if (token.kind === "word" && token.normalized === "create") {
      const offset = tokens[i + 1]?.normalized === "global" && tokens[i + 2]?.normalized === "temporary" ? 3 : 1;
      table = tokens[i + offset]?.normalized === "table";
      options = false;
    }
    if (!table) continue;
    if (token.text === ")") options = true;
    if (!options || token.kind !== "word") continue;
    // Partition expressions and bounds must never be treated as table options.
    if (token.normalized === "partition") {
      table = options = false;
      continue;
    }
    let last = i;
    if (token.normalized === "compress" && tokens[i + 1]?.normalized === "for" && tokens[i + 2]?.normalized === "archive") {
      last = i + 2;
      if (["high", "low"].includes(tokens[last + 1]?.normalized ?? "")) last++;
    } else if (token.normalized === "nocompress") {
      last = i;
    } else if (["replica_num", "block_size", "tablet_size", "pctfree", "use_bloom_filter"].includes(token.normalized)) {
      const valueIndex = tokens[i + 1]?.text === "=" ? i + 2 : i + 1;
      const value = tokens[valueIndex];
      const valid = token.normalized === "use_bloom_filter" ? value?.kind === "word" && ["true", "false"].includes(value.normalized) : value?.kind === "number" && /^\d+$/.test(value.text);
      if (!valid) continue;
      last = valueIndex;
    } else continue;
    removals.push({ start: token.span.start, end: tokens[last]!.span.end });
    i = last;
  }
  return spliceRemovals(sql, removals);
}

/** Clause keywords whose only operand is a bare number, so they are unambiguous. */
const ORACLE_NUMERIC_STORAGE_CLAUSES = new Set(["pctfree", "pctused", "initrans", "maxtrans", "pctthreshold"]);
/** Clause keywords that take no operand and therefore need a context guard. */
const ORACLE_BARE_STORAGE_CLAUSES = new Set(["logging", "nologging", "monitoring", "nomonitoring", "parallel", "noparallel"]);
/** Words that may be followed by an unquoted identifier, i.e. by a partition name. */
const ORACLE_IDENTIFIER_LEAD_WORDS = new Set(["partition", "subpartition"]);
/** Words allowed between `CREATE` and the object keyword it introduces. */
const ORACLE_CREATE_MODIFIERS = new Set(["or", "replace", "force", "global", "temporary", "private", "public", "unique", "bitmap"]);
const ORACLE_LOB_STORAGE_TYPES = new Set(["basicfile", "securefile"]);

function isIdentifierToken(token: SqlSemanticToken | undefined): boolean {
  return token?.kind === "word" || token?.kind === "quoted_identifier";
}

/**
 * End index of a `LOB (…) STORE AS [BASICFILE|SECUREFILE] (…)` clause, or null when the
 * tokens are something else. `DBMS_METADATA` resolves the whole clause against the
 * storage clause and Oracle's own `SEGMENT_ATTRIBUTES=FALSE` transform drops it the
 * same way, so the column name list goes with the storage attributes.
 */
function oracleLobStorageClauseEnd(tokens: readonly SqlSemanticToken[], index: number): number | null {
  if (tokens[index + 1]?.text !== "(") return null;
  const columnListEnd = matchClosingParen(tokens, index + 1);
  if (columnListEnd === null) return null;
  if (tokens[columnListEnd + 1]?.normalized !== "store" || tokens[columnListEnd + 2]?.normalized !== "as") return null;
  let cursor = columnListEnd + 3;
  if (ORACLE_LOB_STORAGE_TYPES.has(tokens[cursor]?.normalized ?? "")) cursor++;
  if (tokens[cursor]?.text !== "(") return null;
  return matchClosingParen(tokens, cursor);
}

/**
 * End index of the storage clause starting at `index`, or null when no clause starts
 * there. `previous` is the last significant token before it, which only the
 * operand-less keywords need: inside a column list or a partition definition the same
 * word is an identifier, never a clause.
 */
function oracleStorageClauseEnd(tokens: readonly SqlSemanticToken[], index: number, previous: SqlSemanticToken | undefined): number | null {
  const token = tokens[index]!;
  if (token.kind !== "word") return null;
  const keyword = token.normalized;
  const next = tokens[index + 1];
  if (ORACLE_NUMERIC_STORAGE_CLAUSES.has(keyword)) return next?.kind === "number" ? index + 1 : null;
  if (keyword === "storage") return next?.text === "(" ? matchClosingParen(tokens, index + 1) : null;
  if (keyword === "tablespace") return isIdentifierToken(next) ? index + 1 : null;
  // Deprecated index statistics clause; `SEGMENT_ATTRIBUTES=FALSE` drops it as well.
  if (keyword === "compute" && next?.normalized === "statistics") return index + 1;
  if (keyword === "segment") {
    return next?.normalized === "creation" && ["immediate", "deferred"].includes(tokens[index + 2]?.normalized ?? "") ? index + 2 : null;
  }
  if (keyword === "lob") return oracleLobStorageClauseEnd(tokens, index);
  if (!ORACLE_BARE_STORAGE_CLAUSES.has(keyword)) return null;
  if (keyword === "parallel" && next?.kind === "number") return index + 1;
  if (previous?.text === "(" || previous?.text === ",") return null;
  if (previous?.kind === "word" && ORACLE_IDENTIFIER_LEAD_WORDS.has(previous.normalized)) return null;
  return index;
}

/** Whether the `CREATE` at `index` introduces a relation whose DDL carries table options. */
function oracleCreatedRelation(tokens: readonly SqlSemanticToken[], index: number): boolean {
  let materialized = false;
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word") return false;
    if (token.normalized === "table" || token.normalized === "index") return true;
    if (token.normalized === "materialized") materialized = true;
    else if (token.normalized === "view") return materialized;
    else if (!ORACLE_CREATE_MODIFIERS.has(token.normalized)) return false;
  }
  return false;
}

/**
 * Strip the physical storage attributes `DBMS_METADATA.GET_DDL` emits — the same set
 * Oracle's `SEGMENT_ATTRIBUTES=FALSE` transform excludes — from table, index and
 * materialized-view DDL: PCTFREE/PCTUSED/INITRANS/MAXTRANS/PCTTHRESHOLD, `STORAGE(…)`,
 * `TABLESPACE`, `LOGGING`, `SEGMENT CREATION`, the attributes of a `USING INDEX`
 * constraint clause and LOB storage clauses. Columns, constraints, partitioning and
 * `COMPRESS` are preserved, and quoted identifiers never match a clause.
 */
function stripOracleStorageAttributes(sql: string): string {
  const tokens = tokenizeDdl(sql);
  if (!tokens) return sql;
  const removals: DdlTokenRemoval[] = [];
  let createsRelation = false;
  let inRelationOptions = false;
  let usingIndexDepth: number | null = null;
  let previous: SqlSemanticToken | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "comment") continue;
    if (token.depth === 0) {
      if (token.text === ";") {
        createsRelation = false;
        inRelationOptions = false;
        usingIndexDepth = null;
      } else if (token.kind === "word" && token.normalized === "create") {
        createsRelation = oracleCreatedRelation(tokens, i);
        inRelationOptions = false;
      } else if (createsRelation && token.text === ")") {
        // The storage options follow the column list of the relation.
        inRelationOptions = true;
      } else if (createsRelation && token.kind === "word" && token.normalized === "as") {
        // `CREATE TABLE/… AS SELECT`: the query body is not a storage options region.
        createsRelation = false;
        inRelationOptions = false;
      }
    }
    if (usingIndexDepth !== null) {
      const endsClause = token.depth === usingIndexDepth && ((token.kind === "word" && (token.normalized === "enable" || token.normalized === "disable")) || token.text === "," || token.text === ";");
      if (token.depth < usingIndexDepth || endsClause) usingIndexDepth = null;
    }
    if (token.kind === "word" && token.normalized === "using" && tokens[i + 1]?.normalized === "index") {
      usingIndexDepth = token.depth;
    }
    const inStorageRegion = inRelationOptions || (usingIndexDepth !== null && token.depth >= usingIndexDepth);
    const clauseEnd = inStorageRegion ? oracleStorageClauseEnd(tokens, i, previous) : null;
    if (clauseEnd !== null) {
      removals.push({ startIndex: i, endIndex: clauseEnd });
      previous = tokens[clauseEnd];
      i = clauseEnd;
      continue;
    }
    previous = token;
  }
  return spliceTightRemovals(sql, tokens, removals);
}
