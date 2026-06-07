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
    matches!(
        database_type,
        Some(DatabaseType::Mysql | DatabaseType::Postgres | DatabaseType::Dameng)
    )
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
