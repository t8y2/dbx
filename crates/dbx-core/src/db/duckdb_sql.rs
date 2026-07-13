//! Quote-aware helpers for inspecting DuckDB SQL snippets without a full
//! parser. Shared by the DuckDB worker (execute-time ATTACH tracking) and the
//! connection layer (init-script handling), and kept free of `duckdb-bundled`
//! so config-derived metadata works in every build.

use crate::models::connection::ConnectionConfig;

/// Splits a SQL script into statements on `;`, ignoring separators inside
/// single/double quotes, `--` line comments, and `/* */` block comments.
/// Statements are trimmed; empty fragments are dropped.
pub fn split_sql_statements(script: &str) -> Vec<String> {
    let bytes = script.as_bytes();
    let mut statements = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_escape_single = false;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if in_single && in_escape_single => {
                // DuckDB E/e strings use backslash escapes, so an escaped
                // quote or semicolon must not change statement boundaries.
                i = (i + 2).min(bytes.len());
                continue;
            }
            b'\'' if !in_double => {
                if in_single && i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                if !in_single {
                    in_escape_single = is_escape_string_quote(bytes, i);
                }
                in_single = !in_single;
                if !in_single {
                    in_escape_single = false;
                }
            }
            b'"' if !in_single => {
                if in_double && i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                    i += 2;
                    continue;
                }
                in_double = !in_double;
            }
            b'-' if !in_single && !in_double && bytes.get(i + 1) == Some(&b'-') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'/' if !in_single && !in_double && bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
                continue;
            }
            b'$' if !in_single && !in_double => {
                if let Some(end) = dollar_quote_end(bytes, i) {
                    i = end;
                    continue;
                }
            }
            b';' if !in_single && !in_double => {
                push_statement(&mut statements, &script[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    push_statement(&mut statements, &script[start..]);
    statements
}

fn is_escape_string_quote(bytes: &[u8], quote_index: usize) -> bool {
    if quote_index == 0 || !matches!(bytes[quote_index - 1], b'E' | b'e') {
        return false;
    }
    quote_index == 1 || !(bytes[quote_index - 2].is_ascii_alphanumeric() || bytes[quote_index - 2] == b'_')
}

fn push_statement(statements: &mut Vec<String>, fragment: &str) {
    let trimmed = fragment.trim();
    if !trimmed.is_empty() {
        statements.push(trimmed.to_string());
    }
}

/// Returns the index right after the closing `$tag$` when `start` opens a
/// dollar-quoted string (Postgres rules: empty tag or an identifier that does
/// not start with a digit, so `$1` placeholders never match). An unterminated
/// dollar quote swallows the rest of the script, like an unterminated quote.
fn dollar_quote_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut j = start + 1;
    while j < bytes.len() && (bytes[j] == b'_' || bytes[j].is_ascii_alphanumeric()) {
        j += 1;
    }
    if j >= bytes.len() || bytes[j] != b'$' {
        return None;
    }
    if j > start + 1 && bytes[start + 1].is_ascii_digit() {
        return None;
    }
    let tag = &bytes[start..=j];
    let mut k = j + 1;
    while k + tag.len() <= bytes.len() {
        if &bytes[k..k + tag.len()] == tag {
            return Some(k + tag.len());
        }
        k += 1;
    }
    Some(bytes.len())
}

/// Returns the alias of an `ATTACH ... AS <name>` statement, or `None` when
/// the statement is not an ATTACH or carries no alias. Leading comments are
/// skipped so `-- note\nATTACH ...` is still recognized.
pub fn attached_name_from_attach_sql(sql: &str) -> Option<String> {
    let trimmed = strip_leading_comments(sql);
    let first_word = trimmed.split(|ch: char| ch.is_whitespace() || ch == ';').next().unwrap_or_default();
    if !first_word.eq_ignore_ascii_case("ATTACH") {
        return None;
    }

    let as_index = find_as_keyword_outside_quotes(trimmed)?;
    parse_identifier_after_as(&trimmed[as_index + 2..])
}

pub(crate) fn strip_leading_comments(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("").trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map(|(_, tail)| tail).unwrap_or("").trim_start();
        } else {
            return rest;
        }
    }
}

/// Collects the aliases of every `ATTACH ... AS <name>` statement in a script.
pub fn init_script_attached_names(script: &str) -> Vec<String> {
    split_sql_statements(script).iter().filter_map(|statement| attached_name_from_attach_sql(statement)).collect()
}

