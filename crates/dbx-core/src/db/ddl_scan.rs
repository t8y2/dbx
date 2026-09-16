//! Structural, quote-and-parenthesis-aware scanning helpers for
//! post-processing already-rendered `CREATE TABLE` DDL text.
//!
//! A naive `str::find` for a literal marker (e.g. `" SERVER \""` or a bare
//! `;`) can be fooled by that same text appearing inside a quoted string
//! literal, a quoted identifier, or a nested parenthesized sub-expression —
//! a column's `DEFAULT`/`CHECK` expression can legally contain any of those.
//! These helpers track quote and parenthesis depth so callers only ever
//! match at the top level.

use std::ops::Range;

fn char_at(sql: &str, pos: usize) -> Option<char> {
    sql.get(pos..)?.chars().next()
}

/// Skips a `'...'` string literal (`''`-escaped, with backslash-escape
/// tolerance) or a `"..."` quoted identifier (`""`-escaped) starting at
/// `pos`, which must point at the opening `quote` character. Returns the
/// index just past the closing quote (or `sql.len()` if unterminated).
fn skip_quoted(sql: &str, pos: usize, quote: char) -> usize {
    let mut i = pos + quote.len_utf8();
    while i < sql.len() {
        let Some(ch) = char_at(sql, i) else { break };
        let next = char_at(sql, i + ch.len_utf8());
        if ch == quote {
            if next == Some(quote) {
                i += ch.len_utf8() + quote.len_utf8();
                continue;
            }
            return i + ch.len_utf8();
        }
        if quote == '\'' && ch == '\\' {
            i += ch.len_utf8();
            if let Some(escaped) = char_at(sql, i) {
                i += escaped.len_utf8();
            }
            continue;
        }
        i += ch.len_utf8();
    }
    sql.len()
}

