use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use crate::models::connection::DatabaseType;
use crate::sql::find_statement_at_cursor;
use crate::sql_dialect::{quote_table_identifier, uses_fetch_first};

static LIMIT_OFFSET_STRIP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?|\s+LIMIT\s+\d+(\s*,\s*\d+)?|\s+OFFSET\s+\d+(\s+LIMIT\s+\d+)?|\s+OFFSET\s+\d+\s+ROWS?\s+FETCH\s+(?:FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY|\s+FETCH\s+(?:FIRST|NEXT)\s+\d+\s+ROWS?\s+ONLY)\s*$").unwrap()
});

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySqlBuildResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPagination {
    pub limit: usize,
    pub offset: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPaginationExecutionPlanOptions {
    pub sql: String,
    pub query_base_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub pagination: QueryPagination,
    pub use_agent_cursor: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPaginationExecutionPlan {
    pub sql_to_execute: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_sql: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_limit: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_offset: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count_sql: Option<String>,
    pub use_agent_result_session: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedQuerySqlOptions {
    pub original_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountQuerySqlOptions {
    pub original_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuerySortDirection {
    Asc,
    Desc,
}

impl QuerySortDirection {
    fn as_sql(self) -> &'static str {
        match self {
            Self::Asc => "ASC",
            Self::Desc => "DESC",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortedQuerySqlOptions {
    pub original_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default)]
    pub result_columns: Vec<String>,
    pub column_index: usize,
    pub column: String,
    pub direction: QuerySortDirection,
}

pub fn build_query_pagination_execution_plan(
    options: QueryPaginationExecutionPlanOptions,
) -> QueryPaginationExecutionPlan {
    let mut plan = QueryPaginationExecutionPlan {
        sql_to_execute: options.sql.clone(),
        page_sql: None,
        page_limit: None,
        page_offset: None,
        count_sql: None,
        use_agent_result_session: false,
    };

    let counted = build_count_query_sql(CountQuerySqlOptions {
        original_sql: options.query_base_sql.clone(),
        database_type: options.database_type,
    });
    if counted.ok {
        plan.count_sql = counted.sql;
    }

    if options.pagination.session_id.is_some() {
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
        return plan;
    }

    if options.database_type == Some(DatabaseType::SqlServer) && starts_with_cte(&options.query_base_sql) {
        return plan;
    }

    if options.use_agent_cursor && options.pagination.offset == 0 {
        plan.sql_to_execute = options.query_base_sql;
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
        return plan;
    }

    let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
        original_sql: options.sql,
        database_type: options.database_type,
        limit: options.pagination.limit,
        offset: options.pagination.offset,
    });
    if paginated.ok {
        plan.sql_to_execute = paginated.sql.clone().unwrap_or_default();
        plan.page_sql = paginated.sql;
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
    }
    plan
}

pub fn build_paginated_query_sql(options: PaginatedQuerySqlOptions) -> QuerySqlBuildResult {
    let Ok(statement) = single_selectable_statement(&options.original_sql) else {
        return err(single_statement_error_reason(&options.original_sql));
    };
    if unsupported_pagination_type(options.database_type) {
        return err("unsupported");
    }

    let safe_limit = options.limit.max(1);
    let safe_offset = options.offset;

    if options.database_type == Some(DatabaseType::SqlServer) {
        if safe_offset > 0 {
            return err("unsupported");
        }
        return ok(add_sql_server_top(&statement, safe_limit));
    }

    if options.database_type == Some(DatabaseType::Mysql) {
        return ok(add_mysql_limit(&statement, safe_limit, safe_offset));
    }

    if options.database_type == Some(DatabaseType::Questdb) {
        return ok(add_questdb_limit(&statement, safe_limit, safe_offset));
    }

    if options.database_type == Some(DatabaseType::Elasticsearch) {
        // If the user wrote their own LIMIT, leave the SQL alone — they
        // explicitly bounded the result set and the front-end will paginate
        // client-side. Otherwise wrap with an explicit OFFSET (even when
        // 0) so the ES driver can tell a plan-wrapped query from one the
        // user wrote, which decides whether affected_rows should reflect
        // the index total or the row count we actually returned.
        if has_top_level_limit(&statement) {
            return err("unsupported");
        }
        return ok(format!("{statement} LIMIT {safe_limit} OFFSET {safe_offset};"));
    }

    if options.database_type == Some(DatabaseType::Oracle) {
        return ok(format!("{statement};"));
    }

    if options.database_type == Some(DatabaseType::Informix) {
        return ok(add_informix_first_limit(&statement, safe_limit, safe_offset));
    }

    if options.database_type.is_some_and(uses_fetch_first) {
        return ok(add_fetch_first_limit(&statement, safe_limit, safe_offset));
    }

    // JDBC connections rely on Statement.setMaxRows() for row limiting.
    if options.database_type == Some(DatabaseType::Jdbc) {
        return ok(format!("{statement};"));
    }

    ok(add_standard_limit(&statement, safe_limit, safe_offset))
}

pub fn build_count_query_sql(options: CountQuerySqlOptions) -> QuerySqlBuildResult {
    let Ok(statement) = single_selectable_statement(&options.original_sql) else {
        return err(single_statement_error_reason(&options.original_sql));
    };
    if unsupported_pagination_type(options.database_type) {
        return err("unsupported");
    }
    // ES SQL can't wrap a SELECT in `SELECT COUNT(*) FROM (...)` — the
    // driver already reports the true match count via affected_rows.
    if options.database_type == Some(DatabaseType::Elasticsearch) {
        return err("unsupported");
    }

    let statement = LIMIT_OFFSET_STRIP_RE.replace(&statement, "").to_string();

    let alias = quote_table_identifier(options.database_type, "dbx_count");
    let wrapped_sql = if options.database_type == Some(DatabaseType::SqlServer) {
        sql_server_statement_for_derived_table(&statement)
    } else {
        statement
    };
    ok(format!("SELECT COUNT(*) AS dbx_total_rows FROM ({wrapped_sql}) {alias};"))
}

pub fn build_sorted_query_sql(options: SortedQuerySqlOptions) -> QuerySqlBuildResult {
    let base_sql = options.original_sql.trim();
    if base_sql.is_empty() {
        return err("empty");
    }

    let statement = find_statement_at_cursor(base_sql, 0).trim().trim_end_matches(';').trim().to_string();
    if statement.is_empty() {
        return err("empty");
    }
    if statement.len() != base_sql.trim_end_matches(';').trim().len() {
        return err("multi");
    }
    if statement.trim_start().to_ascii_uppercase().starts_with("WITH") {
        return err("with");
    }
    if !statement.trim_start().to_ascii_uppercase().starts_with("SELECT") {
        return err("not_select");
    }

    let aliases = build_derived_column_aliases(&options.result_columns);
    let use_derived_column_aliases = options.database_type != Some(DatabaseType::Mysql)
        && options.database_type != Some(DatabaseType::Sqlite)
        && options.database_type != Some(DatabaseType::DuckDb);
    let sort_alias = if use_derived_column_aliases {
        aliases
            .get(options.column_index)
            .or_else(|| {
                options
                    .result_columns
                    .iter()
                    .position(|column| column == &options.column)
                    .and_then(|index| aliases.get(index))
            })
            .cloned()
            .unwrap_or_else(|| fallback_alias(options.column_index))
    } else {
        options.result_columns.get(options.column_index).cloned().unwrap_or_else(|| options.column.clone())
    };
    let quoted_column = quote_table_identifier(options.database_type, &sort_alias);
    let wrapped_statement = if options.database_type == Some(DatabaseType::SqlServer) {
        sql_server_statement_for_derived_table(&statement)
    } else {
        statement
    };

    if use_derived_column_aliases {
        let alias_list = aliases
            .iter()
            .map(|alias| quote_table_identifier(options.database_type, alias))
            .collect::<Vec<_>>()
            .join(", ");
        ok(format!(
            "SELECT * FROM ({wrapped_statement}) t({alias_list}) ORDER BY {quoted_column} {};",
            options.direction.as_sql()
        ))
    } else {
        ok(format!("SELECT * FROM ({wrapped_statement}) t ORDER BY {quoted_column} {};", options.direction.as_sql()))
    }
}

fn ok(sql: String) -> QuerySqlBuildResult {
    QuerySqlBuildResult { ok: true, sql: Some(sql), reason: None }
}

fn err(reason: &str) -> QuerySqlBuildResult {
    QuerySqlBuildResult { ok: false, sql: None, reason: Some(reason.to_string()) }
}

fn unsupported_pagination_type(database_type: Option<DatabaseType>) -> bool {
    matches!(database_type, Some(DatabaseType::Neo4j | DatabaseType::MongoDb | DatabaseType::Redis))
}

fn single_selectable_statement(original_sql: &str) -> Result<String, ()> {
    let base_sql = original_sql.trim();
    if base_sql.is_empty() {
        return Err(());
    }

    let statement = find_statement_at_cursor(base_sql, 0).trim().trim_end_matches(';').trim().to_string();
    if statement.is_empty() {
        return Err(());
    }
    if statement.len() != base_sql.trim_end_matches(';').trim().len() {
        return Err(());
    }
    let upper = statement.trim_start_matches(';').trim_start().to_ascii_uppercase();
    if !(upper.starts_with("SELECT") || upper.starts_with("WITH")) {
        return Err(());
    }
    if has_top_level_select_into(&statement) {
        return Err(());
    }

    Ok(statement)
}

fn starts_with_cte(sql: &str) -> bool {
    sql.trim_start().trim_start_matches(';').trim_start().to_ascii_uppercase().starts_with("WITH")
}

fn single_statement_error_reason(original_sql: &str) -> &'static str {
    let base_sql = original_sql.trim();
    if base_sql.is_empty() {
        return "empty";
    }
    let statement = find_statement_at_cursor(base_sql, 0).trim().trim_end_matches(';').trim().to_string();
    if statement.is_empty() {
        return "empty";
    }
    if statement.len() != base_sql.trim_end_matches(';').trim().len() {
        return "multi";
    }
    "not_select"
}

fn has_top_level_select_into(sql: &str) -> bool {
    let mut saw_select = false;
    for token in top_level_sql_tokens(sql) {
        if !saw_select {
            saw_select = token.text == "SELECT";
            continue;
        }
        if token.text == "INTO" {
            return true;
        }
    }
    false
}

fn add_sql_server_top(sql: &str, limit: usize) -> String {
    if has_top_level_select_top(sql) || has_top_level_offset_fetch_next(sql) {
        return sql.to_string();
    }
    if sql.len() >= 6 && sql[..6].eq_ignore_ascii_case("SELECT") {
        let rest = &sql[6..];
        if let Some((leading, after_modifier)) = strip_sql_server_select_modifier(rest, "DISTINCT") {
            return format!("SELECT{leading}DISTINCT TOP ({limit}){after_modifier}");
        }
        if let Some((leading, after_modifier)) = strip_sql_server_select_modifier(rest, "ALL") {
            return format!("SELECT{leading}ALL TOP ({limit}){after_modifier}");
        }
        format!("SELECT TOP ({limit}){rest}")
    } else {
        format!("SELECT TOP ({limit}) * FROM ({sql}) [dbx_page]")
    }
}

fn strip_sql_server_select_modifier<'a>(rest: &'a str, modifier: &str) -> Option<(&'a str, &'a str)> {
    let trimmed = rest.trim_start();
    let leading_ws_len = rest.len() - trimmed.len();
    let candidate = trimmed.get(..modifier.len())?;
    let after_modifier = trimmed.get(modifier.len()..)?;
    if !candidate.eq_ignore_ascii_case(modifier) {
        return None;
    }
    if after_modifier.chars().next().is_some_and(is_sql_token_part) {
        return None;
    }
    Some((&rest[..leading_ws_len], after_modifier))
}

fn sql_server_statement_for_derived_table(statement: &str) -> String {
    let Some(order_by) = find_top_level_trailing_order_by(statement) else {
        return statement.to_string();
    };
    if has_top_level_select_top(statement) || has_top_level_for_xml(statement) {
        return statement.to_string();
    }
    statement[..order_by].trim_end().to_string()
}

fn add_mysql_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_limit(statement) {
        return format!("{statement};");
    }
    let offset_sql = if offset > 0 { format!(" OFFSET {offset}") } else { String::new() };
    format!("{statement} LIMIT {limit}{offset_sql};")
}

