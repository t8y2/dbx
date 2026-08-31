import * as api from "@/lib/backend/api";
import type { DatabaseType, QueryResult } from "@/types/database";
import type { RoutineParameter, RoutineParameterMode } from "@/lib/table/routineExecutionSql";

export interface LoadRoutineParametersOptions {
  connectionId: string;
  database: string;
  databaseType?: DatabaseType;
  schema?: string;
  routineName: string;
}

export async function loadRoutineParameters(options: LoadRoutineParametersOptions): Promise<RoutineParameter[]> {
  if (options.databaseType === "xugu") {
    const source = await api.getObjectSource(options.connectionId, options.database, options.schema || options.database, options.routineName, "PROCEDURE");
    return xuguRoutineMetadataFromDefinition(source.source).parameters;
  }
  const sql = routineParametersQuery(options);
  if (!sql) return [];
  const result = await api.executeQuery(options.connectionId, options.database, sql, options.schema, undefined, {
    maxRows: 200,
    pageSize: 200,
  });
  return routineParametersFromResult(result, options.databaseType);
}

export function supportsRoutineParameterMetadata(databaseType?: DatabaseType): boolean {
  return (
    databaseType === "postgres" ||
    databaseType === "mysql" ||
    databaseType === "doris" ||
    databaseType === "starrocks" ||
    databaseType === "sqlserver" ||
    databaseType === "oracle" ||
    databaseType === "dameng" ||
    databaseType === "oceanbase-oracle" ||
    databaseType === "databend" ||
    databaseType === "xugu"
  );
}

export function routineParametersQuery(options: Pick<LoadRoutineParametersOptions, "database" | "databaseType" | "schema" | "routineName">): string | null {
  if (!supportsRoutineParameterMetadata(options.databaseType)) return null;
  const effectiveSchema = options.schema || (options.databaseType === "postgres" ? "public" : "") || (options.databaseType === "mysql" || options.databaseType === "doris" || options.databaseType === "starrocks" ? options.database : "");
  const schema = quoteSqlLiteral(effectiveSchema);
  const name = quoteSqlLiteral(options.routineName);
  if (options.databaseType === "postgres") {
    return `
SELECT
  NULLIF(arg.name, '') AS name,
  arg.data_type,
  CASE arg.mode
    WHEN 'i' THEN 'IN'
    WHEN 'o' THEN 'OUT'
    WHEN 'b' THEN 'INOUT'
    WHEN 'v' THEN 'IN'
    WHEN 't' THEN 'OUT'
    ELSE 'IN'
  END AS mode,
  arg.ordinal,
  CASE
    WHEN COALESCE(arg.mode, 'i') IN ('i', 'b', 'v') AND p.pronargdefaults > 0 AND arg.input_ordinal > p.pronargs - p.pronargdefaults THEN TRUE
    ELSE FALSE
  END AS has_default
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL (
  SELECT
    gs.ordinal AS ordinal,
    p.proargnames[gs.ordinal] AS name,
    CASE
      WHEN p.proallargtypes IS NULL THEN p.proargtypes[gs.ordinal - 1]
      ELSE p.proallargtypes[gs.ordinal]
    END::regtype::text AS data_type,
    COALESCE(p.proargmodes[gs.ordinal], 'i') AS mode,
    COUNT(*) FILTER (WHERE COALESCE(p.proargmodes[gs.ordinal], 'i') IN ('i', 'b', 'v')) OVER (ORDER BY gs.ordinal) AS input_ordinal
  FROM generate_series(1, COALESCE(array_length(p.proallargtypes, 1), p.pronargs)) AS gs(ordinal)
) arg
WHERE p.prokind = 'p'
  AND n.nspname = ${schema}
  AND p.proname = ${name}
ORDER BY arg.ordinal;`.trim();
  }
  if (options.databaseType === "mysql" || options.databaseType === "doris" || options.databaseType === "starrocks") {
    return `
SELECT
  PARAMETER_NAME AS name,
  DTD_IDENTIFIER AS data_type,
  COALESCE(PARAMETER_MODE, 'IN') AS mode,
  ORDINAL_POSITION AS ordinal,
  FALSE AS has_default
FROM information_schema.PARAMETERS
WHERE SPECIFIC_SCHEMA = ${schema}
  AND SPECIFIC_NAME = ${name}
  AND ORDINAL_POSITION > 0
ORDER BY ORDINAL_POSITION;`.trim();
  }
  if (options.databaseType === "databend") {
    return `
SELECT arguments
FROM system.procedures
WHERE name = ${name}
ORDER BY procedure_id
LIMIT 1;`.trim();
  }
  if (options.databaseType === "sqlserver") {
    return `
SELECT
  p.name AS name,
  t.name AS data_type,
  CASE WHEN p.is_output = 1 THEN 'OUT' ELSE 'IN' END AS mode,
  p.parameter_id AS ordinal,
  p.has_default_value AS has_default,
  p.max_length AS max_length,
  p.precision AS precision,
  p.scale AS scale,
  SCHEMA_NAME(t.schema_id) AS type_schema,
  t.is_user_defined AS is_user_defined
FROM sys.parameters p
JOIN sys.objects o ON o.object_id = p.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.types t ON t.user_type_id = p.user_type_id
WHERE o.type IN ('P', 'PC')
  AND s.name = ${schema}
  AND o.name = ${name}
ORDER BY p.parameter_id;`.trim();
  }
  if (options.databaseType === "oracle" || options.databaseType === "dameng" || options.databaseType === "oceanbase-oracle") {
    return `
SELECT
  ARGUMENT_NAME AS name,
  DATA_TYPE AS data_type,
  IN_OUT AS mode,
  POSITION AS ordinal,
  DEFAULTED AS has_default
FROM ALL_ARGUMENTS
WHERE OWNER = UPPER(${schema})
  AND OBJECT_NAME = UPPER(${name})
  AND POSITION > 0
ORDER BY SEQUENCE;`.trim();
  }
  return null;
}

