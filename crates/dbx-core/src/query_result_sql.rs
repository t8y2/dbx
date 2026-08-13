use std::collections::HashSet;
use std::ops::ControlFlow;

use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::sql::find_statement_at_cursor;
use crate::sql_dialect::{
    firebird_rows_clause, pagination_strategy, quote_table_identifier, PaginationContext, TablePaginationStrategy,
};
use sqlparser::ast::{visit_expressions, Expr, GroupByExpr, OrderByKind, Select, SelectItem, SetExpr, Statement};
use sqlparser::dialect::{ClickHouseDialect, GenericDialect, MsSqlDialect};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_query_row_bound: Option<usize>,
    pub use_agent_result_session: bool,
    /// True when the statement cannot be paginated server-side and must be
    /// executed once with the whole result streamed back (single execution).
    /// Only meaningful to in-process callers (query-result export); never
    /// serialized to the frontend.
    #[serde(skip)]
    pub single_execution: bool,
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
    let exact_query_row_bound = if options.database_type == Some(DatabaseType::SqlServer) {
        top_level_top_row_count(&options.query_base_sql)
    } else {
        None
    };
    let mut plan = QueryPaginationExecutionPlan {
        sql_to_execute: options.sql.clone(),
        page_sql: None,
        page_limit: None,
        page_offset: None,
        count_sql: None,
        exact_query_row_bound,
        use_agent_result_session: false,
        single_execution: false,
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
        if !options.first_page_uses_actual_sql && options.sql == options.query_base_sql {
            plan.sql_to_execute = options.query_base_sql;
        }
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
        return plan;
    }

    let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
        original_sql: options.sql.clone(),
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
        if !options.first_page_uses_actual_sql && options.sql == options.query_base_sql {
            plan.sql_to_execute = options.query_base_sql;
        }
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
    } else if options.database_type == Some(DatabaseType::Kingbase)
        && single_selectable_statement(&options.sql).is_ok()
        && has_top_level_top(&options.sql)
    {
        // Kingbase SQL Server compatibility mode rejects a statement that mixes a
        // top-level TOP with a sibling LIMIT/OFFSET. Without an Agent cursor the
        // query-result export executes the statement once and streams the whole
        // result; the TOP clause already bounds the row count.
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.single_execution = true;
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

    if matches!(options.database_type, Some(DatabaseType::Elasticsearch | DatabaseType::Easysearch)) {
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
            // Kingbase SQL Server compatibility mode accepts TOP as a real clause.
            // Appending LIMIT/OFFSET alongside a top-level TOP would be rejected by
            // the server ("multiple TOP/LIMIT clauses not allowed"), so fall back to
            // the Agent cursor / client-side row cap for such statements.
            if options.database_type == Some(DatabaseType::Kingbase) && has_top_level_top(&statement) {
                return err("unsupported");
            }
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
    let (execution_hint, statement) = split_leading_execution_hint(&statement);
    // A locking clause does not affect cardinality and cannot appear inside
    // every dialect's derived-table count query. PostgreSQL permits pagination
    // after the lock clause; decline counting that uncommon order rather than
    // accidentally dropping the user's explicit LIMIT/OFFSET.
    let tokens = top_level_sql_tokens(statement);
    let statement = if let Some(index) = locking_clause_index(&tokens) {
        if has_pagination_clause_after(&tokens, index) {
            return err("locking");
        }
        statement[..index].trim_end().to_string()
    } else {
        statement.to_string()
    };
    // ES SQL can't wrap a SELECT in `SELECT COUNT(*) FROM (...)` — the
    // driver already reports the true match count via affected_rows.
    if matches!(options.database_type, Some(DatabaseType::Elasticsearch | DatabaseType::Easysearch)) {
        return err("unsupported");
    }
    if options.database_type == Some(DatabaseType::SqlServer) {
        return sql_server_count_sql(&statement)
            .map(|sql| ok(format!("{execution_hint}{sql}")))
            .unwrap_or_else(|| err("unsupported"));
    }

    let alias = quote_table_identifier(options.database_type, "dbx_count");
    let wrapped_sql = match options.database_type {
        Some(DatabaseType::Iris) => iris_statement_for_derived_table(&statement),
        _ => statement,
    };
    ok(format!(
        "{execution_hint}{}",
        derived_table_sql("SELECT COUNT(*) AS dbx_total_rows FROM", &wrapped_sql, &format!("{alias};"))
    ))
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
        // Doris accepts the derived-table alias but not its column-name list.
        && options.database_type != Some(DatabaseType::Doris)
        && options.database_type != Some(DatabaseType::Sqlite)
        && options.database_type != Some(DatabaseType::DuckDb)
        && options.database_type != Some(DatabaseType::Dameng)
        && options.database_type != Some(DatabaseType::Oracle)
        && options.database_type != Some(DatabaseType::OceanbaseOracle);
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
    // Oracle-compatible derived tables do not accept a PostgreSQL-style
    // column alias list. Use the selected column position when duplicate
    // labels would otherwise make ORDER BY ambiguous.
    let use_sort_ordinal = !use_derived_column_aliases
        && matches!(
            options.database_type,
            Some(DatabaseType::Dameng | DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
        )
        && options.result_columns.get(options.column_index).is_some_and(|column| {
            options.result_columns.iter().filter(|candidate| candidate.eq_ignore_ascii_case(column)).count() > 1
        });
    let sort_reference = if use_sort_ordinal {
        (options.column_index + 1).to_string()
    } else {
        quote_table_identifier(options.database_type, &sort_alias)
    };
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
            "SELECT * FROM ({wrapped_statement}) t({alias_list}) ORDER BY {sort_reference} {};",
            options.direction.as_sql()
        ))
    } else {
        ok(format!("SELECT * FROM ({wrapped_statement}) t ORDER BY {sort_reference} {};", options.direction.as_sql()))
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

    let extracted = find_statement_at_cursor(base_sql, 0).trim().trim_end_matches(';').trim().to_string();
    if extracted.is_empty() {
        return Err(());
    }
    if !single_statement_matches_base_sql(&extracted, base_sql) {
        return Err(());
    }
    let statement = restore_leading_execution_hint(base_sql, &extracted);
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
        return if sql_server_derived_table_projection_safe(statement) {
            Some(add_sql_server_existing_top_pagination(statement, limit, offset))
        } else {
            (offset > 0).then(|| add_sql_server_rowcount_pagination(statement, limit, offset))
        };
    }

    let order_by_index = find_top_level_trailing_order_by(statement);
    if order_by_index.is_none() && has_top_level_select_distinct(statement) {
        return (offset == 0).then(|| add_sql_server_top(statement, limit));
    }

    if offset == 0 {
        return Some(add_sql_server_top(statement, limit));
    }

    let statement_without_order = order_by_index.map(|index| statement[..index].trim_end()).unwrap_or(statement);
    if !sql_server_row_number_pagination_safe(statement) {
        return Some(add_sql_server_rowcount_pagination(statement, limit, offset));
    }

    let row_number_order = order_by_index
        .map(|index| statement[index..].trim().to_string())
        .unwrap_or_else(|| "ORDER BY (SELECT NULL)".to_string());
    let end = offset + limit;
    Some(format!(
        "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER ({row_number_order}) AS [__dbx_row_num] FROM ({statement_without_order}) dbx_page_source) dbx_page WHERE [__dbx_row_num] > {offset} AND [__dbx_row_num] <= {end} ORDER BY [__dbx_row_num];"
    ))
}