fn add_informix_first_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_informix_row_limit(statement) {
        return format!("{statement};");
    }
    let row_limit = if offset > 0 { format!("SKIP {offset} FIRST {limit}") } else { format!("FIRST {limit}") };
    if statement.len() >= 6 && statement[..6].eq_ignore_ascii_case("SELECT") {
        let rest = &statement[6..];
        if let Some((leading, after_modifier)) = strip_sql_server_select_modifier(rest, "DISTINCT") {
            return format!("SELECT{leading}DISTINCT {row_limit}{after_modifier};");
        }
        if let Some((leading, after_modifier)) = strip_sql_server_select_modifier(rest, "UNIQUE") {
            return format!("SELECT{leading}UNIQUE {row_limit}{after_modifier};");
        }
        if let Some((leading, after_modifier)) = strip_sql_server_select_modifier(rest, "ALL") {
            return format!("SELECT{leading}ALL {row_limit}{after_modifier};");
        }
        return format!("SELECT {row_limit}{rest};");
    }
    format!("SELECT {row_limit} * FROM ({statement}) dbx_page;")
}

fn add_questdb_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_limit(statement) {
        return format!("{statement};");
    }
    if offset > 0 {
        let upper_bound = offset + limit;
        format!("{statement} LIMIT {offset}, {upper_bound};")
    } else {
        format!("{statement} LIMIT {limit};")
    }
}

