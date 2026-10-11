import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";
import type { DatabaseType } from "@/types/database";

function isMysqlDdl(databaseType: DatabaseType): boolean {
  return databaseType === "mysql" || databaseType === "goldendb";
}

function tokensForDdl(sql: string, databaseType: DatabaseType): SqlSemanticToken[] {
  const dialect = isMysqlDdl(databaseType) ? "mysql" : sqlFormatDialectForDbType(databaseType);
  return tokenizeSqlSemantic(sql, dialect, { mysqlBackslashEscape: dialect === "mysql", mysqlDashCommentRequiresWhitespace: dialect === "mysql" }).filter((token) => token.kind !== "comment");
}

function identifier(token?: SqlSemanticToken): string | undefined {
  if (token?.kind === "word") return token.text;
  if (token?.kind === "quoted_identifier") return unquoteSqlSemanticIdentifier(token);
  return undefined;
}

function word(token: SqlSemanticToken | undefined, value: string): boolean {
  return token?.kind === "word" && token.normalized === value;
}

function readName(tokens: SqlSemanticToken[], start: number): SqlSemanticToken[] {
  if (identifier(tokens[start]) === undefined) return [];
  const parts = [tokens[start]!];
  for (let index = start + 1; tokens[index]?.text === "." && identifier(tokens[index + 1]) !== undefined; index += 2) parts.push(tokens[index + 1]!);
  return parts;
}

/** Check the actual MySQL table option, never ENGINE-like text in a comment or column. */
export function transactionalMysqlTableDdl(ddl: string): boolean {
  for (const range of splitSqlStatementRanges(ddl, "mysql")) {
    const tokens = tokensForDdl(range.sql, "mysql");
    if (!word(tokens[0], "create") || tokens.some((token) => token.closed === false)) continue;
    const table = tokens.findIndex((token) => word(token, "table") && token.depth === 0);
    const close = tokens.findIndex((token, index) => index > table && token.text === ")" && token.depth === 0);
    if (table < 0 || close < 0) continue;
    const engines: string[] = [];
    for (let index = close + 1; index < tokens.length; index += 1) {
      if (tokens[index]!.depth !== 0 || !word(tokens[index], "engine")) continue;
      let value = index + 1;
      if (tokens[value]?.text === "=") value += 1;
      const token = tokens[value];
      const name = token?.kind === "string" ? token.text.slice(1, -1).replaceAll("''", "'") : identifier(token);
      if (!name) return false;
      engines.push(name.toLowerCase());
    }
    return engines.length === 1 && engines[0] === "innodb";
  }
  return false;
}

function columnDefinitions(ddl: string, databaseType: DatabaseType): SqlSemanticToken[][] {
  const definitions: SqlSemanticToken[][] = [];
  const constraints = new Set(["primary", "key", "unique", "constraint", "check", "foreign", "index", "fulltext", "spatial", "period"]);
  for (const range of splitSqlStatementRanges(ddl, databaseType)) {
    const tokens = tokensForDdl(range.sql, databaseType);
    if (!word(tokens[0], "create")) continue;
    const tableIndex = tokens.findIndex((token) => word(token, "table") && token.depth === 0);
    if (tableIndex < 0) continue;
    const openIndex = tokens.findIndex((token, index) => index > tableIndex && token.text === "(" && token.depth === 0);
    if (openIndex < 0) continue;
    let start = openIndex + 1;
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const end = token.text === ")" && token.depth === 0;
      if (!end && !(token.text === "," && token.depth === 1)) continue;
      const definition = tokens.slice(start, index);
      const first = definition[0];
      if (identifier(first) !== undefined && !(first?.kind === "word" && constraints.has(first.normalized))) definitions.push(definition);
      if (end) break;
      start = index + 1;
    }
  }
  return definitions;
}

