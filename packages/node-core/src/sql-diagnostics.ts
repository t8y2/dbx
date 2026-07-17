const DEFAULT_SQL_DIAGNOSTIC_MAX_CHARS = 512;
const SENSITIVE_NAME_RE = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization|bearer)/i;

function boundedInput(sql: string, maxChars: number): [string, boolean] {
  if (maxChars <= 0) return ["", sql.length > 0];

  let end = 0;
  let chars = 0;
  for (const character of sql) {
    if (chars === maxChars) return [sql.slice(0, end), true];
    end += character.length;
    chars += 1;
  }
  return [sql, false];
}

function truncateForDiagnostic(value: string, maxChars: number, inputTruncated: boolean): string {
  if (value.length > maxChars) return `${value.slice(0, maxChars)}…[truncated]`;
  return inputTruncated ? `${value}…[truncated]` : value;
}

function redactSqlLiterals(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      result += `${quote}[REDACTED]${quote}`;
      i += 1;
      while (i < sql.length) {
        const current = sql[i];
        if (current === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        if (current === "\\" && quote !== "`") {
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (ch === "$") {
      const j = i + 1;
      if (j >= sql.length) {
        result += "$";
        i += 1;
        continue;
      }
      if (sql[j] === "$") {
        // $$...$$ empty-tag dollar-quoted string
        result += "$$[REDACTED]$$";
        i += 2;
        while (i + 1 < sql.length && !(sql[i] === "$" && sql[i + 1] === "$")) {
          i += 1;
        }
        if (i + 1 < sql.length) {
          i += 2;
        }
        continue;
      }
      // $tag$...$tag$ dollar-quoted string — tag must be ASCII alphanumerics + underscore only
      const TAG_CHAR = /^[A-Za-z0-9_]$/;
      let tagEnd = j;
      while (tagEnd < sql.length && TAG_CHAR.test(sql[tagEnd])) {
        tagEnd += 1;
      }
      if (tagEnd > j && tagEnd < sql.length && sql[tagEnd] === "$") {
        const tag = sql.slice(j, tagEnd);
        result += "$[REDACTED]$";
        i = tagEnd + 1;
        const closing = "$" + tag + "$";
        while (i + closing.length <= sql.length) {
          if (sql.slice(i, i + closing.length) === closing) {
            i += closing.length;
            break;
          }
          i += 1;
        }
        continue;
      }
      result += "$";
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      result += "--[REDACTED_COMMENT]";
      i += 2;
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      result += "/*[REDACTED_COMMENT]*/";
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      if (i < sql.length) i += 2;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

export function redactSqlForDiagnostics(sql: string, maxChars = DEFAULT_SQL_DIAGNOSTIC_MAX_CHARS): string {
  const [boundedSql, inputTruncated] = boundedInput(sql, maxChars);
  const literalRedacted = redactSqlLiterals(boundedSql);
  const sensitiveRedacted = literalRedacted.replace(/\b([A-Za-z_][\w.-]*)(\s*[:=]\s*)([^\s,;)]+)/g, (match, key: string, separator: string) => {
    if (!SENSITIVE_NAME_RE.test(key)) return match;
    return `${key}${separator}[REDACTED]`;
  });
  return truncateForDiagnostic(sensitiveRedacted, maxChars, inputTruncated);
}

export function sqlDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DBX_SQL_DEBUG ?? env.DBX_DEBUG_SQL ?? env.DBX_MCP_DEBUG_SQL;
  return value === "1" || value?.toLowerCase() === "true";
}

export function logSqlDiagnostic(scope: string, sql: string, details: Record<string, unknown> = {}, env?: NodeJS.ProcessEnv): void {
  if (!sqlDiagnosticsEnabled(env)) return;
  console.error(`[${scope}] sql:`, JSON.stringify({ ...details, sql: redactSqlForDiagnostics(sql) }));
}