fn has_top_level_limit(sql: &str) -> bool {
    top_level_sql_tokens(sql).iter().any(|token| token.text == "LIMIT")
}

fn has_top_level_informix_row_limit(sql: &str) -> bool {
    if has_top_level_limit(sql) {
        return true;
    }
    let tokens = top_level_sql_tokens(sql);
    let Some(select_index) = tokens.iter().position(|token| token.text == "SELECT") else {
        return false;
    };
    let from_index = tokens
        .iter()
        .enumerate()
        .find(|(index, token)| *index > select_index && token.text == "FROM")
        .map(|(index, _)| index)
        .unwrap_or(tokens.len());
    tokens[select_index + 1..from_index].iter().any(|token| token.text == "FIRST" || token.text == "SKIP")
}

fn has_top_level_fetch_first(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    tokens.windows(2).any(|w| w[0].text == "FETCH" && w[1].text == "FIRST")
}

fn has_top_level_offset_fetch_next(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    let has_offset = tokens.iter().any(|token| token.text == "OFFSET");
    let has_fetch_next = tokens.windows(2).any(|w| w[0].text == "FETCH" && w[1].text == "NEXT");
    has_offset && has_fetch_next
}

fn add_fetch_first_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_fetch_first(statement) {
        return format!("{statement};");
    }
    let offset_sql = if offset > 0 { format!(" OFFSET {offset} ROWS") } else { String::new() };
    format!("{statement}{offset_sql} FETCH FIRST {limit} ROWS ONLY;")
}

