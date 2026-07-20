use serde::{Deserialize, Serialize};
use sqlparser::dialect::{MsSqlDialect, PostgreSqlDialect};
use sqlparser::tokenizer::{Token, Tokenizer};

use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExplainFormat {
    Json,
    Standard,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    /// MySQL supports both a structured JSON plan and the traditional tabular plan.
    /// Omitted formats retain the existing JSON behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ExplainFormat>,
    pub sql: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainSqlBuildResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFilePreviewSqlOptions {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

pub fn build_explain_sql(options: ExplainSqlOptions) -> ExplainSqlBuildResult {
    if !supports_explain_plan(options.database_type) {
        return explain_err("unsupported");
    }

    let source = strip_trailing_semicolons(options.sql.trim());
    if source.is_empty() {
        return explain_err("empty");
    }
    if !is_safe_explain_sql(&source) {
        return explain_err("unsafe");
    }
    if options.database_type == Some(DatabaseType::SqlServer) && crate::sql::split_sql_batches(&source).len() != 1 {
        return explain_err("unsafe");
    }

    let sql = match options.database_type {
        Some(DatabaseType::Postgres | DatabaseType::MongoDb) => {
            format!("EXPLAIN (FORMAT JSON) {source}")
        }
        Some(DatabaseType::Dameng | DatabaseType::Questdb) => {
            format!("EXPLAIN {source}")
        }
        Some(DatabaseType::Oracle) => format!("EXPLAIN PLAN FOR {source}"),
        Some(DatabaseType::SqlServer) => {
            format!("SET SHOWPLAN_XML ON;\nGO\n{source}\nGO\nSET SHOWPLAN_XML OFF;")
        }
        Some(DatabaseType::Mysql) if options.format == Some(ExplainFormat::Standard) => {
            // MySQL 8.0.32+ may otherwise inherit TREE or JSON from the session-level explain_format.
            format!("EXPLAIN FORMAT=TRADITIONAL {source}")
        }
        _ => format!("EXPLAIN FORMAT=JSON {source}"),
    };
    ExplainSqlBuildResult { ok: true, sql: Some(sql), reason: None }
}

pub fn build_dropped_file_preview_sql(options: DroppedFilePreviewSqlOptions) -> Option<String> {
    let lower = options.path.to_lowercase();
    let escaped = options.path.replace('\'', "''");
    let limit = options.limit.unwrap_or(1000).max(1);
    if lower.ends_with(".parquet") {
        return Some(format!("SELECT * FROM read_parquet('{escaped}') LIMIT {limit}"));
    }
    if lower.ends_with(".csv") {
        return Some(format!("SELECT * FROM read_csv('{escaped}') LIMIT {limit}"));
    }
    if lower.ends_with(".tsv") {
        return Some(format!("SELECT * FROM read_csv('{escaped}', delim='\\t') LIMIT {limit}"));
    }
    if lower.ends_with(".json") {
        return Some(format!("SELECT * FROM read_json('{escaped}') LIMIT {limit}"));
    }
    None
}

pub fn supports_explain_plan(database_type: Option<DatabaseType>) -> bool {
    matches!(
        database_type,
        Some(
            DatabaseType::Mysql
                | DatabaseType::Postgres
                | DatabaseType::Questdb
                | DatabaseType::Dameng
                | DatabaseType::Oracle
                | DatabaseType::SqlServer
        )
    )
}

pub fn is_safe_explain_sql(sql: &str) -> bool {
    let source = strip_trailing_semicolons(sql.trim());
    !source.is_empty()
        && !has_extra_statement_after_semicolon(&source)
        && is_safe_explain_source(&source)
        && !contains_dangerous_sql_keyword(&source)
}

/// Returns true for databases that support SQL query execution (execute_query / get_sample_data).
/// Non-SQL databases (Redis, MongoDB, Elasticsearch, InfluxDB, Neo4j, etcd) are excluded.
pub fn supports_sql_query(database_type: DatabaseType) -> bool {
    !matches!(
        database_type,
        DatabaseType::Redis
            | DatabaseType::MongoDb
            | DatabaseType::Elasticsearch
            | DatabaseType::Qdrant
            | DatabaseType::Milvus
            | DatabaseType::Weaviate
            | DatabaseType::ChromaDb
            | DatabaseType::InfluxDb
            | DatabaseType::Neo4j
            | DatabaseType::Etcd
    )
}

pub fn is_safe_dameng_autotrace_sql(sql: &str) -> bool {
    let source = strip_trailing_semicolons(sql.trim());
    if source.is_empty() || has_extra_statement_after_semicolon(&source) {
        return false;
    }
    is_safe_explain_source(&source) && !contains_dangerous_sql_keyword(&source)
}

fn explain_err(reason: &str) -> ExplainSqlBuildResult {
    ExplainSqlBuildResult { ok: false, sql: None, reason: Some(reason.to_string()) }
}

fn strip_trailing_semicolons(sql: &str) -> String {
    sql.trim_end().trim_end_matches(';').trim_end().to_string()
}

fn is_safe_explain_source(sql: &str) -> bool {
    let source = strip_sql_comments(sql).trim_start().to_lowercase();
    ["select", "with", "table", "values"].iter().any(|keyword| {
        source == *keyword || source.starts_with(&format!("{keyword} ")) || source.starts_with(&format!("{keyword}\n"))
    })
}

pub fn contains_dangerous_sql_keyword(sql: &str) -> bool {
    let source = strip_sql_comments_and_literals(sql).to_lowercase();
    ["drop", "delete", "truncate", "alter", "update", "merge", "replace", "insert", "create"]
        .iter()
        .any(|keyword| contains_word(&source, keyword))
}

/// Keywords that start a read-only SQL statement.
/// Note: FROM is a DuckDB-specific read keyword supporting SELECT-less FROM syntax
/// (e.g. `FROM table SELECT *`). In other databases, a statement starting with FROM
/// is invalid and would be rejected by the database itself, so allowing it poses no risk.
///
/// PRAGMA is intentionally NOT in this list because some PRAGMA statements modify
/// database or session state (e.g. SQLite `PRAGMA journal_mode=WAL`). Instead,
/// read-only PRAGMA forms are handled separately in `is_safe_read_pragma`.
const READ_SQL_KEYWORDS: &[&str] = &["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "FROM"];

/// PRAGMA names that are known to be safe read-only queries in SQLite/DuckDB.
/// Only the function-call form `PRAGMA name(args)` matching these names is allowed.
/// Any PRAGMA with assignment (`PRAGMA name = value`) or not in this list is blocked.
const SAFE_READ_PRAGMA_NAMES: &[&str] = &[
    "TABLE_INFO",
    "TABLE_XINFO",
    "INDEX_LIST",
    "INDEX_INFO",
    "FOREIGN_KEY_LIST",
    "DATABASE_LIST",
    "COMPILE_OPTIONS",
    "DATA_VERSION",
];

/// Returns true if the SQL statement is a write operation (not a pure read).
///
/// Callers that know the connection database type should use
/// [`is_write_sql_for_database`] so executable comments are interpreted using
/// the correct dialect. This untyped helper deliberately remains conservative
/// for executable comments.
pub fn is_write_sql(sql: &str) -> bool {
    is_write_sql_with_database_type(sql, None)
}

/// Returns true if the SQL statement is a write operation for a database
/// dialect. In addition to ordinary write statements, this recognizes MySQL
/// executable comments and file exports, plus PostgreSQL-family/SQL Server
/// `SELECT ... INTO` table creation.
pub fn is_write_sql_for_database(sql: &str, database_type: DatabaseType) -> bool {
    is_write_sql_with_database_type(sql, Some(database_type))
}

fn is_write_sql_with_database_type(sql: &str, database_type: Option<DatabaseType>) -> bool {
    if database_type == Some(DatabaseType::SqlServer) && is_sqlserver_showplan_xml_set(sql) {
        return false;
    }
    if database_type.is_some_and(|database_type| has_dialect_specific_write(sql, database_type)) {
        return true;
    }

    // The untyped helper remains conservative for MySQL executable comments.
    // Typed callers handle those comments in has_dialect_specific_write above.
    let detect_mysql_executable_comments = database_type.is_none();
    let detect_select_into = database_type.is_none();
    let statements = match database_type {
        Some(database_type) => crate::sql::split_sql_statements_for_database(sql, database_type),
        None => crate::sql::split_sql_statements(sql),
    };

    statements
        .iter()
        .any(|statement| is_write_sql_statement(statement, detect_mysql_executable_comments, detect_select_into))
}

fn is_sqlserver_showplan_xml_set(sql: &str) -> bool {
    let normalized = strip_sql_comments(sql)
        .split_whitespace()
        .map(|part| part.trim_end_matches(';').to_ascii_uppercase())
        .collect::<Vec<_>>();
    matches!(normalized.as_slice(), [set, showplan, value] if set == "SET" && showplan == "SHOWPLAN_XML" && matches!(value.as_str(), "ON" | "OFF"))
}

fn is_mysql_compatible_database(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::ManticoreSearch
            | DatabaseType::Goldendb
    )
}

fn is_postgresql_family_database(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::Postgres
            | DatabaseType::Redshift
            | DatabaseType::Gaussdb
            | DatabaseType::OpenGauss
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
            | DatabaseType::Kwdb
    )
}

/// Detects write-capable syntax that otherwise looks like a read query and is
/// interpreted differently depending on the database dialect.
pub(crate) fn has_dialect_specific_write(sql: &str, database_type: DatabaseType) -> bool {
    let statements = crate::sql::split_sql_statements_for_database(sql, database_type);
    statements.iter().any(|statement| has_dialect_specific_write_statement(statement, database_type))
}

fn has_dialect_specific_write_statement(sql: &str, database_type: DatabaseType) -> bool {
    if is_mysql_compatible_database(database_type) {
        let (cleaned, has_executable_comment) = strip_sql_comments_and_literals_with_metadata(sql, true);
        return has_executable_comment
            || contains_keyword_sequence(&cleaned, "INTO", "OUTFILE")
            || contains_keyword_sequence(&cleaned, "INTO", "DUMPFILE");
    }

    if is_postgresql_family_database(database_type) {
        contains_unquoted_keyword(sql, &PostgreSqlDialect {}, "INTO")
    } else {
        match database_type {
            DatabaseType::SqlServer => contains_unquoted_keyword(sql, &MsSqlDialect {}, "INTO"),
            _ => false,
        }
    }
}

fn contains_keyword_sequence(sql: &str, first: &str, second: &str) -> bool {
    let words = sql.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_').filter(|word| !word.is_empty());

    let mut previous_matches = false;
    for word in words {
        if previous_matches && word.eq_ignore_ascii_case(second) {
            return true;
        }
        previous_matches = word.eq_ignore_ascii_case(first);
    }
    false
}

fn contains_unquoted_keyword(sql: &str, dialect: &dyn sqlparser::dialect::Dialect, keyword: &str) -> bool {
    Tokenizer::new(dialect, sql).tokenize().is_ok_and(|tokens| {
        tokens.into_iter().any(|token| {
            matches!(token, Token::Word(word) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(keyword))
        })
    })
}

fn is_write_sql_statement(sql: &str, detect_mysql_executable_comments: bool, detect_select_into: bool) -> bool {
    // 1. Strip comments and string literals
    let (cleaned, has_mysql_executable_comment) =
        strip_sql_comments_and_literals_with_metadata(sql, detect_mysql_executable_comments);
    // MySQL/MariaDB executable comments may contain arbitrary SQL, including
    // writes that are not represented by the outer statement (for example,
    // INTO OUTFILE inside a SELECT). Treat them as writes rather than
    // attempting to parse every supported MySQL dialect extension here.
    if has_mysql_executable_comment {
        return true;
    }
    let trimmed = cleaned.trim_start();
    if trimmed.is_empty() {
        return false;
    }
    let upper = trimmed.to_uppercase();

    // 2. Check if first keyword is a read keyword
    let starts_with_read = READ_SQL_KEYWORDS.iter().any(|kw| {
        upper.starts_with(kw) && (upper.len() == kw.len() || !upper.as_bytes()[kw.len()].is_ascii_alphanumeric())
    });

    // 3. Special handling for PRAGMA: only allow safe read-only forms
    if !starts_with_read && starts_with_keyword(&upper, "PRAGMA") {
        return !is_safe_read_pragma(&upper);
    }

    // SHOW CREATE returns object metadata; CREATE is part of its read-only syntax.
    if starts_with_show_create(&upper) {
        return false;
    }

    // Untyped callers stay conservative. Typed callers handle SELECT ... INTO
    // only for database families where the syntax performs a write.
    if detect_select_into && starts_with_keyword(&upper, "SELECT") && select_contains_top_level_into(&upper) {
        return true;
    }

    // A statement is a write if it doesn't start with a read keyword,
    // or if it contains embedded dangerous keywords (e.g. CTE-wrapped writes like WITH ... AS (DELETE FROM ...))
    !starts_with_read || contains_dangerous_sql_keyword(sql)
}

fn starts_with_show_create(upper: &str) -> bool {
    let Some(after_show) = upper.strip_prefix("SHOW") else {
        return false;
    };
    if !after_show.is_empty() && after_show.as_bytes()[0].is_ascii_alphanumeric() {
        return false;
    }
    starts_with_keyword(after_show.trim_start(), "CREATE")
}

fn select_contains_top_level_into(upper: &str) -> bool {
    let mut token = String::new();
    let mut depth = 0usize;
    let mut saw_select = false;

    for ch in upper.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            token.push(ch);
            continue;
        }

        if !token.is_empty() {
            if depth == 0 {
                if token == "SELECT" {
                    saw_select = true;
                } else if saw_select && token == "INTO" {
                    return true;
                }
            }
            token.clear();
        }

        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth = depth.saturating_sub(1);
        }
    }

    false
}

