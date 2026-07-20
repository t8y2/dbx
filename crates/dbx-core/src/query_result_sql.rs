use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::sql::find_statement_at_cursor;
use crate::sql_dialect::{
    firebird_rows_clause, pagination_strategy, quote_table_identifier, PaginationContext, TablePaginationStrategy,
};
use sqlparser::ast::{Expr, GroupByExpr, SelectItem, SetExpr, Statement};
use sqlparser::dialect::{GenericDialect, MsSqlDialect};
use sqlparser::parser::Parser;

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
    #[serde(default)]
    pub first_page_uses_actual_sql: bool,
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

    let can_use_first_page_cursor = options.use_agent_cursor && options.pagination.offset == 0;
    let prefer_server_pagination = options.database_type == Some(DatabaseType::Kingbase);
    if can_use_first_page_cursor && !prefer_server_pagination {
        if !options.first_page_uses_actual_sql {
            plan.sql_to_execute = options.query_base_sql;
        }
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
    } else if can_use_first_page_cursor {
        // Kingbase JDBC may buffer an entire result in auto-commit mode, so use
        // LIMIT/OFFSET whenever the statement can be rewritten safely. Keep the
        // Agent cursor as a bounded fallback for multi-statement or dialect-
        // specific SQL that the pagination parser cannot transform.
        if !options.first_page_uses_actual_sql {
            plan.sql_to_execute = options.query_base_sql;
        }
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
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

    match pagination_strategy(options.database_type, PaginationContext::UserQuery) {
        TablePaginationStrategy::SqlServerTop => add_sql_server_offset_fetch(&statement, safe_limit, safe_offset)
            .map(ok)
            .unwrap_or_else(|| err("unsupported")),
        TablePaginationStrategy::QuestDbLimit => ok(add_questdb_limit(&statement, safe_limit, safe_offset)),
        TablePaginationStrategy::InformixFirst => ok(add_informix_first_limit(&statement, safe_limit, safe_offset)),
        TablePaginationStrategy::FirebirdRows => ok(add_firebird_rows_limit(&statement, safe_limit, safe_offset)),
        TablePaginationStrategy::Db2FetchFirst | TablePaginationStrategy::FetchFirst => {
            ok(add_fetch_first_limit(&statement, safe_limit, safe_offset))
        }
        TablePaginationStrategy::Rownum => ok(add_rownum_limit(&statement, safe_limit, safe_offset)),
        TablePaginationStrategy::AgentMaxRows | TablePaginationStrategy::Unbounded => ok(format!("{statement};")),
        TablePaginationStrategy::IrisTop => ok(add_iris_top_limit(&statement, safe_limit)),
        TablePaginationStrategy::LimitOffset => {
            let dedup_count = dedup_projection_count_without_order_by(&options.original_sql);
            ok(add_standard_limit(&statement, options.database_type, safe_limit, safe_offset, dedup_count))
        }
    }
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
    if options.database_type == Some(DatabaseType::SqlServer) && !sql_server_derived_table_projection_safe(&statement) {
        return err("unsupported");
    }

    let alias = quote_table_identifier(options.database_type, "dbx_count");
    let wrapped_sql = match options.database_type {
        Some(DatabaseType::SqlServer) => sql_server_statement_for_derived_table(&statement),
        Some(DatabaseType::Iris) => iris_statement_for_derived_table(&statement),
        _ => statement,
    };
    ok(derived_table_sql("SELECT COUNT(*) AS dbx_total_rows FROM", &wrapped_sql, &format!("{alias};")))
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
        && options.database_type != Some(DatabaseType::ClickHouse)
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
    if !single_statement_matches_base_sql(&statement, base_sql) {
        return Err(());
    }
    let statement_without_leading_comments =
        strip_leading_statement_comments(statement.trim_start_matches(';').trim_start());
    let upper = statement_without_leading_comments.to_ascii_uppercase();
    if upper.starts_with("WITH") {
        if !cte_main_statement_is_select(&statement) {
            return Err(());
        }
    } else if !upper.starts_with("SELECT") {
        return Err(());
    }
    if has_top_level_select_into(&statement) {
        return Err(());
    }

    Ok(statement)
}

fn single_statement_matches_base_sql(statement: &str, base_sql: &str) -> bool {
    let normalized_statement = statement.trim().trim_end_matches(';').trim();
    let normalized_base = base_sql.trim().trim_end_matches(';').trim();
    if normalized_statement.len() == normalized_base.len() {
        return true;
    }
    let base_without_leading_comments =
        strip_leading_statement_comments(normalized_base).trim().trim_end_matches(';').trim();
    normalized_statement == base_without_leading_comments
}

fn starts_with_cte(sql: &str) -> bool {
    sql.trim_start().trim_start_matches(';').trim_start().to_ascii_uppercase().starts_with("WITH")
}

fn cte_main_statement_is_select(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    let mut index = match tokens.iter().position(|token| token.text == "WITH") {
        Some(index) => index + 1,
        None => return false,
    };

    if tokens.get(index).is_some_and(|token| token.text == "RECURSIVE") {
        index += 1;
    }

    while let Some(token) = tokens.get(index) {
        if is_with_main_statement_keyword(&token.text) {
            return token.text == "SELECT";
        }
        index += 1;
    }
    false
}

