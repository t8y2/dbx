use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlparser::dialect::{Dialect, GenericDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::tokenizer::{Location, Span, Token, TokenWithSpan, Tokenizer};

use crate::models::connection::DatabaseType;
use crate::sql::statement_ranges_for_database;
use crate::sql_analysis::{analyze_sql_references, normalize_dialect, SqlTextSpan};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlSyntaxDiagnostic {
    pub message: String,
    pub severity: String,
    pub span: SqlTextSpan,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expected: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub found: Option<String>,
}

/// Analyzes each statement independently so one parser failure cannot hide later
/// statements. Known-valid dialect gaps remain owned by `analyze_sql_references`.
pub fn analyze_sql_syntax(sql: &str, dialect: Option<&str>) -> Vec<SqlSyntaxDiagnostic> {
    let normalized = normalize_dialect(dialect);
    let database_type = database_type_for_dialect(normalized.id);
    let ranges = statement_ranges_for_database(sql, database_type);
    let mut diagnostics = Vec::new();

    for range in ranges {
        if range.text.trim().is_empty() {
            continue;
        }
        if let Some(diagnostic) = missing_expression_diagnostic(&range.text, normalized.id) {
            let diagnostic = offset_diagnostic(diagnostic, sql, range.start);
            if !diagnostics.contains(&diagnostic) {
                diagnostics.push(diagnostic);
            }
            continue;
        }
        if let Err(error) = analyze_sql_references(&range.text, Some(normalized.id)) {
            let diagnostic = diagnostic_for_error(&range.text, normalized.id, &error);
            let diagnostic = offset_diagnostic(diagnostic, sql, range.start);
            if !diagnostics.contains(&diagnostic) {
                diagnostics.push(diagnostic);
            }
        }
    }
    diagnostics
}

fn missing_expression_diagnostic(sql: &str, dialect: &str) -> Option<SqlSyntaxDiagnostic> {
    let dialect = dialect_for_id(dialect);
    let tokens = Tokenizer::new(dialect.as_ref(), sql).tokenize_with_location().ok()?;
    let tokens: Vec<TokenWithSpan> =
        tokens.into_iter().filter(|token| !matches!(token.token, Token::Whitespace(_) | Token::EOF)).collect();
    for index in 1..tokens.len() {
        let token = &tokens[index];
        let text = token_text(sql, token.span);
        if !text.eq_ignore_ascii_case("AND") && !text.eq_ignore_ascii_case("OR") {
            continue;
        }
        let previous = token_text(sql, tokens[index - 1].span);
        if !matches!(
            previous,
            "=" | "<" | ">" | "<=" | ">=" | "<>" | "!=" | "||" | "|" | "+" | "-" | "*" | "/" | "%" | "," | "("
        ) {
            continue;
        }
        return Some(SqlSyntaxDiagnostic {
            message: format!("Expected: an expression, found: {text}"),
            severity: "error".to_string(),
            span: SqlTextSpan::from(token.span),
            expected: vec!["an expression".to_string()],
            found: Some(text.to_string()),
        });
    }
    None
}

fn database_type_for_dialect(dialect: &str) -> DatabaseType {
    match dialect {
        "postgres" => DatabaseType::Postgres,
        "mysql" => DatabaseType::Mysql,
        "sqlite" => DatabaseType::Sqlite,
        _ => DatabaseType::Sqlite,
    }
}

fn diagnostic_for_error(sql: &str, dialect: &str, error: &str) -> SqlSyntaxDiagnostic {
    let message = error.strip_prefix("sql parser error: ").unwrap_or(error).to_string();
    let location = parser_location(&message).unwrap_or_else(|| end_location(sql));
    let expected_found = expected_found(&message);
    let span = token_span_for_location(sql, dialect, location).unwrap_or_else(|| SqlTextSpan {
        start_line: location.line as usize,
        start_column: location.column as usize,
        end_line: location.line as usize,
        end_column: location.column as usize,
    });
    SqlSyntaxDiagnostic {
        message,
        severity: "error".to_string(),
        span,
        expected: expected_found.as_ref().map(|value| vec![value.0.clone()]).unwrap_or_default(),
        found: expected_found.map(|value| value.1).or_else(|| token_text_for_location(sql, dialect, location)),
    }
}

fn parser_location(message: &str) -> Option<Location> {
    static LOCATION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\bat Line:\s*(\d+),\s*Column:\s*(\d+)\b").expect("valid parser location regex"));
    let captures = LOCATION.captures(message)?;
    let line = captures.get(1)?.as_str().parse::<u64>().ok()?;
    let column = captures.get(2)?.as_str().parse::<u64>().ok()?;
    if line == 0 || column == 0 {
        return None;
    }
    Some(Location { line, column })
}

fn expected_found(message: &str) -> Option<(String, String)> {
    static EXPECTED_FOUND: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?s)^Expected:\s*(.*?),\s*found:\s*(.*?)(?:\s+at\s+Line:.*)?$")
            .expect("valid expected/found regex")
    });
    let captures = EXPECTED_FOUND.captures(message)?;
    let expected = captures.get(1)?.as_str().trim();
    let found = captures.get(2)?.as_str().trim();
    if expected.is_empty() || found.is_empty() {
        return None;
    }
    Some((expected.to_string(), found.to_string()))
}