/// Check if a PRAGMA statement is a safe read-only form.
/// Allows: PRAGMA table_info(...), PRAGMA index_list(...), etc.
/// Blocks: PRAGMA name = value, PRAGMA name(value), or unknown PRAGMA names.
fn is_safe_read_pragma(upper_stripped: &str) -> bool {
    // Skip "PRAGMA" keyword to get the rest
    let rest = upper_stripped.strip_prefix("PRAGMA").unwrap_or("").trim_start();

    if rest.is_empty() {
        return false;
    }

    // Extract the pragma name (first word)
    let name_end = rest.find(|c: char| !c.is_ascii_alphanumeric() && c != '_').unwrap_or(rest.len());
    let pragma_name = &rest[..name_end];

    // Check if it's in the safe list
    if !SAFE_READ_PRAGMA_NAMES.contains(&pragma_name) {
        return false;
    }

    // Check the form after the name: must be function-call style "(...)" or end of statement
    let after_name = rest[name_end..].trim_start();
    if after_name.is_empty() {
        // PRAGMA table_info (no args) — safe
        return true;
    }
    if after_name.starts_with('(') {
        // PRAGMA table_info(users) — safe read form
        return true;
    }
    // PRAGMA table_info = something or other unsafe form — blocked
    false
}

fn starts_with_keyword(upper: &str, keyword: &str) -> bool {
    upper.starts_with(keyword)
        && (upper.len() == keyword.len() || !upper.as_bytes()[keyword.len()].is_ascii_alphanumeric())
}