fn is_with_main_statement_keyword(token: &str) -> bool {
    matches!(token, "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE")
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

fn add_sql_server_offset_fetch(statement: &str, limit: usize, offset: usize) -> Option<String> {
    if has_top_level_offset_fetch_next(statement) {
        return (offset == 0).then(|| statement.to_string());
    }
    if has_top_level_select_top(statement) {
        return sql_server_derived_table_projection_safe(statement)
            .then(|| add_sql_server_existing_top_pagination(statement, limit, offset));
    }

    let order_by_index = find_top_level_trailing_order_by(statement);
    if order_by_index.is_none() && has_top_level_select_distinct(statement) {
        return (offset == 0).then(|| add_sql_server_top(statement, limit));
    }

    if offset == 0 {
        return Some(add_sql_server_top(statement, limit));
    }

    let statement_without_order = order_by_index.map(|index| statement[..index].trim_end()).unwrap_or(statement);
    if !sql_server_derived_table_projection_safe(statement_without_order) {
        return None;
    }

    let row_number_order = order_by_index
        .map(|index| statement[index..].trim().to_string())
        .unwrap_or_else(|| "ORDER BY (SELECT NULL)".to_string());
    let end = offset + limit;
    Some(format!(
        "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER ({row_number_order}) AS [__dbx_row_num] FROM ({statement_without_order}) dbx_page_source) dbx_page WHERE [__dbx_row_num] > {offset} AND [__dbx_row_num] <= {end} ORDER BY [__dbx_row_num];"
    ))
}

fn add_sql_server_existing_top_pagination(statement: &str, limit: usize, offset: usize) -> String {
    let row_number_order = format!("ORDER BY {}", sql_server_default_pagination_order(statement));
    if offset == 0 {
        return format!("SELECT TOP ({limit}) * FROM ({statement}) [dbx_page] {row_number_order};");
    }

    let end = offset + limit;
    format!(
        "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER ({row_number_order}) AS [__dbx_row_num] FROM ({statement}) dbx_page_source) dbx_page WHERE [__dbx_row_num] > {offset} AND [__dbx_row_num] <= {end} ORDER BY [__dbx_row_num];"
    )
}

fn sql_server_default_pagination_order(statement: &str) -> String {
    first_simple_sqlserver_projection_order_column(statement).unwrap_or_else(|| "(SELECT NULL)".to_string())
}

fn first_simple_sqlserver_projection_order_column(statement: &str) -> Option<String> {
    let sql = statement.trim();
    let sql = &sql[skip_leading_sql_comments(sql, 0)..];
    if sql.len() < 6 || !sql[..6].eq_ignore_ascii_case("SELECT") {
        return None;
    }

    let mut index = 6;
    index = skip_sql_whitespace(sql, index);
    if let Some(next) = skip_sql_keyword(sql, index, "DISTINCT").or_else(|| skip_sql_keyword(sql, index, "ALL")) {
        index = skip_sql_whitespace(sql, next);
    }
    if let Some(next) = skip_sql_keyword(sql, index, "TOP") {
        index = skip_sqlserver_top_clause(sql, next);
    }

    let projection_start = skip_sql_whitespace(sql, index);
    let projection_end = find_first_projection_end(sql, projection_start)?;
    let projection = sql[projection_start..projection_end].trim();
    sql_server_derived_order_column_from_projection(projection)
}

fn skip_leading_sql_comments(sql: &str, mut index: usize) -> usize {
    loop {
        index = skip_sql_whitespace(sql, index);
        if sql[index..].starts_with("--") {
            index += 2;
            while index < sql.len() && next_char(sql, index) != '\n' {
                index += next_char(sql, index).len_utf8();
            }
            continue;
        }
        if sql[index..].starts_with("/*") {
            index += 2;
            while index < sql.len() {
                let ch = next_char(sql, index);
                let next = next_char_at(sql, index + ch.len_utf8());
                index += ch.len_utf8();
                if ch == '*' && next == Some('/') {
                    index += 1;
                    break;
                }
            }
            continue;
        }
        return index;
    }
}

fn strip_leading_statement_comments(sql: &str) -> &str {
    &sql[skip_leading_sql_comments(sql, 0)..]
}

fn skip_sqlserver_top_clause(sql: &str, index: usize) -> usize {
    let mut cursor = skip_sql_whitespace(sql, index);
    if next_char_at(sql, cursor) == Some('(') {
        cursor = skip_sql_parenthesized(sql, cursor);
    } else {
        while cursor < sql.len() && !next_char(sql, cursor).is_whitespace() && next_char(sql, cursor) != ',' {
            cursor += next_char(sql, cursor).len_utf8();
        }
    }
    cursor = skip_sql_whitespace(sql, cursor);
    if let Some(next) = skip_sql_keyword(sql, cursor, "PERCENT") {
        cursor = skip_sql_whitespace(sql, next);
    }
    if let Some(next) = skip_sql_keyword(sql, cursor, "WITH") {
        let after_with = skip_sql_whitespace(sql, next);
        if let Some(after_ties) = skip_sql_keyword(sql, after_with, "TIES") {
            cursor = skip_sql_whitespace(sql, after_ties);
        }
    }
    cursor
}

fn find_first_projection_end(sql: &str, start: usize) -> Option<usize> {
    let mut index = start;
    let mut depth = 0usize;
    while index < sql.len() {
        let ch = next_char(sql, index);
        if matches!(ch, '\'' | '"' | '`') {
            index = skip_sql_quoted(sql, index, ch);
            continue;
        }
        if ch == '[' {
            index = skip_sql_bracket_identifier(sql, index);
            continue;
        }
        if ch == '(' {
            depth += 1;
            index += ch.len_utf8();
            continue;
        }
        if ch == ')' {
            depth = depth.saturating_sub(1);
            index += ch.len_utf8();
            continue;
        }
        if depth == 0 && ch == ',' {
            return Some(index);
        }
        if depth == 0 && sql_keyword_at(sql, index, "FROM") {
            return Some(index);
        }
        index += ch.len_utf8();
    }
    None
}

fn is_simple_sqlserver_order_projection(projection: &str) -> bool {
    if projection.is_empty() || projection == "*" {
        return false;
    }
    let mut expect_part = true;
    let mut saw_part = false;
    let mut index = 0;
    while index < projection.len() {
        let ch = next_char(projection, index);
        if ch.is_whitespace() {
            return false;
        }
        if ch == '.' {
            if expect_part {
                return false;
            }
            expect_part = true;
            index += 1;
            continue;
        }
        if ch == '[' {
            if !expect_part {
                return false;
            }
            let next = skip_sql_bracket_identifier(projection, index);
            if next <= index + 1 || next > projection.len() {
                return false;
            }
            saw_part = true;
            expect_part = false;
            index = next;
            continue;
        }
        if is_sql_token_start(ch) {
            if !expect_part {
                return false;
            }
            index += ch.len_utf8();
            while index < projection.len() && is_sql_token_part(next_char(projection, index)) {
                index += next_char(projection, index).len_utf8();
            }
            saw_part = true;
            expect_part = false;
            continue;
        }
        return false;
    }
    saw_part && !expect_part
}

fn sql_server_derived_order_column_from_projection(projection: &str) -> Option<String> {
    if !is_simple_sqlserver_order_projection(projection) {
        return None;
    }

    let last_part = last_sqlserver_identifier_part(projection);
    if last_part.starts_with('[') {
        return Some(last_part.to_string());
    }
    Some(quote_table_identifier(Some(DatabaseType::SqlServer), last_part))
}

fn last_sqlserver_identifier_part(projection: &str) -> &str {
    let mut last_start = 0;
    let mut index = 0;
    while index < projection.len() {
        let ch = next_char(projection, index);
        if ch == '[' {
            index = skip_sql_bracket_identifier(projection, index);
            continue;
        }
        if ch == '.' {
            last_start = index + 1;
            index += 1;
            continue;
        }
        index += ch.len_utf8();
    }
    projection[last_start..].trim()
}

fn skip_sql_whitespace(sql: &str, mut index: usize) -> usize {
    while index < sql.len() && next_char(sql, index).is_whitespace() {
        index += next_char(sql, index).len_utf8();
    }
    index
}

fn skip_sql_keyword(sql: &str, index: usize, keyword: &str) -> Option<usize> {
    sql_keyword_at(sql, index, keyword).then_some(index + keyword.len())
}

fn sql_keyword_at(sql: &str, index: usize, keyword: &str) -> bool {
    let Some(candidate) = sql.get(index..index + keyword.len()) else {
        return false;
    };
    if !candidate.eq_ignore_ascii_case(keyword) {
        return false;
    }
    let before_ok = index == 0 || !is_sql_token_part(next_char_before(sql, index));
    let after = index + keyword.len();
    let after_ok = after >= sql.len() || !is_sql_token_part(next_char(sql, after));
    before_ok && after_ok
}

fn skip_sql_parenthesized(sql: &str, index: usize) -> usize {
    let mut cursor = index;
    let mut depth = 0usize;
    while cursor < sql.len() {
        let ch = next_char(sql, cursor);
        if matches!(ch, '\'' | '"' | '`') {
            cursor = skip_sql_quoted(sql, cursor, ch);
            continue;
        }
        if ch == '[' {
            cursor = skip_sql_bracket_identifier(sql, cursor);
            continue;
        }
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth = depth.saturating_sub(1);
            cursor += ch.len_utf8();
            if depth == 0 {
                return cursor;
            }
            continue;
        }
        cursor += ch.len_utf8();
    }
    sql.len()
}

