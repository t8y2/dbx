import { DEFAULT_SQL_FORMATTER_SETTINGS, sqlFormatterOptions, type SqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";

export type SqlFormatDialect = "mysql" | "postgres" | "sqlite" | "sqlserver" | "clickhouse" | "generic";

export const MAX_SQL_FORMAT_CHARS = 1_000_000;

/**
 * Maps a connection's database type to the SQL-formatter dialect to use.
 *
 * Postgres-compatible engines (GaussDB/openGauss/Kingbase/...) reuse the
 * "postgres" grammar, SQLite-compatible ones reuse "sqlite", and anything
 * unrecognized falls back to the permissive "generic" dialect. Centralized
 * here so every surface that formats SQL (editor, object source, DDL viewers)
 * stays in sync.
 */
export function sqlFormatDialectForDbType(dbType: string | null | undefined): SqlFormatDialect {
  switch (dbType) {
    case "mysql":
      return "mysql";
    case "postgres":
    case "kwdb":
    case "gaussdb":
    case "opengauss":
    case "questdb":
    case "kingbase":
    case "highgo":
    case "vastbase":
    case "redshift":
      return "postgres";
    case "sqlite":
    case "rqlite":
    case "turso":
    case "cloudflare-d1":
      return "sqlite";
    case "sqlserver":
      return "sqlserver";
    case "clickhouse":
      return "clickhouse";
    default:
      return "generic";
  }
}

function formatterLanguage(dialect: SqlFormatDialect) {
  switch (dialect) {
    case "mysql":
      return "mysql";
    case "postgres":
      return "postgresql";
    case "sqlite":
      return "sqlite";
    case "sqlserver":
      return "transactsql";
    case "clickhouse":
      return "clickhouse";
    default:
      return "sql";
  }
}

export async function formatSqlText(sql: string, dialect: SqlFormatDialect = "generic", settings: Partial<SqlFormatterSettings> = DEFAULT_SQL_FORMATTER_SETTINGS): Promise<string> {
  if (!sql.trim()) return sql;
  if (sql.length > MAX_SQL_FORMAT_CHARS) {
    throw new Error("SQL is too large to format safely.");
  }

  const { format } = await import("sql-formatter");
  const options = sqlFormatterOptions(settings);
  const language = formatterLanguage(dialect);
  try {
    return format(sql, { language, ...options });
  } catch (err) {
    // The generic "sql" dialect can't parse many real-world constructs (PostgreSQL
    // `::` casts, GaussDB/openGauss materialized-view DDL, T-SQL specifics, ...).
    // Retry once with the more permissive PostgreSQL grammar, which is a superset
    // that tolerates most of these, before surfacing the failure.
    if (language !== "postgresql") {
      try {
        return format(sql, { language: "postgresql", ...options });
      } catch {
        // fall through to the original error below
      }
    }
    throw err;
  }
}

/**
 * 压缩 SQL 时使用的方言。不同方言对引号、注释、转义的处理不同：
 * - `mysql`：保留 MySQL 可执行注释与 optimizer hint；单引号字符串支持反斜杠转义
 * - `postgres`：支持 dollar-quoted 字符串
 * - `sqlserver`：支持方括号标识符
 * - `generic` / 其它：仅处理标准单/双引号与块/行注释
 */
export type SqlCompressDialect = SqlFormatDialect;

/**
 * 将 SQL 压缩成一行可执行文本：折叠所有空白（含换行）为单个空格，
 * 移除普通行注释（-- ...）与普通块注释（/* ... *\/），
 * 同时按方言完整保留字符串字面量、引号标识符、可执行注释与 optimizer hint。
 *
 * 方言感知说明：
 * - MySQL：可执行注释作为可执行代码原样保留（仅折叠内部空白）；
 *   optimizer hint 原样保留；单引号字符串内反斜杠转义保留
 * - PostgreSQL：dollar-quoted 字符串原样保留（含标签形式）
 * - SQL Server：方括号标识符原样保留（双右括号为转义）
 * - 所有方言：单引号字符串、双引号标识符、反引号标识符均保留
 */
export function compressSqlText(sql: string, dialect: SqlCompressDialect = "generic"): string {
  if (!sql.trim()) return sql;

  const len = sql.length;
  let out = "";
  let i = 0;

  const isWhitespace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
  const isIdentifierPart = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  const isMysqlDashComment = (c: string | undefined) => c === undefined || c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127;
  const supportsNestedBlockComments = dialect === "postgres" || dialect === "sqlserver" || dialect === "clickhouse";

  const dollarQuoteTagAt = (position: number): string | null => {
    if (sql[position] !== "$" || isIdentifierPart(sql[position - 1])) return null;
    if (sql[position + 1] === "$") return "$$";
    if (!/[A-Za-z_]/.test(sql[position + 1] ?? "")) return null;
    let end = position + 2;
    while (/[A-Za-z0-9_]/.test(sql[end] ?? "")) end++;
    return sql[end] === "$" ? sql.slice(position, end + 1) : null;
  };

  // 折叠一段空白为单个空格（仅在 out 非空且不以空格结尾时追加）
  const collapseWhitespace = () => {
    let containsLineBreak = false;
    while (i < len && isWhitespace(sql[i])) i++;
    for (let j = i - 1; j >= 0 && isWhitespace(sql[j]); j--) {
      if (sql[j] === "\n" || sql[j] === "\r") {
        containsLineBreak = true;
        break;
      }
    }
    // PostgreSQL only concatenates adjacent string literals when their separating
    // whitespace contains a newline, so flattening this case would make valid SQL invalid.
    if (dialect === "postgres" && containsLineBreak && out.endsWith("'") && sql[i] === "'") {
      out += "\n";
    } else if (out && !out.endsWith(" ")) {
      out += " ";
    }
  };

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 块注释 /* ... */ —— 需区分普通块注释、MySQL 可执行注释 /*! */、optimizer hint /*+ */
    if (ch === "/" && next === "*") {
      const third = sql[i + 2];
      const isExecutableMysql = third === "!";
      const isOptimizerHint = third === "+";

      if (isExecutableMysql || isOptimizerHint) {
        const contentStart = i + 3;
        const end = sql.indexOf("*/", contentStart);
        if (end < 0) {
          // Keep malformed input malformed instead of silently turning it into executable SQL.
          out += sql.slice(i);
          break;
        }
        const content = sql.slice(contentStart, end);
        const leadingSpace = /^\s/.test(content) ? " " : "";
        const trailingSpace = /\s$/.test(content) ? " " : "";
        const compressedContent = content.trim() ? compressSqlText(content, dialect) : "";
        out += `/*${third}${leadingSpace}${compressedContent}${trailingSpace}*/`;
        i = end + 2;
        continue;
      }

      // 普通块注释 —— 移除
      const commentStart = i;
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (supportsNestedBlockComments && sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) {
        // Removing an unterminated comment can expose a destructive statement that was invalid before.
        out += sql.slice(commentStart);
        break;
      }
      if (out && !out.endsWith(" ")) out += " ";
      continue;
    }

    // MySQL additionally supports # comments and requires whitespace/control after --.
    const startsDashComment = ch === "-" && next === "-" && (dialect !== "mysql" || isMysqlDashComment(sql[i + 2]));
    if (startsDashComment || (dialect === "mysql" && ch === "#")) {
      i += startsDashComment ? 2 : 1;
      while (i < len && sql[i] !== "\n" && sql[i] !== "\r") i++;
      continue;
    }

    // PostgreSQL dollar-quoted 字符串：$$...$$ 或 $tag$...$tag$
    if (dialect === "postgres" && ch === "$") {
      const tag = dollarQuoteTagAt(i);
      if (tag) {
        out += tag;
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end < 0) {
          out += sql.slice(i);
          break;
        }
        out += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }

    // 单引号字符串字面量（处理 '' 转义；MySQL 额外处理反斜杠转义）
    if (ch === "'") {
      out += "'";
      i++;
      const postgresEscapeString = dialect === "postgres" && (sql[i - 2] === "E" || sql[i - 2] === "e") && !isIdentifierPart(sql[i - 3]);
      while (i < len) {
        const c = sql[i];
        // MySQL strings and PostgreSQL E'...' strings use backslash escapes.
        if ((dialect === "mysql" || postgresEscapeString) && c === "\\" && i + 1 < len) {
          out += c;
          out += sql[i + 1];
          i += 2;
          continue;
        }
        out += c;
        if (c === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 双引号标识符（处理 "" 转义）
    if (ch === '"') {
      out += '"';
      i++;
      while (i < len) {
        if (dialect === "mysql" && sql[i] === "\\" && i + 1 < len) {
          out += sql[i];
          out += sql[i + 1];
          i += 2;
          continue;
        }
        out += sql[i];
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 反引号标识符（MySQL）
    if (ch === "`") {
      out += "`";
      i++;
      while (i < len && sql[i] !== "`") {
        out += sql[i];
        i++;
      }
      if (i < len) {
        out += "`";
        i++;
      }
      continue;
    }

    // SQL Server 方括号标识符 [...]（]] 为转义 ]）
    if (dialect === "sqlserver" && ch === "[") {
      out += "[";
      i++;
      while (i < len) {
        const c = sql[i];
        out += c;
        if (c === "]") {
          if (sql[i + 1] === "]") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 空白 —— 折叠为单个空格
    if (isWhitespace(ch)) {
      collapseWhitespace();
      continue;
    }

    out += ch;
    i++;
  }

  return out.trim();
}

/**
 * Format SQL for *display* (object source, view/table DDL viewers).
 *
 * Unlike `formatSqlText`, this never throws: if the SQL can't be parsed by the
 * formatter (vendor-specific DDL, oversized input, ...) the original text is
 * returned unchanged so the viewer still shows the source. Use this for
 * read-only/auto-format surfaces; use `formatSqlText` where a thrown error
 * should surface to the user (e.g. the explicit "Format SQL" command).
 */
export async function formatSqlForDisplay(sql: string, dialect: SqlFormatDialect = "generic", settings: Partial<SqlFormatterSettings> = DEFAULT_SQL_FORMATTER_SETTINGS): Promise<string> {
  if (!sql.trim()) return sql;
  try {
    return await formatSqlText(sql, dialect, settings);
  } catch {
    return sql;
  }
}