export interface XuguRoutineMetadata {
  kind?: "PROCEDURE" | "FUNCTION";
  parameters: RoutineParameter[];
  returnType?: string;
}

interface XuguRoutineToken {
  kind: "word" | "quoted-identifier" | "string" | "symbol";
  text: string;
  start: number;
  end: number;
}

/**
 * XuguDB does not expose ALL_ARGUMENTS on every supported server version.
 * Its DBeaver extension therefore parses ALL_PROCEDURES.DEFINE as well. Keep
 * this parser deliberately limited to the declaration header: the PL/SQL body
 * is never interpreted and malformed definitions fail closed with no metadata.
 */
export function xuguRoutineMetadataFromDefinition(definition: string): XuguRoutineMetadata {
  const tokens = tokenizeXuguRoutineDefinition(definition);
  if (!tokens) return { parameters: [] };
  const kindIndex = tokens.findIndex((token) => isWord(token, "PROCEDURE") || isWord(token, "FUNCTION"));
  if (kindIndex < 0) return { parameters: [] };

  const kind = tokens[kindIndex].text.toUpperCase() as "PROCEDURE" | "FUNCTION";
  const nameEndIndex = xuguRoutineNameEndIndex(tokens, kindIndex + 1);
  if (nameEndIndex < 0) return { kind, parameters: [] };

  let headerIndex = nameEndIndex;
  let parameterCloseIndex = -1;
  let parameters: RoutineParameter[] = [];
  if (tokens[headerIndex]?.text === "(") {
    parameterCloseIndex = matchingTokenParenIndex(tokens, headerIndex);
    if (parameterCloseIndex < 0) return { kind, parameters: [] };
    parameters = parseXuguRoutineParameters(definition, tokens, headerIndex + 1, parameterCloseIndex);
    headerIndex = parameterCloseIndex + 1;
  }

  const returnType = kind === "FUNCTION" ? xuguFunctionReturnType(definition, tokens, headerIndex) : undefined;
  return { kind, parameters, returnType };
}