fn sql_server_row_number_pagination_safe(statement: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&MsSqlDialect {}, statement) else {
        return false;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return false;
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return false;
    };
    if !sql_server_derived_table_select_projection_safe(select) {
        return false;
    }

    let Some(order_by) = &query.order_by else {
        return true;
    };
    let OrderByKind::Expressions(order_exprs) = &order_by.kind else {
        return false;
    };
    let wildcard_projection = matches!(select.projection.as_slice(), [SelectItem::Wildcard(_)]);
    let output_names = select
        .projection
        .iter()
        .filter_map(sql_server_derived_projection_name)
        .map(str::to_lowercase)
        .collect::<HashSet<_>>();

    order_exprs.iter().all(|order_expr| {
        if matches!(order_expr.expr, Expr::Value(_)) {
            return false;
        }
        !visit_expressions(&order_expr.expr, |expr| match expr {
            Expr::CompoundIdentifier(_) => ControlFlow::Break(()),
            Expr::Identifier(identifier)
                if !wildcard_projection && !output_names.contains(&identifier.value.to_lowercase()) =>
            {
                ControlFlow::Break(())
            }
            _ => ControlFlow::Continue(()),
        })
        .is_break()
    })
}

const SQLSERVER_RESULT_OFFSET_PREFIX: &str = "/*__dbx_result_offset=";
const SQLSERVER_RESULT_OFFSET_SUFFIX: &str = "__*/";

fn add_sql_server_rowcount_pagination(statement: &str, limit: usize, offset: usize) -> String {
    let row_count = offset.saturating_add(limit);
    let escaped_statement = statement.replace('\'', "''");
    // Keep duplicate result-column names intact while bounding the server response
    // on every SQL Server version supported by DBX. The dynamic batch scopes
    // SET ROWCOUNT to this execution instead of leaking it into the tab session.
    format!(
        "EXEC sys.sp_executesql N'SET ROWCOUNT {row_count}; {escaped_statement}'; {SQLSERVER_RESULT_OFFSET_PREFIX}{offset}{SQLSERVER_RESULT_OFFSET_SUFFIX}"
    )
}