/// Skips a PostgreSQL `$tag$...$tag$` dollar-quoted body starting at `pos`
/// (pointing at the first `$`). Returns `None` if `pos` isn't actually the
/// start of a valid dollar-quote tag (e.g. a stray `$` in an expression), in
/// which case the caller should treat `$` as an ordinary character.
fn skip_dollar_quoted(sql: &str, pos: usize) -> Option<usize> {
    let tag_end_offset = sql.get(pos + 1..)?.find('$')?;
    let tag_end = pos + 1 + tag_end_offset;
    let tag = &sql[pos + 1..tag_end];
    let valid_tag = tag.is_empty()
        || (tag.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
            && tag.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_'));
    if !valid_tag {
        return None;
    }
    let delimiter = &sql[pos..=tag_end];
    let content_start = tag_end + 1;
    sql.get(content_start..)?.find(delimiter).map(|offset| content_start + offset + delimiter.len())
}

/// Finds the byte index just past the first top-level (parenthesis-depth-0)
/// closing paren at or after `from` — the end of the outermost parenthesized
/// group that starts somewhere at or after `from` — treating quoted or
/// dollar-quoted content as opaque so parens or keywords inside a
/// `DEFAULT`/`CHECK` expression can't confuse the count. Returns `None` if no
/// top-level `(` is ever opened, or it's never closed.
pub(crate) fn find_top_level_paren_close(sql: &str, from: usize) -> Option<usize> {
    let mut i = from;
    let mut depth: usize = 0;
    let mut opened = false;
    while i < sql.len() {
        let ch = char_at(sql, i)?;
        match ch {
            '\'' | '"' => {
                i = skip_quoted(sql, i, ch);
                continue;
            }
            '$' => {
                if let Some(end) = skip_dollar_quoted(sql, i) {
                    i = end;
                    continue;
                }
            }
            '(' => {
                depth += 1;
                opened = true;
            }
            ')' => {
                depth = depth.saturating_sub(1);
                i += ch.len_utf8();
                if opened && depth == 0 {
                    return Some(i);
                }
                continue;
            }
            _ => {}
        }
        i += ch.len_utf8();
    }
    None
}

/// Finds the byte index of the next top-level (depth-0, outside any quoted
/// or dollar-quoted content) `;` at or after `from`.
fn find_top_level_semicolon(sql: &str, from: usize) -> Option<usize> {
    let mut i = from;
    let mut depth: usize = 0;
    while i < sql.len() {
        let ch = char_at(sql, i)?;
        match ch {
            '\'' | '"' => {
                i = skip_quoted(sql, i, ch);
                continue;
            }
            '$' => {
                if let Some(end) = skip_dollar_quoted(sql, i) {
                    i = end;
                    continue;
                }
            }
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ';' if depth == 0 => return Some(i),
            _ => {}
        }
        i += ch.len_utf8();
    }
    None
}

/// Splits `sql` into consecutive top-level statement ranges, each ending
/// just past its own top-level `;`. The last statement may lack a trailing
/// `;`, in which case its range runs to the end of the string.
pub(crate) fn top_level_statement_ranges(sql: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < sql.len() {
        match find_top_level_semicolon(sql, start) {
            Some(semi) => {
                ranges.push(start..semi + 1);
                start = semi + 1;
            }
            None => {
                ranges.push(start..sql.len());
                break;
            }
        }
    }
    ranges
}

/// If `stmt` (ignoring leading whitespace) begins with `CREATE TABLE
/// "schema"."table"` or `CREATE FOREIGN TABLE "schema"."table"`, returns the
/// unescaped `(schema, table)` pair.
pub(crate) fn parse_create_table_relation(stmt: &str) -> Option<(String, String)> {
    let trimmed = stmt.trim_start();
    let rest =
        trimmed.strip_prefix("CREATE FOREIGN TABLE ").or_else(|| trimmed.strip_prefix("CREATE TABLE "))?.trim_start();
    let (schema, rest) = unquote_ident(rest)?;
    let (table, _) = unquote_ident(rest.strip_prefix('.')?)?;
    Some((schema, table))
}

fn unquote_ident(s: &str) -> Option<(String, &str)> {
    if !s.starts_with('"') {
        return None;
    }
    let end = skip_quoted(s, 0, '"');
    if end < 2 {
        return None;
    }
    let raw = &s[1..end - 1];
    Some((raw.replace("\"\"", "\""), &s[end..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paren_close_skips_nested_parens_and_quotes() {
        let ddl =
            "\"public\".\"t\" (\n  \"a\" text DEFAULT 'x(y)'::text,\n  \"b\" text CHECK ((b <> 'z'))\n) SERVER \"s\"";
        let close = find_top_level_paren_close(ddl, 0).unwrap();
        assert_eq!(
            &ddl[..close],
            "\"public\".\"t\" (\n  \"a\" text DEFAULT 'x(y)'::text,\n  \"b\" text CHECK ((b <> 'z'))\n)"
        );
    }

    #[test]
    fn paren_close_ignores_literal_server_text_inside_quotes() {
        let ddl = "\"public\".\"t\" (\n  \"note\" text DEFAULT 'contact SERVER \"admin\"'\n) SERVER \"real_server\"";
        let close = find_top_level_paren_close(ddl, 0).unwrap();
        assert!(ddl[close..].starts_with(" SERVER \"real_server\""));
    }

    #[test]
    fn top_level_statement_ranges_split_on_depth_zero_semicolons() {
        let ddl = "CREATE TABLE \"s\".\"t\" (\n  \"a\" text DEFAULT 'x;y'\n);\nALTER TABLE \"s\".\"t\" ADD CONSTRAINT c CHECK (a <> '');";
        let ranges = top_level_statement_ranges(ddl);
        assert_eq!(ranges.len(), 2);
        assert!(ddl[ranges[0].clone()].starts_with("CREATE TABLE"));
        assert!(ddl[ranges[0].clone()].ends_with(";"));
        assert!(ddl[ranges[1].clone()].trim_start().starts_with("ALTER TABLE"));
    }

    #[test]
    fn parse_create_table_relation_unescapes_doubled_quotes() {
        let (schema, table) =
            parse_create_table_relation("CREATE TABLE \"pub\"\"lic\".\"t\" (\n  \"a\" int\n);").unwrap();
        assert_eq!(schema, "pub\"lic");
        assert_eq!(table, "t");
    }

    #[test]
    fn parse_create_table_relation_rejects_non_create_table() {
        assert!(parse_create_table_relation("ALTER TABLE \"s\".\"t\" ADD CONSTRAINT c CHECK (true);").is_none());
    }
}