function tokenizeXuguRoutineDefinition(definition: string): XuguRoutineToken[] | null {
  const tokens: XuguRoutineToken[] = [];
  let index = 0;
  while (index < definition.length) {
    const char = definition[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && definition[index + 1] === "-") {
      index += 2;
      while (index < definition.length && definition[index] !== "\n" && definition[index] !== "\r") index += 1;
      continue;
    }
    if (char === "/" && definition[index + 1] === "*") {
      const close = definition.indexOf("*/", index + 2);
      if (close < 0) return null;
      index = close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const start = index;
      const quote = char;
      let closed = false;
      index += 1;
      while (index < definition.length) {
        if (definition[index] !== quote) {
          index += 1;
          continue;
        }
        if (definition[index + 1] === quote) {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) return null;
      tokens.push({ kind: quote === "'" ? "string" : "quoted-identifier", text: definition.slice(start, index), start, end: index });
      continue;
    }
    if (/[A-Za-z_#$]/.test(char)) {
      const start = index;
      index += 1;
      while (index < definition.length && /[A-Za-z0-9_#$%]/.test(definition[index])) index += 1;
      tokens.push({ kind: "word", text: definition.slice(start, index), start, end: index });
      continue;
    }
    const start = index;
    if (char === ":" && definition[index + 1] === "=") index += 2;
    else index += 1;
    tokens.push({ kind: "symbol", text: definition.slice(start, index), start, end: index });
  }
  return tokens;
}

function xuguRoutineNameEndIndex(tokens: XuguRoutineToken[], startIndex: number): number {
  const first = tokens[startIndex];
  if (!isIdentifierToken(first)) return -1;
  let index = startIndex + 1;
  while (tokens[index]?.text === "." && isIdentifierToken(tokens[index + 1])) index += 2;
  return index;
}

function isIdentifierToken(token?: XuguRoutineToken): boolean {
  return token?.kind === "word" || token?.kind === "quoted-identifier";
}

function isWord(token: XuguRoutineToken | undefined, word: string): boolean {
  return token?.kind === "word" && token.text.toUpperCase() === word;
}

function matchingTokenParenIndex(tokens: XuguRoutineToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].text === "(") depth += 1;
    if (tokens[index].text === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseXuguRoutineParameters(definition: string, tokens: XuguRoutineToken[], startIndex: number, endIndex: number): RoutineParameter[] {
  const ranges: Array<[number, number]> = [];
  let depth = 0;
  let rangeStart = startIndex;
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index].text === "(") depth += 1;
    if (tokens[index].text === ")") depth = Math.max(0, depth - 1);
    if (tokens[index].text === "," && depth === 0) {
      ranges.push([rangeStart, index]);
      rangeStart = index + 1;
    }
  }
  ranges.push([rangeStart, endIndex]);

  return ranges.flatMap(([start, end], ordinalIndex) => {
    const parameter = parseXuguRoutineParameter(definition, tokens, start, end, ordinalIndex + 1);
    return parameter ? [parameter] : [];
  });
}

function parseXuguRoutineParameter(definition: string, tokens: XuguRoutineToken[], startIndex: number, endIndex: number, ordinal: number): RoutineParameter | null {
  if (startIndex >= endIndex || !isIdentifierToken(tokens[startIndex])) return null;
  const name = unquoteXuguIdentifier(tokens[startIndex].text);
  let typeStartIndex = startIndex + 1;
  let mode: RoutineParameterMode = "IN";
  if (isWord(tokens[typeStartIndex], "INOUT")) {
    mode = "INOUT";
    typeStartIndex += 1;
  } else if (isWord(tokens[typeStartIndex], "IN")) {
    if (isWord(tokens[typeStartIndex + 1], "OUT")) {
      mode = "INOUT";
      typeStartIndex += 2;
    } else {
      mode = "IN";
      typeStartIndex += 1;
    }
  } else if (isWord(tokens[typeStartIndex], "OUT")) {
    mode = "OUT";
    typeStartIndex += 1;
  }

  let depth = 0;
  let defaultIndex = -1;
  for (let index = typeStartIndex; index < endIndex; index += 1) {
    if (tokens[index].text === "(") depth += 1;
    if (tokens[index].text === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (isWord(tokens[index], "DEFAULT") || tokens[index].text === ":=" || tokens[index].text === "=")) {
      defaultIndex = index;
      break;
    }
  }

  const typeEndIndex = defaultIndex >= 0 ? defaultIndex : endIndex;
  if (typeStartIndex >= typeEndIndex) return null;
  const dataType = xuguTokenRangeText(definition, tokens, typeStartIndex, typeEndIndex).replace(/\s+/g, " ");
  if (!dataType) return null;
  const defaultValue = defaultIndex >= 0 ? xuguTokenRangeText(definition, tokens, defaultIndex + 1, endIndex) : undefined;
  if (defaultIndex >= 0 && !defaultValue) return null;
  return {
    name,
    dataType,
    mode,
    ordinal,
    hasDefault: defaultIndex >= 0,
    defaultValue,
  };
}

function xuguFunctionReturnType(definition: string, tokens: XuguRoutineToken[], startIndex: number): string | undefined {
  let returnIndex = -1;
  for (let index = startIndex; index < tokens.length; index += 1) {
    if (isWord(tokens[index], "AS") || isWord(tokens[index], "IS")) break;
    if (isWord(tokens[index], "RETURN")) {
      returnIndex = index;
      break;
    }
  }
  if (returnIndex < 0) return undefined;
  let endIndex = returnIndex + 1;
  let depth = 0;
  while (endIndex < tokens.length) {
    const token = tokens[endIndex];
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (isWord(token, "AS") || isWord(token, "IS") || isWord(token, "AUTHID") || isWord(token, "PIPELINED") || isWord(token, "DETERMINISTIC"))) break;
    endIndex += 1;
  }
  if (returnIndex + 1 >= endIndex) return undefined;
  return xuguTokenRangeText(definition, tokens, returnIndex + 1, endIndex).replace(/\s+/g, " ") || undefined;
}