fn sql_server_derived_table_projection_safe(statement: &str) -> bool {
    let dialect = MsSqlDialect {};
    let Ok(statements) = Parser::parse_sql(&dialect, statement) else {
        return false;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return false;
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return false;
    };

    if matches!(select.projection.as_slice(), [SelectItem::Wildcard(_)]) {
        return select.from.len() == 1 && select.from[0].joins.is_empty();
    }

    let mut column_names = HashSet::with_capacity(select.projection.len());
    select.projection.iter().all(|item| {
        let Some(name) = sql_server_derived_projection_name(item) else {
            return false;
        };
        column_names.insert(name.to_lowercase())
    })
}

fn sql_server_derived_projection_name(item: &SelectItem) -> Option<&str> {
    match item {
        SelectItem::ExprWithAlias { alias, .. } => Some(&alias.value),
        SelectItem::UnnamedExpr(Expr::Identifier(identifier)) if !identifier.value.starts_with('@') => {
            Some(&identifier.value)
        }
        SelectItem::UnnamedExpr(Expr::CompoundIdentifier(identifiers)) => {
            identifiers.last().map(|identifier| identifier.value.as_str())
        }
        SelectItem::UnnamedExpr(_)
        | SelectItem::ExprWithAliases { .. }
        | SelectItem::QualifiedWildcard(_, _)
        | SelectItem::Wildcard(_) => None,
    }
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
    if has_top_level_select_top(statement) || has_top_level_for_xml(statement) {
        return statement.to_string();
    }
    statement_for_order_insensitive_derived_table(statement)
}

fn iris_statement_for_derived_table(statement: &str) -> String {
    statement_for_order_insensitive_derived_table(statement)
}

fn statement_for_order_insensitive_derived_table(statement: &str) -> String {
    let Some(order_by) = find_top_level_trailing_order_by(statement) else {
        return statement.to_string();
    };
    // Result ordering does not change COUNT cardinality, and stripping only
    // depth-zero ORDER BY keeps nested query semantics intact.
    statement[..order_by].trim_end().to_string()
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

fn add_iris_top_limit(statement: &str, limit: usize) -> String {
    if has_top_level_select_top(statement) {
        return format!("{statement};");
    }
    if statement.len() >= 6 && statement[..6].eq_ignore_ascii_case("SELECT") {
        let rest = &statement[6..];
        format!("SELECT TOP {limit}{rest};")
    } else {
        format!("SELECT TOP {limit} * FROM ({statement}) dbx_page;")
    }
}

fn add_questdb_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_limit(statement) {
        if offset > 0 {
            return add_outer_standard_limit(statement, Some(DatabaseType::Questdb), limit, offset, "");
        }
        return format!("{statement};");
    }
    if offset > 0 {
        let upper_bound = offset + limit;
        append_sql_suffix(statement, &format!("LIMIT {offset}, {upper_bound};"))
    } else {
        append_sql_suffix(statement, &format!("LIMIT {limit};"))
    }
}

fn has_top_level_limit(sql: &str) -> bool {
    top_level_sql_tokens(sql).iter().any(|token| token.text == "LIMIT")
}

fn top_level_limit_row_count(sql: &str) -> Option<usize> {
    let token = top_level_sql_tokens(sql).into_iter().find(|token| token.text == "LIMIT")?;
    parse_standard_limit_row_count(sql, token.start + token.text.len())
}

fn parse_standard_limit_row_count(sql: &str, start: usize) -> Option<usize> {
    let mut cursor = skip_sql_whitespace(sql, start);
    let first = parse_usize_literal(sql, &mut cursor)?;
    cursor = skip_sql_whitespace(sql, cursor);
    if sql.get(cursor..)?.starts_with(',') {
        cursor = skip_sql_whitespace(sql, cursor + 1);
        return parse_usize_literal(sql, &mut cursor);
    }
    Some(first)
}

fn parse_usize_literal(sql: &str, cursor: &mut usize) -> Option<usize> {
    let start = *cursor;
    while *cursor < sql.len() && sql.as_bytes()[*cursor].is_ascii_digit() {
        *cursor += 1;
    }
    if *cursor == start {
        return None;
    }
    sql[start..*cursor].parse().ok()
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

fn has_top_level_firebird_row_limit(sql: &str) -> bool {
    if has_top_level_fetch_first(sql) {
        return true;
    }
    let tokens = top_level_sql_tokens(sql);
    if tokens.iter().any(|token| token.text == "ROWS") {
        return true;
    }
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

fn has_top_level_rownum(sql: &str) -> bool {
    top_level_sql_tokens(sql).iter().any(|token| token.text == "ROWNUM")
}

fn has_top_level_offset_fetch_next(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    let has_offset = tokens.iter().any(|token| token.text == "OFFSET");
    let has_fetch_next = tokens.windows(2).any(|w| w[0].text == "FETCH" && w[1].text == "NEXT");
    has_offset && has_fetch_next
}

fn add_fetch_first_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_fetch_first(statement) {
        if offset > 0 {
            let alias = quote_table_identifier(None, "dbx_page");
            return derived_table_sql(
                "SELECT * FROM",
                statement,
                &format!("{alias} OFFSET {offset} ROWS FETCH FIRST {limit} ROWS ONLY;"),
            );
        }
        return format!("{statement};");
    }
    let offset_sql = if offset > 0 { format!(" OFFSET {offset} ROWS") } else { String::new() };
    append_sql_suffix(statement, &format!("{offset_sql} FETCH FIRST {limit} ROWS ONLY;"))
}

fn add_firebird_rows_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_firebird_row_limit(statement) {
        return format!("{statement};");
    }
    let rows = firebird_rows_clause(limit, offset);
    append_sql_suffix(statement, &format!("{rows};"))
}

