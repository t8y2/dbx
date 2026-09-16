/**
 * Tokenizer for the data grid quick-condition bar (WHERE / ORDER BY inputs).
 * Splits the raw text into highlightable tokens so the editor can color
 * keywords (AND/OR/...), condition fields, and values differently.
 */

export type DataGridConditionTokenType = "keyword" | "field" | "value" | "plain";

export interface DataGridConditionToken {
  type: DataGridConditionTokenType;
  text: string;
}

const CONDITION_KEYWORDS = new Set(["and", "or", "not", "like", "ilike", "rlike", "regexp", "in", "is", "null", "isnull", "notnull", "between", "exists", "true", "false", "asc", "desc", "case", "when", "then", "else", "end", "escape"]);

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isIdentifierStart(char: string): boolean {
  return /[\p{L}_$]/u.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[\p{L}\p{N}_$.]/u.test(char);
}

/** Reads a quoted run starting at `start`, honoring backslash and doubled-quote escapes. Returns the end index (exclusive). */
function quotedEnd(text: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < text.length) {
    const char = text[i]!;
    if (char === "\\" && quote !== "]") {
      i += 2;
      continue;
    }
    if (char === quote) {
      // Doubled quote is an escaped literal quote inside the run.
      if (text[i + 1] === quote && quote !== "]") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (quote === "]" && char === "]") return i + 1;
    i++;
  }
  return text.length;
}

export function tokenizeDataGridCondition(text: string): DataGridConditionToken[] {
  const tokens: DataGridConditionToken[] = [];
  let i = 0;

  const push = (type: DataGridConditionTokenType, value: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) {
      last.text += value;
      return;
    }
    tokens.push({ type, text: value });
  };

  while (i < text.length) {
    const char = text[i]!;

    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const end = quotedEnd(text, i, char === "[" ? "]" : char);
      // Backtick / bracket quoting denotes identifiers; quotes denote values.
      push(char === "`" || char === "[" ? "field" : "value", text.slice(i, end));
      i = end;
      continue;
    }

    if (isDigit(char) || (char === "." && isDigit(text[i + 1] ?? ""))) {
      let end = i;
      while (end < text.length && /[\p{N}.]/u.test(text[end]!)) end++;
      // Exponent notation: 1e5 / 1.2e-3
      if ((text[end] === "e" || text[end] === "E") && (isDigit(text[end + 1] ?? "") || ((text[end + 1] === "+" || text[end + 1] === "-") && isDigit(text[end + 2] ?? "")))) {
        end += text[end + 1] === "+" || text[end + 1] === "-" ? 2 : 1;
        while (end < text.length && isDigit(text[end]!)) end++;
      }
      push("value", text.slice(i, end));
      i = end;
      continue;
    }

    if (isIdentifierStart(char)) {
      let end = i + 1;
      while (end < text.length && isIdentifierPart(text[end]!)) end++;
      const word = text.slice(i, end);
      const isKeyword = !word.includes(".") && !word.includes("$") && CONDITION_KEYWORDS.has(word.toLowerCase());
      push(isKeyword ? "keyword" : "field", word);
      i = end;
      continue;
    }

    push("plain", char);
    i++;
  }

  return tokens;
}