/// Check whether a SQL statement is allowed under read-only mode.
/// Returns Err with a descriptive message if the statement is a write operation.
pub fn check_read_only(sql: &str, connection_name: &str, database_type: DatabaseType) -> Result<(), String> {
    if is_write_sql_for_database(sql, database_type) {
        return Err(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. Write operation (including stored procedure calls) blocked.",
            connection_name
        ));
    }
    Ok(())
}

fn contains_word(source: &str, word: &str) -> bool {
    let bytes = source.as_bytes();
    let word_bytes = word.as_bytes();
    if word_bytes.is_empty() || bytes.len() < word_bytes.len() {
        return false;
    }

    for idx in 0..=bytes.len() - word_bytes.len() {
        if &bytes[idx..idx + word_bytes.len()] != word_bytes {
            continue;
        }
        let before = idx.checked_sub(1).and_then(|i| bytes.get(i)).copied();
        let after = bytes.get(idx + word_bytes.len()).copied();
        if !is_identifier_byte(before) && !is_identifier_byte(after) {
            return true;
        }
    }
    false
}

fn is_identifier_byte(byte: Option<u8>) -> bool {
    byte.is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn has_extra_statement_after_semicolon(sql: &str) -> bool {
    let stripped = strip_sql_comments_and_literals(sql);
    stripped.split(';').skip(1).any(|part| !part.trim().is_empty())
}

pub(crate) fn strip_sql_comments(sql: &str) -> String {
    let mut output = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while let Some(ch) = chars.next() {
        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
                output.push(' ');
            }
            continue;
        }

        if in_block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
                output.push(' ');
            }
            continue;
        }

        if ch == '-' && chars.peek() == Some(&'-') {
            chars.next();
            in_line_comment = true;
            continue;
        }
        if ch == '#' {
            in_line_comment = true;
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            if let Some(body) = read_mysql_executable_comment_body(&mut chars) {
                output.push(' ');
                output.push_str(&strip_sql_comments(&body));
                output.push(' ');
            } else {
                in_block_comment = true;
            }
            continue;
        }

        output.push(ch);
    }

    output
}

pub fn strip_sql_comments_and_literals(sql: &str) -> String {
    strip_sql_comments_and_literals_with_metadata(sql, false).0
}