/// Attached-database names for a connection: the configured attach list plus
/// aliases attached by the connection init script (case-insensitive dedup).
pub fn config_attached_names(config: &ConnectionConfig) -> Vec<String> {
    let mut names: Vec<String> = config.attached_databases.iter().map(|database| database.name.clone()).collect();
    if let Some(script) = config.init_script.as_deref() {
        for name in init_script_attached_names(script) {
            if !names.iter().any(|existing| existing.eq_ignore_ascii_case(&name)) {
                names.push(name);
            }
        }
    }
    names
}

fn find_as_keyword_outside_quotes(sql: &str) -> Option<usize> {
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' if !in_double => {
                if in_single && i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                in_single = !in_single;
            }
            b'"' if !in_single => {
                if in_double && i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                    i += 2;
                    continue;
                }
                in_double = !in_double;
            }
            b'a' | b'A' if !in_single && !in_double && i + 1 < bytes.len() => {
                if (bytes[i + 1] == b's' || bytes[i + 1] == b'S')
                    && is_sql_word_boundary(bytes.get(i.wrapping_sub(1)).copied())
                    && is_sql_word_boundary(bytes.get(i + 2).copied())
                {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn is_sql_word_boundary(byte: Option<u8>) -> bool {
    !matches!(byte, Some(b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_'))
}

fn parse_identifier_after_as(input: &str) -> Option<String> {
    let input = input.trim_start();
    if input.is_empty() {
        return None;
    }
    if let Some(rest) = input.strip_prefix('"') {
        let mut name = String::new();
        let mut chars = rest.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    name.push('"');
                    chars.next();
                    continue;
                }
                return (!name.trim().is_empty()).then_some(name);
            }
            name.push(ch);
        }
        return None;
    }

    let name = input.split(|ch: char| ch.is_whitespace() || ch == ';').next().unwrap_or_default().trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_sql_alias_parser_handles_generated_sql() {
        assert_eq!(
            attached_name_from_attach_sql("ATTACH 'D:\\tmp\\sales.duckdb' AS \"sales db\";"),
            Some("sales db".to_string())
        );
        assert_eq!(attached_name_from_attach_sql("select 'not attach' as value"), None);
        assert_eq!(
            attached_name_from_attach_sql("-- note; with semicolon\n/* block */ ATTACH 'x.duckdb' AS warehouse"),
            Some("warehouse".to_string())
        );
    }

    #[test]
    fn split_ignores_separators_in_quotes_and_comments() {
        // Comment text stays inside the statement (DuckDB parses it); the
        // splitter only refuses to break on `;` inside quotes or comments.
        let script = "SET s3_endpoint='host;port'; -- comment; with semicolon\nATTACH 'db;x.duckdb' AS a; /* multi;\nline */ SELECT 1";
        let statements = split_sql_statements(script);
        assert_eq!(
            statements,
            vec![
                "SET s3_endpoint='host;port'".to_string(),
                "-- comment; with semicolon\nATTACH 'db;x.duckdb' AS a".to_string(),
                "/* multi;\nline */ SELECT 1".to_string()
            ]
        );
    }

    #[test]
    fn split_ignores_semicolons_in_dollar_quoted_strings() {
        let script = "SELECT $$a;b$$; SELECT $body$c;d$body$; SELECT 1";
        assert_eq!(
            split_sql_statements(script),
            vec!["SELECT $$a;b$$".to_string(), "SELECT $body$c;d$body$".to_string(), "SELECT 1".to_string()]
        );
        // $1 placeholders are not dollar-quote openers
        assert_eq!(split_sql_statements("SELECT $1; SELECT $2").len(), 2);
        // unterminated dollar quote swallows the rest instead of splitting it
        assert_eq!(split_sql_statements("SELECT $$a;b").len(), 1);
    }

    #[test]
    fn split_ignores_escaped_quotes_and_semicolons_in_escape_strings() {
        let script = r#"SELECT E'it\'s;ok'; SELECT e'path\\;name'; SELECT 2"#;
        assert_eq!(
            split_sql_statements(script),
            vec![r#"SELECT E'it\'s;ok'"#.to_string(), r#"SELECT e'path\\;name'"#.to_string(), "SELECT 2".to_string()]
        );
    }

    #[test]
    fn init_script_names_collects_attach_aliases() {
        let script = "INSTALL httpfs; LOAD httpfs;\nCREATE SECRET (TYPE s3, KEY_ID 'k', SECRET 's');\nATTACH 'ducklake:postgres:dbname=lake' AS lake;\nATTACH 'sales.duckdb' AS \"sales db\";";
        assert_eq!(init_script_attached_names(script), vec!["lake".to_string(), "sales db".to_string()]);
    }
}