fn add_standard_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_limit(statement) {
        return format!("{statement};");
    }
    let offset_sql = if offset > 0 { format!(" OFFSET {offset}") } else { String::new() };
    format!("{statement} LIMIT {limit}{offset_sql};")
}

fn find_top_level_trailing_order_by(sql: &str) -> Option<usize> {
    let tokens = top_level_sql_tokens(sql);
    for index in (0..tokens.len().saturating_sub(1)).rev() {
        if tokens[index].text == "ORDER" && tokens.get(index + 1).is_some_and(|token| token.text == "BY") {
            return Some(tokens[index].start);
        }
    }
    None
}

fn has_top_level_select_top(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    let Some(select_index) = tokens.iter().position(|token| token.text == "SELECT") else {
        return false;
    };
    let from_index = tokens
        .iter()
        .enumerate()
        .find(|(index, token)| *index > select_index && token.text == "FROM")
        .map(|(index, _)| index)
        .unwrap_or(tokens.len());
    tokens[select_index + 1..from_index].iter().any(|token| token.text == "TOP")
}

fn has_top_level_for_xml(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    tokens
        .iter()
        .enumerate()
        .any(|(index, token)| token.text == "FOR" && tokens.get(index + 1).is_some_and(|next| next.text == "XML"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlToken {
    text: String,
    start: usize,
}

fn top_level_sql_tokens(sql: &str) -> Vec<SqlToken> {
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut depth = 0usize;

    while i < sql.len() {
        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());

        if ch == '-' && next == Some('-') {
            i += 2;
            while i < sql.len() && next_char(sql, i) != '\n' {
                i += next_char(sql, i).len_utf8();
            }
            continue;
        }

        if ch == '/' && next == Some('*') {
            i += 2;
            while i < sql.len() {
                let current = next_char(sql, i);
                let following = next_char_at(sql, i + current.len_utf8());
                if current == '*' && following == Some('/') {
                    i += 2;
                    break;
                }
                i += current.len_utf8();
            }
            continue;
        }

        if matches!(ch, '\'' | '"' | '`') {
            i = skip_sql_quoted(sql, i, ch);
            continue;
        }

        if ch == '[' {
            i = skip_sql_bracket_identifier(sql, i);
            continue;
        }

        if ch == '(' {
            depth += 1;
            i += ch.len_utf8();
            continue;
        }

        if ch == ')' {
            depth = depth.saturating_sub(1);
            i += ch.len_utf8();
            continue;
        }

        if depth == 0 && is_sql_token_start(ch) {
            let start = i;
            i += ch.len_utf8();
            while i < sql.len() && is_sql_token_part(next_char(sql, i)) {
                i += next_char(sql, i).len_utf8();
            }
            tokens.push(SqlToken { text: sql[start..i].to_ascii_uppercase(), start });
            continue;
        }

        i += ch.len_utf8();
    }

    tokens
}

fn skip_sql_quoted(sql: &str, pos: usize, quote: char) -> usize {
    let mut i = pos + quote.len_utf8();
    while i < sql.len() {
        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());
        if ch == quote {
            if next == Some(quote) {
                i += ch.len_utf8() + quote.len_utf8();
                continue;
            }
            return i + ch.len_utf8();
        }
        if quote == '\'' && ch == '\\' {
            i += ch.len_utf8();
            if i < sql.len() {
                i += next_char(sql, i).len_utf8();
            }
            continue;
        }
        i += ch.len_utf8();
    }
    sql.len()
}

fn skip_sql_bracket_identifier(sql: &str, pos: usize) -> usize {
    let mut i = pos + 1;
    while i < sql.len() {
        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());
        if ch == ']' {
            if next == Some(']') {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += ch.len_utf8();
    }
    sql.len()
}

fn is_sql_token_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_sql_token_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$' | '#')
}

fn next_char(sql: &str, index: usize) -> char {
    sql[index..].chars().next().unwrap_or('\0')
}

fn next_char_at(sql: &str, index: usize) -> Option<char> {
    if index >= sql.len() {
        None
    } else {
        sql[index..].chars().next()
    }
}

fn build_derived_column_aliases(result_columns: &[String]) -> Vec<String> {
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    result_columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let base = normalize_alias_base(column, index);
            let count = seen.entry(base.clone()).and_modify(|value| *value += 1).or_insert(1);
            if *count == 1 {
                base
            } else {
                format!("{base}_{count}")
            }
        })
        .collect()
}