function definitionWords(definition: SqlSemanticToken[]): string[] {
  // An AS inside DEFAULT CAST(...) is not a computed-column declaration.
  return definition
    .slice(1)
    .filter((token) => token.depth === 1 && token.kind === "word")
    .map((token) => token.normalized);
}

/** A DDL declaration carries the target precision that result/column metadata can omit. */
export function temporalColumnTypesFromDdl(ddl: string, databaseType: DatabaseType): Map<string, string | null> {
  const types = new Map<string, string | null>();
  // SQLite does not enforce temporal precision in a column declaration.
  if (databaseType === "sqlite") return types;
  const temporalNames = new Set(["date", "time", "timetz", "timestamp", "timestamptz", "datetime", "datetime2", "datetimeoffset", "smalldatetime"]);
  for (const definition of columnDefinitions(ddl, databaseType)) {
    const name = identifier(definition[0])!;
    const typeToken = definition[1];
    const base = identifier(typeToken)?.toLowerCase();
    if (!base || !temporalNames.has(base) || (typeToken?.kind !== "word" && databaseType !== "sqlserver") || definition[2]?.text === ".") continue;
    if (databaseType === "sqlserver" && base === "timestamp") continue; // rowversion
    let index = 2;
    let precision: number | undefined;
    if (definition[index]?.text === "(") {
      if (!/^\d+$/.test(definition[index + 1]?.text ?? "") || definition[index + 2]?.text !== ")") {
        types.set(name, null);
        continue;
      }
      precision = Number(definition[index + 1]!.text);
      index += 3;
    }
    let zone = "";
    if (word(definition[index], "with") || word(definition[index], "without")) {
      const start = index++;
      if (word(definition[index], "local")) index += 1;
      if (!word(definition[index], "time") || !word(definition[index + 1], "zone")) {
        types.set(name, null);
        continue;
      }
      index += 2;
      zone =
        " " +
        definition
          .slice(start, index)
          .map((token) => token.text.toUpperCase())
          .join(" ");
    }
    // Preserve the array type for the array serializer instead of replacing it with a scalar.
    if (definition[index]?.text.startsWith("[") || word(definition[index], "array")) continue;
    if (["date", "smalldatetime"].includes(base) || (databaseType === "sqlserver" && base === "datetime")) {
      types.set(name, base.toUpperCase());
      continue;
    }
    if (precision === undefined) {
      if (isMysqlDdl(databaseType)) precision = 0;
      else if (["postgres", "kingbase", "highgo", "vastbase"].includes(databaseType)) precision = 6;
      else if (databaseType === "sqlserver" && ["time", "datetime2", "datetimeoffset"].includes(base)) precision = 7;
      else if (databaseType === "h2") precision = base === "time" ? 0 : base === "timestamp" || base === "datetime" ? 6 : undefined;
      else if (["oracle", "oceanbase-oracle", "db2"].includes(databaseType) && base === "timestamp") precision = 6;
    }
    // Unknown defaults must not fall back to a wire type's maximum precision.
    types.set(name, precision === undefined ? null : `${base.toUpperCase()}(${precision})${zone}`);
  }
  return types;
}

/** Identity columns are writable when the caller enables the dialect's override. */
export function nonInsertableColumnNamesFromDdl(ddl: string, databaseType: DatabaseType): Set<string> {
  return new Set(
    columnDefinitions(ddl, databaseType)
      .filter((definition) => {
        const words = definitionWords(definition);
        return (!words.includes("identity") && (words.includes("generated") || words.includes("as"))) || (databaseType === "sqlserver" && (words[0] === "rowversion" || words[0] === "timestamp"));
      })
      .map((definition) => identifier(definition[0])!),
  );
}

/** Includes PostgreSQL SERIAL, whose owned sequence also needs advancing after explicit inserts. */
export function identityColumnNamesFromDdl(ddl: string, databaseType: DatabaseType): Set<string> {
  return new Set(
    columnDefinitions(ddl, databaseType)
      .filter((definition) => {
        const words = definitionWords(definition);
        return words.includes("identity") || (sqlFormatDialectForDbType(databaseType) === "postgres" && ["serial", "smallserial", "bigserial", "serial2", "serial4", "serial8"].includes(words[0] ?? ""));
      })
      .map((definition) => identifier(definition[0])!),
  );
}