fn add_rownum_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_rownum(statement) {
        return format!("{statement};");
    }
    if offset == 0 {
        return derived_table_sql("SELECT * FROM", statement, &format!("WHERE ROWNUM <= {limit};"));
    }
    let end = offset + limit;
    let inner = derived_table_sql(
        "SELECT dbx_inner.*, ROWNUM AS \"__dbx_row_num\" FROM",
        statement,
        &format!("dbx_inner WHERE ROWNUM <= {end}"),
    );
    format!("SELECT * FROM ({inner}) WHERE \"__dbx_row_num\" > {offset};")
}

fn add_standard_limit(
    statement: &str,
    database_type: Option<DatabaseType>,
    limit: usize,
    offset: usize,
    dedup_projection_count: Option<usize>,
) -> String {
    let order_sql = dedup_projection_count.map_or(String::new(), format_positional_order_by);

    if has_top_level_limit(statement) {
        if !order_sql.is_empty() {
            // For dedup queries (DISTINCT / GROUP BY) without user ORDER BY,
            // wrap the query to guarantee deterministic LIMIT/OFFSET pagination.
            // The inner query preserves DISTINCT semantics; the outer query
            // adds ORDER BY on positional columns to ensure consistent row
            // ordering across pages in distributed databases like Doris.
            return add_outer_standard_limit(statement, database_type, limit, offset, &order_sql);
        }
        // A user/top-level LIMIT can still be wider than the selected grid page size.
        // Wrap it so the first page respects the UI page limit while preserving the user's cap.
        if offset > 0 || top_level_limit_row_count(statement).is_some_and(|row_count| row_count > limit) {
            return add_outer_standard_limit(statement, database_type, limit, offset, "");
        }
        return format!("{statement};");
    }
    let offset_sql = if offset > 0 { format!(" OFFSET {offset}") } else { String::new() };
    let limit_sql = format!("{order_sql} LIMIT {limit}{offset_sql}");
    if database_type == Some(DatabaseType::ClickHouse) {
        return add_clickhouse_limit(statement, &limit_sql);
    }
    append_sql_suffix(statement, &format!("{limit_sql};"))
}

fn add_outer_standard_limit(
    statement: &str,
    database_type: Option<DatabaseType>,
    limit: usize,
    offset: usize,
    order_sql: &str,
) -> String {
    let alias = quote_table_identifier(database_type, "dbx_page");
    derived_table_sql("SELECT * FROM", statement, &format!("{alias}{order_sql} LIMIT {limit} OFFSET {offset};"))
}

fn add_clickhouse_limit(statement: &str, limit_sql: &str) -> String {
    let limit_sql = limit_sql.trim();
    let settings_index =
        top_level_sql_tokens(statement).iter().find(|token| token.text == "SETTINGS").map(|token| token.start);

    if let Some(index) = settings_index {
        let statement_before_settings = statement[..index].trim_end();
        let settings_clause = statement[index..].trim_start();
        return format!("{statement_before_settings} {limit_sql} {settings_clause};");
    }

    append_sql_suffix(statement, &format!("{limit_sql};"))
}

fn derived_table_sql(prefix: &str, statement: &str, suffix: &str) -> String {
    format!("{prefix} ({}) {suffix}", statement_for_sql_suffix(statement))
}

fn append_sql_suffix(statement: &str, suffix: &str) -> String {
    let separator = if sql_suffix_needs_newline(statement) { "\n" } else { " " };
    format!("{}{separator}{}", statement.trim_end(), suffix.trim_start())
}

fn statement_for_sql_suffix(statement: &str) -> String {
    let trimmed = statement.trim_end();
    if sql_suffix_needs_newline(trimmed) {
        format!("{trimmed}\n")
    } else {
        trimmed.to_string()
    }
}

fn sql_suffix_needs_newline(sql: &str) -> bool {
    let Some(last_line_start) = sql.rfind(['\n', '\r']).map(|index| index + 1) else {
        return line_has_open_line_comment(sql);
    };
    line_has_open_line_comment(&sql[last_line_start..])
}

fn line_has_open_line_comment(line: &str) -> bool {
    let mut index = 0;
    while index < line.len() {
        let ch = next_char(line, index);
        let next = next_char_at(line, index + ch.len_utf8());
        if matches!(ch, '\'' | '"' | '`') {
            index = skip_sql_quoted(line, index, ch);
            continue;
        }
        if ch == '[' {
            index = skip_sql_bracket_identifier(line, index);
            continue;
        }
        if ch == '/' && next == Some('*') {
            index += 2;
            while index < line.len() {
                let current = next_char(line, index);
                let following = next_char_at(line, index + current.len_utf8());
                index += current.len_utf8();
                if current == '*' && following == Some('/') {
                    index += 1;
                    break;
                }
            }
            continue;
        }
        if ch == '-' && next == Some('-') {
            return true;
        }
        if ch == '#' {
            return true;
        }
        index += ch.len_utf8();
    }
    false
}

/// For dedup queries (DISTINCT / GROUP BY) without an ORDER BY clause, generate
/// a positional `ORDER BY 1, 2, ..., N` clause so that LIMIT/OFFSET pagination
/// returns deterministic results across pages.  This is especially important for
/// distributed databases (e.g. Doris, StarRocks) where tablet scan order varies
/// between independent query executions.
fn format_positional_order_by(column_count: usize) -> String {
    if column_count == 0 {
        return String::new();
    }
    let cols: Vec<String> = (1..=column_count).map(|i| i.to_string()).collect();
    format!(" ORDER BY {}", cols.join(", "))
}

