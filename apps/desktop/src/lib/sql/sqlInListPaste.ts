export const SQL_IN_LIST_PASTE_MAX_SOURCE_LENGTH = 1024 * 1024;
export const SQL_IN_LIST_PASTE_MAX_VALUES = 10_000;

export type SqlInListPasteError = "empty" | "not-list" | "too-large" | "too-many-values";

export type SqlInListPasteResult =
  | {
      ok: true;
      sql: string;
      valueCount: number;
    }
  | {
      ok: false;
      reason: SqlInListPasteError;
      limit?: number;
    };

interface ParsedPasteValue {
  value: string;
  quoted: boolean;
}

interface ParsedPasteValues {
  values: ParsedPasteValue[];
  explicitList: boolean;
}

const SQL_NUMBER_LITERAL_RE = /^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SIMPLE_SLASH_LIST_VALUE_RE = /^[A-Za-z0-9_.:-]+$/;

export function buildSqlInConditionFromPasteSource(source: string): SqlInListPasteResult {
  if (source.length > SQL_IN_LIST_PASTE_MAX_SOURCE_LENGTH) {
    return { ok: false, reason: "too-large", limit: SQL_IN_LIST_PASTE_MAX_SOURCE_LENGTH };
  }

  const parsed = parsePastedValues(source);
  const values = parsed.values;
  if (values.length === 0) return { ok: false, reason: "empty" };
  if (values.length === 1 && !parsed.explicitList) return { ok: false, reason: "not-list" };
  if (values.length > SQL_IN_LIST_PASTE_MAX_VALUES) {
    return { ok: false, reason: "too-many-values", limit: SQL_IN_LIST_PASTE_MAX_VALUES };
  }

  const literals = values.map(formatSqlLiteral);
  return {
    ok: true,
    sql: `IN (${literals.join(", ")})`,
    valueCount: values.length,
  };
}

export function sqlInConditionNeedsListOnly(prefix: string): boolean {
  return /\b(?:not\s+)?in\s*$/i.test(prefix);
}

export function insertTextForSqlInCondition(condition: string, prefix: string): string {
  if (sqlInConditionNeedsListOnly(prefix)) return condition.replace(/^IN\s+/i, "");
  if (!prefix || /\s$|\($/.test(prefix)) return condition;
  return ` ${condition}`;
}

function parsePastedValues(source: string): ParsedPasteValues {
  const sourceText = source.replace(/\r\n?/g, "\n").trim();
  const withoutInKeyword = stripLeadingInKeyword(sourceText);
  const explicitSource = withoutInKeyword.trim();
  const explicitList = explicitSource.startsWith("(") && explicitSource.endsWith(")") && hasSingleWrappingParentheses(explicitSource);
  const trimmed = stripOuterParentheses(withoutInKeyword);
  if (!trimmed) return { values: [], explicitList };

  return {
    values: splitPasteTokens(trimmed)
      .map(normalizePastedToken)
      .filter((value): value is ParsedPasteValue => !!value),
    explicitList,
  };
}

function stripLeadingInKeyword(value: string): string {
  const match = /^(?:not\s+)?in\b\s*([\s\S]*)$/i.exec(value.trim());
  return match ? match[1].trim() : value;
}

function splitPasteTokens(source: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  const slashIsDelimiter = shouldSplitSlashSeparatedValues(source);

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if ((char === "'" || char === '"') && current.trim().length === 0) {
      quote = char;
      current += char;
      continue;
    }

    if (char === "," || char === "\n" || char === "\t" || (slashIsDelimiter && char === "/")) {
      tokens.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  tokens.push(current);
  return tokens;
}

function shouldSplitSlashSeparatedValues(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed.includes("/") || /[,\n\t]/.test(trimmed)) return false;
  if (trimmed.includes("'") || trimmed.includes('"')) return false;
  if (trimmed.startsWith("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  if (/^\d{4}\/\d{1,2}\/\d{1,2}(?:\D|$)/.test(trimmed) || /^\d{1,2}\/\d{1,2}\/\d{4}(?:\D|$)/.test(trimmed)) return false;

  const parts = trimmed.split("/").map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => !part)) return false;
  return parts.every((part) => SIMPLE_SLASH_LIST_VALUE_RE.test(part));
}

function normalizePastedToken(token: string): ParsedPasteValue | null {
  let value = stripOuterParentheses(
    token
      .trim()
      .replace(/[;,]+$/g, "")
      .trim(),
  );
  if (!value) return null;

  const first = value[0];
  const last = value[value.length - 1];
  const quoted = value.length >= 2 && ((first === "'" && last === "'") || (first === '"' && last === '"'));
  if (quoted) {
    value = value.slice(1, -1);
    value = first === "'" ? value.replace(/''/g, "'") : value.replace(/""/g, '"');
  }

  value = value.trim();
  if (!value) return null;
  return { value, quoted };
}

function stripOuterParentheses(value: string): string {
  let next = value.trim();
  while (next.startsWith("(") && next.endsWith(")") && hasSingleWrappingParentheses(next)) {
    next = next.slice(1, -1).trim();
  }
  return next;
}

function hasSingleWrappingParentheses(value: string): boolean {
  let depth = 0;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (quote) {
      if (char === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }

  return depth === 0;
}

function formatSqlLiteral(token: ParsedPasteValue): string {
  if (!token.quoted && /^null$/i.test(token.value)) return "NULL";
  if (!token.quoted && SQL_NUMBER_LITERAL_RE.test(token.value)) return token.value;
  return `'${token.value.replace(/'/g, "''")}'`;
}