fn strip_sql_comments_and_literals_with_metadata(sql: &str, detect_mysql_executable_comments: bool) -> (String, bool) {
    let mut output = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut in_backtick_quote = false;
    let mut has_mysql_executable_comment = false;

    while let Some(ch) = chars.next() {
        if in_line_comment {
            if ch == '\n' {
                in_line_comment = false;
                output.push(' ');
            }
            continue;
        }

        if in_block_comment {
            if ch == '*' && chars.peek() == Some(&'/') {
                chars.next();
                in_block_comment = false;
                output.push(' ');
            }
            continue;
        }

        if in_single_quote {
            if ch == '\'' {
                if chars.peek() == Some(&'\'') {
                    chars.next();
                } else {
                    in_single_quote = false;
                }
            }
            output.push(' ');
            continue;
        }

        if in_double_quote {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                } else {
                    in_double_quote = false;
                }
            }
            output.push(' ');
            continue;
        }

        if in_backtick_quote {
            if ch == '`' {
                if chars.peek() == Some(&'`') {
                    chars.next();
                } else {
                    in_backtick_quote = false;
                }
            }
            output.push(' ');
            continue;
        }

        if ch == '-' && chars.peek() == Some(&'-') {
            chars.next();
            in_line_comment = true;
            continue;
        }
        if ch == '#' {
            in_line_comment = true;
            continue;
        }
        if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            if detect_mysql_executable_comments && is_mysql_executable_comment_start(&chars) {
                has_mysql_executable_comment = true;
            }
            in_block_comment = true;
            continue;
        }
        if ch == '\'' {
            in_single_quote = true;
            output.push(' ');
            continue;
        }
        if ch == '"' {
            in_double_quote = true;
            output.push(' ');
            continue;
        }
        if ch == '`' {
            in_backtick_quote = true;
            output.push(' ');
            continue;
        }

        output.push(ch);
    }

    (output, has_mysql_executable_comment)
}

/// `/*! ... */` is executable in MySQL, while `/*M! ... */` (optionally
/// followed by a version number) is executable in MariaDB.
fn is_mysql_executable_comment_start(chars: &std::iter::Peekable<std::str::Chars<'_>>) -> bool {
    let mut marker = chars.clone();
    match marker.next() {
        Some('!') => true,
        Some('M') => marker.next() == Some('!'),
        _ => false,
    }
}

