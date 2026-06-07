use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::connection::DatabaseType;
use crate::sql_dialect::{qualified_table_name, quote_table_identifier, uses_fetch_first};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DatabaseSearchColumn {
    pub name: String,
    pub data_type: String,
    #[serde(default)]
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSearchSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub columns: Vec<DatabaseSearchColumn>,
    pub term: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSearchSql {
    pub sql: String,
    pub searchable_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultWhereOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default)]
    pub columns: Vec<DatabaseSearchColumn>,
    #[serde(default)]
    pub result_columns: Vec<String>,
    #[serde(default)]
    pub row: Vec<Value>,
    #[serde(default)]
    pub matched_columns: Vec<String>,
}

const TEXT_TYPES: &[&str] =
    &["char", "text", "clob", "varchar", "nvarchar", "nchar", "uuid", "uniqueidentifier", "enum"];
const NUMBER_TYPES: &[&str] = &["int", "serial", "number", "numeric", "decimal", "float", "double", "real", "money"];
const SKIPPED_TYPES: &[&str] = &["blob", "binary", "bytea", "image", "geometry", "geography"];

pub fn is_text_search_column(column: &DatabaseSearchColumn) -> bool {
    let data_type = column.data_type.to_ascii_lowercase();
    if SKIPPED_TYPES.iter().any(|skipped| data_type.contains(skipped)) {
        return false;
    }
    TEXT_TYPES.iter().any(|text_type| data_type.contains(text_type))
}

pub fn is_numeric_search_column(column: &DatabaseSearchColumn) -> bool {
    let data_type = column.data_type.to_ascii_lowercase();
    if SKIPPED_TYPES.iter().any(|skipped| data_type.contains(skipped)) {
        return false;
    }
    NUMBER_TYPES.iter().any(|number_type| data_type.contains(number_type))
}

pub fn build_database_search_sql(options: DatabaseSearchSqlOptions) -> Option<DatabaseSearchSql> {
    let term = clean_term(&options.term);
    if term.is_empty() {
        return None;
    }

    let text_columns: Vec<_> = options.columns.iter().filter(|column| is_text_search_column(column)).collect();
    let numeric_term = parse_numeric_term(&term);
    let numeric_columns: Vec<_> = if numeric_term.is_some() {
        options.columns.iter().filter(|column| is_numeric_search_column(column)).collect()
    } else {
        Vec::new()
    };

    let mut conditions = Vec::new();
    for column in &text_columns {
        let identifier = quote_table_identifier(options.database_type, &column.name);
        conditions.push(format!(
            "{} LIKE {} ESCAPE '~'",
            text_cast_expression(options.database_type, &identifier),
            sql_string_literal(&like_pattern(&term))
        ));
    }
    for column in &numeric_columns {
        let identifier = quote_table_identifier(options.database_type, &column.name);
        conditions.push(format!("{identifier} = {}", numeric_term.as_deref().unwrap_or_default()));
    }
    if conditions.is_empty() {
        return None;
    }

    let table = qualified_table_name(options.database_type, options.schema.as_deref(), &options.table_name);
    let where_clause = conditions.join(" OR ");
    let limit = clamp_limit(options.limit);
    let searchable_columns =
        text_columns.iter().chain(numeric_columns.iter()).map(|column| column.name.clone()).collect();

    let sql = if options.database_type == Some(DatabaseType::SqlServer) {
        format!("SELECT TOP {limit} * FROM {table} WHERE ({where_clause})")
    } else if options.database_type.is_some_and(uses_fetch_first) {
        format!("SELECT * FROM {table} WHERE ({where_clause}) FETCH FIRST {limit} ROWS ONLY")
    } else {
        format!("SELECT * FROM {table} WHERE ({where_clause}) LIMIT {limit};")
    };

    Some(DatabaseSearchSql { sql, searchable_columns })
}

