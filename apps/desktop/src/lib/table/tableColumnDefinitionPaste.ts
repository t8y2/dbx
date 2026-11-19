import { tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";
import { tableStructureIdentifierComparisonKey } from "@/lib/table/tableStructureEditorState";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";

export const COLUMN_PASTE_MAX_LENGTH = 65536;
export type ColumnPasteErrorCode = "syntax" | "unsupported" | "ambiguous" | "duplicate" | "tooLarge" | "precision";
export interface ColumnPasteDiagnostic {
  code: ColumnPasteErrorCode;
  line: number;
  column: number;
  detail: string;
}
export type PastedColumnDefinition = Omit<EditableStructureColumn, "id" | "original" | "originalPosition">;
export interface ColumnPasteResult {
  columns: PastedColumnDefinition[];
  diagnostics: ColumnPasteDiagnostic[];
}

const NUMERIC_TYPES = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "dec", "numeric", "fixed", "float", "double", "real"]);
const TEMPORAL_TYPES = new Set(["date", "datetime", "timestamp", "time", "year"]);
const OTHER_TYPES = new Set([
  "bit",
  "bool",
  "boolean",
  "char",
  "varchar",
  "binary",
  "varbinary",
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
  "json",
  "enum",
  "set",
  "geometry",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
  "geometrycollection",
]);
const PARAMETER_TYPES = new Set([...NUMERIC_TYPES, "bit", "char", "varchar", "binary", "varbinary", "datetime", "timestamp", "time", "year"]);
const TWO_PARAMETER_TYPES = new Set(["decimal", "dec", "numeric", "fixed", "float", "double", "real"]);
const NON_COLUMN_STARTS = new Set(["create", "alter", "drop", "select", "insert", "update", "delete", "primary", "unique", "key", "index", "constraint", "foreign", "check", "fulltext", "spatial"]);

class ColumnPasteError extends Error {
  constructor(
    readonly code: ColumnPasteErrorCode,
    readonly offset: number,
    readonly detail: string,
  ) {
    super(code);
  }
}

function fail(code: ColumnPasteErrorCode, token?: SqlSemanticToken): never {
  throw new ColumnPasteError(code, token?.span.start ?? 0, token?.text ?? "");
}

function isWord(token: SqlSemanticToken | undefined, word: string): boolean {
  return token?.kind === "word" && token.normalized === word;
}

function stringValue(token: SqlSemanticToken): string {
  if (token.kind !== "string" || token.quote !== "'" || !token.closed) fail("syntax", token);
  return token.text.slice(1, -1).replaceAll("''", "'");
}

function readNumericOrBitLiteral(tokens: SqlSemanticToken[], start: number): { text: string; nextIndex: number } | undefined {
  let text = "";
  let match: { text: string; nextIndex: number } | undefined;
  // The shared tokenizer splits exponents, leading decimal points and bit
  // prefixes. Join only adjacent tokens; never turn `1 e3` into `1e3`.
  // The longest supported form needs five tokens: . 5 e - 3.
  for (let index = start; index < Math.min(tokens.length, start + 5); index++) {
    if (index > start && tokens[index - 1].span.end !== tokens[index].span.start) break;
    text += tokens[index].text;
    if (/^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[bB]'[01]+'|0b[01]+)$/.test(text)) {
      match = { text, nextIndex: index + 1 };
    }
  }
  return match;
}

/** A deliberately small expression grammar, not a general SQL statement parser.
 * Preserve literals, field references, calls and arithmetic, but reject syntax
 * we cannot account for instead of accepting arbitrary text inside parentheses.
 */