export function alwaysIdentityColumnNamesFromDdl(ddl: string, databaseType: DatabaseType): Set<string> {
  return new Set(
    columnDefinitions(ddl, databaseType)
      .filter((definition) => {
        const words = definitionWords(definition);
        return words.includes("identity") && words.includes("generated") && words.includes("always");
      })
      .map((definition) => identifier(definition[0])!),
  );
}

function quoteName(value: string, databaseType: DatabaseType): string {
  if (isMysqlDdl(databaseType)) return "`" + value.replaceAll("`", "``") + "`";
  if (databaseType === "sqlserver") return "[" + value.replaceAll("]", "]]") + "]";
  return '"' + value.replaceAll('"', '""') + '"';
}

/** Names scoped to a schema must not collide with the source table's objects. */
function copiedObjectName(target: string, original: string, databaseType: DatabaseType): string {
  const input = `${target}_${original}`;
  let hash = 2166136261;
  for (const char of input) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  const suffix = `_dbx_${(hash >>> 0).toString(16).padStart(8, "0")}`;
  const limit = ["oracle", "oceanbase-oracle"].includes(databaseType) ? 30 : databaseType === "sqlserver" ? 128 : isMysqlDdl(databaseType) ? 64 : 63;
  let prefix = "";
  for (const char of input) {
    if (new TextEncoder().encode(prefix + char + suffix).length > limit) break;
    prefix += char;
  }
  return quoteName(prefix + suffix, databaseType);
}

/** Accept only the named description-property call emitted by our SQL Server DDL renderer. */
function sqlServerDescriptionParameters(tokens: SqlSemanticToken[]): Map<string, { value: string; tokens: SqlSemanticToken[] }> | undefined {
  const procedure = readName(tokens, 1);
  if (procedure.length !== 2 || identifier(procedure[0])?.toLowerCase() !== "sys" || identifier(procedure[1])?.toLowerCase() !== "sp_addextendedproperty") return undefined;
  const parameters = new Map<string, { value: string; tokens: SqlSemanticToken[] }>();
  for (let index = 4; index < tokens.length; ) {
    const name = tokens[index++];
    if (name?.kind !== "word" || !name.normalized.startsWith("@") || tokens[index++]?.text !== "=" || parameters.has(name.normalized)) return undefined;
    const valueTokens: SqlSemanticToken[] = [];
    if (word(tokens[index], "n")) valueTokens.push(tokens[index++]!);
    const value = tokens[index++];
    if (value?.kind !== "string" || value.quote !== "'") return undefined;
    valueTokens.push(value);
    parameters.set(name.normalized, { value: value.text.slice(1, -1).replaceAll("''", "'"), tokens: valueTokens });
    if (index < tokens.length && tokens[index++]?.text !== ",") return undefined;
  }
  const required = ["@name", "@value", "@level0type", "@level0name", "@level1type", "@level1name"];
  const hasColumn = parameters.has("@level2type") || parameters.has("@level2name");
  if (hasColumn) required.push("@level2type", "@level2name");
  if (parameters.size !== required.length || required.some((name) => !parameters.has(name))) return undefined;
  if (parameters.get("@name")!.value !== "MS_Description" || parameters.get("@level0type")!.value.toUpperCase() !== "SCHEMA" || parameters.get("@level1type")!.value.toUpperCase() !== "TABLE" || (hasColumn && parameters.get("@level2type")!.value.toUpperCase() !== "COLUMN")) return undefined;
  return parameters;
}

/**
 * Rewrite only grammar positions naming the table or its dependent objects.
 * Unknown statements are rejected: replaying a partially rewritten script can
 * otherwise alter the source table or quietly leave dependencies behind.
 */