pub(crate) fn sqlserver_result_offset(sql: &str) -> usize {
    let sql = sql.trim_end();
    if !sql.starts_with("EXEC sys.sp_executesql N'SET ROWCOUNT ") || !sql.ends_with(SQLSERVER_RESULT_OFFSET_SUFFIX) {
        return 0;
    }
    let Some(marker_index) = sql.rfind(SQLSERVER_RESULT_OFFSET_PREFIX) else {
        return 0;
    };
    let value_start = marker_index + SQLSERVER_RESULT_OFFSET_PREFIX.len();
    let value_end = sql.len() - SQLSERVER_RESULT_OFFSET_SUFFIX.len();
    sql[value_start..value_end].parse().unwrap_or(0)
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

fn restore_leading_execution_hint(original_sql: &str, statement: &str) -> String {
    if leading_execution_hint_prefix(statement).is_some() {
        return statement.to_string();
    }
    let normalized = original_sql.trim().trim_end_matches(';').trim();
    match leading_execution_hint_prefix(normalized) {
        Some(prefix) => format!("{prefix}{statement}"),
        None => statement.to_string(),
    }
}

fn split_leading_execution_hint(sql: &str) -> (&str, &str) {
    match leading_execution_hint_prefix(sql) {
        Some(prefix) => (prefix, sql[prefix.len()..].trim_start()),
        None => ("", sql),
    }
}

fn leading_execution_hint_prefix(sql: &str) -> Option<&str> {
    let mut index = 0;
    let mut hint_start = None;
    loop {
        index = skip_sql_whitespace(sql, index);
        let rest = &sql[index..];
        if rest.starts_with("--") {
            index += 2;
            while index < sql.len() && next_char(sql, index) != '\n' {
                index += next_char(sql, index).len_utf8();
            }
            continue;
        }
        if !rest.starts_with("/*") {
            return hint_start.map(|start| &sql[start..index]);
        }
        if hint_start.is_none() && matches!(next_char_at(sql, index + 2), Some('+' | '@' | '&')) {
            hint_start = Some(index);
        }
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

    sql_server_derived_table_select_projection_safe(select)
}

fn sql_server_derived_table_select_projection_safe(select: &Select) -> bool {
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

fn sql_server_count_sql(statement: &str) -> Option<String> {
    let dialect = MsSqlDialect {};
    let mut statements = Parser::parse_sql(&dialect, statement).ok()?;
    let derived_table_projection_safe = {
        let [Statement::Query(query)] = statements.as_slice() else {
            return None;
        };
        let SetExpr::Select(select) = query.body.as_ref() else {
            return None;
        };
        sql_server_derived_table_select_projection_safe(select)
    };
    if derived_table_projection_safe {
        let alias = quote_table_identifier(Some(DatabaseType::SqlServer), "dbx_count");
        let wrapped_sql = sql_server_statement_for_derived_table(statement);
        return Some(derived_table_sql("SELECT COUNT(*) AS dbx_total_rows FROM", &wrapped_sql, &format!("{alias};")));
    }

    let count_projection = match Parser::parse_sql(&dialect, "SELECT COUNT(*) AS dbx_total_rows").ok()?.pop()? {
        Statement::Query(query) => match query.body.as_ref() {
            SetExpr::Select(select) => select.projection.clone(),
            _ => return None,
        },
        _ => return None,
    };

    {
        let [Statement::Query(query)] = statements.as_mut_slice() else {
            return None;
        };
        if query.limit_clause.is_some()
            || query.fetch.is_some()
            || query.for_clause.is_some()
            || !query.locks.is_empty()
        {
            return None;
        }
        let SetExpr::Select(select) = query.body.as_mut() else {
            return None;
        };
        let group_by_is_empty = matches!(&select.group_by, GroupByExpr::Expressions(expressions, modifiers) if expressions.is_empty() && modifiers.is_empty());
        if select.distinct.is_some()
            || select.top.is_some()
            || select.into.is_some()
            || select.from.is_empty()
            || !group_by_is_empty
            || select.having.is_some()
            || !select
                .projection
                .iter()
                .all(|item| matches!(item, SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _)))
        {
            return None;
        }

        select.projection = count_projection;
        query.order_by = None;
    }

    Some(format!("{};", statements.pop()?))
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
    let limit_sql = if offset > 0 {
        let upper_bound = offset + limit;
        format!("LIMIT {offset}, {upper_bound}")
    } else {
        format!("LIMIT {limit}")
    };
    append_or_insert_before_locking(statement, &limit_sql)
}

fn has_top_level_limit(sql: &str) -> bool {
    top_level_sql_tokens(sql).iter().any(|token| token.text == "LIMIT")
}

/// True when the statement has a top-level `TOP` clause (SQL Server dialect).
/// Kingbase's SQL Server compatibility mode treats TOP as a real clause, so a
/// statement that already bounds rows with TOP must not receive a sibling LIMIT.
pub(crate) fn has_top_level_top(sql: &str) -> bool {
    top_level_sql_tokens(sql).iter().any(|token| token.text == "TOP")
}

/// Concrete row-count bound of a top-level `TOP` clause when written as a
/// literal (`TOP n`, `TOP(n)`, `TOP (n)`). Returns `None` for percentage TOP
/// (`TOP n PERCENT`), `WITH TIES` (the server may return more than `n` rows),
/// parenthesized expressions (`TOP (100 + 1)`, `TOP (100 * 2)`), or when the
/// TOP clause has no literal at all. A parenthesized form is only accepted when
/// it is exactly one integer literal followed by `)`, so the returned bound is
/// always exact — never a silent under-count.
pub(crate) fn top_level_top_row_count(sql: &str) -> Option<usize> {
    let tokens = top_level_sql_tokens(sql);
    let top_index = tokens.iter().position(|token| token.text == "TOP")?;
    let top_token = &tokens[top_index];
    // A modifier keyword directly after TOP (ALL / DISTINCT) means the following
    // literal is not a plain row-count bound. PERCENT / WITH TIES come after the
    // literal and are handled by the check below.
    if tokens.get(top_index + 1).is_some_and(|token| matches!(token.text.as_str(), "ALL" | "DISTINCT")) {
        return None;
    }
    let mut cursor = skip_sql_whitespace(sql, top_token.start + top_token.text.len());
    let parenthesized = sql.get(cursor..)?.starts_with('(');
    if parenthesized {
        cursor = skip_sql_whitespace(sql, cursor + 1);
    }
    let count = parse_usize_literal(sql, &mut cursor)?;
    let after = skip_sql_whitespace(sql, cursor);
    if parenthesized {
        // The parenthesized form must be exactly one integer literal followed by
        // `)`. Anything else is an expression whose real bound we cannot know
        // (e.g. TOP (100 + 1) returns 101 rows, not 100), so refuse to treat it
        // as a bound.
        if !sql.get(after..)?.starts_with(')') {
            return None;
        }
    }
    // `TOP n PERCENT` and `TOP n WITH TIES` (parenthesized or not) do not bound
    // the row count to the literal, so reject those adjacent modifiers. A later
    // table hint such as `FROM events WITH (NOLOCK)` is unrelated to TOP.
    let after_paren = if parenthesized { skip_sql_whitespace(sql, after + 1) } else { after };
    let modifier_index = tokens.iter().position(|token| token.start >= after_paren);
    if modifier_index.is_some_and(|index| {
        tokens[index].text == "PERCENT"
            || (tokens[index].text == "WITH" && tokens.get(index + 1).is_some_and(|token| token.text == "TIES"))
    }) {
        return None;
    }
    Some(count)
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
    append_or_insert_before_locking(statement, &format!("{offset_sql} FETCH FIRST {limit} ROWS ONLY"))
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
    append_or_insert_before_locking(statement, &limit_sql)
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
    let settings_index = clickhouse_settings_clause_index(statement);

    if let Some(index) = settings_index {
        let statement_before_settings = statement[..index].trim_end();
        let settings_clause = statement[index..].trim_start();
        return format!("{statement_before_settings} {limit_sql} {settings_clause};");
    }

    append_or_insert_before_locking(statement, limit_sql)
}

/// Insert pagination before a top-level locking clause; SQL dialects require
/// LIMIT/FETCH to precede FOR UPDATE, FOR SHARE, or LOCK IN SHARE MODE.
fn append_or_insert_before_locking(statement: &str, clause: &str) -> String {
    let clause = clause.trim();
    if let Some(index) = locking_clause_index(&top_level_sql_tokens(statement)) {
        let before = statement[..index].trim_end();
        let after = statement[index..].trim_start();
        let separator = if sql_suffix_needs_newline(before) { "\n" } else { " " };
        return format!("{before}{separator}{clause} {after};");
    }
    append_sql_suffix(statement, &format!("{clause};"))
}

const LOCKING_CLAUSE_PATTERNS: &[&[&str]] = &[
    &["FOR", "UPDATE"],
    &["FOR", "SHARE"],
    &["FOR", "KEY", "SHARE"],
    &["FOR", "NO", "KEY", "UPDATE"],
    &["LOCK", "IN", "SHARE", "MODE"],
];

fn locking_clause_index(tokens: &[SqlToken]) -> Option<usize> {
    tokens.iter().enumerate().find_map(|(index, token)| {
        LOCKING_CLAUSE_PATTERNS
            .iter()
            .any(|pattern| token_sequence_matches(&tokens[index..], pattern))
            .then_some(token.start)
    })
}

fn token_sequence_matches(tokens: &[SqlToken], expected: &[&str]) -> bool {
    tokens.len() >= expected.len() && tokens.iter().zip(expected).all(|(token, expected)| token.text == *expected)
}

fn has_pagination_clause_after(tokens: &[SqlToken], index: usize) -> bool {
    tokens.iter().any(|token| token.start > index && matches!(token.text.as_str(), "LIMIT" | "OFFSET" | "FETCH"))
}

fn clickhouse_settings_clause_index(statement: &str) -> Option<usize> {
    let parsed_settings = Parser::parse_sql(&ClickHouseDialect {}, statement).ok().and_then(|statements| {
        let [Statement::Query(query)] = statements.as_slice() else {
            return None;
        };
        Some(query.settings.is_some())
    });
    if parsed_settings == Some(false) {
        return None;
    }

    // Keep the lexical fallback for valid ClickHouse syntax that sqlparser does not yet support.
    top_level_sql_tokens(statement)
        .iter()
        .rev()
        .find(|token| token.text == "SETTINGS" && !is_qualified_identifier_part(statement, token))
        .map(|token| token.start)
}

fn is_qualified_identifier_part(sql: &str, token: &SqlToken) -> bool {
    let token_end = token.start + token.text.len();
    sql[..token.start].chars().rev().find(|ch| !ch.is_whitespace()) == Some('.')
        || sql[token_end..].chars().find(|ch| !ch.is_whitespace()) == Some('.')
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

        if ch == '#' {
            i += 1;
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

        // PostgreSQL dollar-quoted bodies may contain arbitrary SQL keywords.
        // Skip them before scanning for top-level clauses such as FOR UPDATE.
        if ch == '$' {
            if let Some(end) = skip_sql_dollar_quoted(sql, i) {
                i = end;
                continue;
            }
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

fn skip_sql_dollar_quoted(sql: &str, pos: usize) -> Option<usize> {
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
    sql.get(content_start..)?.find(delimiter).map(|closing_offset| content_start + closing_offset + delimiter.len())
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
    fn easysearch_uses_elasticsearch_sql_pagination_rules() {
        let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT name FROM products".to_string(),
            database_type: Some(DatabaseType::Easysearch),
            limit: 100,
            offset: 200,
        });
        let counted = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT name FROM products".to_string(),
            database_type: Some(DatabaseType::Easysearch),
        });

        assert_eq!(paginated.sql.as_deref(), Some("SELECT name FROM products LIMIT 100 OFFSET 200;"));
        assert_eq!(counted, err("unsupported"));
    }

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
    fn sqlserver_qualified_order_by_uses_bounded_rowcount_for_later_pages() {
        let sql = "SELECT LEFT(d.lbbh, 2) AS dlbh, big.lbmc AS dlmc, LEFT(d.lbbh, 4) AS zlbh, middle.lbmc AS zlmc, LEFT(d.lbbh, 6) AS xlbh, small.lbmc AS xlmc, d.lbbh AS cxlbh, d.lbmc AS cxlmc, CASE WHEN d.tybz = '1' THEN '启用' ELSE '停用' END AS zt FROM T_BASE_WZLB AS d LEFT JOIN T_BASE_WZLB AS big ON big.lbbh = LEFT(d.lbbh, 2) AND big.TreeInfo_Layer = 1 LEFT JOIN T_BASE_WZLB AS middle ON middle.lbbh = LEFT(d.lbbh, 4) AND middle.TreeInfo_Layer = 2 LEFT JOIN T_BASE_WZLB AS small ON small.lbbh = LEFT(d.lbbh, 6) AND small.TreeInfo_Layer = 3 WHERE d.TreeInfo_IsDetail = 1 ORDER BY d.lbbh";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 500,
            offset: 500,
        });

        let page_sql = result.sql.expect("build qualified order page");
        assert!(page_sql.starts_with("EXEC sys.sp_executesql N'SET ROWCOUNT 1000; SELECT LEFT(d.lbbh"));
        assert!(page_sql.contains("ORDER BY d.lbbh'"));
        assert!(!page_sql.contains("ROW_NUMBER()"));
        assert_eq!(sqlserver_result_offset(&page_sql), 500);
    }

    #[test]
    fn sqlserver_output_alias_order_keeps_row_number_pagination() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT d.lbbh AS cxlbh FROM T_BASE_WZLB AS d ORDER BY cxlbh".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 500,
            offset: 500,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY cxlbh) AS [__dbx_row_num] FROM (SELECT d.lbbh AS cxlbh FROM T_BASE_WZLB AS d) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 500 AND [__dbx_row_num] <= 1000 ORDER BY [__dbx_row_num];"
        );
    }

    #[test]
    fn sqlserver_unprojected_order_column_uses_bounded_rowcount() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT d.lbmc AS cxlmc FROM T_BASE_WZLB AS d ORDER BY lbbh".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 500,
            offset: 500,
        });

        let page_sql = result.sql.expect("build hidden order column page");
        assert!(page_sql.starts_with("EXEC sys.sp_executesql N'SET ROWCOUNT 1000;"));
        assert_eq!(sqlserver_result_offset(&page_sql), 500);
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
    fn paginates_sqlserver_unnamed_expression_with_rowcount() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id + 1 FROM TicketInfo".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        let sql = result.sql.expect("build unnamed expression page");
        assert!(sql.starts_with("EXEC sys.sp_executesql N'SET ROWCOUNT 200; SELECT id + 1 FROM TicketInfo'"));
        assert_eq!(sqlserver_result_offset(&sql), 100);
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
    fn sqlserver_unsafe_top_projections_use_rowcount_for_later_pages() {
        let queries = [
            "SELECT TOP 100 AAA, * FROM BBB",
            "SELECT TOP 100 AAA, bbb AS aaa FROM BBB",
            "SELECT TOP 100 a.id, b.id FROM AAA a JOIN BBB b ON a.id = b.id",
            "SELECT TOP 100 a.*, b.* FROM AAA a JOIN BBB b ON a.id = b.id",
            "SELECT TOP 100 a.*, * FROM AAA a",
            "SELECT TOP 100 AAA + 1 FROM BBB",
        ];

        for sql in queries {
            let first_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.to_string(),
                query_base_sql: sql.to_string(),
                database_type: Some(DatabaseType::SqlServer),
                pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
                use_agent_cursor: false,
                first_page_uses_actual_sql: false,
            });
            assert_eq!(first_page.sql_to_execute, sql);
            assert!(first_page.page_sql.is_none());
            assert!(first_page.count_sql.is_none());

            let later_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.to_string(),
                query_base_sql: sql.to_string(),
                database_type: Some(DatabaseType::SqlServer),
                pagination: QueryPagination { limit: 100, offset: 100, session_id: None },
                use_agent_cursor: false,
                first_page_uses_actual_sql: false,
            });
            assert!(later_page.sql_to_execute.starts_with("EXEC sys.sp_executesql N'SET ROWCOUNT 200; "));
            assert_eq!(sqlserver_result_offset(&later_page.sql_to_execute), 100);
            assert_eq!(later_page.page_sql, Some(later_page.sql_to_execute.clone()));
            assert!(later_page.count_sql.is_none());
            assert_eq!(later_page.page_limit, Some(100));
            assert_eq!(later_page.page_offset, Some(100));
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
    fn sqlserver_join_wildcard_injects_count_projection() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql:
                "SELECT * FROM WZ_CKGL_WZLLDSQ_DETAIL d LEFT JOIN WZ_CKGL_WZLLDSQ_MAIN AS m ON m.ID = d.ParentID"
                    .to_string(),
            database_type: Some(DatabaseType::SqlServer),
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM WZ_CKGL_WZLLDSQ_DETAIL d LEFT JOIN WZ_CKGL_WZLLDSQ_MAIN AS m ON m.ID = d.ParentID;"
        );
    }

    #[test]
    fn sqlserver_join_wildcard_count_removes_top_level_order_by() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT * FROM AAA a JOIN BBB b ON a.id = b.id ORDER BY a.id".to_string(),
            database_type: Some(DatabaseType::SqlServer),
        });

        assert_eq!(
            result.sql.as_deref(),
            Some("SELECT COUNT(*) AS dbx_total_rows FROM AAA a JOIN BBB b ON a.id = b.id;")
        );
    }

    #[test]
    fn sqlserver_join_wildcard_plan_exposes_count_without_changing_first_page() {
        let sql = "SELECT d.*, m.* FROM WZ_CKGL_WZLLDSQ_DETAIL d LEFT JOIN WZ_CKGL_WZLLDSQ_MAIN m ON m.ID = d.ParentID";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(
            plan.sql_to_execute,
            "SELECT TOP (500) d.*, m.* FROM WZ_CKGL_WZLLDSQ_DETAIL d LEFT JOIN WZ_CKGL_WZLLDSQ_MAIN m ON m.ID = d.ParentID"
        );
        assert_eq!(
            plan.count_sql.as_deref(),
            Some(
                "SELECT COUNT(*) AS dbx_total_rows FROM WZ_CKGL_WZLLDSQ_DETAIL d LEFT JOIN WZ_CKGL_WZLLDSQ_MAIN m ON m.ID = d.ParentID;"
            )
        );
    }

    #[test]
    fn sqlserver_wildcard_count_rejects_semantic_modifiers() {
        for sql in [
            "SELECT DISTINCT * FROM AAA a JOIN BBB b ON a.id = b.id",
            "SELECT TOP 10 * FROM AAA a JOIN BBB b ON a.id = b.id",
            "SELECT * INTO #joined FROM AAA a JOIN BBB b ON a.id = b.id",
            "SELECT * FROM AAA a JOIN BBB b ON a.id = b.id GROUP BY a.id",
            "SELECT * FROM AAA a JOIN BBB b ON a.id = b.id ORDER BY a.id OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY",
        ] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(DatabaseType::SqlServer),
            });

            assert!(!result.ok, "must not rewrite {sql}");
        }
    }

    #[test]
    fn sqlserver_join_wildcard_uses_bounded_rowcount_pagination() {
        let sql = "SELECT * FROM WZ_CKGL_WZLLDSQ_DETAIL d LEFT JOIN WZ_CKGL_WZLLDSQ_MAIN AS m ON m.ID = d.ParentID";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 500,
            offset: 500,
        });

        assert!(result.ok);
        let sql = result.sql.unwrap();
        assert_eq!(
            sql,
            "EXEC sys.sp_executesql N'SET ROWCOUNT 1000; SELECT * FROM WZ_CKGL_WZLLDSQ_DETAIL d LEFT JOIN WZ_CKGL_WZLLDSQ_MAIN AS m ON m.ID = d.ParentID'; /*__dbx_result_offset=500__*/"
        );
        assert_eq!(sqlserver_result_offset(&sql), 500);
    }

    #[test]
    fn sqlserver_result_offset_ignores_user_sql_markers() {
        assert_eq!(sqlserver_result_offset("SELECT 1 /*__dbx_result_offset=500__*/"), 0);
    }

    #[test]
    fn sqlserver_rowcount_pagination_escapes_string_literals() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM detail d JOIN parent p ON p.id = d.parent_id WHERE p.label = N'O''Brien'"
                .to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        let sql = result.sql.expect("build rowcount pagination SQL");
        assert!(sql.contains("WHERE p.label = N''O''''Brien''"));
        assert_eq!(sqlserver_result_offset(&sql), 100);
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
    fn clickhouse_settings_table_is_not_treated_as_settings_clause() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM system.settings".to_string(),
            database_type: Some(DatabaseType::ClickHouse),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT * FROM system.settings LIMIT 100;");
    }

    #[test]
    fn clickhouse_settings_identifier_is_not_treated_as_settings_clause() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT settings FROM (SELECT 1 AS settings)".to_string(),
            database_type: Some(DatabaseType::ClickHouse),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT settings FROM (SELECT 1 AS settings) LIMIT 100;");
    }

    #[test]
    fn clickhouse_settings_identifier_keeps_trailing_settings_clause() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT settings FROM (SELECT 1 AS settings) SETTINGS max_threads = 1".to_string(),
            database_type: Some(DatabaseType::ClickHouse),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT settings FROM (SELECT 1 AS settings) LIMIT 100 SETTINGS max_threads = 1;"
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
    fn mysql_for_update_places_limit_before_locking_clause() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM `test`\nwhere id=1 for update".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT * FROM `test`\nwhere id=1 LIMIT 100 for update;");
    }

    #[test]
    fn locking_query_plan_keeps_server_pagination_and_count() {
        let sql = "SELECT * FROM `test`\nwhere id=1 for update".to_string();
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.clone(),
            query_base_sql: sql.clone(),
            database_type: Some(DatabaseType::Mysql),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM `test`\nwhere id=1 LIMIT 100 for update;");
        assert_eq!(plan.page_sql, Some("SELECT * FROM `test`\nwhere id=1 LIMIT 100 for update;".to_string()));
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(0));
        assert_eq!(
            plan.count_sql,
            Some("SELECT COUNT(*) AS dbx_total_rows FROM (SELECT * FROM `test`\nwhere id=1) `dbx_count`;".to_string())
        );
        assert!(!plan.use_agent_result_session);
    }

    #[test]
    fn locking_query_later_page_places_offset_before_locking_clause() {
        let sql = "SELECT * FROM t WHERE deleted = 0 FOR UPDATE SKIP LOCKED".to_string();
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.clone(),
            query_base_sql: sql.clone(),
            database_type: Some(DatabaseType::Mysql),
            pagination: QueryPagination { limit: 100, offset: 100, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(
            plan.sql_to_execute,
            "SELECT * FROM t WHERE deleted = 0 LIMIT 100 OFFSET 100 FOR UPDATE SKIP LOCKED;"
        );
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(100));
    }

    #[test]
    fn locking_query_count_removes_locking_clause() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT * FROM t WHERE deleted = 0 FOR UPDATE".to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(
            result.sql,
            Some("SELECT COUNT(*) AS dbx_total_rows FROM (SELECT * FROM t WHERE deleted = 0) `dbx_count`;".to_string())
        );
    }

    #[test]
    fn locking_query_count_preserves_postgres_limit_after_lock_by_declining_rewrite() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT * FROM t FOR UPDATE LIMIT 10".to_string(),
            database_type: Some(DatabaseType::Postgres),
        });

        assert_eq!(result, err("locking"));
    }

    #[test]
    fn places_limit_before_supported_top_level_locking_clause_variants() {
        for (sql, expected) in [
            ("SELECT * FROM t FOR UPDATE", "SELECT * FROM t LIMIT 100 FOR UPDATE;"),
            ("SELECT * FROM t FOR SHARE", "SELECT * FROM t LIMIT 100 FOR SHARE;"),
            ("SELECT * FROM t FOR KEY SHARE", "SELECT * FROM t LIMIT 100 FOR KEY SHARE;"),
            ("SELECT * FROM t FOR NO KEY UPDATE", "SELECT * FROM t LIMIT 100 FOR NO KEY UPDATE;"),
            ("SELECT * FROM t LOCK IN SHARE MODE", "SELECT * FROM t LIMIT 100 LOCK IN SHARE MODE;"),
        ] {
            let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(DatabaseType::Postgres),
                limit: 100,
                offset: 0,
            });
            assert_eq!(result.sql.as_deref(), Some(expected), "{sql}");
        }
    }

    #[test]
    fn nested_for_update_does_not_block_outer_limit_append() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM (SELECT id FROM t FOR UPDATE) locked".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT id FROM t FOR UPDATE) locked LIMIT 100;");
    }

    #[test]
    fn for_xml_is_not_treated_as_locking_clause() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id, name FROM users FOR XML PATH('row')".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT id, name FROM users FOR XML PATH('row') LIMIT 100;");
    }

    #[test]
    fn ordinary_select_still_appends_limit() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM t WHERE deleted = 0".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT * FROM t WHERE deleted = 0 LIMIT 100;");
    }

    #[test]
    fn locking_keywords_inside_postgres_dollar_quote_are_not_rewritten() {
        let sql = "SELECT $$FOR UPDATE$$ AS message";
        let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 100,
            offset: 0,
        });
        let counted = build_count_query_sql(CountQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::Postgres),
        });

        assert_eq!(paginated.sql.as_deref(), Some("SELECT $$FOR UPDATE$$ AS message LIMIT 100;"));
        assert_eq!(
            counted.sql.as_deref(),
            Some("SELECT COUNT(*) AS dbx_total_rows FROM (SELECT $$FOR UPDATE$$ AS message) \"dbx_count\";")
        );
    }

    #[test]
    fn locking_keywords_inside_mysql_hash_comment_are_not_rewritten() {
        let sql = "SELECT * FROM t\n# FOR UPDATE LIMIT 1";
        let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 0,
        });
        let counted = build_count_query_sql(CountQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(paginated.sql.as_deref(), Some("SELECT * FROM t\n# FOR UPDATE LIMIT 1\nLIMIT 100;"));
        assert_eq!(
            counted.sql.as_deref(),
            Some("SELECT COUNT(*) AS dbx_total_rows FROM (SELECT * FROM t\n# FOR UPDATE LIMIT 1\n) `dbx_count`;")
        );
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
    fn paginates_sqlserver_wildcard_later_pages_without_derived_tables() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql:
                "SELECT b.ProjectType,* FROM VesselBusinessOpportunity a LEFT JOIN JDDR_sys_BasicConfig_ProjectInfo_Data b ON a.ProjectID = b.ID"
                    .to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        let sql = result.sql.expect("build wildcard page");
        assert!(sql.starts_with("EXEC sys.sp_executesql N'SET ROWCOUNT 200; SELECT b.ProjectType,*"));
        assert_eq!(sqlserver_result_offset(&sql), 100);
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
    fn mysql_pagination_preserves_leading_ampersand_routing_hint() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "/*& tenant:'test' */\nSELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "/*& tenant:'test' */\nSELECT id FROM users LIMIT 50;");
    }

    #[test]
    fn mysql_pagination_preserves_supported_leading_execution_hints_only() {
        for hint in ["/*+ MAX_EXECUTION_TIME(1000) */", "/*@global:true*/", "/*& tenant:'test' */"] {
            let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: format!("{hint}\nSELECT id FROM users"),
                database_type: Some(DatabaseType::Mysql),
                limit: 50,
                offset: 0,
            });

            assert_eq!(result.sql.unwrap(), format!("{hint}\nSELECT id FROM users LIMIT 50;"));
        }

        let ordinary_comment = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "/* report query */\nSELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 0,
        });
        assert_eq!(ordinary_comment.sql.unwrap(), "SELECT id FROM users LIMIT 50;");

        let ordinary_comment_before_hint = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "-- report query\n/*& tenant:'test' */\nSELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 0,
        });
        assert_eq!(ordinary_comment_before_hint.sql.unwrap(), "/*& tenant:'test' */\nSELECT id FROM users LIMIT 50;");
    }

    #[test]
    fn mysql_count_preserves_leading_ampersand_routing_hint() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "/*& tenant:'test' */\nSELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(
            result.sql.unwrap(),
            "/*& tenant:'test' */\nSELECT COUNT(*) AS dbx_total_rows FROM (SELECT id FROM users) `dbx_count`;"
        );
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
    fn kingbase_top_clause_falls_back_to_agent_cursor() {
        for sql in [
            "SELECT TOP 100 * FROM events",
            "SELECT TOP(100) * FROM events",
            "SELECT TOP (100) * FROM events",
            "SELECT TOP 10 PERCENT * FROM events",
            "SELECT TOP (2) WITH TIES * FROM events",
            "SELECT TOP 100 events.name FROM events ORDER BY events.name",
        ] {
            let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.to_string(),
                query_base_sql: sql.to_string(),
                database_type: Some(DatabaseType::Kingbase),
                pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
                use_agent_cursor: true,
                first_page_uses_actual_sql: false,
            });

            assert_eq!(plan.sql_to_execute, sql, "sql_to_execute should stay untouched for {sql}");
            assert!(plan.page_sql.is_none(), "no LIMIT rewrite for {sql}");
            assert_eq!(plan.page_limit, Some(500));
            assert_eq!(plan.page_offset, Some(0));
            assert!(plan.use_agent_result_session, "Agent cursor fallback for {sql}");
        }
    }

    #[test]
    fn kingbase_subquery_top_still_uses_server_pagination() {
        // A TOP inside a derived table is not a top-level clause, so the outer
        // statement can still be paginated with LIMIT/OFFSET.
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM (SELECT TOP 100 * FROM events) t".to_string(),
            query_base_sql: "SELECT * FROM (SELECT TOP 100 * FROM events) t".to_string(),
            database_type: Some(DatabaseType::Kingbase),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM (SELECT TOP 100 * FROM events) t LIMIT 500;");
        assert_eq!(plan.page_sql, Some(plan.sql_to_execute.clone()));
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(!plan.use_agent_result_session);
    }

    #[test]
    fn kingbase_top_clause_without_agent_uses_single_execution() {
        // Non-agent callers (query-result export with use_agent_cursor=false)
        // cannot open an Agent result session, so the Kingbase-TOP plan must
        // mark the query single-execution instead: original SQL unchanged, no
        // page_sql, but bounded page limits the export loop can stream once.
        for sql in [
            "SELECT TOP 100 * FROM events",
            "SELECT TOP(100) * FROM events",
            "SELECT TOP 10 PERCENT * FROM events",
            "SELECT TOP (2) WITH TIES * FROM events",
            "SELECT TOP 100 events.name FROM events JOIN users ON users.id = events.id",
        ] {
            let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.to_string(),
                query_base_sql: sql.to_string(),
                database_type: Some(DatabaseType::Kingbase),
                pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
                use_agent_cursor: false,
                first_page_uses_actual_sql: true,
            });

            assert_eq!(plan.sql_to_execute, sql, "sql_to_execute should stay untouched for {sql}");
            assert!(plan.page_sql.is_none(), "no LIMIT rewrite for {sql}");
            assert_eq!(plan.page_limit, Some(500));
            assert_eq!(plan.page_offset, Some(0));
            assert!(!plan.use_agent_result_session);
            assert!(plan.single_execution, "single-execution fallback for {sql}");
        }
    }

    #[test]
    fn kingbase_top_with_agent_still_uses_agent_session() {
        // Grid/query path: with an Agent cursor available the Kingbase-TOP query
        // keeps the existing bounded Agent-session fallback (not single-execution).
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT TOP 100 * FROM events".to_string(),
            query_base_sql: "SELECT TOP 100 * FROM events".to_string(),
            database_type: Some(DatabaseType::Kingbase),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(plan.sql_to_execute, "SELECT TOP 100 * FROM events");
        assert!(plan.page_sql.is_none());
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(plan.use_agent_result_session);
        assert!(!plan.single_execution);
    }

    #[test]
    fn top_level_top_row_count_extracts_only_concrete_bounds() {
        assert_eq!(top_level_top_row_count("SELECT TOP 100 * FROM events"), Some(100));
        assert_eq!(top_level_top_row_count("SELECT TOP(100) * FROM events"), Some(100));
        assert_eq!(top_level_top_row_count("SELECT TOP (100) * FROM events"), Some(100));
        // Whitespace-only inside the parens is still a single literal bound.
        assert_eq!(top_level_top_row_count("SELECT TOP ( 100 ) * FROM events"), Some(100));
        assert_eq!(top_level_top_row_count("SELECT TOP 100 events.name FROM events ORDER BY events.name"), Some(100));
        assert_eq!(top_level_top_row_count("SELECT TOP 100 * FROM events LIMIT 5"), Some(100));

        // Parenthesized expressions have a real bound different from the leading
        // digits; refusing them (None) beats silently under-counting the export.
        assert_eq!(top_level_top_row_count("SELECT TOP (100 + 1) * FROM events"), None);
        assert_eq!(top_level_top_row_count("SELECT TOP (100 * 2) * FROM events"), None);
        assert_eq!(top_level_top_row_count("SELECT TOP (100 - 1) * FROM events"), None);
        assert_eq!(top_level_top_row_count("SELECT TOP (len(events.name)) * FROM events"), None);

        // Percentage TOP and WITH TIES are not concrete row-count bounds, with or
        // without parentheses.
        assert_eq!(top_level_top_row_count("SELECT TOP 10 PERCENT * FROM events"), None);
        assert_eq!(top_level_top_row_count("SELECT TOP (10) PERCENT * FROM events"), None);
        assert_eq!(top_level_top_row_count("SELECT TOP (2) WITH TIES * FROM events"), None);
        assert_eq!(top_level_top_row_count("SELECT TOP 2 WITH TIES * FROM events"), None);
        assert_eq!(top_level_top_row_count("SELECT TOP 2 * FROM events WITH (NOLOCK)"), Some(2));

        // No TOP clause at all.
        assert_eq!(top_level_top_row_count("SELECT * FROM events"), None);
        // TOP only inside a subquery is not a top-level clause.
        assert_eq!(top_level_top_row_count("SELECT * FROM (SELECT TOP 5 * FROM events) t"), None);
    }

    #[test]
    fn sql_server_pagination_plan_exposes_only_safe_exact_top_bounds() {
        for (database_type, sql, expected) in [
            (Some(DatabaseType::SqlServer), "SELECT TOP 100 * FROM events", Some(100)),
            (Some(DatabaseType::SqlServer), "SELECT TOP(50) * FROM events", Some(50)),
            (Some(DatabaseType::SqlServer), "SELECT TOP (250) * FROM events", Some(250)),
            (Some(DatabaseType::SqlServer), "SELECT TOP 10 PERCENT * FROM events", None),
            (Some(DatabaseType::SqlServer), "SELECT TOP (2) WITH TIES * FROM events", None),
            (Some(DatabaseType::SqlServer), "SELECT TOP (100 + 1) * FROM events", None),
            (Some(DatabaseType::SqlServer), "SELECT TOP (@row_count) * FROM events", None),
            (Some(DatabaseType::SqlServer), "SELECT * FROM (SELECT TOP 5 * FROM events) t", None),
            (Some(DatabaseType::SqlServer), "SELECT * FROM events", None),
            (Some(DatabaseType::Postgres), "SELECT TOP 100 * FROM events", None),
            (Some(DatabaseType::Kingbase), "SELECT TOP 100 * FROM events", None),
        ] {
            let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.to_string(),
                query_base_sql: sql.to_string(),
                database_type,
                pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
                use_agent_cursor: false,
                first_page_uses_actual_sql: false,
            });

            assert_eq!(plan.exact_query_row_bound, expected, "unexpected bound for {database_type:?}: {sql}");
            let serialized = serde_json::to_value(&plan).unwrap();
            assert_eq!(
                serialized.get("exactQueryRowBound").and_then(serde_json::Value::as_u64),
                expected.map(|value| value as u64)
            );
        }
    }

    #[test]
    fn non_kingbase_limit_offset_is_unaffected_by_top_keyword() {
        // A column literally named `top` must not be mistaken for a TOP clause
        // on dialects where TOP is not a clause keyword. Force the server-side
        // LimitOffset path (no Agent cursor) to exercise the rewrite.
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT top, name FROM users".to_string(),
            query_base_sql: "SELECT top, name FROM users".to_string(),
            database_type: Some(DatabaseType::Postgres),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
        });

        assert_eq!(plan.sql_to_execute, "SELECT top, name FROM users LIMIT 500;");
        assert_eq!(plan.page_sql, Some(plan.sql_to_execute.clone()));
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(!plan.use_agent_result_session);
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
    fn builds_doris_sorted_query_without_alias_list() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT id, name FROM users LIMIT 100".to_string(),
            database_type: Some(DatabaseType::Doris),
            result_columns: vec!["id".to_string(), "name".to_string()],
            column_index: 0,
            column: "id".to_string(),
            direction: QuerySortDirection::Desc,
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT id, name FROM users LIMIT 100) t ORDER BY `id` DESC;");
    }

    #[test]
    fn builds_starrocks_sorted_query_with_alias_list() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT id, name FROM users LIMIT 100".to_string(),
            database_type: Some(DatabaseType::StarRocks),
            result_columns: vec!["id".to_string(), "name".to_string()],
            column_index: 0,
            column: "id".to_string(),
            direction: QuerySortDirection::Desc,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT id, name FROM users LIMIT 100) t(`id`, `name`) ORDER BY `id` DESC;"
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
    fn builds_dameng_sorted_query_without_alias_list() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT id, name FROM users".to_string(),
            database_type: Some(DatabaseType::Dameng),
            result_columns: vec!["id".to_string(), "name".to_string()],
            column_index: 0,
            column: "id".to_string(),
            direction: QuerySortDirection::Asc,
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT id, name FROM users) t ORDER BY \"id\" ASC;");
    }

    #[test]
    fn builds_dameng_sorted_query_by_ordinal_for_duplicate_columns() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id".to_string(),
            database_type: Some(DatabaseType::Dameng),
            result_columns: vec!["ID".to_string(), "id".to_string()],
            column_index: 1,
            column: "id".to_string(),
            direction: QuerySortDirection::Desc,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id) t ORDER BY 2 DESC;"
        );
    }

    #[test]
    fn builds_oracle_sorted_query_by_ordinal_for_duplicate_columns() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id".to_string(),
            database_type: Some(DatabaseType::Oracle),
            result_columns: vec!["ID".to_string(), "ID".to_string()],
            column_index: 0,
            column: "ID".to_string(),
            direction: QuerySortDirection::Asc,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id) t ORDER BY 1 ASC;"
        );
    }

    #[test]
    fn preserves_derived_column_aliases_for_generic_jdbc() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT id, name FROM users".to_string(),
            database_type: Some(DatabaseType::Jdbc),
            result_columns: vec!["id".to_string(), "name".to_string()],
            column_index: 0,
            column: "id".to_string(),
            direction: QuerySortDirection::Asc,
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT id, name FROM users) t(id, name) ORDER BY id ASC;");
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