function validateDefaultExpression(tokens: SqlSemanticToken[]): void {
  let index = 0;
  function operand(depth: number): void {
    const token = tokens[index];
    if (!token) fail("syntax", tokens[tokens.length - 1]);
    if (depth > 64) fail("unsupported", token);
    const literal = readNumericOrBitLiteral(tokens, index);
    if (literal) {
      index = literal.nextIndex;
      return;
    }
    index++;
    if (["+", "-", "!", "~"].includes(token.text) || isWord(token, "not")) {
      operand(depth + 1);
    } else if (token.text === "(") {
      expression(depth + 1);
      if (tokens[index++]?.text !== ")") fail("syntax", token);
    } else if (token.kind === "word" || token.kind === "quoted_identifier") {
      if (token.kind === "word" && (NON_COLUMN_STARTS.has(token.normalized) || !/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(token.text))) fail("unsupported", token);
      if (tokens[index]?.text === "(") {
        index++;
        if (tokens[index]?.text !== ")") {
          expression(depth + 1);
          while (tokens[index]?.text === ",") {
            index++;
            expression(depth + 1);
          }
        }
        if (tokens[index++]?.text !== ")") fail("syntax", token);
      }
    } else if (token.kind !== "string") {
      fail("unsupported", token);
    }
  }
  function expression(depth: number): void {
    operand(depth);
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.text === ")" || token.text === ",") return;
      if (["+", "-", "*", "/", "%", "&", "|", "^", "=", "<", ">", "!"].includes(token.text)) {
        index++;
        const next = tokens[index];
        const combined = token.text + (next?.text ?? "");
        if (next?.span.start === token.span.end && ["<=", ">=", "!=", "<>", "<<", ">>", "&&", "||"].includes(combined)) index++;
        else if (token.text === "!") fail("syntax", token);
      } else if (token.kind === "word" && ["and", "or", "xor", "div", "mod", "is"].includes(token.normalized)) {
        index++;
        if (token.normalized === "is" && isWord(tokens[index], "not")) index++;
      } else {
        fail("unsupported", token);
      }
      operand(depth);
    }
  }
  expression(0);
  if (index !== tokens.length) fail("syntax", tokens[index]);
}