export function rewriteCreateTableName(ddl: string, qualifiedTable: string, databaseType: DatabaseType = "mysql", sourceSchema?: string, sourceTable?: string): string | undefined {
  const ranges = splitSqlStatementRanges(ddl, databaseType);
  const targetParts = readName(tokensForDdl(qualifiedTable, databaseType), 0);
  const targetName = identifier(targetParts[targetParts.length - 1]);
  if (!targetName || !ranges.length) return undefined;
  const targetSchema =
    targetParts.length > 1
      ? targetParts
          .slice(0, -1)
          .map((token) => token.text)
          .join(".")
      : undefined;
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const objectNames = new Map<string, string>();
  let createCount = 0;
  let resolvedSource = sourceTable;
  let resolvedSchema = sourceSchema;
  const matchIdentifier = (token: SqlSemanticToken, value: string) => (token.kind === "quoted_identifier" ? identifier(token) === value : identifier(token)?.toLowerCase() === value.toLowerCase());
  const matchesSource = (parts: SqlSemanticToken[]) => parts.length > 0 && !!resolvedSource && matchIdentifier(parts[parts.length - 1]!, resolvedSource) && (parts.length < 2 || !resolvedSchema || matchIdentifier(parts[parts.length - 2]!, resolvedSchema));
  const renameObject = (token: SqlSemanticToken) => {
    const name = identifier(token)!;
    if (!objectNames.has(name)) objectNames.set(name, copiedObjectName(targetName, name, databaseType));
    return objectNames.get(name)!;
  };

  for (const range of ranges) {
    const tokens = tokensForDdl(range.sql, databaseType);
    if (!tokens.length) continue;
    if (tokens.some((token) => token.closed === false)) return undefined;
    const replace = (parts: SqlSemanticToken[], value: string) => replacements.push({ start: range.from + parts[0]!.span.start, end: range.from + parts[parts.length - 1]!.span.end, value });
    const tableAt = (start: number, column = false, value = qualifiedTable): boolean => {
      const parts = readName(tokens, start);
      const tableParts = column ? parts.slice(0, -1) : parts;
      if (!matchesSource(tableParts)) return false;
      replace(tableParts, value);
      return true;
    };
    let handlesTableDefinition = false;
    if (word(tokens[0], "create")) {
      let index = 1;
      while (tokens[index]?.kind === "word") {
        if (["temporary", "temp", "unlogged", "unique", "clustered", "nonclustered", "bitmap", ...(databaseType === "h2" ? ["memory", "cached", "hash", "spatial"] : [])].includes(tokens[index]!.normalized)) {
          index += 1;
        } else if (databaseType === "h2" && word(tokens[index], "nulls")) {
          // H2 SCRIPT emits NULLS DISTINCT even for an ordinary unique index.
          index += 1;
          if (word(tokens[index], "not") || word(tokens[index], "all")) index += 1;
          if (!word(tokens[index], "distinct")) return undefined;
          index += 1;
        } else break;
      }
      const kind = tokens[index++];
      if (word(tokens[index], "if") && word(tokens[index + 1], "not") && word(tokens[index + 2], "exists")) {
        // An existing object must fail CREATE, including a concurrent creator
        // racing the dialog's metadata check. Never insert into it silently.
        replace(tokens.slice(index, index + 3), "");
        index += 3;
      }
      if (word(kind, "table")) {
        const parts = readName(tokens, index);
        resolvedSource ??= identifier(parts[parts.length - 1]);
        resolvedSchema ??= parts.length > 1 ? identifier(parts[parts.length - 2]) : undefined;
        let definitionStart = index + parts.length * 2 - 1;
        // H2 SCRIPT places the table comment between its name and columns.
        if (databaseType === "h2" && word(tokens[definitionStart], "comment") && tokens[definitionStart + 1]?.kind === "string") definitionStart += 2;
        if (++createCount !== 1 || !tableAt(index) || tokens[definitionStart]?.text !== "(") return undefined;
        // A copied partition cannot safely keep a parent in another transfer.
        if (tokens.some((token, i) => token.depth === 0 && word(token, "partition") && word(tokens[i + 1], "of"))) return undefined;
        // PostgreSQL permits an explicit identity sequence name. Reusing it
        // can collide with the source sequence; this uncommon dependency needs
        // a sequence-aware schema transfer rather than partial DDL rewriting.
        if (tokens.some((token, i) => word(token, "sequence") && word(tokens[i + 1], "name"))) return undefined;
        if (tokens.some((token) => word(token, "system_versioning") || word(token, "history_table"))) return undefined;
        handlesTableDefinition = true;
      } else if (word(kind, "index")) {
        const parts = readName(tokens, index);
        const on = tokens.findIndex((token, i) => i > index && token.depth === 0 && word(token, "on"));
        const tableIndex = word(tokens[on + 1], "only") ? on + 2 : on + 1;
        const tableValue = databaseType === "sqlite" ? targetParts[targetParts.length - 1]!.text : qualifiedTable;
        if (!parts.length || on < 0 || !tableAt(tableIndex, false, tableValue)) return undefined;
        // MySQL/SQL Server indexes are table-scoped. PostgreSQL takes the
        // schema from ON; Oracle/SQLite permit an explicit index namespace.
        const renamed = isMysqlDdl(databaseType) || databaseType === "sqlserver" ? parts[parts.length - 1]!.text : renameObject(parts[parts.length - 1]!);
        const qualifyIndex = databaseType === "sqlite" || ["oracle", "oceanbase-oracle", "dameng", "yashandb"].includes(databaseType);
        replace(parts, qualifyIndex && targetSchema ? `${targetSchema}.${renamed}` : renamed);
      } else return undefined;
    } else if (word(tokens[0], "alter") && word(tokens[1], "table")) {
      let index = 2;
      if (word(tokens[index], "only")) index += 1;
      if (!tableAt(index)) return undefined;
      // Dependencies created by a separate source DDL are not copied here.
      if (tokens.some((token) => token.depth === 0 && (word(token, "attach") || word(token, "detach") || word(token, "rename")))) return undefined;
      handlesTableDefinition = true;
    } else if (word(tokens[0], "comment") && word(tokens[1], "on")) {
      if (word(tokens[2], "table") || word(tokens[2], "column")) {
        if (!tableAt(3, word(tokens[2], "column"))) return undefined;
      } else if (word(tokens[2], "constraint")) {
        if (identifier(tokens[3]) === undefined || !word(tokens[4], "on") || !tableAt(5)) return undefined;
        replace([tokens[3]!], renameObject(tokens[3]!));
      } else if (word(tokens[2], "index")) {
        const parts = readName(tokens, 3);
        const name = identifier(parts[parts.length - 1]);
        if (!name || !objectNames.has(name)) return undefined;
        replace(parts, `${targetSchema ? targetSchema + "." : ""}${objectNames.get(name)}`);
      } else return undefined;
    } else if (databaseType === "sqlserver" && (word(tokens[0], "exec") || word(tokens[0], "execute"))) {
      const parameters = sqlServerDescriptionParameters(tokens);
      if (!parameters || parameters.get("@level1name")!.value !== resolvedSource || (resolvedSchema && parameters.get("@level0name")!.value !== resolvedSchema)) return undefined;
      const stringLiteral = (value: string) => "N'" + value.replaceAll("'", "''") + "'";
      const tableParameter = parameters.get("@level1name")!;
      const schemaParameter = parameters.get("@level0name")!;
      if (targetSchema) {
        replace(tableParameter.tokens, stringLiteral(targetName));
        replace(schemaParameter.tokens, stringLiteral(identifier(targetParts[targetParts.length - 2])!));
      } else {
        // Default schemas are per user. Resolve the table just created on the
        // server rather than assuming dbo or reusing the source schema. The
        // dynamic batch keeps the local variable with EXEC in one statement.
        const edits = [
          { tokens: tableParameter.tokens, value: stringLiteral(targetName) },
          { tokens: schemaParameter.tokens, value: "@dbx_transfer_schema" },
        ].sort((left, right) => right.tokens[0]!.span.start - left.tokens[0]!.span.start);
        let propertySql = range.sql;
        for (const edit of edits) propertySql = propertySql.slice(0, edit.tokens[0]!.span.start) + edit.value + propertySql.slice(edit.tokens[edit.tokens.length - 1]!.span.end);
        const dynamicSql = `DECLARE @dbx_transfer_schema sysname = OBJECT_SCHEMA_NAME(OBJECT_ID(${stringLiteral(qualifiedTable)}, N'U'));\n${propertySql}`;
        replacements.push({ start: range.from, end: range.from + range.sql.length, value: `EXEC(${stringLiteral(dynamicSql)})` });
      }
    } else return undefined;

    if (handlesTableDefinition) {
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (word(token, "references")) {
          const parts = readName(tokens, index + 1);
          if (matchesSource(parts)) replace(parts, databaseType === "sqlite" ? targetParts[targetParts.length - 1]!.text : qualifiedTable);
        }
        if (word(token, "constraint") && identifier(tokens[index + 1]) !== undefined) {
          const parts = readName(tokens, index + 1);
          const renamed = renameObject(parts[parts.length - 1]!);
          // H2 SCRIPT qualifies ordinary primary/unique/check constraints.
          // Rename the object, never the schema token preceding its name.
          replace(parts, parts.length > 1 && targetSchema ? `${targetSchema}.${renamed}` : renamed);
        }
      }
    }
  }
  if (createCount !== 1) return undefined;
  let result = ddl;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  return result;
}