fn read_mysql_executable_comment_body<I>(chars: &mut std::iter::Peekable<I>) -> Option<String>
where
    I: Iterator<Item = char>,
{
    let marker = chars.peek().copied()?;
    if marker == '!' {
        chars.next();
    } else if marker == 'M' {
        chars.next();
        if chars.peek() != Some(&'!') {
            return None;
        }
        chars.next();
    } else {
        return None;
    }

    let mut body = String::new();
    let mut skipping_version = true;
    while let Some(ch) = chars.next() {
        if ch == '*' && chars.peek() == Some(&'/') {
            chars.next();
            return Some(body);
        }
        if skipping_version && (ch.is_ascii_digit() || ch.is_whitespace()) {
            continue;
        }
        skipping_version = false;
        body.push(ch);
    }
    Some(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_postgres_json_explain_sql() {
        let result = build_explain_sql(ExplainSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            format: None,
            sql: " select * from users where id = 1; ".to_string(),
        });

        assert_eq!(
            result,
            ExplainSqlBuildResult {
                ok: true,
                sql: Some("EXPLAIN (FORMAT JSON) select * from users where id = 1".to_string()),
                reason: None,
            }
        );
    }

    #[test]
    fn builds_dameng_explain_sql() {
        let result = build_explain_sql(ExplainSqlOptions {
            database_type: Some(DatabaseType::Dameng),
            format: None,
            sql: "SELECT * FROM t1 WHERE id = 1".to_string(),
        });

        assert_eq!(
            result,
            ExplainSqlBuildResult {
                ok: true,
                sql: Some("EXPLAIN SELECT * FROM t1 WHERE id = 1".to_string()),
                reason: None,
            }
        );
    }

    #[test]
    fn builds_oracle_explain_plan_sql() {
        let result = build_explain_sql(ExplainSqlOptions {
            database_type: Some(DatabaseType::Oracle),
            format: None,
            sql: "WITH rows AS (SELECT 1 AS id FROM dual) SELECT * FROM rows;".to_string(),
        });

        assert_eq!(
            result,
            ExplainSqlBuildResult {
                ok: true,
                sql: Some("EXPLAIN PLAN FOR WITH rows AS (SELECT 1 AS id FROM dual) SELECT * FROM rows".to_string()),
                reason: None,
            }
        );
    }

    #[test]
    fn builds_sqlserver_showplan_xml_batches() {
        let result = build_explain_sql(ExplainSqlOptions {
            database_type: Some(DatabaseType::SqlServer),
            format: None,
            sql: "WITH rows AS (SELECT 1 AS id) SELECT * FROM rows;".to_string(),
        });

        assert_eq!(
            result,
            ExplainSqlBuildResult {
                ok: true,
                sql: Some(
                    "SET SHOWPLAN_XML ON;\nGO\nWITH rows AS (SELECT 1 AS id) SELECT * FROM rows\nGO\nSET SHOWPLAN_XML OFF;"
                        .to_string()
                ),
                reason: None,
            }
        );

        assert_eq!(
            build_explain_sql(ExplainSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                format: None,
                sql: "SELECT 1\nGO\nSELECT 2".to_string(),
            }),
            ExplainSqlBuildResult { ok: false, sql: None, reason: Some("unsafe".to_string()) }
        );
        assert!(
            build_explain_sql(ExplainSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                format: None,
                sql: "SELECT 'first line\nGO\nlast line' AS text".to_string(),
            })
            .ok
        );
    }

    #[test]
    fn validates_dameng_autotrace_sql_safety() {
        assert!(is_safe_dameng_autotrace_sql("SELECT * FROM t WHERE name = 'delete';"));
        assert!(is_safe_dameng_autotrace_sql("/* comment */ WITH q AS (SELECT 1) SELECT * FROM q"));
        assert!(!is_safe_dameng_autotrace_sql("SELECT * FROM t; DELETE FROM t"));
        assert!(!is_safe_dameng_autotrace_sql("UPDATE t SET name = 'x'"));
        assert!(!is_safe_dameng_autotrace_sql("SELECT * FROM t; /* hidden */ DROP TABLE t"));
        assert!(!is_safe_dameng_autotrace_sql(""));
    }

    #[test]
    fn builds_mysql_json_explain_and_rejects_unsafe_sql() {
        assert_eq!(
            build_explain_sql(ExplainSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                format: None,
                sql: "SELECT * FROM users;".to_string(),
            }),
            ExplainSqlBuildResult {
                ok: true,
                sql: Some("EXPLAIN FORMAT=JSON SELECT * FROM users".to_string()),
                reason: None,
            }
        );

        assert_eq!(
            build_explain_sql(ExplainSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                format: None,
                sql: "delete from users".to_string(),
            }),
            ExplainSqlBuildResult { ok: false, sql: None, reason: Some("unsafe".to_string()) }
        );

        assert_eq!(
            build_explain_sql(ExplainSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                format: None,
                sql: "SELECT * FROM users; DELETE FROM users".to_string(),
            }),
            ExplainSqlBuildResult { ok: false, sql: None, reason: Some("unsafe".to_string()) }
        );

        assert_eq!(
            build_explain_sql(ExplainSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                format: Some(ExplainFormat::Standard),
                sql: "SELECT * FROM users;".to_string(),
            }),
            ExplainSqlBuildResult {
                ok: true,
                sql: Some("EXPLAIN FORMAT=TRADITIONAL SELECT * FROM users".to_string()),
                reason: None,
            }
        );
    }

    #[test]
    fn builds_dropped_file_preview_sql() {
        assert_eq!(
            build_dropped_file_preview_sql(DroppedFilePreviewSqlOptions {
                path: "/tmp/O'Hara.csv".to_string(),
                limit: Some(25),
            }),
            Some("SELECT * FROM read_csv('/tmp/O''Hara.csv') LIMIT 25".to_string())
        );
        assert_eq!(
            build_dropped_file_preview_sql(DroppedFilePreviewSqlOptions {
                path: "/tmp/data.tsv".to_string(),
                limit: None,
            }),
            Some("SELECT * FROM read_csv('/tmp/data.tsv', delim='\\t') LIMIT 1000".to_string())
        );
        assert_eq!(
            build_dropped_file_preview_sql(DroppedFilePreviewSqlOptions {
                path: "/tmp/data.txt".to_string(),
                limit: None,
            }),
            None
        );
    }

    #[test]
    fn strip_sql_comments_and_literals_basic() {
        assert_eq!(strip_sql_comments_and_literals("SELECT 1"), "SELECT 1");
        assert_eq!(strip_sql_comments_and_literals("SELECT 'hello'"), "SELECT        ");
        assert_eq!(strip_sql_comments_and_literals("SELECT \"hello\""), "SELECT        ");
        assert_eq!(strip_sql_comments_and_literals("-- comment\nSELECT 1"), " SELECT 1");
        assert_eq!(strip_sql_comments_and_literals("/* block */ SELECT 1"), "  SELECT 1");
        assert_eq!(strip_sql_comments_and_literals("# comment\nSELECT 1"), " SELECT 1");
    }

    #[test]
    fn strip_sql_comments_and_literals_nested() {
        // String literals containing comments should be stripped
        assert_eq!(strip_sql_comments_and_literals("SELECT '/* not a comment */'"), "SELECT                      ");
        // Comments containing string delimiters should be stripped
        assert_eq!(strip_sql_comments_and_literals("/* 'not a string' */ SELECT 1"), "  SELECT 1");
    }

    #[test]
    fn contains_dangerous_sql_keyword_detects_writes() {
        assert!(contains_dangerous_sql_keyword("DROP TABLE users"));
        assert!(contains_dangerous_sql_keyword("DELETE FROM users"));
        assert!(contains_dangerous_sql_keyword("TRUNCATE TABLE users"));
        assert!(contains_dangerous_sql_keyword("ALTER TABLE users ADD COLUMN age INT"));
        assert!(contains_dangerous_sql_keyword("UPDATE users SET name = 'x'"));
        assert!(contains_dangerous_sql_keyword("MERGE INTO target USING source"));
        assert!(contains_dangerous_sql_keyword("REPLACE INTO users VALUES (1)"));
        assert!(contains_dangerous_sql_keyword("INSERT INTO users VALUES (1)"));
        assert!(contains_dangerous_sql_keyword("CREATE TABLE users (id INT)"));
    }

    #[test]
    fn contains_dangerous_sql_keyword_ignores_substrings() {
        // "updateable" contains "update" as substring but is a different word
        assert!(!contains_dangerous_sql_keyword("SELECT * FROM updateable_view"));
        // "dropped" contains "drop" as substring
        assert!(!contains_dangerous_sql_keyword("SELECT dropped FROM t"));
        // "inserted" contains "insert"
        assert!(!contains_dangerous_sql_keyword("SELECT inserted FROM t"));
    }

    #[test]
    fn contains_dangerous_sql_keyword_ignores_in_string_literals() {
        assert!(!contains_dangerous_sql_keyword("SELECT 'DROP TABLE users' FROM t"));
        assert!(!contains_dangerous_sql_keyword("SELECT 'delete' FROM t"));
        assert!(!contains_dangerous_sql_keyword("SELECT \"CREATE TABLE\" FROM t"));
    }

    #[test]
    fn contains_dangerous_sql_keyword_ignores_backtick_identifiers() {
        for keyword in ["drop", "delete", "truncate", "alter", "update", "merge", "replace", "insert", "create"] {
            let sql = format!("SELECT 1 AS `{keyword}`");
            assert!(!contains_dangerous_sql_keyword(&sql), "expected safe SQL: {sql}");
        }
        assert!(!contains_dangerous_sql_keyword("SELECT 1 AS `before``delete`"));
    }

    #[test]
    fn is_write_sql_detects_simple_writes() {
        assert!(is_write_sql("INSERT INTO users VALUES (1)"));
        assert!(is_write_sql("UPDATE users SET name = 'x'"));
        assert!(is_write_sql("DELETE FROM users"));
        assert!(is_write_sql("DROP TABLE users"));
        assert!(is_write_sql("CREATE TABLE users (id INT)"));
        assert!(is_write_sql("ALTER TABLE users ADD COLUMN age INT"));
        assert!(is_write_sql("TRUNCATE TABLE users"));
        assert!(is_write_sql("EXPLAIN ANALYZE DELETE FROM users"));
        assert!(is_write_sql("SELECT * INTO backup_users FROM users"));
        assert!(is_write_sql("SELECT * FROM users INTO OUTFILE '/tmp/users.csv'"));
        assert!(is_write_sql("COPY users FROM '/tmp/users.csv'"));
        assert!(is_write_sql("/*! DELETE FROM users */"));
        assert!(is_write_sql(
            "MERGE INTO target USING source ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.name = s.name"
        ));
        assert!(is_write_sql("REPLACE INTO users VALUES (1)"));
    }

    #[test]
    fn is_write_sql_allows_reads() {
        assert!(!is_write_sql("SELECT * FROM users"));
        assert!(!is_write_sql("SELECT id, name FROM users WHERE active = true"));
        assert!(!is_write_sql("WITH cte AS (SELECT 1) SELECT * FROM cte"));
        assert!(!is_write_sql("SHOW TABLES"));
        assert!(!is_write_sql("DESCRIBE users"));
        assert!(!is_write_sql("DESC users"));
        assert!(!is_write_sql("EXPLAIN SELECT * FROM users"));
        assert!(!is_write_sql("PRAGMA table_info(users)"));
        assert!(!is_write_sql("FROM users SELECT *"));
    }

    #[test]
    fn is_write_sql_allows_backtick_identifiers_with_dangerous_keywords() {
        for keyword in ["drop", "delete", "truncate", "alter", "update", "merge", "replace", "insert", "create"] {
            let sql = format!("SELECT 1 AS `{keyword}`");
            assert!(!is_write_sql(&sql), "expected read-only SQL: {sql}");
        }
        assert!(!is_write_sql("SHOW COLUMNS FROM `delete`"));
        assert!(!is_write_sql("DESC `delete`"));
        assert!(!is_write_sql("SELECT 1 AS `before``delete`"));
        assert!(!is_write_sql("SELECT 1 AS `semi;delete`; SELECT 2"));
    }

    #[test]
    fn is_write_sql_still_blocks_writes_with_backtick_identifiers() {
        assert!(is_write_sql("DELETE FROM `users`"));
        assert!(is_write_sql("DROP TABLE `users`"));
        assert!(is_write_sql("UPDATE `users` SET name = 'Ada'"));
    }

    #[test]
    fn is_write_sql_allows_show_create_statements() {
        for sql in [
            "SHOW CREATE TABLE users",
            "show create view active_users",
            "SHOW CREATE PROCEDURE refresh_users",
            "SHOW CREATE FUNCTION user_count",
            "  /* metadata */\nSHOW\nCREATE TABLE users;",
            "SHOW CREATE TABLE users; SELECT ';' AS separator",
            "SHOW CREATE TABLE users /* ; DELETE FROM users */",
        ] {
            assert!(!is_write_sql(sql), "expected read-only SQL: {sql}");
        }
    }

    #[test]
    fn is_write_sql_blocks_writes_after_show_create() {
        for write_sql in [
            "DROP TABLE users",
            "DELETE FROM users",
            "TRUNCATE TABLE users",
            "ALTER TABLE users ADD COLUMN active BOOLEAN",
            "UPDATE users SET active = true",
            "MERGE INTO users USING source ON users.id = source.id WHEN MATCHED THEN UPDATE SET active = true",
            "REPLACE INTO users VALUES (1)",
            "INSERT INTO users VALUES (1)",
            "CREATE TABLE audit (id INT)",
        ] {
            let sql = format!("SHOW CREATE TABLE users; {write_sql}");
            assert!(is_write_sql(&sql), "expected write SQL: {sql}");
        }
    }

    #[test]
    fn is_write_sql_ignores_leading_whitespace_and_comments() {
        assert!(!is_write_sql("   /* comment */ SELECT * FROM users"));
        assert!(!is_write_sql("-- comment\nSELECT * FROM users"));
        assert!(is_write_sql("   /* comment */ INSERT INTO users VALUES (1)"));
    }

    #[test]
    fn is_write_sql_blocks_mysql_and_mariadb_executable_comments() {
        for sql in [
            "SELECT 3156 /*! INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */",
            "SELECT 3156 /*!50000 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */",
            "SELECT 3156 /*M! INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */",
            "SELECT 3156 /*M!100100 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */",
        ] {
            assert!(is_write_sql_for_database(sql, DatabaseType::Mysql), "expected write SQL: {sql}");
        }

        assert!(!is_write_sql_for_database(
            "SELECT 3156 /* INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */",
            DatabaseType::Mysql
        ));
        assert!(!is_write_sql_for_database(
            "SELECT '/*!50000 INTO OUTFILE \'/tmp/probe\' */' AS note",
            DatabaseType::Mysql
        ));
    }

    #[test]
    fn is_write_sql_treats_mysql_executable_comment_syntax_as_plain_for_other_dialects() {
        for database_type in [DatabaseType::Postgres, DatabaseType::Sqlite] {
            for sql in [
                "SELECT 3156 /*!50000 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */",
                "SELECT 3156 /*M!100100 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */",
                "SELECT 3156 /* ordinary block comment */",
            ] {
                assert!(
                    !is_write_sql_for_database(sql, database_type),
                    "expected read-only SQL for {database_type:?}: {sql}"
                );
            }
        }
    }

    #[test]
    fn is_write_sql_blocks_dialect_specific_select_into_writes() {
        for sql in [
            "SELECT 3156 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt'",
            "SELECT 3156 INTO DUMPFILE '/var/lib/mysql-files/dbx_ro_probe.bin'",
            "WITH probe AS (SELECT 3156) SELECT * FROM probe INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt'",
        ] {
            assert!(is_write_sql_for_database(sql, DatabaseType::Mysql), "expected write SQL: {sql}");
        }

        for database_type in [
            DatabaseType::Postgres,
            DatabaseType::Redshift,
            DatabaseType::Gaussdb,
            DatabaseType::OpenGauss,
            DatabaseType::Kingbase,
            DatabaseType::Highgo,
            DatabaseType::Vastbase,
            DatabaseType::Kwdb,
        ] {
            for sql in [
                "SELECT * INTO copied_users FROM users",
                "WITH active AS (SELECT * FROM users WHERE active) SELECT * INTO active_users FROM active",
            ] {
                assert!(
                    is_write_sql_for_database(sql, database_type),
                    "expected write SQL for {database_type:?}: {sql}"
                );
            }
        }

        for sql in [
            "SELECT * INTO dbo.copied_users FROM dbo.users",
            "WITH active AS (SELECT * FROM users WHERE active = 1) SELECT * INTO #active_users FROM active",
        ] {
            assert!(is_write_sql_for_database(sql, DatabaseType::SqlServer), "expected write SQL: {sql}");
        }
    }

    #[test]
    fn is_write_sql_does_not_globally_block_into() {
        for sql in [
            "SELECT 3156 INTO @probe",
            "SELECT 'INTO OUTFILE /tmp/probe' AS note",
            "SELECT 3156 /* INTO OUTFILE '/tmp/probe' */",
            "SELECT 1 AS `into`, 2 AS `outfile`",
        ] {
            assert!(!is_write_sql_for_database(sql, DatabaseType::Mysql), "expected read-only SQL: {sql}");
        }

        for sql in
            ["SELECT 'INTO copied_users' AS note", "SELECT $$INTO copied_users$$ AS note", "SELECT 1 AS \"into\""]
        {
            assert!(!is_write_sql_for_database(sql, DatabaseType::Postgres), "expected read-only SQL: {sql}");
        }

        assert!(!is_write_sql_for_database("SELECT 1 AS [into]", DatabaseType::SqlServer));
        assert!(!is_write_sql_for_database("SELECT 1 INTO unsupported", DatabaseType::Sqlite));
    }

    #[test]
    fn is_write_sql_cte_with_nested_write() {
        // CTE starting with WITH but containing a write operation inside
        assert!(is_write_sql("WITH deleted AS (DELETE FROM users RETURNING id) SELECT * FROM deleted"));
        assert!(is_write_sql("WITH updated AS (UPDATE users SET name = 'x' RETURNING id) SELECT * FROM updated"));
        assert!(is_write_sql("WITH inserted AS (INSERT INTO users VALUES (1) RETURNING id) SELECT * FROM inserted"));
        // Pure read CTE should be allowed
        assert!(!is_write_sql("WITH cte AS (SELECT * FROM users) SELECT * FROM cte"));
    }

    #[test]
    fn is_write_sql_case_insensitive() {
        assert!(!is_write_sql("select * from users"));
        assert!(!is_write_sql("Select * From users"));
        assert!(is_write_sql("insert into users values (1)"));
        assert!(is_write_sql("Insert Into users Values (1)"));
        assert!(is_write_sql("update users set name = 'x'"));
    }

    #[test]
    fn is_write_sql_edge_cases() {
        assert!(!is_write_sql("")); // empty string -> not a write
        assert!(!is_write_sql("   ")); // whitespace only -> not a write
        assert!(is_write_sql("COMMIT")); // not a recognized read keyword
        assert!(is_write_sql("ROLLBACK")); // not a recognized read keyword
        assert!(is_write_sql("BEGIN")); // not a recognized read keyword
        assert!(is_write_sql("GRANT SELECT ON users TO admin"));
        assert!(is_write_sql("REVOKE SELECT ON users FROM admin"));
    }

    #[test]
    fn is_write_sql_blocks_stored_procedure_calls() {
        // CALL and EXEC don't start with a read keyword, so they are treated as writes
        assert!(is_write_sql("CALL my_procedure(1, 2)"));
        assert!(is_write_sql("call my_procedure()"));
        assert!(is_write_sql("EXEC sp_update_stats"));
        assert!(is_write_sql("EXECUTE sp_rename 'old', 'new'"));
        assert!(is_write_sql("execute my_func()"));
    }

    #[test]
    fn is_write_sql_allows_safe_read_pragmas() {
        // Read-only PRAGMA forms (function-call style with known safe names) are allowed
        assert!(!is_write_sql("PRAGMA table_info(users)"));
        assert!(!is_write_sql("PRAGMA table_xinfo(users)"));
        assert!(!is_write_sql("PRAGMA index_list(users)"));
        assert!(!is_write_sql("PRAGMA index_info(idx_name)"));
        assert!(!is_write_sql("PRAGMA foreign_key_list(users)"));
        assert!(!is_write_sql("PRAGMA database_list"));
        assert!(!is_write_sql("PRAGMA compile_options"));
        assert!(!is_write_sql("PRAGMA data_version"));
        assert!(!is_write_sql("pragma table_info(users)"));
    }

    #[test]
    fn is_write_sql_blocks_unsafe_pragmas() {
        // Assignment forms are always blocked
        assert!(is_write_sql("PRAGMA journal_mode = WAL"));
        assert!(is_write_sql("PRAGMA synchronous = OFF"));
        assert!(is_write_sql("PRAGMA foreign_keys = ON"));
        assert!(is_write_sql("PRAGMA cache_size = -2000"));
        assert!(is_write_sql("PRAGMA user_version = 123"));
        // Unknown PRAGMA names are blocked
        assert!(is_write_sql("PRAGMA writable_schema = ON"));
        assert!(is_write_sql("PRAGMA locking_mode = EXCLUSIVE"));
        assert!(is_write_sql("PRAGMA temp_store = MEMORY"));
        assert!(is_write_sql("PRAGMA some_unknown_pragma"));
    }

    #[test]
    fn is_write_sql_string_literal_hides_keywords() {
        // The dangerous keyword is inside a string literal, so it should NOT be detected
        assert!(!is_write_sql("SELECT 'DROP TABLE users' AS hint FROM t"));
        assert!(!is_write_sql("SELECT * FROM t WHERE name = 'delete'"));
    }

    #[test]
    fn check_read_only_success_and_error() {
        assert_eq!(check_read_only("SELECT * FROM users", "prod-db", DatabaseType::Mysql), Ok(()));
        assert_eq!(check_read_only("WITH cte AS (SELECT 1) SELECT * FROM cte", "prod-db", DatabaseType::Mysql), Ok(()));
        assert_eq!(check_read_only("SHOW CREATE TABLE users", "prod-db", DatabaseType::Mysql), Ok(()));
        assert_eq!(check_read_only("SELECT 1 AS `delete`", "prod-db", DatabaseType::Mysql), Ok(()));

        let err = check_read_only("DELETE FROM users", "prod-db", DatabaseType::Mysql);
        assert!(err.is_err());
        assert_eq!(
            err.unwrap_err(),
            "Read-only mode: connection 'prod-db' has read-only protection enabled. Write operation (including stored procedure calls) blocked."
        );

        let err2 = check_read_only("UPDATE users SET name = 'x'", "reporting-db", DatabaseType::Mysql);
        assert!(err2.is_err());
        assert!(err2.unwrap_err().contains("reporting-db"));

        let show_create_err =
            check_read_only("SHOW CREATE TABLE users; DELETE FROM users", "prod-db", DatabaseType::Mysql);
        assert!(show_create_err.is_err());
        assert!(show_create_err.unwrap_err().contains("Write operation"));
    }

    #[test]
    fn check_read_only_allows_only_sqlserver_showplan_xml_session_switches() {
        for sql in ["SET SHOWPLAN_XML ON;", "-- explain\nSET SHOWPLAN_XML OFF"] {
            assert_eq!(check_read_only(sql, "readonly", DatabaseType::SqlServer), Ok(()));
        }
        assert!(check_read_only("SET SHOWPLAN_ALL ON", "readonly", DatabaseType::SqlServer).is_err());
        assert!(check_read_only("SET SHOWPLAN_XML ON; SELECT 1", "readonly", DatabaseType::SqlServer).is_err());
        assert!(check_read_only("SET SHOWPLAN_XML OFF; DROP TABLE users", "readonly", DatabaseType::SqlServer).is_err());
    }

    #[test]
    fn check_read_only_only_treats_executable_comments_as_writes_for_mysql_compatible_connections() {
        let mysql_executable_comment = "SELECT 3156 /*!50000 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */";
        let mariadb_executable_comment =
            "SELECT 3156 /*M!100100 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */";

        assert!(check_read_only(mysql_executable_comment, "mysql", DatabaseType::Mysql).is_err());
        assert!(check_read_only(mariadb_executable_comment, "mariadb", DatabaseType::Mysql).is_err());

        for database_type in [DatabaseType::Postgres, DatabaseType::Sqlite] {
            assert_eq!(check_read_only(mysql_executable_comment, "readonly", database_type), Ok(()));
            assert_eq!(check_read_only(mariadb_executable_comment, "readonly", database_type), Ok(()));
        }
    }

    #[test]
    fn check_read_only_blocks_dialect_specific_select_into_writes() {
        for (sql, database_type) in [
            ("SELECT 3156 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt'", DatabaseType::Mysql),
            ("SELECT * INTO copied_users FROM users", DatabaseType::Postgres),
            ("SELECT * INTO copied_users FROM users", DatabaseType::Redshift),
            ("SELECT * INTO copied_users FROM users", DatabaseType::Gaussdb),
            ("SELECT * INTO copied_users FROM users", DatabaseType::OpenGauss),
            ("SELECT * INTO copied_users FROM users", DatabaseType::Kingbase),
            ("SELECT * INTO copied_users FROM users", DatabaseType::Highgo),
            ("SELECT * INTO copied_users FROM users", DatabaseType::Vastbase),
            ("SELECT * INTO copied_users FROM users", DatabaseType::Kwdb),
            ("SELECT * INTO #copied_users FROM users", DatabaseType::SqlServer),
        ] {
            assert!(check_read_only(sql, "readonly", database_type).is_err(), "expected blocked SQL: {sql}");
        }
    }

    #[test]
    fn strip_sql_comments_basic() {
        assert_eq!(strip_sql_comments("SELECT 1"), "SELECT 1");
        assert_eq!(strip_sql_comments("-- comment\nSELECT 1"), " SELECT 1");
        assert_eq!(strip_sql_comments("/* block */ SELECT 1"), "  SELECT 1");
        assert_eq!(strip_sql_comments("# comment\nSELECT 1"), " SELECT 1");
    }

    #[test]
    fn strip_sql_comments_preserves_strings() {
        // strip_sql_comments does NOT handle string delimiters, so it strips
        // comments even inside string literals
        assert_eq!(strip_sql_comments("SELECT 'hello /* not a comment */'"), "SELECT 'hello  '");
    }
}
