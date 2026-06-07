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

    let sql = if options.database_type == Some(DatabaseType::Postgres) {
        format!("EXPLAIN (FORMAT JSON) {source}")
    } else if options.database_type == Some(DatabaseType::Dameng) {
        format!("EXPLAIN {source}")
    } else {
        format!("EXPLAIN FORMAT=JSON {source}")
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
    matches!(database_type, Some(DatabaseType::Mysql | DatabaseType::Postgres | DatabaseType::Dameng))
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

fn contains_dangerous_sql_keyword(sql: &str) -> bool {
    let source = strip_sql_comments_and_literals(sql).to_lowercase();
    ["drop", "delete", "truncate", "alter", "update", "merge", "replace", "insert", "create"]
        .iter()
        .any(|keyword| contains_word(&source, keyword))
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

fn strip_sql_comments_and_literals(sql: &str) -> String {
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
}