fn normalize_alias_base(column: &str, index: usize) -> String {
    let compact = column.split_whitespace().collect::<Vec<_>>().join("_");
    let safe = compact
        .chars()
        .map(|ch| if ch.is_alphanumeric() || matches!(ch, '_' | '$') { ch } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if safe.is_empty() {
        fallback_alias(index)
    } else {
        safe
    }
}

fn fallback_alias(index: usize) -> String {
    format!("column_{}", index + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_single_select_query_with_limit_and_offset() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id, name FROM users;".to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 100,
            offset: 200,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT id, name FROM users LIMIT 100 OFFSET 200;");
    }

    #[test]
    fn uses_sqlserver_top_pagination_for_first_page() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users ORDER BY id DESC".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT TOP (100) id FROM users ORDER BY id DESC");
    }

    #[test]
    fn uses_sqlserver_top_for_count_queries_without_derived_table() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT COUNT(*) FROM TicketInfo".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT TOP (100) COUNT(*) FROM TicketInfo");
    }

    #[test]
    fn inserts_sqlserver_top_after_distinct_modifier() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT DISTINCT ProjectType FROM JDDR_sys_BasicConfig_ProjectInfo_Data".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT DISTINCT TOP (100) ProjectType FROM JDDR_sys_BasicConfig_ProjectInfo_Data"
        );
    }

    #[test]
    fn inserts_sqlserver_top_after_all_modifier() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT ALL ProjectType FROM JDDR_sys_BasicConfig_ProjectInfo_Data".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT ALL TOP (100) ProjectType FROM JDDR_sys_BasicConfig_ProjectInfo_Data");
    }

    #[test]
    fn does_not_treat_sqlserver_select_prefix_as_all_modifier() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT AllProjectType FROM JDDR_sys_BasicConfig_ProjectInfo_Data".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT TOP (100) AllProjectType FROM JDDR_sys_BasicConfig_ProjectInfo_Data");
    }

    #[test]
    fn keeps_existing_sqlserver_top_clause() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT TOP 1000 * FROM TicketInfo".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT TOP 1000 * FROM TicketInfo");
    }

    #[test]
    fn sqlserver_cte_pagination_plan_executes_original_sql() {
        let sql = ";WITH ranked AS (SELECT id FROM dbo.users) SELECT * FROM ranked".to_string();
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.clone(),
            query_base_sql: sql.clone(),
            database_type: Some(DatabaseType::SqlServer),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: false,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert!(plan.count_sql.is_none());
        assert_eq!(plan.page_limit, None);
        assert_eq!(plan.page_offset, None);
    }

    #[test]
    fn sqlserver_cte_count_query_is_not_wrapped_as_derived_table() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: ";WITH cte AS (SELECT 1 AS id) SELECT * FROM cte".to_string(),
            database_type: Some(DatabaseType::SqlServer),
        });

        assert!(!result.ok);
        assert!(result.sql.is_none());
    }

    #[test]
    fn wraps_sqlserver_select_with_unnamed_column() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT @@version".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT TOP (100) @@version");
    }

    #[test]
    fn rejects_sqlserver_offset_pagination_for_later_pages() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 300,
        });

        assert_eq!(result, err("unsupported"));
    }

    #[test]
    fn keeps_sqlserver_offset_fetch_next_when_offset_is_zero() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM TABLE_NAME ORDER BY id OFFSET 1 ROWS FETCH NEXT 10 ROWS ONLY".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT * FROM TABLE_NAME ORDER BY id OFFSET 1 ROWS FETCH NEXT 10 ROWS ONLY");
    }

    #[test]
    fn oracle_pagination_skips_sql_clause() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Oracle),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT id FROM users;");
    }

    #[test]
    fn uses_fetch_first_pagination_for_db2() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Db2),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT id FROM users FETCH FIRST 100 ROWS ONLY;");
    }

    #[test]
    fn uses_skip_first_pagination_for_informix() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users WHERE active = 1".to_string(),
            database_type: Some(DatabaseType::Informix),
            limit: 50,
            offset: 100,
        });

        assert_eq!(result.sql.unwrap(), "SELECT SKIP 100 FIRST 50 id FROM users WHERE active = 1;");
    }

    #[test]
    fn informix_pagination_keeps_existing_first() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT FIRST 20 id FROM users".to_string(),
            database_type: Some(DatabaseType::Informix),
            limit: 50,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT FIRST 20 id FROM users;");
    }

    #[test]
    fn uses_mysql_style_alias_for_pagination() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users WHERE active = 1".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT id FROM users WHERE active = 1 LIMIT 50;");
    }

    #[test]
    fn mysql_pagination_does_not_wrap_duplicate_result_columns() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT p.id, t.id FROM table1 p LEFT JOIN table2 t ON p.f = t.f".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 100,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT p.id, t.id FROM table1 p LEFT JOIN table2 t ON p.f = t.f LIMIT 50 OFFSET 100;"
        );
    }

    #[test]
    fn mysql_pagination_keeps_existing_top_level_limit() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users LIMIT 20;".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT id FROM users LIMIT 20;");
    }

    #[test]
    fn rejects_multiple_statements_for_pagination() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT 1; SELECT 2;".to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result, err("multi"));
    }

    #[test]
    fn rejects_select_into_for_pagination() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * INTO copy_users FROM users WHERE active = 1".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result, err("not_select"));
    }

    #[test]
    fn builds_count_query() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "WITH cte AS (SELECT 1 AS id) SELECT * FROM cte".to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM (WITH cte AS (SELECT 1 AS id) SELECT * FROM cte) `dbx_count`;"
        );
    }

    #[test]
    fn builds_agent_cursor_pagination_plan() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Oracle),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM events");
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(plan.page_sql.is_none());
        assert!(plan.use_agent_result_session);
    }

    #[test]
    fn builds_sorted_query_sql() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT c.id, m.id FROM t_campaign c LEFT JOIN t_campaign_mdf m ON m.campaign_id = c.id"
                .to_string(),
            database_type: Some(DatabaseType::Postgres),
            result_columns: vec!["id".to_string(), "id".to_string()],
            column_index: 1,
            column: "id".to_string(),
            direction: QuerySortDirection::Asc,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT c.id, m.id FROM t_campaign c LEFT JOIN t_campaign_mdf m ON m.campaign_id = c.id) t(\"id\", \"id_2\") ORDER BY \"id_2\" ASC;"
        );
    }

    #[test]
    fn builds_sorted_query_sql_for_first_result_column() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT iso3, year, gdp_pc FROM country_gdp".to_string(),
            database_type: Some(DatabaseType::Postgres),
            result_columns: vec!["iso3".to_string(), "year".to_string(), "gdp_pc".to_string()],
            column_index: 0,
            column: "iso3".to_string(),
            direction: QuerySortDirection::Asc,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT iso3, year, gdp_pc FROM country_gdp) t(\"iso3\", \"year\", \"gdp_pc\") ORDER BY \"iso3\" ASC;"
        );
    }

    #[test]
    fn builds_mysql_sorted_query_without_alias_list() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT * FROM admin LIMIT 100;".to_string(),
            database_type: Some(DatabaseType::Mysql),
            result_columns: vec![
                "id".to_string(),
                "guid".to_string(),
                "role_guid".to_string(),
                "login_name".to_string(),
                "password".to_string(),
            ],
            column_index: 3,
            column: "login_name".to_string(),
            direction: QuerySortDirection::Asc,
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT * FROM admin LIMIT 100) t ORDER BY `login_name` ASC;");
    }

    #[test]
    fn strips_sqlserver_order_by_for_sorted_query() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT id, name FROM users ORDER BY id DESC".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            result_columns: vec!["id".to_string(), "name".to_string()],
            column_index: 1,
            column: "name".to_string(),
            direction: QuerySortDirection::Asc,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT id, name FROM users) t([id], [name]) ORDER BY [name] ASC;"
        );
    }

    #[test]
    fn rejects_with_query_sorting() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "WITH cte AS (SELECT 1) SELECT * FROM cte".to_string(),
            database_type: Some(DatabaseType::Postgres),
            result_columns: vec!["id".to_string()],
            column_index: 0,
            column: "id".to_string(),
            direction: QuerySortDirection::Asc,
        });

        assert_eq!(result, err("with"));
    }
}