function xuguTokenRangeText(definition: string, tokens: XuguRoutineToken[], startIndex: number, endIndex: number): string {
  if (startIndex >= endIndex) return "";
  return stripXuguSqlComments(definition.slice(tokens[startIndex].start, tokens[endIndex - 1].end)).trim();
}

function stripXuguSqlComments(value: string): string {
  let result = "";
  let index = 0;
  let quote = "";
  while (index < value.length) {
    const char = value[index];
    if (quote) {
      result += char;
      if (char === quote) {
        if (value[index + 1] === quote) {
          result += value[index + 1];
          index += 2;
          continue;
        }
        quote = "";
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += char;
      index += 1;
      continue;
    }
    if (char === "-" && value[index + 1] === "-") {
      result += " ";
      index += 2;
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") index += 1;
      continue;
    }
    if (char === "/" && value[index + 1] === "*") {
      result += " ";
      const close = value.indexOf("*/", index + 2);
      if (close < 0) break;
      index = close + 2;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function unquoteXuguIdentifier(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/""/g, '"');
}

export function routineParametersFromResult(result: QueryResult, databaseType?: DatabaseType): RoutineParameter[] {
  if (databaseType === "databend") return databendRoutineParametersFromResult(result);
  const sqlServerMetadata =
    databaseType === "sqlserver"
      ? {
          maxLength: result.columns.findIndex((column) => column.toLowerCase() === "max_length"),
          precision: result.columns.findIndex((column) => column.toLowerCase() === "precision"),
          scale: result.columns.findIndex((column) => column.toLowerCase() === "scale"),
          typeSchema: result.columns.findIndex((column) => column.toLowerCase() === "type_schema"),
          isUserDefined: result.columns.findIndex((column) => column.toLowerCase() === "is_user_defined"),
        }
      : null;
  return result.rows
    .map((row, index) => {
      const dataType = String(row[1] || "");
      return {
        name: String(row[0] || `arg${index + 1}`),
        dataType: sqlServerMetadata ? sqlServerParameterDeclarationType(dataType, row, sqlServerMetadata) : dataType,
        mode: normalizeParameterMode(row[2]),
        ordinal: Number(row[3] || index + 1),
        hasDefault: normalizeBoolean(row[4]),
      };
    })
    .filter((parameter) => parameter.mode !== "RETURN");
}

interface SqlServerParameterMetadataIndexes {
  maxLength: number;
  precision: number;
  scale: number;
  typeSchema: number;
  isUserDefined: number;
}

function sqlServerParameterDeclarationType(baseType: string, row: unknown[], indexes: SqlServerParameterMetadataIndexes): string {
  const typeName = baseType.trim();
  if (!typeName) return "";
  if (normalizeBoolean(valueAt(row, indexes.isUserDefined))) {
    const schema = String(valueAt(row, indexes.typeSchema) || "").trim();
    const qualifiedType = quoteSqlServerIdentifier(typeName);
    return schema ? `${quoteSqlServerIdentifier(schema)}.${qualifiedType}` : qualifiedType;
  }

  const normalizedType = typeName.toLowerCase();
  const maxLength = Number(valueAt(row, indexes.maxLength));
  if (["varchar", "char", "varbinary", "binary"].includes(normalizedType) && Number.isFinite(maxLength)) {
    return `${typeName}(${maxLength === -1 ? "max" : Math.max(1, maxLength)})`;
  }
  if (["nvarchar", "nchar"].includes(normalizedType) && Number.isFinite(maxLength)) {
    return `${typeName}(${maxLength === -1 ? "max" : Math.max(1, Math.floor(maxLength / 2))})`;
  }

  const precision = Number(valueAt(row, indexes.precision));
  const scale = Number(valueAt(row, indexes.scale));
  if (["decimal", "numeric"].includes(normalizedType) && Number.isFinite(precision) && Number.isFinite(scale)) {
    return `${typeName}(${precision},${scale})`;
  }
  if (["datetime2", "datetimeoffset", "time"].includes(normalizedType) && Number.isFinite(scale)) {
    return `${typeName}(${scale})`;
  }
  if (normalizedType === "float" && Number.isFinite(precision)) {
    return `${typeName}(${precision})`;
  }
  return typeName;
}

function valueAt(row: unknown[], index: number): unknown {
  return index >= 0 ? row[index] : undefined;
}

function quoteSqlServerIdentifier(value: string): string {
  return `[${value.replace(/]/g, "]]")}]`;
}

function databendRoutineParametersFromResult(result: QueryResult): RoutineParameter[] {
  const argumentsIndex = result.columns.findIndex((column) => column.toLowerCase() === "arguments");
  const signature = String(result.rows[0]?.[argumentsIndex >= 0 ? argumentsIndex : 0] || "");
  const inputTypes = databendInputTypesFromArguments(signature);
  return inputTypes.map((dataType, index) => ({
    name: `arg${index + 1}`,
    dataType,
    mode: "IN",
    ordinal: index + 1,
    hasDefault: false,
  }));
}

function databendInputTypesFromArguments(signature: string): string[] {
  const openIndex = signature.indexOf("(");
  if (openIndex < 0) return [];
  let depth = 0;
  for (let index = openIndex; index < signature.length; index += 1) {
    const char = signature[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return splitTopLevelComma(signature.slice(openIndex + 1, index)).filter(Boolean);
      }
    }
  }
  return [];
}

function splitTopLevelComma(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function normalizeParameterMode(value: unknown): RoutineParameterMode {
  const mode = String(value || "IN")
    .toUpperCase()
    .replace(/\s+/g, "");
  if (mode === "IN") return "IN";
  if (mode === "OUT") return "OUT";
  if (mode === "INOUT" || mode === "IN/OUT") return "INOUT";
  if (mode === "RETURN") return "RETURN";
  return "UNKNOWN";
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value || "").toLowerCase();
  return text === "true" || text === "yes" || text === "y" || text === "1";
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