pub fn build_search_result_where(options: SearchResultWhereOptions) -> String {
    let mut value_by_column = std::collections::HashMap::new();
    for (index, column) in options.result_columns.iter().enumerate() {
        if let Some(value) = options.row.get(index) {
            value_by_column.insert(column.to_ascii_lowercase(), value);
        }
    }

    let primary_columns: Vec<_> = options
        .columns
        .iter()
        .filter(|column| column.is_primary_key && value_by_column.contains_key(&column.name.to_ascii_lowercase()))
        .collect();
    let fallback_columns: Vec<_> = options
        .columns
        .iter()
        .filter(|column| {
            options.matched_columns.iter().any(|name| name.eq_ignore_ascii_case(&column.name))
                && value_by_column.contains_key(&column.name.to_ascii_lowercase())
        })
        .collect();
    let selected_columns = if primary_columns.is_empty() { fallback_columns } else { primary_columns };

    selected_columns
        .iter()
        .take(3)
        .map(|column| {
            let identifier = quote_table_identifier(options.database_type, &column.name);
            let value = value_by_column.get(&column.name.to_ascii_lowercase()).copied().unwrap_or(&Value::Null);
            if value.is_null() {
                format!("{identifier} IS NULL")
            } else {
                format!("{identifier} = {}", sql_value_literal(options.database_type, column, value))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn clean_term(term: &str) -> String {
    term.trim().to_string()
}

fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(20).clamp(1, 100)
}

fn parse_numeric_term(term: &str) -> Option<String> {
    let trimmed = clean_term(term);
    if trimmed.is_empty() {
        return None;
    }
    let bytes = trimmed.as_bytes();
    let start = usize::from(matches!(bytes.first(), Some(b'+') | Some(b'-')));
    let number = &trimmed[start..];
    if number.is_empty() {
        return None;
    }
    let mut dot_count = 0;
    let mut digit_count = 0;
    for ch in number.chars() {
        if ch == '.' {
            dot_count += 1;
            if dot_count > 1 {
                return None;
            }
        } else if ch.is_ascii_digit() {
            digit_count += 1;
        } else {
            return None;
        }
    }
    if digit_count == 0 {
        None
    } else {
        Some(trimmed)
    }
}

fn sql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn like_pattern(term: &str) -> String {
    let mut pattern = String::from("%");
    for ch in clean_term(term).to_ascii_lowercase().chars() {
        if matches!(ch, '~' | '%' | '_') {
            pattern.push('~');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

fn text_cast_expression(database_type: Option<DatabaseType>, identifier: &str) -> String {
    match database_type {
        Some(DatabaseType::Mysql) => format!("LOWER(CAST({identifier} AS CHAR))"),
        Some(DatabaseType::SqlServer) => format!("LOWER(CAST({identifier} AS NVARCHAR(MAX)))"),
        Some(DatabaseType::Oracle) => format!("LOWER(CAST({identifier} AS VARCHAR2(4000)))"),
        Some(DatabaseType::ClickHouse) => format!("lower(toString({identifier}))"),
        _ => format!("LOWER(CAST({identifier} AS TEXT))"),
    }
}

fn sql_value_literal(database_type: Option<DatabaseType>, column: &DatabaseSearchColumn, value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Number(number) => number.to_string(),
        Value::Bool(value) => {
            if *value {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Value::String(value) => {
            if is_numeric_search_column(column) && parse_numeric_term(value).is_some() {
                return value.trim().to_string();
            }
            if database_type == Some(DatabaseType::SqlServer) {
                format!("N{}", sql_string_literal(value))
            } else {
                sql_string_literal(value)
            }
        }
        other => sql_string_literal(&other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str, is_primary_key: bool) -> DatabaseSearchColumn {
        DatabaseSearchColumn { name: name.to_string(), data_type: data_type.to_string(), is_primary_key }
    }

    #[test]
    fn builds_table_search_query_over_text_columns() {
        let query = build_database_search_sql(DatabaseSearchSqlOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: "users".to_string(),
            columns: vec![col("id", "bigint", true), col("email", "varchar", false), col("avatar", "blob", false)],
            term: "alice@example.com".to_string(),
            limit: Some(20),
        })
        .unwrap();

        assert_eq!(query.searchable_columns, vec!["email"]);
        assert_eq!(
            query.sql,
            "SELECT * FROM `users` WHERE (LOWER(CAST(`email` AS CHAR)) LIKE '%alice@example.com%' ESCAPE '~') LIMIT 20;"
        );
    }

    #[test]
    fn adds_numeric_predicates_only_for_numeric_terms() {
        let query = build_database_search_sql(DatabaseSearchSqlOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: "orders".to_string(),
            columns: vec![col("id", "integer", true), col("note", "text", false)],
            term: "42".to_string(),
            limit: Some(10),
        })
        .unwrap();

        assert_eq!(query.searchable_columns, vec!["note", "id"]);
        assert!(query.sql.contains("\"id\" = 42"));
        assert!(query.sql.contains("FROM \"public\".\"orders\""));
    }

    #[test]
    fn returns_none_for_tables_without_searchable_columns() {
        assert_eq!(
            build_database_search_sql(DatabaseSearchSqlOptions {
                database_type: Some(DatabaseType::Sqlite),
                schema: None,
                table_name: "files".to_string(),
                columns: vec![col("payload", "blob", false)],
                term: "needle".to_string(),
                limit: None,
            }),
            None
        );
    }

    #[test]
    fn builds_stable_where_predicate_for_opening_result_rows() {
        let where_clause = build_search_result_where(SearchResultWhereOptions {
            database_type: Some(DatabaseType::SqlServer),
            columns: vec![col("id", "integer", true), col("email", "varchar", false)],
            result_columns: vec!["id".to_string(), "email".to_string()],
            row: vec![Value::from(42), Value::from("alice@example.com")],
            matched_columns: Vec::new(),
        });

        assert_eq!(where_clause, "[id] = 42");
    }
}