/** Only inspect COLLATE clauses; never replace matching text in data/comments. */
function mysqlCollationTokens(ddl: string): Array<{ start: number; end: number; name: string }> {
  const clauses: Array<{ start: number; end: number; name: string }> = [];
  for (const range of splitSqlStatementRanges(ddl, "mysql")) {
    const tokens = tokensForDdl(range.sql, "mysql");
    for (let i = 0; i < tokens.length; i++) {
      if (!word(tokens[i], "collate")) continue;
      const token = tokens[i + (tokens[i + 1]?.text === "=" ? 2 : 1)];
      const name = token?.kind === "string" ? token.text.slice(1, -1) : identifier(token);
      if (token && name) clauses.push({ start: range.from + token.span.start, end: range.from + token.span.end, name: name.toLowerCase() });
    }
  }
  return clauses;
}

export function mysqlDdlCollations(ddl: string): string[] {
  return [...new Set(mysqlCollationTokens(ddl).map((clause) => clause.name))];
}

export function adaptMysqlDdlCollations(ddl: string, supportedNames: string[]): { ddl: string; changes: string[]; unsupported: string[] } {
  const supported = new Set(supportedNames.map((name) => name.toLowerCase()));
  const changes = new Set<string>();
  const unsupported = new Set<string>();
  let result = ddl;
  for (const clause of mysqlCollationTokens(ddl).reverse()) {
    if (supported.has(clause.name)) continue;
    // Keep utf8mb4 and accent/case insensitivity. Do not guess mappings for
    // language-specific, binary or case-sensitive collations.
    const replacement = clause.name === "utf8mb4_0900_ai_ci" ? ["utf8mb4_unicode_520_ci", "utf8mb4_unicode_ci"].find((name) => supported.has(name)) : undefined;
    if (!replacement) {
      unsupported.add(clause.name);
      continue;
    }
    result = result.slice(0, clause.start) + replacement + result.slice(clause.end);
    changes.add(`${clause.name} → ${replacement}`);
  }
  return { ddl: result, changes: [...changes], unsupported: [...unsupported] };
}