fn end_location(sql: &str) -> Location {
    let mut line = 1_u64;
    let mut column = 1_u64;
    for character in sql.chars() {
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    Location { line, column }
}

fn dialect_for_id(dialect: &str) -> Box<dyn Dialect> {
    match dialect {
        "postgres" => Box::new(PostgreSqlDialect {}),
        "mysql" => Box::new(MySqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

fn token_span_for_location(sql: &str, dialect: &str, location: Location) -> Option<SqlTextSpan> {
    let dialect = dialect_for_id(dialect);
    let tokens = Tokenizer::new(dialect.as_ref(), sql).tokenize_with_location().ok()?;
    let token = token_at_location(&tokens, location)?;
    Some(SqlTextSpan::from(token.span))
}

fn token_text_for_location(sql: &str, dialect: &str, location: Location) -> Option<String> {
    let dialect = dialect_for_id(dialect);
    let tokens = Tokenizer::new(dialect.as_ref(), sql).tokenize_with_location().ok()?;
    let token = token_at_location(&tokens, location)?;
    if matches!(token.token, Token::EOF) {
        return Some("EOF".to_string());
    }

    Some(token_text(sql, token.span).to_string())
}

fn token_at_location(tokens: &[TokenWithSpan], location: Location) -> Option<&TokenWithSpan> {
    let mut fallback = None;
    for token in tokens {
        if matches!(token.token, Token::Whitespace(_)) {
            continue;
        }
        fallback = Some(token);
        if location < token.span.start {
            return Some(token);
        }
        if location >= token.span.start && location < token.span.end {
            return Some(token);
        }
    }
    fallback
}

fn token_text(sql: &str, span: Span) -> &str {
    let start = byte_offset_for_location(sql, span.start);
    let end = byte_offset_for_location(sql, span.end);
    sql.get(start..end).unwrap_or("")
}

fn byte_offset_for_location(sql: &str, location: Location) -> usize {
    if location.line == 0 || location.column == 0 {
        return sql.len();
    }
    let mut line = 1_u64;
    let mut column = 1_u64;
    for (offset, character) in sql.char_indices() {
        if line == location.line && column == location.column {
            return offset;
        }
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    sql.len()
}

fn offset_diagnostic(diagnostic: SqlSyntaxDiagnostic, sql: &str, start: usize) -> SqlSyntaxDiagnostic {
    let (line, column) = line_column_at_byte_offset(sql, start);
    SqlSyntaxDiagnostic { span: offset_span(diagnostic.span, line, column), ..diagnostic }
}

fn line_column_at_byte_offset(sql: &str, offset: usize) -> (usize, usize) {
    let mut line = 1_usize;
    let mut column = 1_usize;
    for (index, character) in sql.char_indices() {
        if index >= offset {
            break;
        }
        if character == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

fn offset_span(span: SqlTextSpan, line: usize, column: usize) -> SqlTextSpan {
    SqlTextSpan {
        start_line: span.start_line + line - 1,
        start_column: if span.start_line == 1 { span.start_column + column - 1 } else { span.start_column },
        end_line: span.end_line + line - 1,
        end_column: if span.end_line == 1 { span.end_column + column - 1 } else { span.end_column },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_structured_expression_errors_for_target_dialects() {
        for dialect in ["postgres", "mysql", "sqlite"] {
            let sql = "SELECT u.id FROM users u WHERE u.active = AND u.id;";
            let diagnostics = analyze_sql_syntax(sql, Some(dialect));
            assert_eq!(diagnostics.len(), 1, "{dialect}");
            let diagnostic = &diagnostics[0];
            assert_eq!(diagnostic.severity, "error");
            assert!(diagnostic.expected.iter().any(|value| value.contains("expression")), "{dialect}: {diagnostic:?}");
            assert_eq!(diagnostic.found.as_deref(), Some("AND"), "{dialect}: {diagnostic:?}");
            assert_eq!(diagnostic.span.start_column, 43, "{dialect}: {diagnostic:?}");
        }
    }

    #[test]
    fn recovers_independent_errors_in_later_statements() {
        let sql = "SELECT a FROM t WHERE a = AND a = 1;\nSELECT * FROM x WHERE );";
        let diagnostics = analyze_sql_syntax(sql, Some("postgres"));
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0].span.start_line, 1);
        assert_eq!(diagnostics[1].span.start_line, 2);
        assert!(diagnostics[1].span.start_column > 1);
    }

    #[test]
    fn leaves_valid_dialect_specific_sql_untouched() {
        for (dialect, sql) in [
            ("postgres", "DELETE FROM orders WHERE total < 0 RETURNING id, user_id;"),
            ("postgres", "DROP INDEX CONCURRENTLY IF EXISTS orders_idx;"),
            ("mysql", "REPLACE INTO users (id, name) VALUES (1, 'A');"),
            ("mysql", "ALTER TABLE users COMMENT = ' archived ';"),
            (
                "sqlite",
                "INSERT INTO users (id, name) VALUES (1, 'A') ON CONFLICT(id) DO UPDATE SET name = excluded.name;",
            ),
        ] {
            assert_eq!(analyze_sql_syntax(sql, Some(dialect)), vec![], "{dialect}: {sql}");
        }
    }

    #[test]
    fn maps_eof_and_unterminated_strings_to_a_safe_position() {
        let eof = analyze_sql_syntax("SELECT * FROM users WHERE id =", Some("mysql"));
        assert_eq!(eof.len(), 1);
        assert!(eof[0].span.start_column >= 30);
        let unterminated = analyze_sql_syntax("SELECT 'abc", Some("postgres"));
        assert_eq!(unterminated.len(), 1);
        assert!(unterminated[0].message.to_ascii_lowercase().contains("unterminated"));
    }

    #[test]
    fn keeps_crlf_and_unicode_positions_consistent() {
        let sql = "-- 注释 😀\r\nSELECT * FROM users WHERE active = AND id = 1;";
        let diagnostics = analyze_sql_syntax(sql, Some("postgres"));
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].span.start_line, 2);
        assert!(diagnostics[0].span.start_column > 30);
    }
}