/// Detect dedup queries (SELECT DISTINCT, GROUP BY, HAVING) that lack a
/// top-level ORDER BY clause.  Returns the number of projection items so that
/// a positional ORDER BY can be injected for deterministic pagination.
///
/// Returns `None` for:
///   - Non-SELECT queries
///   - Queries without dedup semantics
///   - Queries that already specify ORDER BY
///   - Wildcard projections (`SELECT *`)
///   - Parse failures
fn dedup_projection_count_without_order_by(sql: &str) -> Option<usize> {
    let dialect = GenericDialect {};
    let statements = Parser::parse_sql(&dialect, sql).ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    // Reject if the query already has an ORDER BY clause.
    if query.order_by.is_some() {
        return None;
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return None;
    };
    let has_distinct = select.distinct.is_some();
    let has_group_by = !matches!(&select.group_by, GroupByExpr::Expressions(exprs, _) if exprs.is_empty());
    let has_having = select.having.is_some();
    if !has_distinct && !has_group_by && !has_having {
        return None;
    }
    // Wildcard projections cannot be used with positional ORDER BY.
    if select.projection.len() == 1 && matches!(select.projection.first(), Some(SelectItem::Wildcard(_))) {
        return None;
    }
    Some(select.projection.len())
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
    top_level_select_tokens_before_from(sql).iter().any(|token| token.text == "TOP")
}

fn has_top_level_select_distinct(sql: &str) -> bool {
    top_level_select_tokens_before_from(sql).iter().any(|token| token.text == "DISTINCT")
}

