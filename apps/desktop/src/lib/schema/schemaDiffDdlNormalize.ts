function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Object keywords may be preceded by CREATE/ALTER modifiers. MySQL view DDL
// puts ALGORITHM=…/DEFINER=…/SQL SECURITY … between the verb and VIEW, so the
// schema qualifier is not directly after the object keyword without them.
export function inferSchemaFromSql(sql: string): string | null {
  if (!sql) return null;
  const match = sql.match(
    /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMPORARY|UNLOGGED|ALGORITHM\s*=\s*\w+|DEFINER\s*=\s*\S+|SQL\s+SECURITY\s+(?:DEFINER|INVOKER))\s+)*(?:TABLE|VIEW|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER)|ALTER\s+(?:(?:TEMPORARY|UNLOGGED|ALGORITHM\s*=\s*\w+|DEFINER\s*=\s*\S+|SQL\s+SECURITY\s+(?:DEFINER|INVOKER))\s+)*(?:TABLE(?:\s+ONLY)?|VIEW)|COMMENT\s+ON\s+(?:TABLE|COLUMN|INDEX|CONSTRAINT))\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"([^"]+)")|(?:`([^`]+)`)|(?:\[([^\]]+)\])|([a-zA-Z0-9_]+))\s*\./i,
  );
  if (!match) return null;
  return match[1] || match[2] || match[3] || match[4] || null;
}

// Advance past a quoted span so the quote-state scanner never mistakes quotes
// inside it for the start of another construct. Returns the index just past the
// closing delimiter (or the end of the input when unterminated).
function skipQuoted(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (backslashEscapes && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function skipBracketIdentifier(sql: string, start: number): number | null {
  const close = sql.indexOf("]", start + 1);
  if (close === -1 || close - start > 128) return null;
  const content = sql.slice(start + 1, close);
  // Only SQL Server style identifiers; keep array literals such as
  // ARRAY['a','b'] on the normal path so their literals stay protected.
  if (!/^[\w $@#.-]+$/.test(content)) return null;
  return close + 1;
}

export function stripSchemaFromSql(sql: string, schema?: string): string {
  if (!sql) return "";

  const targetSchemas: string[] = [];
  if (schema && schema.trim()) {
    targetSchemas.push(schema.trim());
  } else {
    const inferred = inferSchemaFromSql(sql);
    if (inferred) targetSchemas.push(inferred);
  }

  if (targetSchemas.length === 0) return sql;

  function stripInCode(text: string): string {
    let result = text;
    for (const s of targetSchemas) {
      const esc = escapeRegExp(s);
      // 1. Quoted with double quotes: "schema".
      result = result.replace(new RegExp(`"${esc}"\\s*\\.`, "gi"), "");
      // 2. Quoted with backticks: `schema`.
      result = result.replace(new RegExp(`\`${esc}\`\\s*\\.`, "gi"), "");
      // 3. Quoted with brackets: [schema].
      result = result.replace(new RegExp(`\\[${esc}\\]\\s*\\.`, "gi"), "");
      // 4. Unquoted: schema. (preceded by non-identifier character or start of string)
      // No lookbehind assertion here: old WebKit (before Safari 16.4) throws
      // while parsing the module on lookbehind syntax, which kills the whole
      // app at startup (see legacyWebViewRegexCompat.spec.ts). Match the
      // preceding character explicitly and re-emit it instead; a single pass
      // keeps the exact original semantics (a `.` before the name blocks the
      // strip, so `x.public.users` and the second half of
      // `public.public.users` are left alone).
      result = result.replace(new RegExp(`(^|[^\\w."\`\\[])${esc}\\s*\\.`, "gi"), "$1");
    }
    return result;
  }

  // Single pass that masks string literals and comments (and skips over quoted
  // identifiers) so only real code is stripped. A single regex alternation
  // cannot do this correctly: MySQL honours `\'` inside literals, `''` is an
  // escaped quote everywhere, and an apostrophe inside a quoted identifier must
  // not open a string.
  let out = "";
  let codeStart = 0;

  function emitProtected(start: number, end: number) {
    if (start > codeStart) out += stripInCode(sql.slice(codeStart, start));
    out += sql.slice(start, end);
    codeStart = end;
  }

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    // Single-quoted string literal: '' and backslash escapes (MySQL, E-strings).
    if (ch === "'") {
      const end = skipQuoted(sql, i, "'", true);
      emitProtected(i, end);
      i = end;
      continue;
    }

    // Quoted identifier: skipped (kept in code) but must not start a literal.
    if (ch === '"') {
      i = skipQuoted(sql, i, '"', false);
      continue;
    }

    if (ch === "`") {
      i = skipQuoted(sql, i, "`", false);
      continue;
    }

    if (ch === "[") {
      const end = skipBracketIdentifier(sql, i);
      if (end !== null) {
        i = end;
        continue;
      }
      i += 1;
      continue;
    }

    // -- line comment.
    if (ch === "-" && sql[i + 1] === "-") {
      let end = i + 2;
      while (end < sql.length && sql[end] !== "\n" && sql[end] !== "\r") end += 1;
      emitProtected(i, end);
      i = end;
      continue;
    }

    // /* block comment */
    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      const end = close === -1 ? sql.length : close + 2;
      emitProtected(i, end);
      i = end;
      continue;
    }

    // PostgreSQL dollar-quoted string: $tag$ ... $tag$
    if (ch === "$") {
      const delimiter = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (delimiter) {
        const close = sql.indexOf(delimiter[0], i + delimiter[0].length);
        if (close !== -1) {
          const end = close + delimiter[0].length;
          emitProtected(i, end);
          i = end;
          continue;
        }
      }
    }

    i += 1;
  }

  if (codeStart < sql.length) out += stripInCode(sql.slice(codeStart));
  return out;
}