/** Parse only the field-local attributes that the editor can round-trip. */
function parseColumn(tokens: SqlSemanticToken[], source: string): PastedColumnDefinition {
  let index = 0;
  const nameToken = tokens[index++];
  if (!nameToken || (nameToken.kind !== "word" && nameToken.kind !== "quoted_identifier")) fail("syntax", nameToken);
  if (nameToken.kind === "word" && NON_COLUMN_STARTS.has(nameToken.normalized)) fail("unsupported", nameToken);
  if (nameToken.kind === "word" && !/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(nameToken.text)) fail("syntax", nameToken);
  const name = unquoteSqlSemanticIdentifier(nameToken);
  // The editor's name comparison and SQL builder trim names. Do not silently
  // turn a quoted name with edge whitespace into a different identifier.
  if (!name || name !== name.trim() || [...name].length > 64 || /[\u0000-\u001f\u007f]/.test(name)) fail("unsupported", nameToken);

  const typeToken = tokens[index++];
  if (!typeToken || typeToken.kind !== "word") fail("syntax", typeToken ?? nameToken);
  const baseType = typeToken.normalized;
  if (!NUMERIC_TYPES.has(baseType) && !TEMPORAL_TYPES.has(baseType) && !OTHER_TYPES.has(baseType)) fail("unsupported", typeToken);
  if (baseType === "double" && isWord(tokens[index], "precision")) index++;

  function group(): SqlSemanticToken[] {
    const opening = tokens[index++];
    const start = index;
    while (index < tokens.length && !(tokens[index].text === ")" && tokens[index].depth === opening.depth)) index++;
    if (index === tokens.length) fail("syntax", opening);
    const contents = tokens.slice(start, index);
    index++;
    return contents;
  }

  let enumValues: string[] | undefined;
  let parameters: number[] = [];
  if (tokens[index]?.text === "(") {
    const opening = tokens[index];
    const contents = group();
    if (baseType === "enum" || baseType === "set") {
      if (!contents.length || contents.length % 2 === 0) fail("syntax", opening);
      enumValues = [];
      for (let position = 0; position < contents.length; position++) {
        const item = contents[position];
        if (position % 2) {
          if (item.text !== ",") fail("syntax", item);
        } else {
          enumValues.push(stringValue(item));
        }
      }
    } else {
      if (!PARAMETER_TYPES.has(baseType)) fail("unsupported", opening);
      const numericParameters = contents.map((item) => item.text).join("");
      if (!/^\d+(?:,\d+)?$/.test(numericParameters) || contents.some((item, position) => (position % 2 ? item.text !== "," : item.kind !== "number" || !/^\d+$/.test(item.text)))) fail("syntax", opening);
      parameters = numericParameters.split(",").map(Number);
      if (parameters.length > 1 && !TWO_PARAMETER_TYPES.has(baseType)) fail("syntax", opening);
      if (["datetime", "timestamp", "time"].includes(baseType) && !/^[0-6]$/.test(numericParameters)) fail("precision", opening);
    }
  } else if (["enum", "set", "varchar", "varbinary"].includes(baseType)) {
    fail("syntax", typeToken);
  }
  if (isWord(tokens[index], "unsigned")) {
    if (!NUMERIC_TYPES.has(baseType)) fail("unsupported", tokens[index]);
    index++;
  }
  const dataType = source.slice(typeToken.span.start, tokens[index - 1].span.end).trim();
  const column: PastedColumnDefinition = { name, dataType, enumValues, isNullable: true, defaultValue: "", comment: "", isPrimaryKey: false, extra: {}, markedForDrop: false };
  const seen = new Set<string>();
  const temporalPrecision = parameters[0] ?? 0;

  function currentTimestamp(): void {
    const token = tokens[index++];
    if (!isWord(token, "current_timestamp") || !["datetime", "timestamp"].includes(baseType)) fail("unsupported", token);
    if (tokens[index]?.text === "(") {
      const opening = tokens[index];
      const contents = group();
      if (contents.length > 1 || (contents.length === 1 && !/^[0-6]$/.test(contents[0].text))) fail("precision", opening);
      const precision = contents.length ? Number(contents[0].text) : 0;
      if (precision !== temporalPrecision) fail("precision", opening);
    }
  }

  while (index < tokens.length) {
    const clause = tokens[index++];
    if (clause.kind !== "word") fail("syntax", clause);
    const kind = clause.normalized === "not" ? "null" : clause.normalized;
    if (seen.has(kind)) fail("syntax", clause);
    seen.add(kind);
    if (kind === "null") {
      if (clause.normalized === "not") {
        if (!isWord(tokens[index], "null")) fail("syntax", tokens[index] ?? clause);
        index++;
        column.isNullable = false;
      }
    } else if (kind === "auto_increment") {
      if (!["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "float", "double", "real"].includes(baseType)) fail("unsupported", clause);
      column.extra.autoIncrement = true;
    } else if (kind === "character" || kind === "collate") {
      if (!["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set"].includes(baseType)) fail("unsupported", clause);
      if (kind === "character" && !isWord(tokens[index++], "set")) fail("syntax", clause);
      const value = tokens[index++];
      if (!value || (value.kind !== "word" && value.kind !== "quoted_identifier")) fail("syntax", value ?? clause);
      const name = unquoteSqlSemanticIdentifier(value);
      if (!/^[a-zA-Z0-9_]+$/.test(name)) fail("unsupported", value);
      if (kind === "character") column.characterSet = name;
      else column.collation = name;
    } else if (kind === "comment") {
      const value = tokens[index++];
      if (!value) fail("syntax", clause);
      column.comment = stringValue(value);
      // The SQL builder trims comments. Reject rather than change their text.
      if (column.comment !== column.comment.trim()) fail("unsupported", value);
    } else if (kind === "on") {
      if (!isWord(tokens[index++], "update")) fail("unsupported", clause);
      currentTimestamp();
      column.extra.onUpdateCurrentTimestamp = true;
    } else if (kind === "default") {
      const value = tokens[index];
      if (!value) fail("syntax", clause);
      if (value.kind === "string") {
        const literal = stringValue(value);
        index++;
        // Temporal controls store date/time literals without SQL quotes; their
        // SQL builder adds quotes. Only admit unambiguous temporal literals.
        if (TEMPORAL_TYPES.has(baseType)) {
          if (literal !== literal.trim() || !/^-?\d[\d :.+-]*$/.test(literal)) fail("unsupported", value);
          column.defaultValue = literal;
        } else {
          column.defaultValue = value.text;
        }
      } else if (isWord(value, "current_timestamp")) {
        currentTimestamp();
        column.defaultValue = source.slice(value.span.start, tokens[index - 1].span.end).trim();
      } else if (isWord(value, "null")) {
        column.defaultValue = "NULL";
        index++;
      } else if (value.text === "(") {
        const contents = group();
        if (!contents.length) fail("syntax", value);
        validateDefaultExpression(contents);
        // Expression defaults are passed through, never evaluated here. The
        // global token checks reject statement separators and mode ambiguity.
        column.defaultValue = source.slice(value.span.start, tokens[index - 1].span.end).trim();
      } else if (NUMERIC_TYPES.has(baseType) || ["bit", "bool", "boolean"].includes(baseType)) {
        if (isWord(value, "true") || isWord(value, "false")) {
          column.defaultValue = value.text;
          index++;
        } else {
          const sign = value.text === "-" || value.text === "+" ? value.text : "";
          if (sign) index++;
          const literal = readNumericOrBitLiteral(tokens, index);
          if (!literal) fail("unsupported", value);
          column.defaultValue = sign + literal.text;
          index = literal.nextIndex;
        }
      } else {
        fail("unsupported", value);
      }
    } else {
      fail("unsupported", clause);
    }
  }
  if (column.extra.autoIncrement) {
    if (seen.has("null") && column.isNullable) fail("unsupported", nameToken);
    if (seen.has("default")) fail("unsupported", nameToken);
    column.isNullable = false;
  }
  if (!column.isNullable && column.defaultValue === "NULL") fail("unsupported", nameToken);
  return column;
}

/** All-or-nothing import; existing names include rows marked for deletion. */
export function parseTableColumnDefinitions(text: string, existingNames: readonly string[] = []): ColumnPasteResult {
  try {
    if (text.length > COLUMN_PASTE_MAX_LENGTH) throw new ColumnPasteError("tooLarge", 0, "");
    const allTokens = tokenizeSqlSemantic(text, "mysql", { mysqlDashCommentRequiresWhitespace: true, mysqlBackslashEscape: true });
    const tokens: SqlSemanticToken[] = [];
    const sourceParts: string[] = [];
    let sourceOffset = 0;
    const openings: SqlSemanticToken[] = [];
    for (const token of allTokens) {
      if (token.closed === false) fail("syntax", token);
      if (token.kind === "comment") {
        if (token.text.startsWith("/*") && (token.text.length < 4 || !token.text.endsWith("*/"))) fail("syntax", token);
        if (/^\/\*[!+]/.test(token.text)) fail("unsupported", token);
        sourceParts.push(text.slice(sourceOffset, token.span.start), " ".repeat(token.span.end - token.span.start));
        sourceOffset = token.span.end;
        continue;
      }
      // No server sql_mode is available here. Backslash escapes and double
      // quotes can change meaning with that mode; never guess their meaning.
      if (token.kind === "string" && (token.quote !== "'" || token.text.includes("\\"))) fail("ambiguous", token);
      if (token.kind === "quoted_identifier" && token.quote !== "`") fail("ambiguous", token);
      if (token.kind === "parameter" || token.text === "（" || token.text === "）") fail("unsupported", token);
      if (token.text === "(") {
        openings.push(token);
        if (openings.length > 64) fail("unsupported", token);
      }
      if (token.text === ")" && !openings.pop()) fail("syntax", token);
      tokens.push(token);
    }
    if (openings.length) fail("syntax", openings[openings.length - 1]);
    sourceParts.push(text.slice(sourceOffset));
    const source = sourceParts.join("");
    const names = new Set(existingNames.map((name) => tableStructureIdentifierComparisonKey(name, "mysql")));
    const columns: PastedColumnDefinition[] = [];
    const statements = isWord(tokens[0], "alter");
    let start = 0;
    for (let index = 0; index <= tokens.length; index++) {
      if (index < tokens.length && !(tokens[index].text === (statements ? ";" : ",") && tokens[index].depth === 0)) continue;
      // Allow one trailing separator, but never empty definitions/statements.
      if (start === index) {
        if (index < tokens.length) fail("syntax", tokens[index]);
        break;
      }
      let definitionStart = start;
      if (statements) {
        let cursor = start;
        if (!isWord(tokens[cursor++], "alter") || !isWord(tokens[cursor++], "table")) fail("unsupported", tokens[start]);
        const readIdentifier = () => {
          const token = tokens[cursor++];
          if (!token || cursor > index || (token.kind !== "word" && token.kind !== "quoted_identifier")) fail("syntax", token ?? tokens[start]);
          const name = unquoteSqlSemanticIdentifier(token);
          const hasControlCharacter = [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
          if (!name || name !== name.trim() || [...name].length > 64 || hasControlCharacter) fail("unsupported", token);
          if (token.kind === "word" && !/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) fail("syntax", token);
        };
        readIdentifier();
        if (tokens[cursor]?.text === ".") {
          cursor++;
          readIdentifier();
        }
        if (!isWord(tokens[cursor++], "add")) fail("unsupported", tokens[cursor - 1]);
        if (isWord(tokens[cursor], "column")) cursor++;
        definitionStart = cursor;
      }
      const column = parseColumn(tokens.slice(definitionStart, index), source);
      const key = tableStructureIdentifierComparisonKey(column.name, "mysql");
      if (names.has(key)) throw new ColumnPasteError("duplicate", tokens[definitionStart].span.start, column.name);
      names.add(key);
      columns.push(column);
      start = index + 1;
    }
    return { columns, diagnostics: [] };
  } catch (error) {
    if (!(error instanceof ColumnPasteError)) throw error;
    const before = text.slice(0, error.offset).split(/\r\n|\r|\n/);
    return { columns: [], diagnostics: [{ code: error.code, line: before.length, column: before[before.length - 1].length + 1, detail: error.detail }] };
  }
}

export function createPastedColumnDrafts(columns: readonly PastedColumnDefinition[], createId: () => string): EditableStructureColumn[] {
  return columns.map((column) => ({ ...column, id: `new:${createId()}`, extra: { ...column.extra }, enumValues: column.enumValues ? [...column.enumValues] : undefined }));
}