fn top_level_select_tokens_before_from(sql: &str) -> Vec<SqlToken> {
    let tokens = top_level_sql_tokens(sql);
    let Some(select_index) = tokens.iter().position(|token| token.text == "SELECT") else {
        return Vec::new();
    };
    let from_index = tokens
        .iter()
        .enumerate()
        .find(|(index, token)| *index > select_index && token.text == "FROM")
        .map(|(index, _)| index)
        .unwrap_or(tokens.len());
    tokens[select_index + 1..from_index].to_vec()
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

fn next_char_before(sql: &str, index: usize) -> char {
    sql[..index].chars().next_back().unwrap_or('\0')
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
    fn uses_sqlserver_top_for_unnamed_expression_on_first_page() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id + 1 FROM TicketInfo".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT TOP (100) id + 1 FROM TicketInfo");
    }

    #[test]
    fn rejects_sqlserver_unnamed_expression_for_later_pages() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id + 1 FROM TicketInfo".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        assert_eq!(result, err("unsupported"));
    }

    #[test]
    fn uses_sqlserver_top_for_distinct_queries_without_order_by() {
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
    fn rejects_sqlserver_distinct_later_pages_without_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT DISTINCT ProjectType FROM JDDR_sys_BasicConfig_ProjectInfo_Data".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        assert_eq!(result, err("unsupported"));
    }

    #[test]
    fn paginates_sqlserver_all_queries_with_top() {
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
    fn paginates_sqlserver_select_prefix_like_all_modifier() {
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
    fn paginates_existing_sqlserver_top_clause_on_first_page() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT TOP 1000 * FROM TicketInfo".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT TOP (100) * FROM (SELECT TOP 1000 * FROM TicketInfo) [dbx_page] ORDER BY (SELECT NULL);"
        );
    }

    #[test]
    fn paginates_existing_sqlserver_top_clause_for_later_pages() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT TOP 1000 * FROM TicketInfo".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [__dbx_row_num] FROM (SELECT TOP 1000 * FROM TicketInfo) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 200 ORDER BY [__dbx_row_num];"
        );
    }

    #[test]
    fn sqlserver_top_query_later_page_keeps_page_metadata() {
        let sql = "SELECT TOP 1000 * FROM TicketInfo".to_string();
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.clone(),
            query_base_sql: sql,
            database_type: Some(DatabaseType::SqlServer),
            pagination: QueryPagination { limit: 100, offset: 100, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(
            plan.sql_to_execute,
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [__dbx_row_num] FROM (SELECT TOP 1000 * FROM TicketInfo) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 200 ORDER BY [__dbx_row_num];"
        );
        assert_eq!(plan.page_sql, Some(plan.sql_to_execute.clone()));
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(100));
    }

    #[test]
    fn sqlserver_unsafe_projections_execute_original_sql_without_wrappers() {
        let queries = [
            "SELECT TOP 100 AAA, * FROM BBB",
            "SELECT TOP 100 AAA, bbb AS aaa FROM BBB",
            "SELECT TOP 100 a.id, b.id FROM AAA a JOIN BBB b ON a.id = b.id",
            "SELECT TOP 100 a.*, b.* FROM AAA a JOIN BBB b ON a.id = b.id",
            "SELECT TOP 100 a.*, * FROM AAA a",
            "SELECT TOP 100 AAA + 1 FROM BBB",
        ];

        for sql in queries {
            for offset in [0, 100] {
                let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                    sql: sql.to_string(),
                    query_base_sql: sql.to_string(),
                    database_type: Some(DatabaseType::SqlServer),
                    pagination: QueryPagination { limit: 100, offset, session_id: None },
                    use_agent_cursor: false,
                    first_page_uses_actual_sql: false,
                });

                assert_eq!(plan.sql_to_execute, sql);
                assert!(plan.page_sql.is_none());
                assert!(plan.count_sql.is_none());
                assert_eq!(plan.page_limit, None);
                assert_eq!(plan.page_offset, None);
            }
        }
    }

    #[test]
    fn sqlserver_unsafe_projection_is_not_wrapped_for_count() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT TOP 100 AAA, * FROM BBB".to_string(),
            database_type: Some(DatabaseType::SqlServer),
        });

        assert_eq!(result, err("unsupported"));
    }

    #[test]
    fn sqlserver_unsafe_projection_is_not_paginated_directly() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT TOP 100 AAA, * FROM BBB".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        assert_eq!(result, err("unsupported"));
    }

    #[test]
    fn sqlserver_unique_top_projection_keeps_server_pagination() {
        let sql = "SELECT TOP 500 [id], [order_no] FROM [sales].[orders_10k]".to_string();
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.clone(),
            query_base_sql: sql,
            database_type: Some(DatabaseType::SqlServer),
            pagination: QueryPagination { limit: 100, offset: 100, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
        });

        assert!(plan.sql_to_execute.contains("ROW_NUMBER()"));
        assert_eq!(plan.page_sql, Some(plan.sql_to_execute.clone()));
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(100));
        assert!(plan.count_sql.is_some());
    }

    #[test]
    fn paginates_sqlserver_top_parenthesized_projection_query_by_first_column() {
        let sql = "SELECT TOP (500) [id], [order_no], [store_id], [product_id], [customer_name], [quantity], [amount], [order_status], [created_at] FROM [sales].[orders_10k]";
        let first_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });
        let second_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        assert!(first_page.ok);
        assert!(second_page.ok);
        assert_eq!(
            first_page.sql.unwrap(),
            "SELECT TOP (100) * FROM (SELECT TOP (500) [id], [order_no], [store_id], [product_id], [customer_name], [quantity], [amount], [order_status], [created_at] FROM [sales].[orders_10k]) [dbx_page] ORDER BY [id];"
        );
        assert_eq!(
            second_page.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY [id]) AS [__dbx_row_num] FROM (SELECT TOP (500) [id], [order_no], [store_id], [product_id], [customer_name], [quantity], [amount], [order_status], [created_at] FROM [sales].[orders_10k]) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 200 ORDER BY [__dbx_row_num];"
        );
    }

    #[test]
    fn paginates_sqlserver_top_query_with_qualified_first_projection_by_exposed_column() {
        let sql = "select top 1  t1.FSUPPLIERID,  kh.FNAME gysnm   from  GDWORKOUT t1 join  SUPPLIER kh on t1.FSUPPLIERID=kh.FITEMID join GDWORKOUTS t2 on t1.fid=t2.fid";
        let first_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });
        let second_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        assert!(first_page.ok);
        assert!(second_page.ok);
        assert_eq!(
            first_page.sql.unwrap(),
            "SELECT TOP (100) * FROM (select top 1  t1.FSUPPLIERID,  kh.FNAME gysnm   from  GDWORKOUT t1 join  SUPPLIER kh on t1.FSUPPLIERID=kh.FITEMID join GDWORKOUTS t2 on t1.fid=t2.fid) [dbx_page] ORDER BY [FSUPPLIERID];"
        );
        assert_eq!(
            second_page.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY [FSUPPLIERID]) AS [__dbx_row_num] FROM (select top 1  t1.FSUPPLIERID,  kh.FNAME gysnm   from  GDWORKOUT t1 join  SUPPLIER kh on t1.FSUPPLIERID=kh.FITEMID join GDWORKOUTS t2 on t1.fid=t2.fid) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 200 ORDER BY [__dbx_row_num];"
        );
    }

    #[test]
    fn paginates_sqlserver_top_query_with_dotted_bracket_identifier() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT TOP 1000 [order.id] FROM TicketInfo".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT TOP (100) * FROM (SELECT TOP 1000 [order.id] FROM TicketInfo) [dbx_page] ORDER BY [order.id];"
        );
    }

    #[test]
    fn paginates_sqlserver_top_query_after_leading_comment_by_first_column() {
        let sql = "-- 测试\nSELECT TOP (500) [id], [order_no], [store_id], [product_id], [customer_name], [quantity], [amount], [order_status], [created_at] FROM [sales].[orders_10k]";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY [id]) AS [__dbx_row_num] FROM (SELECT TOP (500) [id], [order_no], [store_id], [product_id], [customer_name], [quantity], [amount], [order_status], [created_at] FROM [sales].[orders_10k]) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 200 ORDER BY [__dbx_row_num];"
        );
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
            first_page_uses_actual_sql: false,
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
    fn postgres_cte_update_is_not_paginated() {
        let sql = r#"
WITH available AS (
    SELECT id
    FROM app_users
    WHERE deleted_at IS NULL
),
picked AS (
    SELECT id
    FROM available
    ORDER BY random()
    LIMIT 10
)
UPDATE app_users AS u
SET subscription_type = 1
FROM picked
WHERE u.id = picked.id;
"#;

        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result, err("not_select"));
    }

    #[test]
    fn postgres_cte_update_pagination_plan_executes_original_sql() {
        let sql = "WITH picked AS (SELECT id FROM app_users LIMIT 10) UPDATE app_users SET subscription_type = 1 FROM picked WHERE app_users.id = picked.id".to_string();
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.clone(),
            query_base_sql: sql.clone(),
            database_type: Some(DatabaseType::Postgres),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert!(plan.count_sql.is_none());
        assert_eq!(plan.page_limit, None);
        assert_eq!(plan.page_offset, None);
    }

    #[test]
    fn postgres_cte_select_still_paginates() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "WITH picked AS (SELECT id FROM app_users LIMIT 10) SELECT * FROM picked".to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "WITH picked AS (SELECT id FROM app_users LIMIT 10) SELECT * FROM picked LIMIT 100;"
        );
    }

    #[test]
    fn clickhouse_scalar_with_select_is_paginated() {
        let sql = "WITH 1 AS min_id SELECT dept, COUNT(*) FROM employees WHERE id >= min_id GROUP BY dept";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::ClickHouse),
            limit: 50,
            offset: 100,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "WITH 1 AS min_id SELECT dept, COUNT(*) FROM employees WHERE id >= min_id GROUP BY dept LIMIT 50 OFFSET 100;"
        );
    }

    #[test]
    fn clickhouse_settings_clause_is_paginated_before_settings() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM system.clusters SETTINGS max_execution_time = 0".to_string(),
            database_type: Some(DatabaseType::ClickHouse),
            limit: 50,
            offset: 100,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM system.clusters LIMIT 50 OFFSET 100 SETTINGS max_execution_time = 0;"
        );
    }

    #[test]
    fn clickhouse_query_plan_places_limit_before_settings() {
        let sql = "SELECT * FROM system.clusters SETTINGS max_execution_time = 0";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::ClickHouse),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM system.clusters LIMIT 100 SETTINGS max_execution_time = 0;");
        assert_eq!(
            plan.page_sql,
            Some("SELECT * FROM system.clusters LIMIT 100 SETTINGS max_execution_time = 0;".to_string())
        );
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(0));
    }

    #[test]
    fn clickhouse_scalar_with_select_can_be_counted() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "WITH 1 AS min_id SELECT dept, COUNT(*) FROM employees WHERE id >= min_id GROUP BY dept"
                .to_string(),
            database_type: Some(DatabaseType::ClickHouse),
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM (WITH 1 AS min_id SELECT dept, COUNT(*) FROM employees WHERE id >= min_id GROUP BY dept) `dbx_count`;"
        );
    }

    #[test]
    fn clickhouse_scalar_with_update_is_not_paginated() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "WITH 1 AS min_id UPDATE employees SET dept = 'sales' WHERE id = min_id".to_string(),
            database_type: Some(DatabaseType::ClickHouse),
            limit: 50,
            offset: 0,
        });

        assert_eq!(result, err("not_select"));
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
    fn uses_sqlserver_row_number_pagination_for_later_pages() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 300,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [__dbx_row_num] FROM (SELECT id FROM users) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 300 AND [__dbx_row_num] <= 400 ORDER BY [__dbx_row_num];"
        );
    }

    #[test]
    fn rejects_sqlserver_wildcard_later_pages_to_avoid_duplicate_columns() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql:
                "SELECT b.ProjectType,* FROM VesselBusinessOpportunity a LEFT JOIN JDDR_sys_BasicConfig_ProjectInfo_Data b ON a.ProjectID = b.ID"
                    .to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
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
    fn oceanbase_oracle_pagination_wraps_with_rownum() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users ORDER BY id".to_string(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT id FROM users ORDER BY id) WHERE ROWNUM <= 100;");
    }

    #[test]
    fn oceanbase_oracle_pagination_wraps_offset_with_rownum_bounds() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users ORDER BY id".to_string(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            limit: 100,
            offset: 200,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_inner.*, ROWNUM AS \"__dbx_row_num\" FROM (SELECT id FROM users ORDER BY id) dbx_inner WHERE ROWNUM <= 300) WHERE \"__dbx_row_num\" > 200;"
        );
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
    fn uses_rows_pagination_for_firebird() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users WHERE active = 1 ORDER BY id".to_string(),
            database_type: Some(DatabaseType::Firebird),
            limit: 50,
            offset: 100,
        });

        assert_eq!(result.sql.unwrap(), "SELECT id FROM users WHERE active = 1 ORDER BY id ROWS 101 TO 150;");
    }

    #[test]
    fn firebird_pagination_keeps_existing_rows_clause() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users ROWS 20".to_string(),
            database_type: Some(DatabaseType::Firebird),
            limit: 50,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT id FROM users ROWS 20;");
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
    fn mysql_pagination_keeps_limit_outside_trailing_line_comment() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT 1 AS id\n-- tail comment".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT 1 AS id\n-- tail comment\nLIMIT 50;");
    }

    #[test]
    fn mysql_pagination_keeps_limit_outside_trailing_hash_comment() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT 1 AS id\n# tail comment".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT 1 AS id\n# tail comment\nLIMIT 50;");
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
    fn mysql_pagination_wraps_wide_existing_limit_on_first_page() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM dy_promotion_item WHERE create_time < '2026-06-01' LIMIT 10000;".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 500,
            offset: 0,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT * FROM dy_promotion_item WHERE create_time < '2026-06-01' LIMIT 10000) `dbx_page` LIMIT 500 OFFSET 0;"
        );
    }

    #[test]
    fn mysql_pagination_wraps_comma_limit_row_count_on_first_page() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM users LIMIT 20, 10000;".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 500,
            offset: 0,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT * FROM users LIMIT 20, 10000) `dbx_page` LIMIT 500 OFFSET 0;"
        );
    }

    #[test]
    fn mysql_pagination_wraps_existing_limit_for_later_pages() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM dy_promotion_item WHERE create_time < '2026-06-01' LIMIT 10000;".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 1000,
            offset: 1000,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT * FROM dy_promotion_item WHERE create_time < '2026-06-01' LIMIT 10000) `dbx_page` LIMIT 1000 OFFSET 1000;"
        );
    }

    #[test]
    fn standard_pagination_wraps_existing_limit_for_later_pages() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users LIMIT 20;".to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 5,
            offset: 10,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT id FROM users LIMIT 20) \"dbx_page\" LIMIT 5 OFFSET 10;"
        );
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
    fn count_query_keeps_wrapper_outside_trailing_line_comment() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT 1 AS id\n-- tail comment".to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT 1 AS id\n-- tail comment\n) `dbx_count`;"
        );
    }

    #[test]
    fn count_query_keeps_wrapper_outside_trailing_hash_comment() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT 1 AS id\n# tail comment".to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT 1 AS id\n# tail comment\n) `dbx_count`;"
        );
    }

    #[test]
    fn count_query_preserves_user_limit() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT * FROM dy_promotion_item WHERE create_time < '2026-06-01' LIMIT 10000".to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT * FROM dy_promotion_item WHERE create_time < '2026-06-01' LIMIT 10000) `dbx_count`;"
        );
    }

    #[test]
    fn count_query_preserves_user_limit_offset() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT * FROM users WHERE active = 1 LIMIT 100 OFFSET 50".to_string(),
            database_type: Some(DatabaseType::Postgres),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT * FROM users WHERE active = 1 LIMIT 100 OFFSET 50) \"dbx_count\";"
        );
    }

    #[test]
    fn iris_count_query_removes_top_level_order_by() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT id, appointment_time FROM patients WHERE status = ? ORDER BY appointment_time DESC"
                .to_string(),
            database_type: Some(DatabaseType::Iris),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT id, appointment_time FROM patients WHERE status = ?) \"dbx_count\";"
        );
    }

    #[test]
    fn iris_count_query_preserves_nested_order_by_and_parameters() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT * FROM (SELECT TOP ? id FROM visits WHERE status = ? ORDER BY created_at DESC) recent WHERE id > ? ORDER BY id"
                .to_string(),
            database_type: Some(DatabaseType::Iris),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT * FROM (SELECT TOP ? id FROM visits WHERE status = ? ORDER BY created_at DESC) recent WHERE id > ?) \"dbx_count\";"
        );
    }

    #[test]
    fn iris_count_query_without_order_by_is_unchanged() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT id FROM visits WHERE status = ?".to_string(),
            database_type: Some(DatabaseType::Iris),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT id FROM visits WHERE status = ?) \"dbx_count\";"
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
            first_page_uses_actual_sql: false,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM events");
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(plan.page_sql.is_none());
        assert!(plan.use_agent_result_session);
    }

    #[test]
    fn kingbase_prefers_server_pagination_over_agent_cursor() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Kingbase),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM events LIMIT 500;");
        assert_eq!(plan.page_sql, Some(plan.sql_to_execute.clone()));
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(!plan.use_agent_result_session);
    }

    #[test]
    fn kingbase_falls_back_to_agent_cursor_for_unrewritable_queries() {
        let sql = "SELECT * FROM events; SELECT 1";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::Kingbase),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(plan.use_agent_result_session);
    }

    #[test]
    fn export_agent_cursor_first_page_keeps_actual_sorted_sql() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM (SELECT * FROM events) t ORDER BY created_at DESC".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Oracle),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: true,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM (SELECT * FROM events) t ORDER BY created_at DESC");
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
    fn builds_clickhouse_sorted_query_without_alias_list() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT id, part_day, hid FROM events LIMIT 100".to_string(),
            database_type: Some(DatabaseType::ClickHouse),
            result_columns: vec!["id".to_string(), "part_day".to_string(), "hid".to_string()],
            column_index: 0,
            column: "id".to_string(),
            direction: QuerySortDirection::Desc,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT id, part_day, hid FROM events LIMIT 100) t ORDER BY `id` DESC;"
        );
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

    // -----------------------------------------------------------------------
    // Dedup query ORDER BY injection (DISTINCT / GROUP BY)
    // -----------------------------------------------------------------------

    #[test]
    fn dedup_count_detects_distinct_query_without_order_by() {
        assert_eq!(dedup_projection_count_without_order_by("SELECT DISTINCT a, b, c FROM t"), Some(3));
    }

    #[test]
    fn dedup_count_detects_group_by_query() {
        assert_eq!(dedup_projection_count_without_order_by("SELECT city, COUNT(*) FROM users GROUP BY city"), Some(2));
    }

    #[test]
    fn dedup_count_returns_none_for_plain_select() {
        assert_eq!(dedup_projection_count_without_order_by("SELECT a, b FROM t"), None);
    }

    #[test]
    fn dedup_count_returns_none_when_order_by_exists() {
        assert_eq!(dedup_projection_count_without_order_by("SELECT DISTINCT a, b FROM t ORDER BY a"), None);
    }

    #[test]
    fn dedup_count_returns_none_for_wildcard() {
        assert_eq!(dedup_projection_count_without_order_by("SELECT DISTINCT * FROM t"), None);
    }

    #[test]
    fn doris_distinct_query_first_page_gets_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT DISTINCT city, name FROM users".to_string(),
            database_type: Some(DatabaseType::Doris),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT DISTINCT city, name FROM users ORDER BY 1, 2 LIMIT 100;");
    }

    #[test]
    fn doris_distinct_query_second_page_wraps_with_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT DISTINCT city, name FROM users".to_string(),
            database_type: Some(DatabaseType::Doris),
            limit: 100,
            offset: 100,
        });

        assert!(result.ok);
        // No top-level LIMIT in the original query, so ORDER BY + LIMIT + OFFSET
        // are appended directly to the statement (no wrapping needed).
        assert_eq!(result.sql.unwrap(), "SELECT DISTINCT city, name FROM users ORDER BY 1, 2 LIMIT 100 OFFSET 100;");
    }

    #[test]
    fn doris_group_by_query_first_page_gets_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT dept, SUM(salary) FROM employees GROUP BY dept".to_string(),
            database_type: Some(DatabaseType::Doris),
            limit: 50,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT dept, SUM(salary) FROM employees GROUP BY dept ORDER BY 1, 2 LIMIT 50;"
        );
    }

    #[test]
    fn doris_plain_query_without_distinct_is_unaffected() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id, name FROM users".to_string(),
            database_type: Some(DatabaseType::Doris),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT id, name FROM users LIMIT 100;");
    }

    #[test]
    fn doris_distinct_with_existing_limit_first_page_keeps_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT DISTINCT a, b, c FROM t LIMIT 500".to_string(),
            database_type: Some(DatabaseType::Doris),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        // The dedup query has a LIMIT, so it must be wrapped.
        // `add_outer_standard_limit` always includes OFFSET clause.
        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT DISTINCT a, b, c FROM t LIMIT 500) `dbx_page` ORDER BY 1, 2, 3 LIMIT 100 OFFSET 0;"
        );
    }

    #[test]
    fn mysql_distinct_query_first_page_gets_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT DISTINCT city FROM users".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 200,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT DISTINCT city FROM users ORDER BY 1 LIMIT 200;");
    }

    #[test]
    fn postgres_distinct_query_first_page_gets_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT DISTINCT city, name FROM users".to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT DISTINCT city, name FROM users ORDER BY 1, 2 LIMIT 100;");
    }

    #[test]
    fn distinct_query_with_existing_order_by_is_not_modified() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT DISTINCT a, b FROM t ORDER BY a".to_string(),
            database_type: Some(DatabaseType::Doris),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        // Already has ORDER BY, so only LIMIT is appended.
        assert_eq!(result.sql.unwrap(), "SELECT DISTINCT a, b FROM t ORDER BY a LIMIT 100;");
    }

    // -----------------------------------------------------------------------
    // Complex queries with aliases, expressions, subqueries
    // -----------------------------------------------------------------------

    #[test]
    fn dedup_count_handles_aliases() {
        assert_eq!(dedup_projection_count_without_order_by("SELECT DISTINCT a AS x, b AS y, c AS z FROM t"), Some(3));
    }

    #[test]
    fn dedup_count_handles_expressions() {
        assert_eq!(
            dedup_projection_count_without_order_by(
                "SELECT DISTINCT a + b AS sum_col, CASE WHEN c > 0 THEN 'Y' ELSE 'N' END AS flag FROM t"
            ),
            Some(2)
        );
    }

    #[test]
    fn dedup_count_handles_aggregate_with_alias() {
        assert_eq!(
            dedup_projection_count_without_order_by(
                "SELECT city, COUNT(*) AS cnt, AVG(salary) AS avg_sal FROM users GROUP BY city"
            ),
            Some(3)
        );
    }

    #[test]
    fn doris_distinct_with_alias_and_expression_gets_positional_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql:
                "SELECT DISTINCT a AS col1, b + c AS col2, CASE WHEN d > 0 THEN 'Y' ELSE 'N' END AS col3 FROM t"
                    .to_string(),
            database_type: Some(DatabaseType::Doris),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        // Positional ORDER BY 1, 2, 3 works regardless of aliases or expressions.
        assert_eq!(
            result.sql.unwrap(),
            "SELECT DISTINCT a AS col1, b + c AS col2, CASE WHEN d > 0 THEN 'Y' ELSE 'N' END AS col3 FROM t ORDER BY 1, 2, 3 LIMIT 100;"
        );
    }

    #[test]
    fn doris_group_by_with_aggregate_alias_gets_positional_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT dept, SUM(salary) AS total, COUNT(*) AS head_count FROM emp GROUP BY dept"
                .to_string(),
            database_type: Some(DatabaseType::Doris),
            limit: 50,
            offset: 100,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT dept, SUM(salary) AS total, COUNT(*) AS head_count FROM emp GROUP BY dept ORDER BY 1, 2, 3 LIMIT 50 OFFSET 100;"
        );
    }

    #[test]
    fn doris_distinct_with_subquery_column_gets_positional_order_by() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql:
                "SELECT DISTINCT name, (SELECT MAX(score) FROM scores s WHERE s.uid = u.id) AS max_score FROM users u"
                    .to_string(),
            database_type: Some(DatabaseType::Doris),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT DISTINCT name, (SELECT MAX(score) FROM scores s WHERE s.uid = u.id) AS max_score FROM users u ORDER BY 1, 2 LIMIT 100;"
        );
    }

    #[test]
    fn union_query_is_not_treated_as_dedup() {
        assert_eq!(dedup_projection_count_without_order_by("SELECT a FROM t1 UNION SELECT b FROM t2"), None);
    }
}
