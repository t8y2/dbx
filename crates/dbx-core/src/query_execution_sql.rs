use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
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
    if !is_safe_explain_source(&source) {
        return explain_err("unsafe");
    }

    let sql = match options.database_type {
        Some(DatabaseType::Postgres | DatabaseType::MongoDb) => {
            format!("EXPLAIN (FORMAT JSON) {source}")
        }
        Some(DatabaseType::Dameng | DatabaseType::Questdb) => {
            format!("EXPLAIN {source}")
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
        Some(DatabaseType::Mysql | DatabaseType::Postgres | DatabaseType::Questdb | DatabaseType::Dameng)
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
pub fn is_write_sql(sql: &str) -> bool {
    // 1. Strip comments and string literals
    let cleaned = strip_sql_comments_and_literals(sql);
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

    // A statement is a write if it doesn't start with a read keyword,
    // or if it contains embedded dangerous keywords (e.g. CTE-wrapped writes like WITH ... AS (DELETE FROM ...))
    !starts_with_read || contains_dangerous_sql_keyword(sql)
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
pub fn check_read_only(sql: &str, connection_name: &str) -> Result<(), String> {
    if is_write_sql(sql) {
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

fn strip_sql_comments(sql: &str) -> String {
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
            in_block_comment = true;
            continue;
        }

        output.push(ch);
    }

    output
}

pub fn strip_sql_comments_and_literals(sql: &str) -> String {
    let mut output = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut in_single_quote = false;
    let mut in_double_quote = false;

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

        output.push(ch);
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_postgres_json_explain_sql() {
        let result = build_explain_sql(ExplainSqlOptions {
            database_type: Some(DatabaseType::Postgres),
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
                sql: "delete from users".to_string(),
            }),
            ExplainSqlBuildResult { ok: false, sql: None, reason: Some("unsafe".to_string()) }
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
    fn is_write_sql_detects_simple_writes() {
        assert!(is_write_sql("INSERT INTO users VALUES (1)"));
        assert!(is_write_sql("UPDATE users SET name = 'x'"));
        assert!(is_write_sql("DELETE FROM users"));
        assert!(is_write_sql("DROP TABLE users"));
        assert!(is_write_sql("CREATE TABLE users (id INT)"));
        assert!(is_write_sql("ALTER TABLE users ADD COLUMN age INT"));
        assert!(is_write_sql("TRUNCATE TABLE users"));
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
    fn is_write_sql_ignores_leading_whitespace_and_comments() {
        assert!(!is_write_sql("   /* comment */ SELECT * FROM users"));
        assert!(!is_write_sql("-- comment\nSELECT * FROM users"));
        assert!(is_write_sql("   /* comment */ INSERT INTO users VALUES (1)"));
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
        assert_eq!(check_read_only("SELECT * FROM users", "prod-db"), Ok(()));
        assert_eq!(check_read_only("WITH cte AS (SELECT 1) SELECT * FROM cte", "prod-db"), Ok(()));

        let err = check_read_only("DELETE FROM users", "prod-db");
        assert!(err.is_err());
        assert_eq!(
            err.unwrap_err(),
            "Read-only mode: connection 'prod-db' has read-only protection enabled. Write operation (including stored procedure calls) blocked."
        );

        let err2 = check_read_only("UPDATE users SET name = 'x'", "reporting-db");
        assert!(err2.is_err());
        assert!(err2.unwrap_err().contains("reporting-db"));
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
