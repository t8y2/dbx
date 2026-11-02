use std::collections::HashSet;
use std::ops::ControlFlow;

use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::sql::{find_statement_at_cursor, find_statement_at_cursor_for_database};
use crate::sql_dialect::{
    firebird_rows_clause, pagination_strategy, quote_gaussdb_jdbc_identifier, quote_iris_identifier,
    quote_table_identifier, PaginationContext, TablePaginationStrategy,
};
use sqlparser::ast::{
    visit_expressions, BinaryOperator, Expr, ForClause, GroupByExpr, LimitClause, ObjectNamePart, OrderByKind, Select,
    SelectItem, SelectModifiers, SetExpr, Statement, TableFactor, Value, ValueWithSpan,
};
use sqlparser::dialect::{ClickHouseDialect, GenericDialect, MsSqlDialect, MySqlDialect, OracleDialect};
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
    /// Optional optimizer hint injected into the generated count (`dbx_count`)
    /// and page (`dbx_page`) statements — e.g. GaussDB `/*+ set(query_dop N) */`
    /// for parallel COUNT(*) and pagination. Only set for databases that accept
    /// hints after the SELECT keyword (GaussDB/OpenGauss); other dialects and
    /// callers without the feature keep the SQL unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPaginationExecutionPlan {
    pub sql_to_execute: String,
    /// Legacy optional MySQL lookahead, retained for wire compatibility.
    /// New plans leave this unset to avoid scanning beyond the requested page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_probe_sql: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pagination_error: Option<String>,
    /// Trailing helper column added by DBX's ROWNUM pagination wrapper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pagination_row_number_column: Option<String>,
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
    /// Result-column positions appended after the sort column, typically the
    /// primary key. The sort column alone is not unique, and tied rows come
    /// back in a different order for each `LIMIT`/`OFFSET` page than for the
    /// full export, so pages repeat or skip rows.
    #[serde(default)]
    pub tie_breaker_column_indexes: Vec<usize>,
}

pub fn build_query_pagination_execution_plan(
    options: QueryPaginationExecutionPlanOptions,
) -> QueryPaginationExecutionPlan {
    // Every page DBX generates for this query is derived from the same
    // user-written statement, so a literal LIMIT/TOP the user already wrote
    // bounds the query's total row count regardless of how large the
    // underlying table is — a cheap, exact upper bound that needs no
    // COUNT(*) execution. SQL Server's TOP is covered separately from the
    // standard LIMIT/OFFSET dialects (MySQL, Postgres, etc.) since they use
    // different clause syntax.
    let exact_query_row_bound = match pagination_strategy(options.database_type, PaginationContext::UserQuery) {
        TablePaginationStrategy::SqlServerTop => {
            // TOP bounds input rows, while FOR JSON/XML emit chunked output
            // rows — a TOP bound would misreport the result total.
            if has_top_level_for_output_clause(&options.query_base_sql) {
                None
            } else {
                top_level_top_row_count(&options.query_base_sql)
            }
        }
        TablePaginationStrategy::LimitOffset => top_level_limit_row_count(&options.query_base_sql),
        // Dameng accepts MySQL-style `LIMIT n` alongside its ROWNUM pagination.
        // A user-written LIMIT is an exact bound there too, so a `LIMIT 1000`
        // query with 258 matching rows is fetched in one shot instead of
        // stopping at the first 100-row agent page (#13502).
        TablePaginationStrategy::Rownum if options.database_type == Some(DatabaseType::Dameng) => {
            top_level_limit_row_count(&options.query_base_sql)
        }
        _ => None,
    };
    let mut plan = QueryPaginationExecutionPlan {
        sql_to_execute: options.sql.clone(),
        page_probe_sql: None,
        page_sql: None,
        page_limit: None,
        page_offset: None,
        count_sql: None,
        exact_query_row_bound,
        use_agent_result_session: false,
        pagination_error: None,
        pagination_row_number_column: None,
        single_execution: false,
    };
    // DynamoDB paginates ExecuteStatement with opaque API tokens, not SQL
    // LIMIT/OFFSET or derived COUNT queries. Keep PartiQL byte-for-byte intact.
    if options.database_type == Some(DatabaseType::DynamoDb) {
        plan.exact_query_row_bound = None;
        plan.single_execution = true;
        if options.pagination.offset > 0 || options.pagination.session_id.is_some() {
            plan.pagination_error = Some("DynamoDB PartiQL does not support SQL offset pagination".into());
        }
        return plan;
    }
    let execution_hint = options.execution_hint.as_deref().filter(|hint| !hint.trim().is_empty());

    let sql_server_cte =
        options.database_type == Some(DatabaseType::SqlServer) && starts_with_cte(&options.query_base_sql);
    if !sql_server_cte {
        let counted = build_count_query_sql(CountQuerySqlOptions {
            original_sql: options.query_base_sql.clone(),
            database_type: options.database_type,
        });
        if counted.ok {
            plan.count_sql = counted.sql.map(|count_sql| match execution_hint {
                Some(hint) => inject_execution_hint(&count_sql, hint),
                None => count_sql,
            });
        }
    }

    if options.pagination.session_id.is_some() {
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
        return plan;
    }

    // DB2's OFFSET clause is unavailable on older server families (for
    // example Db2 for z/OS before V12). DBX connections use the Agent/JDBC
    // cursor for DB2, so keep every page on that cursor path instead of
    // generating OFFSET ... FETCH FIRST SQL that fails with SQLCODE -104.
    // DuckDB must also keep offset replay on one result session: independent
    // LIMIT/OFFSET executions can return overlapping rows even with ORDER BY.
    if matches!(options.database_type, Some(DatabaseType::Db2 | DatabaseType::DuckDb)) && options.use_agent_cursor {
        if !options.first_page_uses_actual_sql && options.sql == options.query_base_sql {
            plan.sql_to_execute = options.query_base_sql;
        }
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
        return plan;
    }

    if let Some(db_type) = options.database_type {
        if matches!(db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
            && rownum_wrapper_is_unsupported(&options.sql, db_type)
        {
            if options.use_agent_cursor {
                plan.page_limit = Some(options.pagination.limit.max(1));
                plan.page_offset = Some(options.pagination.offset);
                plan.use_agent_result_session = true;
            } else if options.pagination.offset > 0 {
                plan.pagination_error =
                    Some("This query requires an Agent result session for offset pagination".into());
                plan.sql_to_execute.clear();
            }
            return plan;
        }
    }

    if sql_server_cte {
        return plan;
    }

    let can_use_first_page_cursor = options.use_agent_cursor && options.pagination.offset == 0;
    // GoldenDB, HighGo, OceanBase Oracle, and Xugu can spend substantially more time
    // executing an unbounded query before the Agent exposes its first cursor
    // page. Prefer a bounded SQL query whenever it can be rewritten safely.
    // DB2 is handled above on the Agent cursor path because OFFSET was added
    // only in newer DB2 families (and older servers reject OFFSET/FETCH).
    // Independent pages of an unordered query do not have a stable row order;
    // callers should add ORDER BY when that matters.
    // Kingbase keeps the cursor for unordered queries to preserve its behavior.
    let prefer_server_pagination = match options.database_type {
        Some(
            DatabaseType::Goldendb
            | DatabaseType::Highgo
            | DatabaseType::OceanbaseOracle
            | DatabaseType::Oracle
            | DatabaseType::Xugu,
        ) => true,
        Some(DatabaseType::Kingbase) => kingbase_server_pagination_is_stable(&options.query_base_sql),
        _ => false,
    };
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
        // The executed statement and the recorded page SQL are the same string;
        // build it once so the optimizer hint is applied consistently to both.
        let page_sql = paginated.sql.clone().map(|sql| match execution_hint {
            Some(hint) => inject_execution_hint(&sql, hint),
            None => sql,
        });
        plan.sql_to_execute = page_sql.clone().unwrap_or_default();
        plan.page_sql = page_sql;
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        // Do not request an extra row to prove that another page exists.
        // Finding one more match in a filtered query can scan the entire
        // remaining input even when the requested page is ready (#13211).
        // A full page with unknown total keeps the frontend's next-page option.
        if options.pagination.offset > 0
            && pagination_strategy(options.database_type, PaginationContext::UserQuery)
                == TablePaginationStrategy::Rownum
            && !has_top_level_rownum(&options.sql)
        {
            plan.pagination_row_number_column = single_selectable_statement(&options.sql, options.database_type)
                .ok()
                .map(|statement| rownum_pagination_column_name(&statement));
        }
        if options.use_agent_cursor
            && matches!(
                pagination_strategy(options.database_type, PaginationContext::UserQuery),
                TablePaginationStrategy::AgentMaxRows | TablePaginationStrategy::Unbounded
            )
        {
            // The dialect cannot rewrite the statement with server-side
            // pagination (Oracle user queries, generic JDBC), so the page
            // metadata alone cannot reach a non-zero offset. Keep the Agent
            // result session enabled and let the client consume through to
            // the requested offset (#8993).
            plan.use_agent_result_session = true;
        }
    } else if can_use_first_page_cursor && options.database_type != Some(DatabaseType::Highgo) {
        // Kingbase JDBC may buffer an entire result in auto-commit mode, so use
        // LIMIT/OFFSET whenever the statement can be rewritten safely. Keep the
        // Agent cursor as a bounded fallback for multi-statement or dialect-
        // specific SQL that the pagination parser cannot transform. HighGo does
        // not take this fallback: its JDBC driver may materialize the unbounded
        // result before cursor paging starts. Leaving the page metadata unset
        // routes it through regular execution and the configured JDBC maxRows
        // safeguard instead.
        if !options.first_page_uses_actual_sql && options.sql == options.query_base_sql {
            plan.sql_to_execute = options.query_base_sql;
        }
        plan.page_limit = Some(options.pagination.limit);
        plan.page_offset = Some(options.pagination.offset);
        plan.use_agent_result_session = true;
    } else if matches!(options.database_type, Some(DatabaseType::Kingbase | DatabaseType::Xugu))
        && single_selectable_statement(&options.sql, options.database_type).is_ok()
        && has_top_level_top(&options.sql)
    {
        // Kingbase SQL Server compatibility mode and Xugu reject statements mixing a
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
    let Ok(statement) = single_selectable_statement(&options.original_sql, options.database_type) else {
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
        TablePaginationStrategy::Rownum => {
            if let Some(db_type) = options.database_type {
                if matches!(db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle)
                    && rownum_wrapper_is_unsupported(&statement, db_type)
                {
                    return err("unsupported");
                }
            }
            ok(add_rownum_limit(&statement, safe_limit, safe_offset))
        }
        TablePaginationStrategy::AgentMaxRows | TablePaginationStrategy::Unbounded => ok(format!("{statement};")),
        TablePaginationStrategy::IrisTop => ok(add_iris_top_limit(&statement, safe_limit)),
        TablePaginationStrategy::LimitOffset => {
            // Kingbase SQL Server compatibility mode and Xugu accept TOP as a real clause.
            // Appending LIMIT/OFFSET alongside a top-level TOP would be rejected by
            // the server ("multiple TOP/LIMIT clauses not allowed"), so fall back to
            // the Agent cursor / client-side row cap for such statements.
            if matches!(options.database_type, Some(DatabaseType::Kingbase | DatabaseType::Xugu))
                && has_top_level_top(&statement)
            {
                return err("unsupported");
            }
            let dedup_order_by = dedup_projection_count_without_order_by(&options.original_sql);
            add_standard_limit(&statement, options.database_type, safe_limit, safe_offset, dedup_order_by)
                .map(ok)
                .unwrap_or_else(|| err("unsupported"))
        }
    }
}

pub fn build_count_query_sql(options: CountQuerySqlOptions) -> QuerySqlBuildResult {
    let Ok(statement) = single_selectable_statement(&options.original_sql, options.database_type) else {
        return err(single_statement_error_reason(&options.original_sql));
    };
    if unsupported_pagination_type(options.database_type) {
        return err("unsupported");
    }
    if options.database_type == Some(DatabaseType::Cassandra) {
        return err("unsupported");
    }
    let (execution_hint, statement) = split_leading_execution_hint(&statement, options.database_type);
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
    if matches!(options.database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb)) {
        return mysql_count_sql(&statement)
            .map(|sql| ok(format!("{execution_hint}{sql}")))
            .unwrap_or_else(|| err("unsupported"));
    }
    if options.database_type == Some(DatabaseType::Iotdb) {
        // IoTDB Tree Model does not support derived tables. Count the selected
        // time series directly when doing so is guaranteed to preserve the
        // result cardinality; decline complex queries instead of issuing SQL
        // that IoTDB cannot parse or returning a misleading total.
        return iotdb_tree_count_sql(&statement)
            .map(|sql| ok(format!("{execution_hint}{sql}")))
            .unwrap_or_else(|| err("unsupported"));
    }

    if options.database_type == Some(DatabaseType::Iris) {
        // IRIS JDBC can parameterize a derived-table alias as `:%qpar` during
        // prepare, even when the alias is unquoted.  A simple single-table
        // query does not need a derived table to count rows, so inject COUNT
        // directly and leave the wrapper fallback for queries whose row
        // cardinality depends on the original projection.
        if let Some(sql) = iris_count_sql(&statement) {
            return ok(format!("{execution_hint}{sql}"));
        }
    }

    let alias = if options.database_type == Some(DatabaseType::Iris) {
        // With delimited identifiers disabled, Caché 2016 can parameterize a
        // double-quoted alias as a string literal, leaving a trailing :%qpar.
        "dbx_count".to_string()
    } else {
        derived_table_alias(options.database_type, "dbx_count")
    };
    if options.database_type == Some(DatabaseType::Hive) && starts_with_cte(&statement) {
        if let Some(main_query_start) = top_level_sql_tokens(&statement)
            .into_iter()
            .find(|token| matches!(token.text.as_str(), "SELECT" | "FROM"))
            .map(|token| token.start)
        {
            let (with_clause, main_query) = statement.split_at(main_query_start);
            return ok(format!(
                "{execution_hint}{with_clause}{}",
                derived_table_sql("SELECT COUNT(*) AS dbx_total_rows FROM", main_query, &format!("{alias};"))
            ));
        }
    }
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

    let mut statement = find_query_result_statement_at_cursor(base_sql, 0, options.database_type)
        .trim()
        .trim_end_matches(';')
        .trim()
        .to_string();
    if statement.is_empty() {
        return err("empty");
    }
    let normalized_base_len = base_sql.trim_end_matches(';').trim().len();
    if statement.len() != normalized_base_len {
        if !matches!(options.database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb)) {
            return err("multi");
        }
        statement = restore_leading_execution_hint(base_sql, &statement, options.database_type);
        if statement.len() != normalized_base_len {
            return err("multi");
        }
    }
    let (execution_hint, statement) =
        if matches!(options.database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb)) {
            split_leading_execution_hint(&statement, options.database_type)
        } else {
            ("", statement.as_str())
        };
    // SQL Server and other engines reject WITH inside a derived table, so a CTE
    // query is sorted by appending ORDER BY <position> to its main query.
    let is_cte = statement.trim_start().to_ascii_uppercase().starts_with("WITH");
    if is_cte {
        if !cte_main_statement_is_select(statement) || has_top_level_select_into(statement) {
            return err("with");
        }
    } else if !statement.trim_start().to_ascii_uppercase().starts_with("SELECT") {
        return err("not_select");
    }

    // Oracle expands `SELECT *` over a derived table by name, so a projection
    // with duplicate labels fails with ORA-00918 no matter how ORDER BY refers
    // to the column. MySQL rejects such a derived table outright (error 1060),
    // and compares column names case-insensitively. Sort the original
    // statement by position instead.
    let has_duplicate_labels = |same_label: fn(&str, &str) -> bool| {
        options.result_columns.iter().enumerate().any(|(index, column)| {
            options.result_columns[..index].iter().any(|candidate| same_label(candidate, column))
        })
    };
    let mut seen_tie_breakers = HashSet::new();
    let tie_breaker_indexes = options
        .tie_breaker_column_indexes
        .iter()
        .copied()
        .filter(|&index| {
            index < options.result_columns.len() && index != options.column_index && seen_tie_breakers.insert(index)
        })
        .collect::<Vec<_>>();
    let derived_table_rejects_duplicate_labels = match options.database_type {
        Some(DatabaseType::Oracle) => has_duplicate_labels(|left, right| left == right),
        Some(DatabaseType::Mysql | DatabaseType::Goldendb) => has_duplicate_labels(str::eq_ignore_ascii_case),
        _ => false,
    };
    if is_cte
        || derived_table_rejects_duplicate_labels
        || (options.database_type == Some(DatabaseType::OceanbaseOracle)
            && !rownum_wrapper_projection_is_safe(statement))
    {
        let parsed = match options.database_type {
            Some(DatabaseType::Mysql | DatabaseType::Goldendb) => Parser::parse_sql(&MySqlDialect {}, statement),
            Some(DatabaseType::SqlServer) => Parser::parse_sql(&MsSqlDialect {}, statement),
            Some(DatabaseType::ClickHouse) => Parser::parse_sql(&ClickHouseDialect {}, statement),
            _ => Parser::parse_sql(&GenericDialect {}, statement),
        };
        let Ok(statements) = parsed else {
            return err("unsupported");
        };
        let [Statement::Query(query)] = statements.as_slice() else {
            return err("unsupported");
        };
        if options.column_index >= options.result_columns.len() {
            return err("unsupported");
        }
        // Appending ORDER BY after the statement cannot follow the user's
        // row-limit clause (`... LIMIT 10 ORDER BY` is a syntax error), so a
        // statement that entered this block on a row limit must not take the
        // append path. A CTE on an engine that accepts WITH inside a derived
        // table falls through to the wrapper sort instead; the Oracle family
        // and SQL Server keep the historical rejection (#13639). Entry reasons
        // other than the CTE itself (duplicate labels, OceanBase projection
        // safety) cannot use the wrapper, so they stay rejected.
        let has_row_limit = query.limit_clause.is_some()
            || query.fetch.is_some()
            || !query.locks.is_empty()
            || has_top_level_rownum(statement)
            || has_top_level_top(statement);
        if has_row_limit
            && (!is_cte || !derived_table_allows_cte(options.database_type) || derived_table_rejects_duplicate_labels)
        {
            return err("unsupported");
        }
        // 词法扫描在标准串反斜杠、Oracle `q'...'` 字面量等场景会漏掉结尾
        // ORDER BY；定位不到就无法安全剥离，追加第二个 ORDER BY 会被
        // Oracle 系拒绝。
        let order_by_index = find_top_level_trailing_order_by(statement);
        if order_by_index.is_none() && query.order_by.is_some() {
            return err("unsupported");
        }
        if !has_row_limit {
            return ok(format!(
                "{execution_hint}{}",
                append_sql_suffix(
                    statement[..order_by_index.unwrap_or(statement.len())].trim_end(),
                    &format!(
                        "ORDER BY {} {}{};",
                        options.column_index + 1,
                        options.direction.as_sql(),
                        tie_breaker_indexes.iter().map(|index| format!(", {} ASC", index + 1)).collect::<String>()
                    ),
                )
            ));
        }
        // A row-limited CTE on a wrapper-capable engine: fall through to the
        // derived-table path below, which sorts the limited result set.
    }

    let uses_hive_subquery_syntax =
        matches!(options.database_type, Some(DatabaseType::Argo | DatabaseType::Hive | DatabaseType::Impala));
    if uses_hive_subquery_syntax {
        let mut column_names = HashSet::new();
        if options.result_columns.iter().any(|column| !column_names.insert(column.to_lowercase())) {
            return err("unsupported");
        }
    }

    let aliases = build_derived_column_aliases(&options.result_columns);
    // Caché/IRIS rejects derived-table column alias lists (`t(col, col)`)
    // outright (SQLCODE -25), regardless of delimited-identifier support.
    let use_derived_column_aliases = !uses_hive_subquery_syntax
        && !matches!(options.database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb))
        && options.database_type != Some(DatabaseType::ClickHouse)
        // Doris accepts the derived-table alias but not its column-name list.
        && options.database_type != Some(DatabaseType::Doris)
        && options.database_type != Some(DatabaseType::Sqlite)
        && options.database_type != Some(DatabaseType::DuckDb)
        && options.database_type != Some(DatabaseType::Dameng)
        && options.database_type != Some(DatabaseType::Oracle)
        && options.database_type != Some(DatabaseType::OceanbaseOracle)
        && options.database_type != Some(DatabaseType::SapHana)
        && options.database_type != Some(DatabaseType::Iris);
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
    let column_reference = |index: usize, alias: &str| {
        // Oracle-compatible derived tables do not accept a PostgreSQL-style
        // column alias list. Use the column position when duplicate labels
        // would otherwise make ORDER BY ambiguous.
        let use_ordinal = !use_derived_column_aliases
            && matches!(
                options.database_type,
                Some(DatabaseType::Dameng | DatabaseType::OceanbaseOracle | DatabaseType::SapHana | DatabaseType::Iris)
            )
            && options.result_columns.get(index).is_some_and(|column| {
                options.result_columns.iter().filter(|candidate| candidate.eq_ignore_ascii_case(column)).count() > 1
            });
        if use_ordinal {
            (index + 1).to_string()
        } else if options.database_type == Some(DatabaseType::Iris) {
            // With delimited identifiers disabled, a quoted ORDER BY name becomes
            // a string literal on Caché and the sort silently degrades to a
            // constant. Ordinary names must be sent unquoted.
            quote_iris_identifier(alias, None)
        } else {
            quote_table_identifier(options.database_type, alias)
        }
    };
    let sort_reference = column_reference(options.column_index, &sort_alias);
    let tie_breaker_order = tie_breaker_indexes
        .iter()
        .map(|&index| {
            let alias = if use_derived_column_aliases {
                aliases.get(index).cloned().unwrap_or_else(|| fallback_alias(index))
            } else {
                options.result_columns[index].clone()
            };
            format!(", {} ASC", column_reference(index, &alias))
        })
        .collect::<String>();
    if options.database_type == Some(DatabaseType::SqlServer)
        && find_top_level_trailing_order_by(statement).is_none()
        && sql_server_ast_has_order_by(statement)
        && !has_top_level_select_top(statement)
        && !sql_server_ast_has_offset_or_fetch(statement)
    {
        // 词法定位不到结尾 ORDER BY（`#` 临时表/反斜杠字符串）时无法把它从
        // 派生表包装里剥掉，SQL Server 会拒绝包装后的语句。
        // 例外：带 TOP 或 OFFSET/FETCH 的语句在派生表里允许保留 ORDER BY
        // （T-SQL Msg 1033 的豁免条件），`sql_server_statement_for_derived_table`
        // 对这类语句本就原样包装，无需剥除。
        return err("unsupported");
    }
    let wrapped_statement = if options.database_type == Some(DatabaseType::SqlServer) {
        sql_server_statement_for_derived_table(statement)
    } else {
        statement.to_string()
    };

    if use_derived_column_aliases {
        let alias_list = aliases
            .iter()
            .map(|alias| quote_table_identifier(options.database_type, alias))
            .collect::<Vec<_>>()
            .join(", ");
        ok(format!(
            "{execution_hint}SELECT * FROM ({wrapped_statement}) t({alias_list}) ORDER BY {sort_reference} {}{tie_breaker_order};",
            options.direction.as_sql()
        ))
    } else {
        ok(format!(
            "{execution_hint}SELECT * FROM ({wrapped_statement}) t ORDER BY {sort_reference} {}{tie_breaker_order};",
            options.direction.as_sql()
        ))
    }
}

fn ok(sql: String) -> QuerySqlBuildResult {
    QuerySqlBuildResult { ok: true, sql: Some(sql), reason: None }
}

fn err(reason: &str) -> QuerySqlBuildResult {
    QuerySqlBuildResult { ok: false, sql: None, reason: Some(reason.to_string()) }
}

fn unsupported_pagination_type(database_type: Option<DatabaseType>) -> bool {
    // SOQL has no derived tables and no OFFSET wrapping; the Salesforce driver
    // pages through QueryLocator cursors (session_id) instead.
    matches!(
        database_type,
        Some(
            DatabaseType::Neo4j
                | DatabaseType::Nebula
                | DatabaseType::MongoDb
                | DatabaseType::Redis
                | DatabaseType::Salesforce
                | DatabaseType::Solr
                | DatabaseType::CouchDb
                | DatabaseType::DynamoDb
        )
    )
}

/// Whether the engine accepts a `WITH ... SELECT` statement inside a derived
/// table (`SELECT * FROM (WITH ... SELECT ...) t`), so a CTE can be sorted by
/// wrapping instead of appending ORDER BY to its main query. SQL Server, Db2
/// and the Oracle family reject WITH in a derived table; PostgreSQL, MySQL,
/// SQLite and ClickHouse accept it. The Hive family also rejects it — "The
/// WITH clause is not supported within SubQuery Blocks" — which is why the
/// count path hoists the CTE out instead (`#8535`); engines not yet verified
/// against a live instance stay excluded so sorting degrades to the
/// "not sortable" message instead of a server error.
fn derived_table_allows_cte(database_type: Option<DatabaseType>) -> bool {
    !matches!(
        database_type,
        Some(
            DatabaseType::Oracle
                | DatabaseType::OceanbaseOracle
                | DatabaseType::Dameng
                | DatabaseType::Yashandb
                | DatabaseType::Gaussdb
                | DatabaseType::Kingbase
                | DatabaseType::Oscar
                | DatabaseType::Xugu
                | DatabaseType::SqlServer
                | DatabaseType::Iris
                | DatabaseType::SapHana
                | DatabaseType::Hive
                | DatabaseType::Argo
                | DatabaseType::Impala
                | DatabaseType::Db2
                | DatabaseType::Teradata
                | DatabaseType::Firebird
                | DatabaseType::Informix
                | DatabaseType::Gbase8s
        )
    )
}

fn find_query_result_statement_at_cursor(sql: &str, cursor_pos: usize, database_type: Option<DatabaseType>) -> String {
    if matches!(database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb)) {
        find_statement_at_cursor_for_database(sql, cursor_pos, database_type.unwrap())
    } else {
        find_statement_at_cursor(sql, cursor_pos)
    }
}

fn kingbase_server_pagination_is_stable(sql: &str) -> bool {
    let has_order_by = Parser::parse_sql(&GenericDialect {}, sql)
        .ok()
        .and_then(|statements| {
            let [Statement::Query(query)] = statements.as_slice() else {
                return None;
            };
            Some(query.order_by.as_ref().is_some_and(
                |order_by| !matches!(&order_by.kind, OrderByKind::Expressions(expressions) if expressions.is_empty()),
            ))
        })
        .unwrap_or(false);

    has_order_by || dedup_projection_count_without_order_by(sql).is_some()
}

fn single_selectable_statement(original_sql: &str, database_type: Option<DatabaseType>) -> Result<String, ()> {
    let base_sql = original_sql.trim();
    if base_sql.is_empty() {
        return Err(());
    }

    let extracted = find_query_result_statement_at_cursor(base_sql, 0, database_type)
        .trim()
        .trim_end_matches(';')
        .trim()
        .to_string();
    if extracted.is_empty() {
        return Err(());
    }
    if !single_statement_matches_base_sql(&extracted, base_sql) {
        return Err(());
    }
    let statement = restore_leading_execution_hint(base_sql, &extracted, database_type);
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
    let mut statement = sql;
    loop {
        let previous_len = statement.len();
        statement = strip_leading_statement_comments(statement);
        statement = statement.trim_start_matches(';').trim_start();
        if statement.len() == previous_len {
            break;
        }
    }
    sql_keyword_at(statement, 0, "WITH")
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
    // FOR JSON/XML produces an unnamed result value and cannot be projected
    // from a derived table used by DBX pagination. 词法扫描在 `#` 临时表、
    // 反斜杠字符串后会漏检顶层 FOR JSON/XML，AST 检测补位。
    if has_top_level_for_output_clause(statement) || sql_server_ast_has_for_output_clause(statement) {
        return None;
    }
    // 用户已写 OFFSET/FETCH 时必须原样保留，不能再注入 TOP（两者同块会被 SQL Server 拒绝）。
    // 词法检测与 AST 检测任一命中即视为已有分页：词法扫描器在 # 临时表、
    // 反斜杠字符串等场景会漏检，AST 检测负责把这些情况补上。
    if has_top_level_offset_fetch_next(statement) || sql_server_ast_has_offset_or_fetch(statement) {
        return (offset == 0).then(|| statement.to_string());
    }
    if has_top_level_select_top(statement) {
        return if sql_server_derived_table_projection_safe(statement) {
            Some(add_sql_server_existing_top_pagination(statement, limit, offset))
        } else {
            (offset > 0).then(|| add_sql_server_rowcount_pagination(statement, limit, offset))
        };
    }

    // TOP injected into the first SELECT only bounds that branch of a UNION /
    // INTERSECT / EXCEPT, so the combined result comes out wrong. Bound the
    // whole statement instead. 词法扫描在 `#` 临时表、反斜杠字符串后会漏检
    // set 操作符，AST 检测补位。
    if has_top_level_set_operator(statement) || sql_server_ast_has_set_operator(statement) {
        return Some(add_sql_server_rowcount_pagination(statement, limit, offset));
    }

    let order_by_index = find_top_level_trailing_order_by(statement);
    if order_by_index.is_none() && has_top_level_select_distinct(statement) {
        return (offset == 0).then(|| inject_sql_server_top(statement, limit));
    }

    if offset == 0 {
        return Some(inject_sql_server_top(statement, limit));
    }

    // 词法扫描对 `#` 临时表、反斜杠字符串等会漏掉结尾 ORDER BY；此时 ROW_NUMBER
    // 包装会把 ORDER BY 留在派生表里并被 SQL Server 拒绝，也不应按 (SELECT NULL)
    // 排序。退回 ROWCOUNT 封顶执行，保留原语句和用户排序。
    if order_by_index.is_none() && sql_server_ast_has_order_by(statement) {
        return Some(add_sql_server_rowcount_pagination(statement, limit, offset));
    }

    // The inner query may end with a line comment after removing ORDER BY.
    // Keep the derived-table closing parenthesis on a new line so it is not
    // swallowed by `--` / `#` comments.
    let statement_without_order = order_by_index
        .map(|index| statement_for_sql_suffix(statement[..index].trim_end()))
        .unwrap_or_else(|| statement_for_sql_suffix(statement));
    if !sql_server_row_number_pagination_safe(statement) {
        return Some(add_sql_server_rowcount_pagination(statement, limit, offset));
    }

    let row_number_order = order_by_index
        .map(|index| statement_for_sql_suffix(statement[index..].trim()))
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
    let output_names =
        select.projection.iter().filter_map(derived_projection_name).map(str::to_lowercase).collect::<HashSet<_>>();

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

pub fn sqlserver_result_offset(sql: &str) -> usize {
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
    // Prefer the user's own trailing ORDER BY so wrapping the query in a
    // derived table does not silently override their requested ordering.
    // Fall back to the first projection column when it cannot be mapped to
    // the derived table's output columns (existing behavior).
    let row_number_order = sql_server_derived_pagination_order(statement)
        .unwrap_or_else(|| format!("ORDER BY {}", sql_server_default_pagination_order(statement)));
    if offset == 0 {
        let derived_statement = statement_for_sql_suffix(statement);
        return format!("SELECT TOP ({limit}) * FROM ({derived_statement}) [dbx_page] {row_number_order};");
    }

    let end = offset + limit;
    let derived_statement = statement_for_sql_suffix(statement);
    format!(
        "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER ({row_number_order}) AS [__dbx_row_num] FROM ({derived_statement}) dbx_page_source) dbx_page WHERE [__dbx_row_num] > {offset} AND [__dbx_row_num] <= {end} ORDER BY [__dbx_row_num];"
    )
}

/// Reuses the user's trailing ORDER BY as the pagination sort key when every
/// expression can be expressed against the derived table's output columns.
/// Returns None when the statement has no ORDER BY, cannot be parsed, or any
/// sort expression is not an output column or ordinal, so callers keep their
/// existing deterministic fallback ordering.
fn sql_server_derived_pagination_order(statement: &str) -> Option<String> {
    let dialect = MsSqlDialect {};
    let Ok(statements) = Parser::parse_sql(&dialect, statement) else {
        return None;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return None;
    };
    let OrderByKind::Expressions(order_by_exprs) = &query.order_by.as_ref()?.kind else {
        return None;
    };
    if order_by_exprs.is_empty() || !sql_server_derived_table_projection_safe(statement) {
        return None;
    }

    let output_columns = select.projection.iter().map(derived_projection_name).collect::<Option<Vec<_>>>()?;
    let column_names = output_columns.iter().map(|name| name.to_lowercase()).collect::<HashSet<_>>();

    let mut parts = Vec::with_capacity(order_by_exprs.len());
    for order_by in order_by_exprs {
        let column = sql_server_order_expr_output_column(&order_by.expr, &output_columns, &column_names)?;
        let direction = match order_by.options.asc {
            Some(true) => " ASC",
            Some(false) => " DESC",
            None => "",
        };
        let mut part = column;
        part.push_str(direction);
        parts.push(part);
    }
    Some(format!("ORDER BY {}", parts.join(", ")))
}

/// Maps one ORDER BY expression to a reference that stays valid outside the
/// derived table: output columns by name (case-insensitive, bracket/quoted
/// identifiers already unquoted by the parser) or positional ordinals mapped
/// to their corresponding output column.
/// Anything else (functions, unprojected columns, ...) cannot be referenced
/// from the wrapper and makes the caller fall back to its default ordering.
fn sql_server_order_expr_output_column(
    expr: &Expr,
    output_columns: &[&str],
    column_names: &HashSet<String>,
) -> Option<String> {
    match expr {
        Expr::Identifier(identifier) => {
            let name = identifier.value.to_lowercase();
            column_names
                .contains(&name)
                .then(|| quote_table_identifier(Some(DatabaseType::SqlServer), &identifier.value))
        }
        Expr::CompoundIdentifier(identifiers) => {
            let last = identifiers.last()?;
            let name = last.value.to_lowercase();
            column_names.contains(&name).then(|| quote_table_identifier(Some(DatabaseType::SqlServer), &last.value))
        }
        Expr::Value(ValueWithSpan { value: Value::Number(number, _), .. }) => {
            let ordinal = number.parse::<usize>().ok()?.checked_sub(1)?;
            output_columns.get(ordinal).map(|name| quote_table_identifier(Some(DatabaseType::SqlServer), name))
        }
        _ => None,
    }
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

fn restore_leading_execution_hint(original_sql: &str, statement: &str, database_type: Option<DatabaseType>) -> String {
    if leading_execution_hint_prefix_for_database(statement, database_type).is_some() {
        return statement.to_string();
    }
    let normalized = original_sql.trim().trim_end_matches(';').trim();
    match leading_execution_hint_prefix_for_database(normalized, database_type) {
        Some(prefix) => format!("{prefix}{statement}"),
        None => statement.to_string(),
    }
}

fn split_leading_execution_hint(sql: &str, database_type: Option<DatabaseType>) -> (&str, &str) {
    match leading_execution_hint_prefix_for_database(sql, database_type) {
        Some(prefix) => (prefix, sql[prefix.len()..].trim_start()),
        None => ("", sql),
    }
}

fn leading_execution_hint_prefix_for_database(sql: &str, database_type: Option<DatabaseType>) -> Option<&str> {
    if let Some(prefix) = leading_execution_hint_prefix(sql) {
        return Some(prefix);
    }
    if database_type != Some(DatabaseType::Mysql) {
        return None;
    }

    let executable_start = skip_leading_sql_comments(sql, 0);
    let directive_start = crate::tdsql_mysql::leading_directive_start(sql, executable_start)?;
    (directive_start < executable_start).then(|| &sql[directive_start..executable_start])
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
        let Some(name) = derived_projection_name(item) else {
            return false;
        };
        column_names.insert(name.to_lowercase())
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MysqlDerivedProjectionSafety {
    Safe,
    Ambiguous,
    Unknown,
}

fn mysql_count_sql(statement: &str) -> Option<String> {
    let dialect = MySqlDialect {};
    let Ok(mut statements) = Parser::parse_sql(&dialect, statement) else {
        return Some(mysql_wrapped_count_sql(statement));
    };
    let projection_safety = {
        let [Statement::Query(query)] = statements.as_slice() else {
            return None;
        };
        mysql_derived_table_set_projection_safety(query.body.as_ref())
    };
    if projection_safety != MysqlDerivedProjectionSafety::Ambiguous {
        return Some(mysql_wrapped_count_sql(statement));
    }

    let replacement_projection = match Parser::parse_sql(&dialect, "SELECT 1 AS dbx_count_value").ok()?.pop()? {
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
        let SetExpr::Select(select) = query.body.as_mut() else {
            return None;
        };
        let group_by_is_empty = matches!(&select.group_by, GroupByExpr::Expressions(expressions, modifiers) if expressions.is_empty() && modifiers.is_empty());
        if select.distinct.is_some()
            || select.into.is_some()
            || !group_by_is_empty
            || select.having.is_some()
            || !select.projection.iter().all(mysql_projection_item_is_row_preserving)
        {
            return None;
        }

        select.projection = replacement_projection;
        // An ORDER BY can refer to a removed output alias; ordering never
        // changes how many rows survive MySQL LIMIT/OFFSET.
        query.order_by = None;
    }

    Some(mysql_wrapped_count_sql(&statements.pop()?.to_string()))
}

fn mysql_wrapped_count_sql(statement: &str) -> String {
    let alias = quote_table_identifier(Some(DatabaseType::Mysql), "dbx_count");
    derived_table_sql("SELECT COUNT(*) AS dbx_total_rows FROM", statement, &format!("{alias};"))
}

fn iotdb_tree_count_sql(statement: &str) -> Option<String> {
    let dialect = GenericDialect {};
    let mut statements = Parser::parse_sql(&dialect, statement).ok()?;
    let [Statement::Query(query)] = statements.as_mut_slice() else {
        return None;
    };
    if query.with.is_some()
        || query.limit_clause.is_some()
        || query.fetch.is_some()
        || !query.locks.is_empty()
        || query.for_clause.is_some()
    {
        return None;
    }
    let SetExpr::Select(select) = query.body.as_mut() else {
        return None;
    };
    let group_by_is_empty = matches!(&select.group_by, GroupByExpr::Expressions(expressions, modifiers) if expressions.is_empty() && modifiers.is_empty());
    let tree_path = match select.from.as_slice() {
        [source] if source.joins.is_empty() => match &source.relation {
            TableFactor::Table { name, .. } => name,
            _ => return None,
        },
        _ => return None,
    };
    let tree_path_parts = tree_path.0.iter().map(ObjectNamePart::as_ident).collect::<Option<Vec<_>>>()?;
    if tree_path_parts.len() < 3 || !tree_path_parts[0].value.eq_ignore_ascii_case("root") {
        return None;
    }
    if select.distinct.is_some()
        || select.top.is_some()
        || select.exclude.is_some()
        || select.prewhere.is_some()
        || select.into.is_some()
        || !group_by_is_empty
        || select.having.is_some()
        || select.qualify.is_some()
        || !select.lateral_views.is_empty()
        || !select.optimizer_hints.is_empty()
        || select.select_modifiers.as_ref().is_some_and(SelectModifiers::is_any_set)
        || !select.connect_by.is_empty()
        || !select.cluster_by.is_empty()
        || !select.distribute_by.is_empty()
        || !select.sort_by.is_empty()
        || !select.named_window.is_empty()
        || select.value_table_mode.is_some()
    {
        return None;
    }

    let measurement = match select.projection.as_slice() {
        [SelectItem::UnnamedExpr(expr @ (Expr::Identifier(_) | Expr::CompoundIdentifier(_)))] => expr.to_string(),
        [SelectItem::ExprWithAlias { expr: expr @ (Expr::Identifier(_) | Expr::CompoundIdentifier(_)), .. }] => {
            expr.to_string()
        }
        _ => return None,
    };
    // IoTDB's value-filter mode allows WHERE to reference a series that is
    // not in the SELECT list; `COUNT(<measurement>)` would then count only
    // the selected series' non-null points and understate the row total, so
    // only count when every WHERE reference is `time` or the measurement
    // itself (bare or full-path form).
    if let Some(selection) = select.selection.as_ref() {
        let allowed = |expr: &Expr| match expr {
            Expr::Identifier(identifier) => {
                identifier.value.eq_ignore_ascii_case("time") || identifier.value == measurement
            }
            Expr::CompoundIdentifier(parts) => {
                parts.iter().map(|part| part.value.as_str()).collect::<Vec<_>>().join(".") == measurement
            }
            _ => true,
        };
        if visit_expressions(
            selection,
            |expr| {
                if allowed(expr) {
                    ControlFlow::Continue(())
                } else {
                    ControlFlow::Break(())
                }
            },
        )
        .is_break()
        {
            return None;
        }
    }
    let count_projection =
        match Parser::parse_sql(&dialect, &format!("SELECT COUNT({measurement}) AS dbx_total_rows")).ok()?.pop()? {
            Statement::Query(query) => match query.body.as_ref() {
                SetExpr::Select(select) => select.projection.clone(),
                _ => return None,
            },
            _ => return None,
        };
    select.projection = count_projection;
    query.order_by = None;
    Some(format!("{query};"))
}

fn iris_count_sql(statement: &str) -> Option<String> {
    let dialect = GenericDialect {};
    let mut statements = Parser::parse_sql(&dialect, statement).ok()?;
    let [Statement::Query(query)] = statements.as_mut_slice() else {
        return None;
    };
    if query.with.is_some()
        || query.limit_clause.is_some()
        || query.fetch.is_some()
        || !query.locks.is_empty()
        || query.for_clause.is_some()
    {
        return None;
    }
    let SetExpr::Select(select) = query.body.as_mut() else {
        return None;
    };
    let group_by_is_empty = matches!(&select.group_by, GroupByExpr::Expressions(expressions, modifiers) if expressions.is_empty() && modifiers.is_empty());
    if select.from.len() != 1
        || !select.from[0].joins.is_empty()
        || !matches!(&select.from[0].relation, TableFactor::Table { .. })
        || !matches!(select.projection.as_slice(), [SelectItem::Wildcard(_)] | [SelectItem::QualifiedWildcard(_, _)])
        || select.distinct.is_some()
        || select.top.is_some()
        || select.exclude.is_some()
        || select.prewhere.is_some()
        || select.into.is_some()
        || !group_by_is_empty
        || select.having.is_some()
        || select.qualify.is_some()
        || !select.lateral_views.is_empty()
        || !select.optimizer_hints.is_empty()
        || select.select_modifiers.as_ref().is_some_and(SelectModifiers::is_any_set)
        || !select.connect_by.is_empty()
        || !select.cluster_by.is_empty()
        || !select.distribute_by.is_empty()
        || !select.sort_by.is_empty()
        || !select.named_window.is_empty()
        || select.value_table_mode.is_some()
    {
        return None;
    }

    let count_projection = match Parser::parse_sql(&dialect, "SELECT COUNT(*) AS dbx_total_rows").ok()?.pop()? {
        Statement::Query(query) => match query.body.as_ref() {
            SetExpr::Select(select) => select.projection.clone(),
            _ => return None,
        },
        _ => return None,
    };
    select.projection = count_projection;
    query.order_by = None;
    Some(format!("{query};"))
}

fn mysql_derived_table_set_projection_safety(set_expr: &SetExpr) -> MysqlDerivedProjectionSafety {
    match set_expr {
        SetExpr::Select(select) => mysql_derived_table_select_projection_safety(select),
        SetExpr::Query(query) => mysql_derived_table_set_projection_safety(query.body.as_ref()),
        SetExpr::SetOperation { left, .. } => mysql_derived_table_set_projection_safety(left),
        SetExpr::Values(_) | SetExpr::Table(_) => MysqlDerivedProjectionSafety::Safe,
        SetExpr::Insert(_) | SetExpr::Update(_) | SetExpr::Delete(_) | SetExpr::Merge(_) => {
            MysqlDerivedProjectionSafety::Unknown
        }
    }
}

fn mysql_derived_table_select_projection_safety(select: &Select) -> MysqlDerivedProjectionSafety {
    if select.projection.len() == 1 {
        return if matches!(select.projection.as_slice(), [SelectItem::Wildcard(_)])
            && (select.from.len() != 1 || !select.from[0].joins.is_empty())
        {
            MysqlDerivedProjectionSafety::Ambiguous
        } else {
            MysqlDerivedProjectionSafety::Safe
        };
    }
    if select
        .projection
        .iter()
        .any(|item| matches!(item, SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _)))
    {
        return MysqlDerivedProjectionSafety::Ambiguous;
    }

    let mut column_names = HashSet::with_capacity(select.projection.len());
    let mut unknown_name = false;
    for item in &select.projection {
        let Some(name) = derived_projection_name(item) else {
            unknown_name = true;
            continue;
        };
        if !column_names.insert(name.to_lowercase()) {
            return MysqlDerivedProjectionSafety::Ambiguous;
        }
    }
    if unknown_name {
        MysqlDerivedProjectionSafety::Unknown
    } else {
        MysqlDerivedProjectionSafety::Safe
    }
}

fn mysql_projection_item_is_row_preserving(item: &SelectItem) -> bool {
    match item {
        SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _) => true,
        SelectItem::UnnamedExpr(Expr::Identifier(_) | Expr::CompoundIdentifier(_)) => true,
        SelectItem::ExprWithAlias { expr: Expr::Identifier(_) | Expr::CompoundIdentifier(_), .. } => true,
        SelectItem::UnnamedExpr(_) | SelectItem::ExprWithAlias { .. } | SelectItem::ExprWithAliases { .. } => false,
    }
}

fn sql_server_count_sql(statement: &str) -> Option<String> {
    // FOR JSON/XML produces an unnamed result value that cannot be projected
    // from the derived table used by the count wrapper.
    if has_top_level_for_output_clause(statement) {
        return None;
    }
    let dialect = MsSqlDialect {};
    let mut statements = Parser::parse_sql(&dialect, statement).ok()?;
    let (derived_table_projection_safe, ast_has_order_by) = {
        let [Statement::Query(query)] = statements.as_slice() else {
            return None;
        };
        let SetExpr::Select(select) = query.body.as_ref() else {
            return None;
        };
        (sql_server_derived_table_select_projection_safe(select), query.order_by.is_some())
    };
    // 词法扫描在 `#` 临时表、反斜杠字符串后会漏掉结尾 ORDER BY（见
    // sql_server_ast_has_order_by）。定位不到就不能原样塞进派生表：SQL Server
    // 拒绝派生表里的 ORDER BY。改走下面的 AST 重写分支，由它剥掉 ORDER BY。
    // 例外：带 TOP 或 OFFSET/FETCH 的语句在派生表里允许保留 ORDER BY
    // （T-SQL Msg 1033 的豁免条件），而且 AST 重写分支遇 TOP 会放弃精确计数，
    // 因此这类语句仍走原样包装，保住精确行数。
    let hidden_order_by = ast_has_order_by
        && find_top_level_trailing_order_by(statement).is_none()
        && !has_top_level_select_top(statement)
        && !sql_server_ast_has_offset_or_fetch(statement);
    if derived_table_projection_safe && !hidden_order_by {
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
            || !select.projection.iter().all(|item| match item {
                SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _) => true,
                SelectItem::UnnamedExpr(expr) | SelectItem::ExprWithAlias { expr, .. } => {
                    matches!(expr, Expr::Identifier(_) | Expr::CompoundIdentifier(_))
                }
                _ => false,
            })
        {
            return None;
        }

        select.projection = count_projection;
        query.order_by = None;
    }

    Some(format!("{};", statements.pop()?))
}

fn derived_projection_name(item: &SelectItem) -> Option<&str> {
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

/// Inserts TOP after add_sql_server_offset_fetch has ruled out an existing
/// TOP or OFFSET/FETCH clause, avoiding a second AST parse on the first page.
fn inject_sql_server_top(sql: &str, limit: usize) -> String {
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
    if has_top_level_select_top(statement) || has_top_level_for_output_clause(statement) {
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
    top_level_sql_tokens(sql).iter().any(|token| token.text == "LIMIT") || ast_top_level_limit(sql).is_some()
}

/// 词法扫描在字符串里的反斜杠（Postgres 标准串、SQLite 等）会让引号配对错乱，
/// 漏掉顶层 LIMIT；AST 解析不受影响，作为 `has_top_level_limit` /
/// `top_level_limit_row_count` 的补位。外层 `None` 表示没有顶层行数上限
/// （单独的 `OFFSET` 不算），内层 `None` 表示有上限但行数不是字面量。
fn ast_top_level_limit(sql: &str) -> Option<Option<usize>> {
    let statements = Parser::parse_sql(&GenericDialect {}, sql).ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    if let Some(LimitClause::LimitOffset { limit: Some(expr), .. }) = &query.limit_clause {
        return Some(match expr {
            Expr::Value(ValueWithSpan { value: Value::Number(text, _), .. }) => text.to_string().parse().ok(),
            _ => None,
        });
    }
    query.fetch.is_some().then_some(None)
}

/// True when the statement has a top-level `TOP` clause (SQL Server dialect).
/// Kingbase's SQL Server compatibility mode treats TOP as a real clause, so a
/// statement that already bounds rows with TOP must not receive a sibling LIMIT.
pub fn has_top_level_top(sql: &str) -> bool {
    top_level_sql_tokens(sql).iter().any(|token| token.text == "TOP")
}

/// Concrete row-count bound of a top-level `TOP` clause when written as a
/// literal (`TOP n`, `TOP(n)`, `TOP (n)`). Returns `None` for percentage TOP
/// (`TOP n PERCENT`), `WITH TIES` (the server may return more than `n` rows),
/// parenthesized expressions (`TOP (100 + 1)`, `TOP (100 * 2)`), or when the
/// TOP clause has no literal at all. A parenthesized form is only accepted when
/// it is exactly one integer literal followed by `)`, so the returned bound is
/// always exact — never a silent under-count.
pub fn top_level_top_row_count(sql: &str) -> Option<usize> {
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
    let tokens = top_level_sql_tokens(sql);
    let limit_index = tokens.iter().position(|token| token.text == "LIMIT")?;
    let token = &tokens[limit_index];
    let (count, suffix_start) = parse_standard_limit_row_count(sql, token.start + token.text.len())?;
    let suffix_start = skip_sql_whitespace(sql, suffix_start);
    if sql.get(suffix_start..)?.starts_with('%') {
        return None;
    }
    if tokens[limit_index + 1..].iter().enumerate().any(|(offset, token)| {
        token.text == "BY"
            || token.text == "PERCENT"
            || (token.text == "WITH" && tokens.get(limit_index + offset + 2).is_some_and(|next| next.text == "TIES"))
    }) {
        return None;
    }
    Some(count)
}

fn parse_standard_limit_row_count(sql: &str, start: usize) -> Option<(usize, usize)> {
    let mut cursor = skip_sql_whitespace(sql, start);
    let first = parse_usize_literal(sql, &mut cursor)?;
    cursor = skip_sql_whitespace(sql, cursor);
    if sql.get(cursor..)?.starts_with(',') {
        cursor = skip_sql_whitespace(sql, cursor + 1);
        let count = parse_usize_literal(sql, &mut cursor)?;
        return Some((count, cursor));
    }
    Some((first, cursor))
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

/// Exact upper bound on the rows a query can return when it already filters on
/// Oracle's `ROWNUM` pseudo-column with a literal comparison (`ROWNUM < n`,
/// `ROWNUM <= n`, in either operand order, optionally combined through `AND`).
///
/// Such a statement bounds itself, so it can be exported in one execution
/// without a LIMIT/OFFSET rewrite (which Oracle 11g does not have) or an Agent
/// cursor page — the predicate keeps the buffered result below the export page
/// size. Anything ambiguous (expressions, placeholders, `OR`, ROWNUM inside a
/// subquery) yields `None` so the caller keeps its normal pagination path.
pub fn top_level_rownum_row_count(sql: &str) -> Option<usize> {
    let statements = Parser::parse_sql(&OracleDialect {}, sql).ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return None;
    };
    rownum_bound_from_expr(select.selection.as_ref()?)
}

fn rownum_bound_from_expr(expr: &Expr) -> Option<usize> {
    match expr {
        Expr::Nested(inner) => rownum_bound_from_expr(inner),
        Expr::BinaryOp { left, op, right } if *op == BinaryOperator::And => {
            match (rownum_bound_from_expr(left), rownum_bound_from_expr(right)) {
                (Some(left_bound), Some(right_bound)) => Some(left_bound.min(right_bound)),
                (Some(bound), None) | (None, Some(bound)) => Some(bound),
                (None, None) => None,
            }
        }
        Expr::BinaryOp { left, op, right } => {
            let (rownum, literal, inclusive) = match op {
                BinaryOperator::Lt => (left, right, false),
                BinaryOperator::LtEq => (left, right, true),
                // `2000 > ROWNUM` / `2000 >= ROWNUM` bound ROWNUM from above too.
                BinaryOperator::Gt => (right, left, false),
                BinaryOperator::GtEq => (right, left, true),
                _ => return None,
            };
            if !is_rownum_column(rownum) {
                return None;
            }
            let bound = literal_row_count(literal)?;
            Some(if inclusive { bound } else { bound.saturating_sub(1) })
        }
        _ => None,
    }
}

fn is_rownum_column(expr: &Expr) -> bool {
    matches!(expr, Expr::Identifier(ident) if ident.value.eq_ignore_ascii_case("ROWNUM"))
}

fn literal_row_count(expr: &Expr) -> Option<usize> {
    match expr {
        Expr::Value(ValueWithSpan { value: Value::Number(number, _), .. }) => number.parse().ok(),
        Expr::Nested(inner) => literal_row_count(inner),
        _ => None,
    }
}

fn has_top_level_offset_fetch_next(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    let has_offset = tokens.iter().any(|token| token.text == "OFFSET");
    let has_fetch_next = tokens.windows(2).any(|w| w[0].text == "FETCH" && w[1].text == "NEXT");
    has_offset && has_fetch_next
}

/// 用 sqlparser AST 判断 SQL Server 语句顶层是否已带 OFFSET 或 FETCH。
/// 词法扫描器（top_level_sql_tokens）存在三类漏检：
/// 1. 把 `#`/`##` 临时表前缀当成注释跳过到行尾，丢掉同一行后面的 OFFSET/FETCH；
/// 2. 要求 OFFSET 与 FETCH NEXT 同时出现，漏掉只写 `OFFSET n ROWS` 的合法语句；
/// 3. 把字符串里的反斜杠当转义符，引号配对错乱后丢失后续词法。
///
/// AST 解析不受这些影响，因此作为补充检测，避免向已有分页的语句注入 TOP。
fn sql_server_ast_has_offset_or_fetch(statement: &str) -> bool {
    // 解析失败时返回 false，交由原有词法检测结果决定，不改变既有行为。
    let Ok(statements) = Parser::parse_sql(&MsSqlDialect {}, statement) else {
        return false;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return false;
    };
    // OFFSET 挂在 limit_clause 里（可能是 `OFFSET n ROWS` 单独出现，也可能与 FETCH 同时出现）。
    let has_offset = matches!(&query.limit_clause, Some(LimitClause::LimitOffset { offset: Some(_), .. }));
    has_offset || query.fetch.is_some()
}

/// 词法扫描器对 `#` 临时表、反斜杠字符串等会漏掉结尾 ORDER BY，AST 解析不受影响。
/// 用于判断这类语句是否带有无法定位的顶层 ORDER BY：定位不到就不能安全地包派生表。
fn sql_server_ast_has_order_by(statement: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&MsSqlDialect {}, statement) else {
        return false;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return false;
    };
    query.order_by.is_some()
}

/// 词法扫描器对 `#` 临时表、反斜杠字符串等会漏掉顶层 set 操作符（UNION 等）；
/// 此时给第一个分支注入 TOP 会返回错误的合并结果，AST 解析补位。
fn sql_server_ast_has_set_operator(statement: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&MsSqlDialect {}, statement) else {
        return false;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return false;
    };
    matches!(query.body.as_ref(), SetExpr::SetOperation { .. })
}

/// 词法扫描器对 `#` 临时表、反斜杠字符串等会漏掉顶层 FOR JSON/XML；
/// 这类语句与词法可见时一样不支持分页，AST 解析补位。
fn sql_server_ast_has_for_output_clause(statement: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&MsSqlDialect {}, statement) else {
        return false;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return false;
    };
    matches!(query.for_clause, Some(ForClause::Json { .. } | ForClause::Xml { .. }))
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

fn rownum_wrapper_projection_is_safe(statement: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&GenericDialect {}, statement) else {
        return false;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return false;
    };
    // Oracle-compatible servers reject `seq.NEXTVAL` / `seq.CURRVAL` inside a
    // derived table with ORA-02287, so the ROWNUM wrapper cannot be used.
    if references_sequence_pseudocolumn(&statements[0]) {
        return false;
    }
    fn safe_projection(body: &SetExpr) -> bool {
        match body {
            SetExpr::Query(query) => safe_projection(&query.body),
            SetExpr::SetOperation { left, .. } => safe_projection(left),
            SetExpr::Select(select) => {
                let mut names = HashSet::new();
                select.projection.iter().all(|item| {
                    let name = match item {
                        SelectItem::ExprWithAlias { alias, .. } => alias,
                        SelectItem::UnnamedExpr(Expr::Identifier(name)) => name,
                        SelectItem::UnnamedExpr(Expr::CompoundIdentifier(parts)) => {
                            let Some(name) = parts.last() else {
                                return false;
                            };
                            name
                        }
                        SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(_, _) => {
                            // SQL text cannot reveal wildcard columns, including a real
                            // quoted __dbx_row_num column. Keep one Agent cursor rather
                            // than adding a potentially ambiguous pagination helper.
                            return false;
                        }
                        _ => return select.projection.len() == 1,
                    };
                    // OceanBase resolves a derived-table ROWID output as its physical
                    // locator even when the user projected a quoted business alias.
                    // Keep that legal projection on the original Agent cursor.
                    if name.value.eq_ignore_ascii_case("ROWID") {
                        return false;
                    }
                    names.insert(if name.quote_style.is_some() {
                        name.value.clone()
                    } else {
                        name.value.to_uppercase()
                    })
                })
            }
            _ => false,
        }
    }
    safe_projection(&query.body)
}

fn references_sequence_pseudocolumn(statement: &Statement) -> bool {
    visit_expressions(statement, |expr| match expr {
        Expr::CompoundIdentifier(parts)
            if parts.len() > 1
                && parts.last().is_some_and(|name| match name.quote_style {
                    // A quoted name is a pseudocolumn only when written in its stored uppercase form.
                    Some(_) => matches!(name.value.as_str(), "NEXTVAL" | "CURRVAL"),
                    None => name.value.eq_ignore_ascii_case("NEXTVAL") || name.value.eq_ignore_ascii_case("CURRVAL"),
                }) =>
        {
            ControlFlow::Break(())
        }
        _ => ControlFlow::Continue(()),
    })
    .is_break()
}

fn has_top_level_lock(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    tokens.iter().enumerate().any(|(index, token)| {
        token.text == "FOR" && tokens.get(index + 1).is_some_and(|next| next.text == "UPDATE" || next.text == "SHARE")
    })
}

fn oracle_rownum_wrapper_is_unsupported(statement: &str) -> bool {
    if !rownum_wrapper_projection_is_safe(statement)
        || has_top_level_rownum(statement)
        || has_top_level_fetch_first(statement)
        || has_top_level_offset_fetch_next(statement)
        || has_top_level_limit(statement)
        || has_top_level_lock(statement)
    {
        return true;
    }
    if let Ok(statements) = Parser::parse_sql(&GenericDialect {}, statement) {
        if let [Statement::Query(query)] = statements.as_slice() {
            if query.limit_clause.is_some()
                || query.fetch.is_some()
                || !query.locks.is_empty()
                || query.for_clause.is_some()
            {
                return true;
            }
        }
    }
    false
}

fn oceanbase_rownum_wrapper_is_unsupported(statement: &str) -> bool {
    !rownum_wrapper_projection_is_safe(statement) || has_top_level_rownum(statement) || has_top_level_lock(statement)
}

fn rownum_wrapper_is_unsupported(statement: &str, database_type: DatabaseType) -> bool {
    match database_type {
        DatabaseType::Oracle => oracle_rownum_wrapper_is_unsupported(statement),
        DatabaseType::OceanbaseOracle => oceanbase_rownum_wrapper_is_unsupported(statement),
        _ => false,
    }
}

fn add_rownum_limit(statement: &str, limit: usize, offset: usize) -> String {
    if has_top_level_rownum(statement) {
        return format!("{statement};");
    }
    if offset == 0 {
        return derived_table_sql("SELECT * FROM", statement, &format!("WHERE ROWNUM <= {limit};"));
    }
    let end = offset.saturating_add(limit);
    let column = rownum_pagination_column_name(statement);
    let inner = derived_table_sql(
        &format!("SELECT dbx_inner.*, ROWNUM AS \"{column}\" FROM"),
        statement,
        &format!("dbx_inner WHERE ROWNUM <= {end}"),
    );
    format!("SELECT * FROM ({inner}) WHERE \"{column}\" > {offset};")
}

fn rownum_pagination_column_name(statement: &str) -> String {
    let sql = statement.to_ascii_lowercase();
    let base = "__dbx_row_num";
    let mut column = base.to_string();
    let mut suffix = 0;
    while sql.contains(&column) {
        suffix += 1;
        column = format!("{base}_{suffix}");
    }
    column
}

fn add_standard_limit(
    statement: &str,
    database_type: Option<DatabaseType>,
    limit: usize,
    offset: usize,
    dedup_order_by: Option<Vec<usize>>,
) -> Option<String> {
    let order_sql = dedup_order_by.as_deref().map_or(String::new(), format_positional_order_by);

    if has_top_level_limit(statement) {
        // MySQL rejects a derived table whose columns share a name (error 1060),
        // which `SELECT t.id, t.*` produces. Page through the user's own LIMIT
        // instead of wrapping it.
        let rewrite_limit_in_place = matches!(database_type, Some(DatabaseType::Mysql | DatabaseType::Goldendb))
            && !mysql_projection_has_unique_names(statement);
        if !order_sql.is_empty() {
            if rewrite_limit_in_place {
                return rewrite_mysql_top_level_limit(statement, limit, offset, &order_sql);
            }
            // For dedup queries (DISTINCT / GROUP BY) without user ORDER BY,
            // wrap the query to guarantee deterministic LIMIT/OFFSET pagination.
            // The inner query preserves DISTINCT semantics; the outer query
            // adds ORDER BY on positional columns to ensure consistent row
            // ordering across pages in distributed databases like Doris.
            return Some(add_outer_standard_limit(statement, database_type, limit, offset, &order_sql));
        }
        // A user/top-level LIMIT can still be wider than the selected grid page size.
        // Wrap it so the first page respects the UI page limit while preserving the user's cap.
        if offset > 0
            || top_level_limit_row_count(statement)
                .or_else(|| ast_top_level_limit(statement).flatten())
                .is_some_and(|row_count| row_count > limit)
        {
            if rewrite_limit_in_place {
                return rewrite_mysql_top_level_limit(statement, limit, offset, "");
            }
            return Some(add_outer_standard_limit(statement, database_type, limit, offset, ""));
        }
        return Some(format!("{statement};"));
    }
    let offset_sql = if offset > 0 { format!(" OFFSET {offset}") } else { String::new() };
    let limit_sql = format!("{order_sql} LIMIT {limit}{offset_sql}");
    if database_type == Some(DatabaseType::ClickHouse) {
        return Some(add_clickhouse_limit(statement, &limit_sql));
    }
    Some(append_or_insert_before_locking(statement, &limit_sql))
}

fn mysql_projection_has_unique_names(statement: &str) -> bool {
    let Ok(statements) = Parser::parse_sql(&MySqlDialect {}, statement) else {
        return true;
    };
    let [Statement::Query(query)] = statements.as_slice() else {
        return true;
    };
    mysql_derived_table_set_projection_safety(query.body.as_ref()) == MysqlDerivedProjectionSafety::Safe
}

/// Narrows a literal top-level `LIMIT n`, `LIMIT n OFFSET m`, or `LIMIT m, n`
/// to the requested page. Returns `None` for any other form, so the caller
/// runs the statement without server-side pagination.
fn rewrite_mysql_top_level_limit(statement: &str, limit: usize, offset: usize, order_sql: &str) -> Option<String> {
    let tokens = top_level_sql_tokens(statement);
    let mut limit_tokens = tokens.iter().filter(|token| token.text == "LIMIT");
    let limit_token = limit_tokens.next()?;
    if limit_tokens.next().is_some() {
        return None;
    }
    let mut cursor = skip_sql_whitespace(statement, limit_token.start + limit_token.text.len());
    let first = parse_usize_literal(statement, &mut cursor)?;
    cursor = skip_sql_whitespace(statement, cursor);
    let (row_count, user_offset) = if statement[cursor..].starts_with(',') {
        cursor = skip_sql_whitespace(statement, cursor + 1);
        (parse_usize_literal(statement, &mut cursor)?, first)
    } else if let Some(after_offset) = skip_sql_keyword(statement, cursor, "OFFSET") {
        cursor = skip_sql_whitespace(statement, after_offset);
        (first, parse_usize_literal(statement, &mut cursor)?)
    } else {
        (first, 0)
    };
    let rest_start = skip_sql_whitespace(statement, cursor);
    if rest_start < statement.len() && locking_clause_index(&tokens) != Some(rest_start) {
        return None;
    }

    let page_limit = limit.min(row_count.saturating_sub(offset));
    let page_offset = user_offset.checked_add(offset)?;
    let before = statement[..limit_token.start].trim_end();
    let rest = &statement[rest_start..];
    let separator = if rest.is_empty() { "" } else { " " };
    Some(append_sql_suffix(before, &format!("{order_sql} LIMIT {page_limit} OFFSET {page_offset}{separator}{rest};")))
}

fn add_outer_standard_limit(
    statement: &str,
    database_type: Option<DatabaseType>,
    limit: usize,
    offset: usize,
    order_sql: &str,
) -> String {
    let alias = derived_table_alias(database_type, "dbx_page");
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

/// Quote an alias DBX generates for its own derived-table wrappers.
///
/// The static default from `quote_table_identifier` is a double-quoted
/// identifier, which only parses where `"..."` delimits identifiers. The
/// Gaussdb database type covers native GaussDB, the openGauss driver profile,
/// and GaussDB M mode (`driver_profile: gaussdb-m`); the M profile speaks
/// MySQL syntax, where a double-quoted name is a string literal, so the
/// generated count query is rejected at the alias with
/// `syntax error at or near ""dbx_count""` instead of counting rows.
///
/// The quote decision is left to `quote_gaussdb_jdbc_identifier`, the same
/// helper `quote_table_data_identifier` uses for this family: it emits an
/// ordinary lower-snake identifier bare and only delimits names whose spelling
/// requires it. Wrapper aliases are DBX-owned, never referenced by the outer
/// query, and always lower snake case, so they come out bare — valid in every
/// GaussDB mode — while every other dialect keeps its spelling unchanged.
fn derived_table_alias(database_type: Option<DatabaseType>, name: &str) -> String {
    if matches!(database_type, Some(DatabaseType::Gaussdb | DatabaseType::OpenGauss)) {
        // The connection's reported quote is not plumbed into this builder, so
        // pass the static double-quote default. Either quote the agent may
        // report (`"` natively, backtick in M mode) leaves a simple-lower
        // alias bare, so the choice does not change the emitted SQL here.
        return quote_gaussdb_jdbc_identifier(name, "\"");
    }
    quote_table_identifier(database_type, name)
}

fn derived_table_sql(prefix: &str, statement: &str, suffix: &str) -> String {
    format!("{prefix} ({}) {suffix}", statement_for_sql_suffix(statement))
}

/// Insert an optimizer hint (e.g. GaussDB `/*+ set(query_dop N) */`) right after
/// the top-level SELECT keyword that opens the statement's outermost projection.
///
/// GaussDB only accepts hints between the SELECT keyword and the select list, and
/// the tokenizer skips comments and parenthesised subqueries, so the first
/// top-level SELECT token is the right anchor even for statements with CTEs or
/// set operators. Callers only pass hints for databases that accept them; without
/// a hint this is a no-op passthrough.
fn inject_execution_hint(statement: &str, hint: &str) -> String {
    let Some(select_end) = top_level_sql_tokens(statement)
        .into_iter()
        .find(|token| token.text == "SELECT")
        .map(|token| token.start + token.text.len())
    else {
        return statement.to_string();
    };
    let (head, tail) = statement.split_at(select_end);
    if tail.starts_with(char::is_whitespace) {
        format!("{head} {hint}{tail}")
    } else {
        format!("{head} {hint} {tail}")
    }
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
fn format_positional_order_by(positions: &[usize]) -> String {
    if positions.is_empty() {
        return String::new();
    }
    let cols: Vec<String> = positions.iter().map(|position| position.to_string()).collect();
    format!(" ORDER BY {}", cols.join(", "))
}

/// Detect dedup queries (SELECT DISTINCT, GROUP BY, HAVING) that lack a
/// top-level ORDER BY clause.  Returns the 1-based projection positions to sort
/// on so that a positional ORDER BY can be injected for deterministic pagination.
///
/// A GROUP BY query sorts on its grouping keys alone: the keys already identify
/// an output row uniquely, and some engines reject sorting on aggregate outputs.
///
/// Returns `None` for:
///   - Non-SELECT queries
///   - Queries without dedup semantics
///   - Queries that already specify ORDER BY
///   - Wildcard projections (`SELECT *`)
///   - Parse failures
fn dedup_projection_count_without_order_by(sql: &str) -> Option<Vec<usize>> {
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
    let all_positions: Vec<usize> = (1..=select.projection.len()).collect();
    if has_distinct {
        return Some(all_positions);
    }
    if let GroupByExpr::Expressions(exprs, _) = &select.group_by {
        if let Some(positions) = group_by_key_positions(exprs, &select.projection) {
            return Some(positions);
        }
    }
    Some(all_positions)
}

/// Map every GROUP BY key onto the 1-based position of the output column that
/// exposes it.  Returns `None` when a key is not projected (sorting on the keys
/// alone is then impossible) or when a wildcard hides which position is which,
/// so callers fall back to sorting on the full projection.
fn group_by_key_positions(group_by: &[Expr], projection: &[SelectItem]) -> Option<Vec<usize>> {
    if group_by.is_empty() {
        return None;
    }
    if !projection.iter().all(|item| matches!(item, SelectItem::UnnamedExpr(_) | SelectItem::ExprWithAlias { .. })) {
        return None;
    }
    let mut positions: Vec<usize> = Vec::with_capacity(group_by.len());
    for key in group_by {
        let position = group_by_key_position(key, projection)?;
        if !positions.contains(&position) {
            positions.push(position);
        }
    }
    positions.sort_unstable();
    Some(positions)
}

fn group_by_key_position(key: &Expr, projection: &[SelectItem]) -> Option<usize> {
    // `GROUP BY 1` is already a projection position.
    if let Expr::Value(ValueWithSpan { value: Value::Number(number, _), .. }) = key {
        let position = number.parse::<usize>().ok()?;
        return (1..=projection.len()).contains(&position).then_some(position);
    }
    let key_sql = key.to_string();
    projection
        .iter()
        .position(|item| match item {
            SelectItem::UnnamedExpr(expr) => expr.to_string() == key_sql,
            SelectItem::ExprWithAlias { expr, alias } => alias.value == key_sql || expr.to_string() == key_sql,
            _ => false,
        })
        .map(|index| index + 1)
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

fn has_top_level_set_operator(sql: &str) -> bool {
    top_level_sql_tokens(sql).iter().any(|token| matches!(token.text.as_str(), "UNION" | "INTERSECT" | "EXCEPT"))
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

fn has_top_level_for_output_clause(sql: &str) -> bool {
    let tokens = top_level_sql_tokens(sql);
    tokens.iter().enumerate().any(|(index, token)| {
        token.text == "FOR" && tokens.get(index + 1).is_some_and(|next| next.text == "XML" || next.text == "JSON")
    })
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
    // A name that is already safe is kept verbatim. Trimming its underscores
    // would rename the hidden `__DBX_PK_n` key column, so the grid no longer
    // recognises it as hidden after a database sort (#11623).
    if !compact.is_empty() && compact.chars().all(is_safe_alias_char) {
        return compact;
    }
    let safe = compact
        .chars()
        .map(|ch| if is_safe_alias_char(ch) { ch } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if safe.is_empty() {
        fallback_alias(index)
    } else {
        safe
    }
}

fn is_safe_alias_char(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '_' | '$')
}

fn fallback_alias(index: usize) -> String {
    format!("column_{}", index + 1)
}

#[cfg(test)]
mod tests {
    #[test]
    fn duckdb_pages_and_offset_replays_keep_a_single_result_session() {
        for offset in [0, 100, 500] {
            for session_id in [None, Some("duckdb-result".to_string())] {
                let sql = "SELECT * FROM settlements ORDER BY period";
                let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                    sql: sql.into(),
                    query_base_sql: sql.into(),
                    database_type: Some(DatabaseType::DuckDb),
                    pagination: QueryPagination { limit: 100, offset, session_id },
                    use_agent_cursor: true,
                    first_page_uses_actual_sql: true,
                    execution_hint: None,
                });
                assert!(plan.use_agent_result_session);
                assert_eq!(plan.sql_to_execute, sql);
                assert_eq!(plan.page_offset, Some(offset));
                assert_eq!(plan.page_limit, Some(100));
                assert!(plan.pagination_error.is_none());
            }
        }
    }

    #[test]
    fn dynamodb_partiql_uses_api_bounds_without_sql_rewrites() {
        for sql in [
            "SELECT * FROM \"orders\" WHERE status = 'PAID';",
            "SELECT VALUE {'id': o.id} FROM \"orders\" o;",
            "SELECT * FROM \"orders\"; SELECT * FROM \"archive\";",
            "UPDATE \"orders\" SET status = 'PAID' WHERE id = '1';",
        ] {
            for (offset, session_id) in [(0, None), (100, None), (0, Some("opaque".into()))] {
                let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                    sql: sql.into(),
                    query_base_sql: sql.into(),
                    database_type: Some(DatabaseType::DynamoDb),
                    pagination: QueryPagination { limit: 100, offset, session_id: session_id.clone() },
                    use_agent_cursor: false,
                    first_page_uses_actual_sql: false,
                    execution_hint: None,
                });
                assert_eq!(plan.sql_to_execute, sql);
                assert!(plan.page_sql.is_none());
                assert!(plan.page_limit.is_none());
                assert!(plan.page_offset.is_none());
                assert!(plan.count_sql.is_none());
                assert!(plan.exact_query_row_bound.is_none());
                assert!(!plan.use_agent_result_session);
                assert!(plan.single_execution);
                assert_eq!(plan.pagination_error.is_some(), offset > 0 || session_id.is_some());
            }
        }
        let sql = "SELECT * FROM \"orders\"";
        assert!(
            !build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: sql.into(),
                database_type: Some(DatabaseType::DynamoDb),
                limit: 100,
                offset: 0,
            })
            .ok
        );
        assert!(
            !build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.into(),
                database_type: Some(DatabaseType::DynamoDb),
            })
            .ok
        );
    }

    fn oceanbase_plan(sql: &str, limit: usize, offset: usize, cursor: bool) -> QueryPaginationExecutionPlan {
        build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.into(),
            query_base_sql: sql.into(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            pagination: QueryPagination { limit, offset, session_id: None },
            use_agent_cursor: cursor,
            first_page_uses_actual_sql: true,
            execution_hint: None,
        })
    }

    fn oracle_plan(sql: &str, limit: usize, offset: usize, cursor: bool) -> QueryPaginationExecutionPlan {
        build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.into(),
            query_base_sql: sql.into(),
            database_type: Some(DatabaseType::Oracle),
            pagination: QueryPagination { limit, offset, session_id: None },
            use_agent_cursor: cursor,
            first_page_uses_actual_sql: true,
            execution_hint: None,
        })
    }

    #[test]
    fn oceanbase_cursor_fallback_preserves_limits_and_rejects_unavailable_offsets() {
        for sql in [
            "SELECT a.name, a.* FROM people a ORDER BY a.id",
            "SELECT name, name FROM people WHERE ROWNUM <= 9",
            "SELECT name, name FROM people ORDER BY name FETCH FIRST 9 ROWS ONLY",
            "SELECT * FROM people WHERE ROWNUM <= 9",
            "SELECT * FROM (SELECT name, name FROM people) p",
            "SELECT a.id AS label, a.name AS \"LABEL\" FROM people a",
            "SELECT a.name || a.name, a.name || a.name FROM people a",
        ] {
            for limit in [0, 1, 100, i32::MAX as usize] {
                for offset in [0, 1, 100, 500] {
                    let plan = oceanbase_plan(sql, limit, offset, true);
                    assert_eq!(plan.sql_to_execute, sql);
                    assert!(plan.use_agent_result_session, "{sql}");
                    assert_eq!(plan.page_limit, Some(limit.max(1)));
                    assert_eq!(plan.page_offset, Some(offset));
                    assert!(plan.pagination_error.is_none());
                    let plan = oceanbase_plan(sql, limit, offset, false);
                    assert!(!plan.use_agent_result_session);
                    assert!(plan.page_sql.is_none());
                    if offset == 0 {
                        assert_eq!(plan.sql_to_execute, sql);
                        assert!(plan.pagination_error.is_none());
                    } else {
                        assert!(plan.pagination_error.is_some());
                        assert!(plan.sql_to_execute.is_empty());
                    }
                }
            }
        }
    }

    // #12271: OceanBase Oracle, like Oracle, raises ORA-02287 when a sequence
    // pseudocolumn sits inside the ROWNUM pagination derived table.
    #[test]
    fn oceanbase_sequence_pseudocolumns_keep_the_original_statement() {
        for sql in [
            "SELECT to_char(sysdate,'yyyymmdd')||seq_yaz001.nextval FROM DUAL",
            "SELECT seq_yaz001.NEXTVAL AS id FROM DUAL",
            "SELECT app.seq_yaz001.currval AS id FROM DUAL",
            "SELECT \"SEQ_YAZ001\".\"NEXTVAL\" AS id FROM DUAL",
            "SELECT NVL(seq_yaz001.nextval, 0) AS id FROM DUAL",
        ] {
            for limit in [1, 100] {
                let plan = oceanbase_plan(sql, limit, 0, true);
                assert_eq!(plan.sql_to_execute, sql);
                assert!(plan.use_agent_result_session, "{sql}");
                assert!(plan.page_sql.is_none());
                assert_eq!(plan.page_limit, Some(limit));

                let plan = oceanbase_plan(sql, limit, 0, false);
                assert_eq!(plan.sql_to_execute, sql);
                assert!(plan.page_sql.is_none());
                assert!(plan.pagination_error.is_none());
            }
            let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: sql.into(),
                database_type: Some(DatabaseType::OceanbaseOracle),
                limit: 100,
                offset: 100,
            });
            assert!(!paginated.ok, "{sql}");
        }
    }

    #[test]
    fn oceanbase_columns_named_like_pseudocolumns_keep_bounded_sql() {
        for sql in ["SELECT t.\"nextval\" AS v FROM t", "SELECT nextval AS v FROM t"] {
            let plan = oceanbase_plan(sql, 100, 0, true);
            assert!(!plan.use_agent_result_session, "{sql}");
            assert!(plan.sql_to_execute.contains("ROWNUM <= 100"), "{sql}");
        }
    }

    #[test]
    fn oceanbase_safe_projections_keep_bounded_sql_at_every_offset() {
        for sql in [
            "SELECT a.id, a.name FROM people a",
            "SELECT a.id AS left_id, b.id AS right_id FROM people a JOIN people b ON a.id=b.id",
            "SELECT a.id AS label, a.name AS \"label\" FROM people a",
            "SELECT name AS label, name AS other_label FROM people ORDER BY name FETCH FIRST 9 ROWS ONLY",
            "SELECT name AS label, COUNT(*) AS n FROM people GROUP BY name",
        ] {
            for cursor in [false, true] {
                for limit in [0, 1, 100, i32::MAX as usize] {
                    for offset in [0, 100, 500] {
                        let plan = oceanbase_plan(sql, limit, offset, cursor);
                        assert!(!plan.use_agent_result_session, "{sql}");
                        assert!(plan.pagination_error.is_none());
                        assert!(plan.sql_to_execute.contains(sql));
                        assert!(plan.sql_to_execute.contains(&format!("ROWNUM <= {}", offset + limit.max(1))));
                        assert_eq!(plan.pagination_row_number_column.is_some(), offset > 0);
                    }
                }
            }
        }
    }

    #[test]
    fn oceanbase_wildcard_keeps_one_cursor_when_real_columns_are_unknown() {
        // Either table can contain a quoted "__dbx_row_num" column, invisible
        // in the SQL text. UI paging and streaming export share this plan.
        for sql in ["SELECT * FROM events", "SELECT t.* FROM events t"] {
            for offset in [0, 2, 4] {
                let mut options = QueryPaginationExecutionPlanOptions {
                    sql: sql.into(),
                    query_base_sql: sql.into(),
                    database_type: Some(DatabaseType::OceanbaseOracle),
                    pagination: QueryPagination {
                        limit: 2,
                        offset,
                        session_id: (offset > 0).then(|| "same-cursor".into()),
                    },
                    use_agent_cursor: true,
                    first_page_uses_actual_sql: true,
                    execution_hint: None,
                };
                let plan = build_query_pagination_execution_plan(options.clone());
                assert_eq!(plan.sql_to_execute, sql);
                assert!(plan.use_agent_result_session);
                assert_eq!(plan.page_limit, Some(2));
                assert_eq!(plan.page_offset, Some(offset));
                assert!(plan.page_sql.is_none());
                assert!(plan.pagination_row_number_column.is_none());
                assert!(!plan.single_execution);
                assert!(plan.pagination_error.is_none());

                // Existing sessions remain usable even if cursor availability
                // changes after the first page.
                if offset > 0 {
                    options.use_agent_cursor = false;
                    assert_eq!(build_query_pagination_execution_plan(options), plan);
                }
            }
        }
    }

    #[test]
    fn oceanbase_existing_session_wins_over_projection_and_cursor_availability() {
        let sql = "SELECT a.name, a.* FROM people a";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.into(),
            query_base_sql: sql.into(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            pagination: QueryPagination { limit: 10, offset: 50, session_id: Some("cursor".into()) },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });
        assert!(plan.use_agent_result_session);
        assert_eq!(plan.sql_to_execute, sql);
        assert_eq!(plan.page_offset, Some(50));
        assert!(plan.pagination_error.is_none());
    }

    #[test]
    fn oceanbase_duplicate_projection_sort_preserves_text_and_count_preserves_cardinality() {
        for sql in [
            "SELECT /*+ FULL(a) */ a.name, a.* FROM people a ORDER BY a.id",
            "SELECT DISTINCT name, name FROM people ORDER BY name",
            "SELECT name, name, COUNT(*) FROM people GROUP BY name ORDER BY name",
            "SELECT name, name FROM people UNION ALL SELECT name, name FROM old_people ORDER BY 1",
        ] {
            let sorted = build_sorted_query_sql(SortedQuerySqlOptions {
                original_sql: sql.into(),
                database_type: Some(DatabaseType::OceanbaseOracle),
                result_columns: vec!["NAME".into(), "NAME".into()],
                column_index: 1,
                column: "NAME".into(),
                direction: QuerySortDirection::Desc,
                tie_breaker_column_indexes: Vec::new(),
            });
            assert!(sorted.ok, "{sql}");
            let sorted = sorted.sql.unwrap();
            assert_eq!(sorted, format!("{} ORDER BY 2 DESC;", &sql[..sql.rfind(" ORDER BY").unwrap()]));
            assert!(oceanbase_plan(&sorted, 10, 0, true).use_agent_result_session);
            let count = build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.into(),
                database_type: Some(DatabaseType::OceanbaseOracle),
            });
            assert!(count.ok);
            let count = count.sql.unwrap();
            assert!(count.starts_with("SELECT COUNT(*) AS dbx_total_rows FROM ("));
            assert!(count.contains(sql));
        }
    }

    #[test]
    fn oceanbase_sort_does_not_move_ordering_across_user_limits_or_locks() {
        for suffix in ["WHERE ROWNUM <= 9", "ORDER BY name FETCH FIRST 9 ROWS ONLY", "FOR UPDATE"] {
            let sorted = build_sorted_query_sql(SortedQuerySqlOptions {
                original_sql: format!("SELECT name, name FROM people {suffix}"),
                database_type: Some(DatabaseType::OceanbaseOracle),
                result_columns: vec!["NAME".into(), "NAME".into()],
                column_index: 0,
                column: "NAME".into(),
                direction: QuerySortDirection::Asc,
                tie_breaker_column_indexes: Vec::new(),
            });
            assert!(!sorted.ok);
        }
    }

    // 词法扫描在标准串反斜杠、Oracle `q'...'` 字面量后会漏掉结尾 ORDER BY；
    // 定位不到就不能追加第二个 ORDER BY（Oracle 系会直接拒绝）。
    #[test]
    fn oceanbase_sort_rejects_lexically_hidden_order_by() {
        for sql in ["SELECT * FROM t WHERE p = 'C:\\' ORDER BY id", "SELECT * FROM t WHERE p = q'[it's]' ORDER BY id"] {
            let sorted = build_sorted_query_sql(SortedQuerySqlOptions {
                original_sql: sql.into(),
                database_type: Some(DatabaseType::OceanbaseOracle),
                result_columns: vec!["id".into()],
                column_index: 0,
                column: "id".into(),
                direction: QuerySortDirection::Asc,
                tie_breaker_column_indexes: Vec::new(),
            });

            assert!(!sorted.ok, "must not append a second ORDER BY: {sql}");
            assert_eq!(sorted.reason.as_deref(), Some("unsupported"), "{sql}");
        }

        // 对照：完全没有 ORDER BY 时照常在末尾追加序号排序；这条路径就是
        // `order_by_index.unwrap_or(statement.len())` 的 None 分支。
        let sorted = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT * FROM t".into(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            result_columns: vec!["id".into()],
            column_index: 0,
            column: "id".into(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });
        assert!(sorted.ok);
        assert_eq!(sorted.sql.unwrap(), "SELECT * FROM t ORDER BY 1 ASC;");
    }

    #[test]
    fn oceanbase_unsafe_projection_uses_cursor_at_every_offset() {
        for sql in [
            "SELECT * FROM people",
            "SELECT a.* FROM people a",
            "SELECT ID, BUSINESS_ROWID AS \"rowid\" FROM DBX_LOB_NOPK ORDER BY ID",
            "SELECT BUSINESS_ROWID AS ROWID FROM DBX_LOB_NOPK",
            "SELECT BUSINESS_ROWID AS \"RoWiD\", ROWIDTOCHAR(ROWID) AS \"__DBX_PK_0\" FROM DBX_LOB_NOPK",
            "SELECT t.\"rowid\" FROM DBX_LOB_NOPK t",
            "SELECT a.name, a.* FROM people a ORDER BY a.id",
            "SELECT a.name, a.name FROM people a",
            "SELECT a.id, b.id FROM people a JOIN people b ON a.id = b.id",
            "SELECT * FROM people a JOIN people b ON a.id = b.id",
            "SELECT a.*, b.* FROM people a JOIN people b ON a.id = b.id",
            "SELECT a.id AS label, a.name AS LABEL FROM people a",
            "SELECT DISTINCT a.name, a.name FROM people a",
            "SELECT a.name, a.name, COUNT(*) FROM people a GROUP BY a.name",
            "WITH p AS (SELECT * FROM people) SELECT p.name, p.* FROM p",
            "SELECT name, name FROM people UNION ALL SELECT name, name FROM people",
        ] {
            for offset in [0, 100, 500] {
                let plan = super::build_query_pagination_execution_plan(super::QueryPaginationExecutionPlanOptions {
                    sql: sql.into(),
                    query_base_sql: sql.into(),
                    database_type: Some(super::DatabaseType::OceanbaseOracle),
                    pagination: super::QueryPagination { limit: 100, offset, session_id: None },
                    use_agent_cursor: true,
                    first_page_uses_actual_sql: true,
                    execution_hint: None,
                });
                assert!(plan.use_agent_result_session, "{sql} offset {offset}");
                assert_eq!(plan.sql_to_execute, sql);
                assert_eq!(plan.page_offset, Some(offset));
                assert!(plan.pagination_row_number_column.is_none());
                assert!(plan.page_sql.is_none());
                let rewritten = super::build_paginated_query_sql(super::PaginatedQuerySqlOptions {
                    original_sql: sql.into(),
                    database_type: Some(super::DatabaseType::OceanbaseOracle),
                    limit: 100,
                    offset,
                });
                assert!(!rewritten.ok, "{sql}");
            }
        }
    }

    #[test]
    fn oracle_cursor_fallback_preserves_limits_and_rejects_unavailable_offsets() {
        for sql in [
            "SELECT a.name, a.* FROM people a ORDER BY a.id",
            "SELECT name, name FROM people WHERE ROWNUM <= 9",
            "SELECT name, name FROM people ORDER BY name FETCH FIRST 9 ROWS ONLY",
            "SELECT * FROM people WHERE ROWNUM <= 9",
            "SELECT * FROM (SELECT name, name FROM people) p",
            "SELECT a.id AS label, a.name AS \"LABEL\" FROM people a",
            "SELECT a.name || a.name, a.name || a.name FROM people a",
            "SELECT a.id, b.id FROM people a JOIN people b ON a.id = b.id",
            "SELECT id FROM people FOR UPDATE",
            "SELECT id FROM people FOR UPDATE NOWAIT",
            "SELECT id FROM people FOR UPDATE SKIP LOCKED",
            "SELECT id FROM people WHERE ROWNUM <= 10",
            "SELECT id FROM people FETCH FIRST 10 ROWS ONLY",
        ] {
            for limit in [0, 1, 100, i32::MAX as usize] {
                for offset in [0, 1, 100, 500] {
                    let plan = oracle_plan(sql, limit, offset, true);
                    assert_eq!(plan.sql_to_execute, sql);
                    assert!(plan.use_agent_result_session, "{sql}");
                    assert_eq!(plan.page_limit, Some(limit.max(1)));
                    assert_eq!(plan.page_offset, Some(offset));
                    assert!(plan.pagination_error.is_none());
                    let plan = oracle_plan(sql, limit, offset, false);
                    assert!(!plan.use_agent_result_session);
                    assert!(plan.page_sql.is_none());
                    if offset == 0 {
                        assert_eq!(plan.sql_to_execute, sql);
                        assert!(plan.pagination_error.is_none());
                    } else {
                        assert!(plan.pagination_error.is_some());
                        assert!(plan.sql_to_execute.is_empty());
                    }
                }
            }
        }
    }

    #[test]
    fn oracle_sequence_pseudocolumns_keep_the_original_statement() {
        for sql in [
            "SELECT to_char(sysdate,'yyyymmdd')||seq_yaz001.nextval FROM DUAL",
            "SELECT seq_yaz001.NEXTVAL AS id FROM DUAL",
            "SELECT app.seq_yaz001.currval AS id FROM DUAL",
            "SELECT \"SEQ_YAZ001\".\"NEXTVAL\" AS id FROM DUAL",
            "SELECT NVL(seq_yaz001.nextval, 0) AS id FROM DUAL",
        ] {
            for limit in [1, 100] {
                let plan = oracle_plan(sql, limit, 0, true);
                assert_eq!(plan.sql_to_execute, sql);
                assert!(plan.use_agent_result_session, "{sql}");
                assert!(plan.page_sql.is_none());
                assert_eq!(plan.page_limit, Some(limit));

                let plan = oracle_plan(sql, limit, 0, false);
                assert_eq!(plan.sql_to_execute, sql);
                assert!(plan.page_sql.is_none());
                assert!(plan.pagination_error.is_none());
            }
            let paginated = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: sql.into(),
                database_type: Some(DatabaseType::Oracle),
                limit: 100,
                offset: 100,
            });
            assert!(!paginated.ok, "{sql}");
        }
    }

    #[test]
    fn oracle_columns_named_like_pseudocolumns_keep_bounded_sql() {
        for sql in ["SELECT t.\"nextval\" AS v FROM t", "SELECT nextval AS v FROM t"] {
            let plan = oracle_plan(sql, 100, 0, true);
            assert!(!plan.use_agent_result_session, "{sql}");
            assert!(plan.sql_to_execute.contains("ROWNUM <= 100"), "{sql}");
        }
    }

    #[test]
    fn oracle_safe_projections_keep_bounded_sql_at_every_offset() {
        for sql in [
            "SELECT a.id, a.name FROM people a",
            "SELECT a.id AS left_id, b.id AS right_id FROM people a JOIN people b ON a.id=b.id",
            "SELECT a.id AS label, a.name AS \"label\" FROM people a",
            "SELECT name AS label, COUNT(*) AS n FROM people GROUP BY name",
            "SELECT code, name FROM BD_MATERIAL",
            "SELECT DISTINCT bm.code 物料编码, bm.name 物料名称, bs.name 仓库 FROM BD_MATERIAL bm INNER JOIN BD_MATERIALSTOCK bm2 ON bm.PK_MATERIAL = bm2.PK_MATERIAL",
        ] {
            for cursor in [false, true] {
                for limit in [0, 1, 100, i32::MAX as usize] {
                    for offset in [0, 100, 500] {
                        let plan = oracle_plan(sql, limit, offset, cursor);
                        assert!(!plan.use_agent_result_session, "{sql}");
                        assert!(plan.pagination_error.is_none());
                        assert!(plan.sql_to_execute.contains(sql));
                        assert!(plan.sql_to_execute.contains(&format!("ROWNUM <= {}", offset + limit.max(1))));
                        assert_eq!(plan.pagination_row_number_column.is_some(), offset > 0);
                    }
                }
            }
        }
    }

    #[test]
    fn oracle_unsafe_projection_uses_cursor_at_every_offset() {
        for sql in [
            "SELECT * FROM people",
            "SELECT a.* FROM people a",
            "SELECT ID, BUSINESS_ROWID AS \"rowid\" FROM DBX_LOB_NOPK ORDER BY ID",
            "SELECT BUSINESS_ROWID AS ROWID FROM DBX_LOB_NOPK",
            "SELECT BUSINESS_ROWID AS \"RoWiD\", ROWIDTOCHAR(ROWID) AS \"__DBX_PK_0\" FROM DBX_LOB_NOPK",
            "SELECT t.\"rowid\" FROM DBX_LOB_NOPK t",
            "SELECT a.name, a.* FROM people a ORDER BY a.id",
            "SELECT a.name, a.name FROM people a",
            "SELECT a.id, b.id FROM people a JOIN people b ON a.id = b.id",
            "SELECT * FROM people a JOIN people b ON a.id = b.id",
            "SELECT a.*, b.* FROM people a JOIN people b ON a.id = b.id",
            "SELECT a.id AS label, a.name AS LABEL FROM people a",
            "SELECT DISTINCT a.name, a.name FROM people a",
            "SELECT a.name, a.name, COUNT(*) FROM people a GROUP BY a.name",
            "WITH p AS (SELECT * FROM people) SELECT p.name, p.* FROM p",
            "SELECT name, name FROM people UNION ALL SELECT name, name FROM people",
            "SELECT id FROM people FOR UPDATE",
            "SELECT id FROM people WHERE ROWNUM <= 10",
            "SELECT id FROM people FETCH FIRST 10 ROWS ONLY",
        ] {
            for offset in [0, 100, 500] {
                let plan = super::build_query_pagination_execution_plan(super::QueryPaginationExecutionPlanOptions {
                    sql: sql.into(),
                    query_base_sql: sql.into(),
                    database_type: Some(super::DatabaseType::Oracle),
                    pagination: super::QueryPagination { limit: 100, offset, session_id: None },
                    use_agent_cursor: true,
                    first_page_uses_actual_sql: true,
                    execution_hint: None,
                });
                assert!(plan.use_agent_result_session, "{sql} offset {offset}");
                assert_eq!(plan.sql_to_execute, sql);
                assert_eq!(plan.page_offset, Some(offset));
                assert!(plan.pagination_row_number_column.is_none());
                assert!(plan.page_sql.is_none());
                let rewritten = super::build_paginated_query_sql(super::PaginatedQuerySqlOptions {
                    original_sql: sql.into(),
                    database_type: Some(super::DatabaseType::Oracle),
                    limit: 100,
                    offset,
                });
                assert!(!rewritten.ok, "{sql}");
            }
        }
    }

    use super::*;

    /// Query shape from issue #7832: a MySQL GROUP BY over a LEFT JOIN with an
    /// aggregated derived table, COUNT(DISTINCT IF(...)) in the projection, and
    /// inline `-- 中文` line comments. Locks in the invariants that keep DBX's
    /// derived page/count SQL row-count-identical to the user's statement:
    /// the statement splitter must keep it a single statement, the page SQL
    /// must preserve the GROUP BY while injecting deterministic pagination,
    /// and the count wrap must count the grouped result, not the raw join.
    #[test]
    fn mysql_group_by_with_distinct_if_and_comments_keeps_grouping_in_page_and_count_sql() {
        let sql = "SELECT\n  base.brand_name\n ,base.stall_id\n ,base.floor\n ,COUNT(1) total_invite -- 邀约数量\n ,SUM(IFNULL(base.ver_status, 0)) sign_num -- 签到数量\n ,SUM(IFNULL(dr.draw_count, 0)) draw_num -- 抽奖次数\n ,SUM(IFNULL(dr.draw_user_num, 0)) draw_user_num -- 抽奖人数\n ,COUNT(distinct IF(base.ver_status = 1, base.mobile, null)) sign_and_draw_user_num\nFROM v_form_data_1786326962 base\nLEFT JOIN (\n  SELECT id, SUM(IFNULL(hx_status, 0)) draw_count, COUNT(distinct IF(hx_status = 1, mobile, null)) draw_user_num\n  FROM v_form_data_1786326962_coupon\n  GROUP BY id\n) dr ON base.id = dr.id\nGROUP BY base.brand_name, base.stall_id, base.floor";

        let statements = crate::sql::split_sql_statements_for_database(sql, DatabaseType::Mysql);
        assert_eq!(statements.len(), 1, "inline comments must not split the statement");

        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::Mysql),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        let page_sql = plan.page_sql.expect("pagination plan provides page SQL");
        assert!(page_sql.to_uppercase().contains("GROUP BY"));
        assert!(
            page_sql.contains("ORDER BY 1, 2, 3 LIMIT 500;"),
            "dedup pagination must be appended after the GROUP BY, got: {page_sql}"
        );

        let count_sql = plan.count_sql.expect("pagination plan provides count SQL");
        assert!(count_sql.starts_with("SELECT COUNT(*) AS dbx_total_rows FROM ("));
        assert_eq!(
            count_sql.matches("GROUP BY").count(),
            2,
            "the count wrap must keep both the outer and derived-table GROUP BY, got: {count_sql}"
        );

        let mut variants = vec![
            ("crlf", sql.replace('\n', "\r\n")),
            ("trailing semicolon", format!("{sql};")),
            ("trailing GROUP BY comment", format!("{sql} -- 分组")),
        ];
        if let Some(stripped) = sql.strip_prefix("SELECT") {
            variants.push(("leading comment", format!("-- header\nSELECT{stripped}")));
        }
        for (name, variant) in variants {
            let counted = build_count_query_sql(CountQuerySqlOptions {
                original_sql: variant.clone(),
                database_type: Some(DatabaseType::Mysql),
            });
            let counted = counted.sql.unwrap_or_default();
            assert_eq!(counted.matches("GROUP BY").count(), 2, "{name}: count wrap kept both GROUP BYs");
            let statements = crate::sql::split_sql_statements_for_database(&variant, DatabaseType::Mysql);
            assert_eq!(statements.len(), 1, "{name}: still a single statement");
        }
    }

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

    // 词法扫描在标准串（反斜杠）后漏掉顶层 LIMIT 时，不能再追加第二个 LIMIT。
    #[test]
    fn postgres_hidden_limit_is_not_appended_twice() {
        for (offset, expected) in [
            (0usize, "SELECT * FROM t WHERE p = 'C:\\' LIMIT 10;"),
            (500, "SELECT * FROM (SELECT * FROM t WHERE p = 'C:\\' LIMIT 10) \"dbx_page\" LIMIT 500 OFFSET 500;"),
        ] {
            let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: "SELECT * FROM t WHERE p = 'C:\\' LIMIT 10".to_string(),
                database_type: Some(DatabaseType::Postgres),
                limit: 500,
                offset,
            });

            assert!(result.ok);
            assert_eq!(result.sql.unwrap(), expected, "offset {offset}");
        }
    }

    // 隐藏的 LIMIT 比页大小更宽时，与可见场景一致：包一层并保持页大小。
    #[test]
    fn postgres_hidden_limit_over_page_size_is_wrapped() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM t WHERE p = 'C:\\' LIMIT 1000".to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 500,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT * FROM t WHERE p = 'C:\\' LIMIT 1000) \"dbx_page\" LIMIT 500 OFFSET 0;"
        );
    }

    // 只有 OFFSET 的语句不算已限行，不能被 AST 补位误判成"已有分页"。
    #[test]
    fn postgres_offset_only_query_still_gets_a_limit() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM t OFFSET 5".to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 500,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT * FROM t OFFSET 5 LIMIT 500;");
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
    fn paginates_sqlserver_set_operations_with_rowcount_instead_of_limiting_first_branch() {
        // TOP injected into the first SELECT of INTERSECT/EXCEPT/UNION only bounds
        // that branch, so the combined result is wrong (e.g. 0 rows instead of the
        // real intersection). The whole statement must be bounded instead.
        for operator in ["INTERSECT", "EXCEPT", "UNION", "UNION ALL"] {
            let original_sql = format!("SELECT id FROM a {operator} SELECT id FROM b");
            let first_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: original_sql.clone(),
                database_type: Some(DatabaseType::SqlServer),
                limit: 100,
                offset: 0,
            });
            let sql = first_page.sql.expect("build set operation first page");
            assert!(!sql.contains("TOP ("), "{operator}: {sql}");
            assert_eq!(
                sql,
                format!("EXEC sys.sp_executesql N'SET ROWCOUNT 100; {original_sql}'; /*__dbx_result_offset=0__*/")
            );

            let later_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql,
                database_type: Some(DatabaseType::SqlServer),
                limit: 100,
                offset: 100,
            });
            let sql = later_page.sql.expect("build set operation later page");
            assert!(sql.starts_with("EXEC sys.sp_executesql N'SET ROWCOUNT 200; "), "{operator}: {sql}");
            assert_eq!(sqlserver_result_offset(&sql), 100);
        }
    }

    // 词法扫描漏检的 set 操作符同样不能被 TOP 只盖住第一个分支。
    #[test]
    fn sqlserver_hidden_set_operations_use_rowcount_instead_of_limiting_first_branch() {
        for (original, expected) in [
            (
                "SELECT id FROM #t UNION SELECT id FROM u",
                "EXEC sys.sp_executesql N'SET ROWCOUNT 500; SELECT id FROM #t UNION SELECT id FROM u'; /*__dbx_result_offset=0__*/",
            ),
            (
                "SELECT id FROM t WHERE p = 'C:\\' UNION SELECT id FROM u",
                "EXEC sys.sp_executesql N'SET ROWCOUNT 500; SELECT id FROM t WHERE p = ''C:\\'' UNION SELECT id FROM u'; /*__dbx_result_offset=0__*/",
            ),
        ] {
            let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: original.to_string(),
                database_type: Some(DatabaseType::SqlServer),
                limit: 500,
                offset: 0,
            });

            assert!(result.ok, "must stay paginatable: {original}");
            assert_eq!(result.sql.unwrap(), expected);
        }
    }

    #[test]
    fn keeps_top_level_order_by_when_paginating_sqlserver_set_operations() {
        let original_sql = "SELECT id FROM a INTERSECT SELECT id FROM b ORDER BY id";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: original_sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert_eq!(
            result.sql.unwrap(),
            format!("EXEC sys.sp_executesql N'SET ROWCOUNT 100; {original_sql}'; /*__dbx_result_offset=0__*/")
        );
    }

    #[test]
    fn keeps_sqlserver_top_when_set_operator_is_only_inside_subquery() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM (SELECT id FROM a UNION SELECT id FROM b) t".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT TOP (100) id FROM (SELECT id FROM a UNION SELECT id FROM b) t");
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
    fn paginates_existing_sqlserver_top_clause_keeping_user_order_by_desc() {
        let sql = "SELECT top 10 [ID], [ProcInstID], [ActInstID], [ActInstDestID], [StartDate], [DestUser], [Status], [Data], [SerialNumber] FROM [dbo].[_WorkList] ORDER BY ID DESC";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });
        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT TOP (100) * FROM (SELECT top 10 [ID], [ProcInstID], [ActInstID], [ActInstDestID], [StartDate], [DestUser], [Status], [Data], [SerialNumber] FROM [dbo].[_WorkList] ORDER BY ID DESC) [dbx_page] ORDER BY [ID] DESC;"
        );
    }

    #[test]
    fn paginates_existing_sqlserver_top_clause_later_page_keeping_user_order_by_desc() {
        let sql = "SELECT top 10 [ID], [ProcInstID] FROM [dbo].[_WorkList] ORDER BY ID DESC";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });
        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY [ID] DESC) AS [__dbx_row_num] FROM (SELECT top 10 [ID], [ProcInstID] FROM [dbo].[_WorkList] ORDER BY ID DESC) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 200 ORDER BY [__dbx_row_num];"
        );
    }

    #[test]
    fn paginates_existing_sqlserver_top_clause_keeping_multi_column_user_order_by() {
        let sql = "SELECT top 100 [ID], [StartDate] FROM [dbo].[_WorkList] ORDER BY [StartDate] DESC, ID";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });
        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT TOP (100) * FROM (SELECT top 100 [ID], [StartDate] FROM [dbo].[_WorkList] ORDER BY [StartDate] DESC, ID) [dbx_page] ORDER BY [StartDate] DESC, [ID];"
        );
    }

    #[test]
    fn paginates_existing_sqlserver_top_clause_keeping_ordinal_order_by() {
        let sql = "SELECT top 100 [ID], [Name] FROM [dbo].[_WorkList] ORDER BY 2 DESC";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });
        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT TOP (100) * FROM (SELECT top 100 [ID], [Name] FROM [dbo].[_WorkList] ORDER BY 2 DESC) [dbx_page] ORDER BY [Name] DESC;"
        );
    }

    #[test]
    fn paginates_later_sqlserver_top_page_mapping_ordinal_order_to_output_column() {
        let sql = "SELECT top 100 [ID], [Name] FROM [dbo].[_WorkList] ORDER BY 2 DESC";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });
        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY [Name] DESC) AS [__dbx_row_num] FROM (SELECT top 100 [ID], [Name] FROM [dbo].[_WorkList] ORDER BY 2 DESC) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 200 ORDER BY [__dbx_row_num];"
        );
    }

    #[test]
    fn paginates_sqlserver_top_clause_falling_back_for_out_of_range_ordinal() {
        let sql = "SELECT top 100 [ID], [Name] FROM [dbo].[_WorkList] ORDER BY 3 DESC";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });
        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY [ID]) AS [__dbx_row_num] FROM (SELECT top 100 [ID], [Name] FROM [dbo].[_WorkList] ORDER BY 3 DESC) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 200 ORDER BY [__dbx_row_num];"
        );
    }

    #[test]
    fn paginates_existing_sqlserver_top_clause_falls_back_when_order_by_not_projected() {
        let sql = "SELECT top 100 [ID] FROM [dbo].[_WorkList] ORDER BY [SerialNumber]";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 0,
        });
        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT TOP (100) * FROM (SELECT top 100 [ID] FROM [dbo].[_WorkList] ORDER BY [SerialNumber]) [dbx_page] ORDER BY [ID];"
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
            execution_hint: None,
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
                execution_hint: None,
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
                execution_hint: None,
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
    fn sqlserver_mixed_wildcard_count_preserves_query_predicates() {
        for projection in
            ["x_JtRoomCode, RoomInfo, *", "sr.x_JtRoomCode, sr.RoomInfo, sr.*", "sr.RoomInfo AS info, sr.*"]
        {
            let sql = format!("SELECT {projection} FROM s_room sr WHERE sr.RoomInfo LIKE N'%合肥天珺一期%' AND sr.x_JtRoomCode IS NULL ORDER BY sr.RoomInfo");
            let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.clone(),
                query_base_sql: sql,
                database_type: Some(DatabaseType::SqlServer),
                pagination: QueryPagination { limit: 1000, offset: 0, session_id: None },
                use_agent_cursor: false,
                first_page_uses_actual_sql: false,
                execution_hint: None,
            });
            assert_eq!(plan.count_sql.as_deref(), Some("SELECT COUNT(*) AS dbx_total_rows FROM s_room sr WHERE sr.RoomInfo LIKE N'%合肥天珺一期%' AND sr.x_JtRoomCode IS NULL;"));
            assert!(plan.sql_to_execute.starts_with("SELECT TOP (1000)"));
        }
    }

    #[test]
    fn sqlserver_mixed_wildcard_count_rejects_semantic_modifiers_and_expressions() {
        for sql in [
            "SELECT DISTINCT id, * FROM rooms",
            "SELECT TOP 10 id, * FROM rooms",
            "SELECT COUNT(*), * FROM rooms",
            "SELECT id + 1, * FROM rooms",
            "SELECT id, * FROM rooms GROUP BY id",
        ] {
            assert!(
                !build_count_query_sql(CountQuerySqlOptions {
                    original_sql: sql.to_string(),
                    database_type: Some(DatabaseType::SqlServer),
                })
                .ok,
                "must not rewrite {sql}"
            );
        }
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
            execution_hint: None,
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

    // 词法扫描漏检的结尾 ORDER BY 不能原样塞进 COUNT 派生表（SQL Server 拒绝），
    // 走 AST 重写分支剥离后再计数。
    #[test]
    fn sqlserver_count_strips_lexically_hidden_order_by() {
        for (original, expected) in [
            (
                "SELECT * FROM t WHERE p = 'C:\\' ORDER BY id",
                "SELECT COUNT(*) AS dbx_total_rows FROM t WHERE p = 'C:\\';",
            ),
            ("SELECT id FROM #t ORDER BY id", "SELECT COUNT(*) AS dbx_total_rows FROM #t;"),
        ] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: original.to_string(),
                database_type: Some(DatabaseType::SqlServer),
            });

            assert!(result.ok, "must stay countable: {original}");
            assert_eq!(result.sql.unwrap(), expected);
        }
    }

    #[test]
    fn sqlserver_count_wraps_top_with_lexically_hidden_order_by() {
        // T-SQL 允许派生表在带 TOP / OFFSET-FETCH 时保留 ORDER BY（Msg 1033 豁免），
        // 这类语句即使词法定位不到 ORDER BY 也应原样包装，保住精确行数。
        for original in [
            "SELECT TOP (100) * FROM #Orders ORDER BY id",
            "SELECT * FROM #Orders ORDER BY id OFFSET 10 ROWS FETCH NEXT 20 ROWS ONLY",
        ] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: original.to_string(),
                database_type: Some(DatabaseType::SqlServer),
            });

            assert!(result.ok, "must stay countable: {original}");
            let sql = result.sql.unwrap();
            assert!(sql.contains("COUNT(*)"), "{original} -> {sql}");
            assert!(sql.contains("ORDER BY"), "derived table must keep ORDER BY: {original} -> {sql}");
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
            execution_hint: None,
        });

        assert!(plan.sql_to_execute.contains("ROW_NUMBER()"));
        assert_eq!(plan.page_sql, Some(plan.sql_to_execute.clone()));
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(100));
        assert!(plan.count_sql.is_some());
    }

    #[test]
    fn sqlserver_json_output_executes_original_sql_without_wrappers() {
        let sql = "SELECT TOP 10 * FROM [sales].[orders_10k] FOR JSON AUTO".to_string();
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.clone(),
            query_base_sql: sql.clone(),
            database_type: Some(DatabaseType::SqlServer),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert!(plan.count_sql.is_none());
        assert_eq!(plan.page_limit, None);
        assert_eq!(plan.page_offset, None);
        assert_eq!(plan.exact_query_row_bound, None);
        assert!(!plan.single_execution);
        assert_eq!(
            build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: "SELECT TOP 10 * FROM [sales].[orders_10k] FOR JSON AUTO".to_string(),
                database_type: Some(DatabaseType::SqlServer),
                limit: 100,
                offset: 0,
            }),
            err("unsupported")
        );
        assert_eq!(
            build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql,
                database_type: Some(DatabaseType::SqlServer),
            }),
            err("unsupported")
        );
    }

    #[test]
    fn sqlserver_json_output_without_top_also_skips_wrappers() {
        let sql = "SELECT id, name FROM users FOR JSON PATH".to_string();
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.clone(),
            query_base_sql: sql.clone(),
            database_type: Some(DatabaseType::SqlServer),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert!(plan.count_sql.is_none());
        assert_eq!(plan.exact_query_row_bound, None);
    }

    // 词法扫描漏检的顶层 FOR JSON/XML 与可见时一致：不包装、不分页（否则首页被 TOP 静默截断、后续页生成非法 SQL）。
    #[test]
    fn sqlserver_hidden_json_output_also_skips_wrappers() {
        for original in ["SELECT * FROM #t FOR JSON PATH", "SELECT * FROM t WHERE p = 'C:\\' FOR JSON PATH"] {
            for offset in [0, 500] {
                let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                    original_sql: original.to_string(),
                    database_type: Some(DatabaseType::SqlServer),
                    limit: 500,
                    offset,
                });

                assert!(!result.ok, "must not wrap FOR JSON output (offset {offset}): {original}");
            }
        }
    }

    #[test]
    fn sqlserver_nested_json_output_in_subquery_still_paginates() {
        // FOR JSON nested inside a scalar subquery is not a top-level output
        // clause; the outer query is a normal projection and paginates.
        let sql = "SELECT id, (SELECT name FROM tags FOR JSON PATH) AS tags FROM users".to_string();
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.clone(),
            query_base_sql: sql,
            database_type: Some(DatabaseType::SqlServer),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert!(plan.page_sql.is_some());
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
    fn sqlserver_later_page_keeps_derived_table_closing_after_comment_before_order_by() {
        let sql = "SELECT\n*\nFROM\ncode\n-- WHERE\n-- ccode = '1002'\nORDER BY\nccode;";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        let generated = result.sql.expect("build SQL Server page SQL");
        assert!(generated.contains("FROM (SELECT\n*\nFROM\ncode\n-- WHERE\n-- ccode = '1002'\n) dbx_page_source"));
        assert!(!generated.contains("-- ccode = '1002') dbx_page_source"));
    }

    #[test]
    fn sqlserver_later_page_keeps_row_number_window_after_comment_after_order_by() {
        let sql = "SELECT\n*\nFROM\ncode\nORDER BY\nccode -- sort";
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 100,
            offset: 100,
        });

        let generated = result.sql.expect("build SQL Server page SQL");
        assert!(generated.contains("ROW_NUMBER() OVER (ORDER BY\nccode -- sort\n) AS [__dbx_row_num]"));
        assert!(!generated.contains("-- sort) AS [__dbx_row_num]"));
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
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert!(plan.count_sql.is_none());
        assert_eq!(plan.page_limit, None);
        assert_eq!(plan.page_offset, None);
    }

    #[test]
    fn sqlserver_cte_after_leading_comments_executes_original_sql() {
        for sql in [
            "-- heading comment\nWITH staff AS (SELECT 1 AS id) SELECT id FROM staff;",
            "/* heading comment */\nWITH staff AS (SELECT 1 AS id) SELECT id FROM staff;",
            ";-- heading comment\nWITH staff AS (SELECT 1 AS id) SELECT id FROM staff;",
            "-- heading comment\n;WITH staff AS (SELECT 1 AS id) SELECT id FROM staff;",
        ] {
            let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.to_string(),
                query_base_sql: sql.to_string(),
                database_type: Some(DatabaseType::SqlServer),
                pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
                use_agent_cursor: false,
                first_page_uses_actual_sql: false,
                execution_hint: None,
            });

            assert_eq!(plan.sql_to_execute, sql);
            assert!(plan.page_sql.is_none());
            assert!(plan.count_sql.is_none());
            assert_eq!(plan.page_limit, None);
            assert_eq!(plan.page_offset, None);
        }
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
            execution_hint: None,
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
            execution_hint: None,
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
            execution_hint: None,
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
            execution_hint: None,
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
    fn sqlserver_first_page_preserves_existing_pagination_or_injects_top() {
        for (original_sql, expected_sql) in [
            (
                "SELECT * FROM TABLE_NAME ORDER BY id OFFSET 1 ROWS FETCH NEXT 10 ROWS ONLY",
                "SELECT * FROM TABLE_NAME ORDER BY id OFFSET 1 ROWS FETCH NEXT 10 ROWS ONLY",
            ),
            ("SELECT id FROM TABLE_NAME", "SELECT TOP (100) id FROM TABLE_NAME"),
        ] {
            let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: original_sql.to_string(),
                database_type: Some(DatabaseType::SqlServer),
                limit: 100,
                offset: 0,
            });

            assert!(result.ok, "{original_sql}");
            assert_eq!(result.sql.as_deref(), Some(expected_sql), "{original_sql}");
        }
    }

    // 临时表 #tmp 会让词法扫描器把同一行后面的 OFFSET/FETCH 当成注释丢掉，
    // 必须靠 AST 检测拦住 TOP 注入，否则 SQL Server 报“TOP 不能与 OFFSET 同用”。
    #[test]
    fn keeps_sqlserver_offset_fetch_next_with_temp_table_on_same_line() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM #tmp ORDER BY id OFFSET 0 ROWS FETCH NEXT 62000 ROWS ONLY".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 500,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT * FROM #tmp ORDER BY id OFFSET 0 ROWS FETCH NEXT 62000 ROWS ONLY");
    }

    // 全局临时表 ##tmp 同样不能被注入 TOP。
    #[test]
    fn keeps_sqlserver_offset_fetch_next_with_global_temp_table() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM ##tmp ORDER BY id OFFSET 0 ROWS FETCH NEXT 62000 ROWS ONLY".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 500,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT * FROM ##tmp ORDER BY id OFFSET 0 ROWS FETCH NEXT 62000 ROWS ONLY");
    }

    // 只写 OFFSET 不写 FETCH NEXT 也是 SQL Server 合法分页写法，同样不能注入 TOP。
    #[test]
    fn keeps_sqlserver_offset_without_fetch_next() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM t ORDER BY id OFFSET 0 ROWS".to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 500,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(result.sql.unwrap(), "SELECT * FROM t ORDER BY id OFFSET 0 ROWS");
    }

    // 字符串里的反斜杠会让词法扫描器引号配对错乱，AST 检测需补位。
    #[test]
    fn keeps_sqlserver_offset_fetch_next_with_backslash_string() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT * FROM t WHERE p = 'C:\\' ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY"
                .to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 500,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM t WHERE p = 'C:\\' ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY"
        );
    }

    // `#` 临时表/反斜杠字符串让词法扫描漏掉结尾 ORDER BY 时，offset > 0 不能走
    // ROW_NUMBER 派生表包装（SQL Server 拒绝派生表里的 ORDER BY），退回 ROWCOUNT 封顶。
    #[test]
    fn sqlserver_hidden_order_by_uses_bounded_rowcount_pagination() {
        for (original, expected) in [
            (
                "SELECT * FROM t WHERE p = 'C:\\' ORDER BY id",
                "EXEC sys.sp_executesql N'SET ROWCOUNT 1000; SELECT * FROM t WHERE p = ''C:\\'' ORDER BY id'; /*__dbx_result_offset=500__*/",
            ),
            (
                "SELECT * FROM #t ORDER BY id",
                "EXEC sys.sp_executesql N'SET ROWCOUNT 1000; SELECT * FROM #t ORDER BY id'; /*__dbx_result_offset=500__*/",
            ),
        ] {
            let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: original.to_string(),
                database_type: Some(DatabaseType::SqlServer),
                limit: 500,
                offset: 500,
            });

            assert!(result.ok, "must stay paginatable: {original}");
            assert_eq!(result.sql.unwrap(), expected);
        }
    }

    // UNION 顶层的 OFFSET/FETCH 也不能被注入 TOP。
    #[test]
    fn keeps_sqlserver_offset_fetch_next_after_union() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM a UNION SELECT id FROM b ORDER BY id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY"
                .to_string(),
            database_type: Some(DatabaseType::SqlServer),
            limit: 500,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT id FROM a UNION SELECT id FROM b ORDER BY id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY"
        );
    }

    #[test]
    fn oracle_pagination_wraps_with_rownum() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Oracle),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT id FROM users) WHERE ROWNUM <= 100;");
    }

    #[test]
    fn oracle_pagination_wraps_offset_with_rownum_bounds() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Oracle),
            limit: 100,
            offset: 200,
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT dbx_inner.*, ROWNUM AS \"__dbx_row_num\" FROM (SELECT id FROM users) dbx_inner WHERE ROWNUM <= 300) WHERE \"__dbx_row_num\" > 200;"
        );
    }

    #[test]
    fn oracle_pagination_rejects_unsafe_queries() {
        for sql in [
            "SELECT a.id, b.id FROM a JOIN b ON a.id = b.id",
            "SELECT a.id, a.* FROM a",
            "SELECT * FROM users",
            "SELECT id FROM users FOR UPDATE",
            "SELECT id FROM users FOR UPDATE NOWAIT",
            "SELECT id FROM users WHERE ROWNUM <= 10",
            "SELECT id FROM users FETCH FIRST 10 ROWS ONLY",
        ] {
            let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(DatabaseType::Oracle),
                limit: 100,
                offset: 0,
            });
            assert!(!result.ok, "expected query to be rejected: {sql}");
            assert_eq!(result.reason.as_deref(), Some("unsupported"), "reason mismatch: {sql}");
        }
    }

    #[test]
    fn top_level_rownum_row_count_bounds_rownum_filtered_queries() {
        for (sql, expected) in [
            ("SELECT FJFY, JCBW FROM T_YL_JCZD01 WHERE ROWNUM < 2000;", Some(1999)),
            ("SELECT FJFY, JCBW FROM T_YL_JCZD01 WHERE ROWNUM <= 2000;", Some(2000)),
            ("SELECT id FROM users WHERE ROWNUM < 10 AND active = 1", Some(9)),
            ("SELECT id FROM users WHERE active = 1 AND ROWNUM <= 100", Some(100)),
            ("SELECT id FROM users WHERE 2000 > ROWNUM", Some(1999)),
            ("SELECT id FROM users WHERE (ROWNUM <= 50)", Some(50)),
            ("SELECT id FROM users WHERE ROWNUM < 1", Some(0)),
            // Ambiguous shapes must keep the normal pagination path.
            ("SELECT id FROM users WHERE ROWNUM < 2000 OR active = 1", None),
            ("SELECT id FROM users WHERE ROWNUM < :limit", None),
            ("SELECT id FROM users WHERE ROWNUM > 10", None),
            ("SELECT id FROM (SELECT id FROM users WHERE ROWNUM < 10) t WHERE ROWNUM <= 5", Some(5)),
            ("SELECT id FROM (SELECT id FROM users WHERE ROWNUM < 10) t", None),
            ("SELECT ROWNUM, id FROM users", None),
            ("SELECT id FROM users", None),
            ("SELECT id FROM users; SELECT 1", None),
        ] {
            assert_eq!(top_level_rownum_row_count(sql), expected, "{sql}");
        }
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
    fn mysql_pagination_preserves_same_line_tdsql_directives() {
        for directive in ["/*sets:allsets*/", "/*master*/", "/*slave:set_1781591902_7*/", "/*future-route:anywhere*/"] {
            let first_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: format!("{directive}select @@server_id;"),
                database_type: Some(DatabaseType::Mysql),
                limit: 100,
                offset: 0,
            });
            let later_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: format!("{directive}select @@server_id;"),
                database_type: Some(DatabaseType::Mysql),
                limit: 100,
                offset: 100,
            });

            assert_eq!(first_page.sql.unwrap(), format!("{directive}select @@server_id LIMIT 100;"));
            assert_eq!(later_page.sql.unwrap(), format!("{directive}select @@server_id LIMIT 100 OFFSET 100;"));
        }
    }

    #[test]
    fn mysql_pagination_preserves_exact_proxy_directive() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "/*proxy*/\nSELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "/*proxy*/\nSELECT id FROM users LIMIT 50;");
    }

    #[test]
    fn native_mysql_pagination_plan_preserves_exact_issue_directive() {
        let original_sql = "/*sets:allsets*/select @@server_id;";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: original_sql.to_string(),
            query_base_sql: original_sql.to_string(),
            database_type: Some(DatabaseType::Mysql),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, "/*sets:allsets*/select @@server_id LIMIT 100;");
        assert_eq!(plan.page_sql.as_deref(), Some(plan.sql_to_execute.as_str()));
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(0));
        assert_eq!(
            plan.count_sql.as_deref(),
            Some("/*sets:allsets*/SELECT COUNT(*) AS dbx_total_rows FROM (select @@server_id) `dbx_count`;")
        );
        assert!(!plan.use_agent_result_session);
    }

    #[test]
    fn mysql_pagination_does_not_look_past_the_requested_page() {
        for sql in [
            "SELECT * FROM table1 a, table2 b WHERE a.id = b.id AND REPLACE(SUBSTR(b.ymd, 1, 7), '-', '') < a.ym",
            "SELECT id FROM people WHERE active = 1",
            "SELECT id FROM people",
        ] {
            for offset in [0, 1000] {
                let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                    sql: sql.to_string(),
                    query_base_sql: sql.to_string(),
                    database_type: Some(DatabaseType::Mysql),
                    pagination: QueryPagination { limit: 1000, offset, session_id: None },
                    use_agent_cursor: false,
                    first_page_uses_actual_sql: false,
                    execution_hint: None,
                });
                let expected_sql = if offset == 0 {
                    format!("{sql} LIMIT 1000;")
                } else {
                    format!("{sql} LIMIT 1000 OFFSET {offset};")
                };

                assert_eq!(plan.sql_to_execute, expected_sql);
                assert_eq!(plan.page_sql.as_deref(), Some(expected_sql.as_str()));
                assert_eq!(plan.page_limit, Some(1000));
                assert_eq!(plan.page_offset, Some(offset));
                assert!(plan.page_probe_sql.is_none(), "must not wait for a 1001st match: {sql}");
                assert!(serde_json::to_value(&plan).unwrap().get("pageProbeSql").is_none());
            }
        }
    }

    #[test]
    fn dameng_user_limit_bounds_the_query_row_count() {
        // DM8 accepts MySQL-style LIMIT alongside ROWNUM pagination; a
        // user-written LIMIT must bound the fetch so the whole result comes
        // back in one shot instead of stopping at the first agent page (#13502).
        let sql = "SELECT DATE, COUNT(*) FROM t GROUP BY DATE ORDER BY DATE LIMIT 1000";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::Dameng),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });
        assert_eq!(plan.exact_query_row_bound, Some(1000));

        // ROWNUM remains the pagination strategy, so the bound does not change
        // generated page SQL.
        assert_eq!(plan.page_limit, Some(100));
    }

    #[test]
    fn mysql_pagination_keeps_the_user_limit_without_a_probe() {
        let sql = "SELECT id FROM people LIMIT 10";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::Mysql),
            pagination: QueryPagination { limit: 1000, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, "SELECT id FROM people LIMIT 10;");
        assert_eq!(plan.exact_query_row_bound, Some(10));
        assert!(plan.page_probe_sql.is_none());
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
    fn mysql_count_preserves_directives_at_outermost_start() {
        for prefix in [
            "/*sets:allsets*/",
            "/*master*/",
            "/*slave:set_1781591902_7*/",
            "/*future-route:anywhere*/",
            "/*proxy*/\n",
            "/*+ MAX_EXECUTION_TIME(1000) */\n",
            "/*@global:true*/\n",
            "/*& tenant:'test' */\n",
        ] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: format!("{prefix}select @@server_id;"),
                database_type: Some(DatabaseType::Mysql),
            });

            assert_eq!(
                result.sql.unwrap(),
                format!("{prefix}SELECT COUNT(*) AS dbx_total_rows FROM (select @@server_id) `dbx_count`;")
            );
        }
    }

    #[test]
    fn mysql_generated_queries_keep_standalone_comments_non_executable() {
        for original_sql in ["/* report query */\nSELECT id FROM users", "-- report query\nSELECT id FROM users"] {
            let page = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: original_sql.to_string(),
                database_type: Some(DatabaseType::Mysql),
                limit: 50,
                offset: 0,
            });
            let count = build_count_query_sql(CountQuerySqlOptions {
                original_sql: original_sql.to_string(),
                database_type: Some(DatabaseType::Mysql),
            });
            let sort = build_sorted_query_sql(SortedQuerySqlOptions {
                original_sql: original_sql.to_string(),
                database_type: Some(DatabaseType::Mysql),
                result_columns: vec!["id".to_string()],
                column_index: 0,
                column: "id".to_string(),
                direction: QuerySortDirection::Asc,
                tie_breaker_column_indexes: Vec::new(),
            });

            assert_eq!(page.sql.unwrap(), "SELECT id FROM users LIMIT 50;");
            assert_eq!(
                count.sql.unwrap(),
                "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT id FROM users) `dbx_count`;"
            );
            assert_eq!(sort, err("multi"));
        }
    }

    #[test]
    fn tdsql_directives_remain_mysql_only_in_generated_queries() {
        let original_sql = "/*sets:allsets*/SELECT id FROM users";
        let page = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: original_sql.to_string(),
            database_type: Some(DatabaseType::Postgres),
            limit: 50,
            offset: 0,
        });
        let count = build_count_query_sql(CountQuerySqlOptions {
            original_sql: original_sql.to_string(),
            database_type: Some(DatabaseType::Postgres),
        });

        assert_eq!(page.sql.unwrap(), "SELECT id FROM users LIMIT 50;");
        assert_eq!(count.sql.unwrap(), "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT id FROM users) \"dbx_count\";");
    }

    #[test]
    fn mysql_generated_queries_reject_non_executable_and_multi_statement_inputs() {
        for original_sql in ["/*sets:allsets*/", "/*sets:allsets SELECT id FROM users"] {
            let page = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: original_sql.to_string(),
                database_type: Some(DatabaseType::Mysql),
                limit: 50,
                offset: 0,
            });
            let count = build_count_query_sql(CountQuerySqlOptions {
                original_sql: original_sql.to_string(),
                database_type: Some(DatabaseType::Mysql),
            });

            assert!(!page.ok, "{original_sql}");
            assert!(page.sql.is_none(), "{original_sql}");
            assert!(!count.ok, "{original_sql}");
            assert!(count.sql.is_none(), "{original_sql}");
        }

        let multi = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "/*sets:allsets*/SELECT 1; SELECT 2".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 50,
            offset: 0,
        });
        assert_eq!(multi, err("multi"));
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
    fn mysql_pagination_rewrites_wide_limit_in_place_for_duplicate_projection() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT t.id, t.* FROM dbx_eval_t t ORDER BY t.id DESC LIMIT 500".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT t.id, t.* FROM dbx_eval_t t ORDER BY t.id DESC LIMIT 100 OFFSET 0;");
    }

    #[test]
    fn mysql_pagination_rewrites_comma_limit_in_place_for_later_pages() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id LIMIT 20, 250".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 200,
        });

        assert_eq!(result.sql.unwrap(), "SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id LIMIT 50 OFFSET 220;");
    }

    #[test]
    fn mysql_pagination_rewrites_limit_offset_in_place_before_locking_clause() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT t.id, t.* FROM t LIMIT 500 OFFSET 10 FOR UPDATE".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 100,
        });

        assert_eq!(result.sql.unwrap(), "SELECT t.id, t.* FROM t LIMIT 100 OFFSET 110 FOR UPDATE;");
    }

    #[test]
    fn mysql_pagination_rewrites_dedup_limit_in_place_with_positional_order() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT DISTINCT t.id, t.* FROM t LIMIT 500".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 0,
        });

        assert_eq!(result.sql.unwrap(), "SELECT DISTINCT t.id, t.* FROM t ORDER BY 1, 2 LIMIT 100 OFFSET 0;");
    }

    #[test]
    fn mysql_pagination_declines_non_literal_limit_for_duplicate_projection() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql: "SELECT t.id, t.* FROM t LIMIT ?".to_string(),
            database_type: Some(DatabaseType::Mysql),
            limit: 100,
            offset: 100,
        });

        assert!(!result.ok);
        assert_eq!(result.reason.as_deref(), Some("unsupported"));
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
    fn gaussdb_pagination_wraps_existing_limit_with_bare_page_alias() {
        // Same MySQL-mode string-literal trap as the count wrapper: the page
        // alias must reach the server unquoted on GaussDB M mode.
        for database_type in [DatabaseType::Gaussdb, DatabaseType::OpenGauss] {
            let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: "SELECT id FROM users LIMIT 20;".to_string(),
                database_type: Some(database_type),
                limit: 5,
                offset: 10,
            });

            assert_eq!(
                result.sql,
                Some("SELECT * FROM (SELECT id FROM users LIMIT 20) dbx_page LIMIT 5 OFFSET 10;".to_string()),
                "{database_type:?}"
            );
        }
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
    fn hive_count_keeps_cte_outside_derived_table() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "WITH cte AS (SELECT 1 AS id) SELECT * FROM cte".to_string(),
            database_type: Some(DatabaseType::Hive),
        });

        assert_eq!(
            result.sql.unwrap(),
            "WITH cte AS (SELECT 1 AS id) SELECT COUNT(*) AS dbx_total_rows FROM (SELECT * FROM cte) `dbx_count`;"
        );
    }

    #[test]
    fn hive_count_keeps_from_style_query_inside_derived_table() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "WITH cte AS (SELECT 1 AS id) FROM cte SELECT *".to_string(),
            database_type: Some(DatabaseType::Hive),
        });

        assert_eq!(
            result.sql.unwrap(),
            "WITH cte AS (SELECT 1 AS id) SELECT COUNT(*) AS dbx_total_rows FROM (FROM cte SELECT *) `dbx_count`;"
        );
    }

    #[test]
    fn mysql_count_rewrites_ambiguous_join_projection() {
        for sql in [
            "SELECT a.*, b.* FROM a JOIN b ON b.a_id = a.id ORDER BY b.id",
            "SELECT * FROM a JOIN b ON b.a_id = a.id ORDER BY b.id",
        ] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(DatabaseType::Mysql),
            });

            assert_eq!(
                result.sql.as_deref(),
                Some(
                    "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT 1 AS dbx_count_value FROM a JOIN b ON b.a_id = a.id) `dbx_count`;"
                ),
                "{sql}"
            );
        }
    }

    #[test]
    fn mysql_count_rewrites_duplicate_explicit_names() {
        for sql in [
            "SELECT a.id AS id, b.id AS id FROM a JOIN b ON b.a_id = a.id",
            "SELECT a.`1111`, b.`1111` FROM a JOIN b ON b.a_id = a.id",
        ] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(DatabaseType::Mysql),
            });

            assert_eq!(
                result.sql.as_deref(),
                Some(
                    "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT 1 AS dbx_count_value FROM a JOIN b ON b.a_id = a.id) `dbx_count`;"
                ),
                "{sql}"
            );
        }
    }

    #[test]
    fn mysql_count_keeps_unique_projection_wrapper() {
        let sql = "SELECT a.id AS a_id, b.id AS b_id FROM a JOIN b ON b.a_id = a.id ORDER BY b.id";
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(
            result.sql.as_deref(),
            Some(
                "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT a.id AS a_id, b.id AS b_id FROM a JOIN b ON b.a_id = a.id ORDER BY b.id) `dbx_count`;"
            )
        );
    }

    #[test]
    fn mysql_count_rewrite_preserves_limit_and_offset() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql:
                "SELECT a.*, b.* FROM a JOIN b ON b.a_id = a.id ORDER BY FIELD(b.id, 11, 10) LIMIT 2 OFFSET 1"
                    .to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(
            result.sql.as_deref(),
            Some(
                "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT 1 AS dbx_count_value FROM a JOIN b ON b.a_id = a.id LIMIT 2 OFFSET 1) `dbx_count`;"
            )
        );
    }

    #[test]
    fn mysql_count_rejects_ambiguous_cardinality_dependent_queries() {
        for sql in [
            "SELECT DISTINCT a.id AS id, b.id AS id FROM a JOIN b ON b.a_id = a.id",
            "SELECT a.id AS id, b.id AS id FROM a JOIN b ON b.a_id = a.id GROUP BY a.id, b.id",
            "SELECT a.id AS id, b.id AS id FROM a JOIN b ON b.a_id = a.id HAVING id > 0",
            "SELECT a.id AS id, b.id AS id FROM a JOIN b ON b.a_id = a.id UNION ALL SELECT c.id AS id, d.id AS id FROM c JOIN d ON d.c_id = c.id",
            "SELECT COUNT(*) AS id, SUM(a.id) AS id FROM a",
        ] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(DatabaseType::Mysql),
            });

            assert_eq!(result, err("unsupported"), "{sql}");
        }
    }

    #[test]
    fn mysql_count_rejects_ambiguous_select_into() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT a.id AS id, b.id AS id INTO OUTFILE 'dump.tsv' FROM a JOIN b ON b.a_id = a.id"
                .to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert!(!result.ok);
        assert!(result.sql.is_none());
    }

    #[test]
    fn mysql_count_keeps_parse_failure_fallback() {
        let sql = "SELECT a.id AS id, FROM a";
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::Mysql),
        });

        assert_eq!(
            result.sql.as_deref(),
            Some("SELECT COUNT(*) AS dbx_total_rows FROM (SELECT a.id AS id, FROM a) `dbx_count`;")
        );
    }

    #[test]
    fn non_mysql_count_keeps_ambiguous_projection_wrapper() {
        let sql = "SELECT a.*, b.* FROM a JOIN b ON b.a_id = a.id ORDER BY b.id";
        for database_type in [DatabaseType::Postgres, DatabaseType::Sqlite, DatabaseType::ClickHouse] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(database_type),
            });
            let alias = quote_table_identifier(Some(database_type), "dbx_count");

            assert_eq!(
                result.sql,
                Some(format!("SELECT COUNT(*) AS dbx_total_rows FROM ({sql}) {alias};")),
                "{database_type:?}"
            );
        }
    }

    #[test]
    fn gaussdb_count_uses_bare_derived_table_alias() {
        // GaussDB M mode parses MySQL syntax, where a double-quoted alias is a
        // string literal: `... FROM (SELECT ...) "dbx_count"` fails with
        // `syntax error at or near ""dbx_count""` instead of counting rows.
        let sql = "select * from sec_acct.other_sec_acct_info osai";
        for database_type in [DatabaseType::Gaussdb, DatabaseType::OpenGauss] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(database_type),
            });

            assert_eq!(
                result.sql,
                Some(format!("SELECT COUNT(*) AS dbx_total_rows FROM ({sql}) dbx_count;")),
                "{database_type:?}"
            );
        }
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
    fn iotdb_tree_count_rewrites_single_series_without_derived_table() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT WGEN_GnTmpSta1 FROM root.dbx_time_preview.device WHERE time >= 1 ORDER BY time DESC"
                .to_string(),
            database_type: Some(DatabaseType::Iotdb),
        });

        assert_eq!(
            result.sql.as_deref(),
            Some("SELECT COUNT(WGEN_GnTmpSta1) AS dbx_total_rows FROM root.dbx_time_preview.device WHERE time >= 1;")
        );
    }

    #[test]
    fn iotdb_count_allows_value_filters_on_selected_series() {
        for sql in [
            "SELECT s1 FROM root.db.device WHERE s1 > 10",
            "SELECT root.db.device.s1 FROM root.db.device WHERE root.db.device.s1 > 10",
        ] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(DatabaseType::Iotdb),
            });

            assert!(result.sql.is_some(), "{sql}");
        }
    }

    #[test]
    fn iotdb_count_declines_queries_without_safe_tree_row_semantics() {
        for sql in [
            "SELECT * FROM root.db.device",
            "SELECT s1, s2 FROM root.db.device",
            "SELECT COUNT(s1) FROM root.db.device",
            "SELECT s1 FROM root.db.device GROUP BY ([0, 100), 10ms)",
            "SELECT s1 FROM root.db.device WHERE s2 > 10",
            "SELECT s1 FROM root.db.device WHERE root.db.device.s2 > 10",
            "SELECT s1 FROM root.db.device LIMIT 10",
            "SELECT s1 FROM root.db.device, root.db.other",
            "SELECT value FROM metrics",
        ] {
            let result = build_count_query_sql(CountQuerySqlOptions {
                original_sql: sql.to_string(),
                database_type: Some(DatabaseType::Iotdb),
            });

            assert_eq!(result, err("unsupported"), "{sql}");
        }
    }

    #[test]
    fn iotdb_pagination_plan_uses_tree_model_count_query() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT WGEN_GnTmpSta1 FROM root.dbx_time_preview.device".to_string(),
            query_base_sql: "SELECT WGEN_GnTmpSta1 FROM root.dbx_time_preview.device".to_string(),
            database_type: Some(DatabaseType::Iotdb),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(
            plan.count_sql.as_deref(),
            Some("SELECT COUNT(WGEN_GnTmpSta1) AS dbx_total_rows FROM root.dbx_time_preview.device;")
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
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT id, appointment_time FROM patients WHERE status = ?) dbx_count;"
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
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT * FROM (SELECT TOP ? id FROM visits WHERE status = ? ORDER BY created_at DESC) recent WHERE id > ?) dbx_count;"
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
            "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT id FROM visits WHERE status = ?) dbx_count;"
        );
    }

    #[test]
    fn iris_count_query_injects_count_for_legacy_cache_table() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT * FROM TATFY WHERE UpdateDate = '2026-07-30' AND UpdateTime > '08:00:00'".to_string(),
            database_type: Some(DatabaseType::Iris),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT COUNT(*) AS dbx_total_rows FROM TATFY WHERE UpdateDate = '2026-07-30' AND UpdateTime > '08:00:00';"
        );
    }

    #[test]
    fn iris_count_query_injects_count_for_simple_select() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "select * from PA_Adm".to_string(),
            database_type: Some(DatabaseType::Iris),
        });

        assert_eq!(result.sql.as_deref(), Some("SELECT COUNT(*) AS dbx_total_rows FROM PA_Adm;"));
    }

    #[test]
    fn iris_count_query_preserves_simple_select_predicates_without_derived_alias() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT * FROM PA_Adm WHERE status = ? ORDER BY id DESC".to_string(),
            database_type: Some(DatabaseType::Iris),
        });

        assert_eq!(result.sql.as_deref(), Some("SELECT COUNT(*) AS dbx_total_rows FROM PA_Adm WHERE status = ?;"));
    }

    #[test]
    fn iris_count_query_keeps_wrapper_for_top_limited_select() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT TOP 10 * FROM PA_Adm ORDER BY id DESC".to_string(),
            database_type: Some(DatabaseType::Iris),
        });

        assert_eq!(
            result.sql.as_deref(),
            Some("SELECT COUNT(*) AS dbx_total_rows FROM (SELECT TOP 10 * FROM PA_Adm) dbx_count;")
        );
    }

    #[test]
    fn iris_count_query_keeps_derived_wrapper_for_complex_selects() {
        let result = build_count_query_sql(CountQuerySqlOptions {
            original_sql: "SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id".to_string(),
            database_type: Some(DatabaseType::Iris),
        });

        assert_eq!(
            result.sql.as_deref(),
            Some(
                "SELECT COUNT(*) AS dbx_total_rows FROM (SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id) dbx_count;"
            )
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
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM events");
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(plan.page_sql.is_none());
        assert!(plan.use_agent_result_session);
    }

    #[test]
    fn oracle_offset_jump_with_wildcard_keeps_agent_result_session() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Oracle),
            pagination: QueryPagination { limit: 100, offset: 200, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        // Wildcard projections cannot safely be wrapped in a derived table due to unknown
        // column collisions; offset jumps must keep the agent cursor session.
        assert_eq!(plan.sql_to_execute, "SELECT * FROM events");
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(200));
        assert!(plan.use_agent_result_session);
        assert!(plan.pagination_row_number_column.is_none());
    }

    #[test]
    fn oracle_offset_jump_with_safe_projection_rewrites_with_rownum() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT id FROM events".to_string(),
            query_base_sql: "SELECT id FROM events".to_string(),
            database_type: Some(DatabaseType::Oracle),
            pagination: QueryPagination { limit: 100, offset: 200, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        // Safe projections without wildcard or duplicate output names support ROWNUM pagination (#12789),
        // so offset jumps rewrite the query with server-side row-number bounds.
        assert_eq!(
            plan.sql_to_execute,
            "SELECT * FROM (SELECT dbx_inner.*, ROWNUM AS \"__dbx_row_num\" FROM (SELECT id FROM events) dbx_inner WHERE ROWNUM <= 300) WHERE \"__dbx_row_num\" > 200;"
        );
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(200));
        assert!(!plan.use_agent_result_session);
        assert_eq!(plan.pagination_row_number_column.as_deref(), Some("__dbx_row_num"));
    }

    #[test]
    fn jdbc_offset_jump_keeps_agent_result_session() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Jdbc),
            pagination: QueryPagination { limit: 100, offset: 200, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert!(plan.use_agent_result_session);
        assert_eq!(plan.page_offset, Some(200));
    }

    #[test]
    fn cassandra_offset_jump_keeps_agent_result_session_without_sql_pagination() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Cassandra),
            pagination: QueryPagination { limit: 100, offset: 200, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM events;");
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(200));
        assert!(plan.page_sql.is_some());
        assert!(plan.count_sql.is_none());
        assert!(plan.use_agent_result_session);
    }

    #[test]
    fn rewritten_offset_jump_does_not_use_agent_result_session() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Postgres),
            pagination: QueryPagination { limit: 100, offset: 200, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert!(plan.sql_to_execute.contains("LIMIT"));
        assert!(!plan.use_agent_result_session);
    }

    #[test]
    fn highgo_prefers_server_pagination_over_agent_cursor() {
        let first_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Highgo),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(first_page.sql_to_execute, "SELECT * FROM events LIMIT 500;");
        assert_eq!(first_page.page_sql, Some(first_page.sql_to_execute.clone()));
        assert_eq!(first_page.page_limit, Some(500));
        assert_eq!(first_page.page_offset, Some(0));
        assert!(!first_page.use_agent_result_session);

        let second_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Highgo),
            pagination: QueryPagination { limit: 500, offset: 500, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(second_page.sql_to_execute, "SELECT * FROM events LIMIT 500 OFFSET 500;");
        assert_eq!(second_page.page_sql, Some(second_page.sql_to_execute.clone()));
        assert_eq!(second_page.page_limit, Some(500));
        assert_eq!(second_page.page_offset, Some(500));
        assert!(!second_page.use_agent_result_session);
    }

    #[test]
    fn db2_uses_agent_cursor_for_compatible_offset_pagination() {
        let first_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Db2),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(first_page.sql_to_execute, "SELECT * FROM events");
        assert!(first_page.page_sql.is_none());
        assert_eq!(first_page.page_limit, Some(500));
        assert_eq!(first_page.page_offset, Some(0));
        assert!(first_page.use_agent_result_session);

        let second_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Db2),
            pagination: QueryPagination { limit: 500, offset: 500, session_id: Some("db2-session".to_string()) },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(second_page.sql_to_execute, "SELECT * FROM events");
        assert!(second_page.page_sql.is_none());
        assert_eq!(second_page.page_limit, Some(500));
        assert_eq!(second_page.page_offset, Some(500));
        assert!(second_page.use_agent_result_session);

        let sql = "SELECT * FROM events; SELECT 1";
        let fallback = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::Db2),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(fallback.sql_to_execute, sql);
        assert!(fallback.page_sql.is_none());
        assert!(fallback.use_agent_result_session);

        let offset_jump = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Db2),
            pagination: QueryPagination { limit: 500, offset: 500, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(offset_jump.sql_to_execute, "SELECT * FROM events");
        assert!(offset_jump.page_sql.is_none());
        assert_eq!(offset_jump.page_limit, Some(500));
        assert_eq!(offset_jump.page_offset, Some(500));
        assert!(offset_jump.use_agent_result_session);
    }

    #[test]
    fn xugu_prefers_server_pagination_over_agent_cursor() {
        let first_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Xugu),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(first_page.sql_to_execute, "SELECT * FROM events LIMIT 100;");
        assert_eq!(first_page.page_sql, Some(first_page.sql_to_execute.clone()));
        assert_eq!(first_page.page_limit, Some(100));
        assert_eq!(first_page.page_offset, Some(0));
        assert!(!first_page.use_agent_result_session);

        let second_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Xugu),
            pagination: QueryPagination { limit: 100, offset: 100, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(second_page.sql_to_execute, "SELECT * FROM events LIMIT 100 OFFSET 100;");
        assert_eq!(second_page.page_sql, Some(second_page.sql_to_execute.clone()));
        assert_eq!(second_page.page_limit, Some(100));
        assert_eq!(second_page.page_offset, Some(100));
        assert!(!second_page.use_agent_result_session);
    }

    #[test]
    fn xugu_keeps_agent_fallback_for_unrewritable_query() {
        let sql = "SELECT * FROM events; SELECT 1";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::Xugu),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert!(plan.use_agent_result_session);
    }

    #[test]
    fn goldendb_prefers_server_pagination_over_agent_cursor() {
        let first_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Goldendb),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(first_page.sql_to_execute, "SELECT * FROM events LIMIT 100;");
        assert_eq!(first_page.page_sql, Some(first_page.sql_to_execute.clone()));
        assert_eq!(first_page.page_limit, Some(100));
        assert_eq!(first_page.page_offset, Some(0));
        assert!(!first_page.use_agent_result_session);

        let second_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Goldendb),
            pagination: QueryPagination { limit: 100, offset: 100, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(second_page.sql_to_execute, "SELECT * FROM events LIMIT 100 OFFSET 100;");
        assert_eq!(second_page.page_sql, Some(second_page.sql_to_execute.clone()));
        assert_eq!(second_page.page_limit, Some(100));
        assert_eq!(second_page.page_offset, Some(100));
        assert!(!second_page.use_agent_result_session);
    }

    #[test]
    fn goldendb_keeps_agent_fallback_for_unrewritable_query() {
        let sql = "SELECT * FROM events; SELECT 1";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::Goldendb),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert!(plan.use_agent_result_session);
    }

    #[test]
    fn goldendb_count_query_handles_duplicate_column_names() {
        let sql = "SELECT t.id, t.* FROM events t";
        let count = build_count_query_sql(CountQuerySqlOptions {
            original_sql: sql.to_string(),
            database_type: Some(DatabaseType::Goldendb),
        });

        assert!(count.ok);
        assert_eq!(
            count.sql.as_deref(),
            Some("SELECT COUNT(*) AS dbx_total_rows FROM (SELECT 1 AS dbx_count_value FROM events t) `dbx_count`;")
        );
    }

    #[test]
    fn xugu_top_clause_keeps_first_page_agent_cursor() {
        for sql in [
            "SELECT TOP 10 * FROM events",
            "select top 10 * from events",
            "/* first page */ SELECT /* bounded */ TOP 10 * FROM events",
        ] {
            let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.to_string(),
                query_base_sql: sql.to_string(),
                database_type: Some(DatabaseType::Xugu),
                pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
                use_agent_cursor: true,
                first_page_uses_actual_sql: false,
                execution_hint: None,
            });

            assert_eq!(plan.sql_to_execute, sql);
            assert!(plan.page_sql.is_none());
            assert_eq!(plan.page_limit, Some(100));
            assert_eq!(plan.page_offset, Some(0));
            assert!(plan.use_agent_result_session);
            assert!(!plan.single_execution);
        }
    }

    #[test]
    fn xugu_top_clause_without_agent_uses_single_execution() {
        let sql = "SELECT TOP 10 * FROM events";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::Xugu),
            pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: true,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert_eq!(plan.page_limit, Some(100));
        assert_eq!(plan.page_offset, Some(0));
        assert!(!plan.use_agent_result_session);
        assert!(plan.single_execution);
    }

    #[test]
    fn xugu_top_clause_rejects_sibling_limit_on_every_page() {
        for offset in [0, 100] {
            let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
                original_sql: "SELECT TOP 10 * FROM events".to_string(),
                database_type: Some(DatabaseType::Xugu),
                limit: 100,
                offset,
            });

            assert!(!result.ok);
            assert!(result.sql.is_none());
            assert_eq!(result.reason.as_deref(), Some("unsupported"));
        }
    }

    #[test]
    fn oceanbase_oracle_prefers_bounded_first_page_and_keeps_cursor_fallback() {
        let sql = "SELECT id FROM events";
        let first_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });
        assert_eq!(first_page.sql_to_execute, "SELECT * FROM (SELECT id FROM events) WHERE ROWNUM <= 500;");
        assert_eq!(first_page.page_sql.as_deref(), Some(first_page.sql_to_execute.as_str()));
        assert_eq!(first_page.page_limit, Some(500));
        assert_eq!(first_page.page_offset, Some(0));
        assert!(!first_page.use_agent_result_session);
        assert!(first_page.count_sql.is_some());
        assert!(first_page.pagination_row_number_column.is_none());

        let next_page = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            pagination: QueryPagination { limit: 500, offset: 500, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });
        assert!(next_page.sql_to_execute.contains("ROWNUM <= 1000"));
        assert!(next_page.sql_to_execute.contains("\"__dbx_row_num\" > 500"));
        assert_eq!(next_page.page_sql.as_deref(), Some(next_page.sql_to_execute.as_str()));
        assert!(!next_page.use_agent_result_session);
        assert_eq!(next_page.pagination_row_number_column.as_deref(), Some("__dbx_row_num"));

        let unrewritable = "SELECT * FROM events; SELECT 1";
        let fallback = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: unrewritable.to_string(),
            query_base_sql: unrewritable.to_string(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });
        assert_eq!(fallback.sql_to_execute, unrewritable);
        assert!(fallback.page_sql.is_none());
        assert!(fallback.use_agent_result_session);
    }

    #[test]
    fn rownum_helper_avoids_names_in_the_original_query() {
        let sql = "SELECT LEVEL AS \"__dbx_row_num\" FROM DUAL CONNECT BY LEVEL <= 10";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            pagination: QueryPagination { limit: 5, offset: 5, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });
        assert_eq!(plan.pagination_row_number_column.as_deref(), Some("__dbx_row_num_1"));
        assert!(plan.sql_to_execute.contains("ROWNUM AS \"__dbx_row_num_1\""));
        assert!(plan.sql_to_execute.contains("WHERE \"__dbx_row_num_1\" > 5"));
        assert!(plan.sql_to_execute.contains(sql));
    }

    #[test]
    fn existing_rownum_keeps_a_cursor_and_does_not_mark_a_user_column_as_generated() {
        let sql = "SELECT ROWNUM AS \"__dbx_row_num\", name FROM events WHERE ROWNUM <= 1000";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::OceanbaseOracle),
            pagination: QueryPagination { limit: 500, offset: 500, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });
        assert!(plan.pagination_row_number_column.is_none());
        assert!(plan.use_agent_result_session);
        assert_eq!(plan.page_offset, Some(500));
        assert_eq!(plan.sql_to_execute, sql);
    }

    #[test]
    fn highgo_avoids_agent_cursor_for_unrewritable_queries() {
        let sql = "SELECT * FROM events; SELECT 1";
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: sql.to_string(),
            query_base_sql: sql.to_string(),
            database_type: Some(DatabaseType::Highgo),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, sql);
        assert!(plan.page_sql.is_none());
        assert!(plan.page_limit.is_none());
        assert!(plan.page_offset.is_none());
        assert!(!plan.use_agent_result_session);
    }

    #[test]
    fn kingbase_prefers_server_pagination_for_ordered_query() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events ORDER BY id".to_string(),
            query_base_sql: "SELECT * FROM events ORDER BY id".to_string(),
            database_type: Some(DatabaseType::Kingbase),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM events ORDER BY id LIMIT 500;");
        assert_eq!(plan.page_sql, Some(plan.sql_to_execute.clone()));
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(!plan.use_agent_result_session);
    }

    #[test]
    fn kingbase_uses_agent_cursor_for_unordered_query() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM events".to_string(),
            query_base_sql: "SELECT * FROM events".to_string(),
            database_type: Some(DatabaseType::Kingbase),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM events");
        assert!(plan.page_sql.is_none());
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(plan.use_agent_result_session);
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
            execution_hint: None,
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
                execution_hint: None,
            });

            assert_eq!(plan.sql_to_execute, sql, "sql_to_execute should stay untouched for {sql}");
            assert!(plan.page_sql.is_none(), "no LIMIT rewrite for {sql}");
            assert_eq!(plan.page_limit, Some(500));
            assert_eq!(plan.page_offset, Some(0));
            assert!(plan.use_agent_result_session, "Agent cursor fallback for {sql}");
        }
    }

    #[test]
    fn kingbase_unordered_subquery_top_uses_agent_cursor() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT * FROM (SELECT TOP 100 * FROM events) t".to_string(),
            query_base_sql: "SELECT * FROM (SELECT TOP 100 * FROM events) t".to_string(),
            database_type: Some(DatabaseType::Kingbase),
            pagination: QueryPagination { limit: 500, offset: 0, session_id: None },
            use_agent_cursor: true,
            first_page_uses_actual_sql: false,
            execution_hint: None,
        });

        assert_eq!(plan.sql_to_execute, "SELECT * FROM (SELECT TOP 100 * FROM events) t");
        assert!(plan.page_sql.is_none());
        assert_eq!(plan.page_limit, Some(500));
        assert_eq!(plan.page_offset, Some(0));
        assert!(plan.use_agent_result_session);
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
                execution_hint: None,
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
            execution_hint: None,
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
    fn pagination_plan_exposes_only_safe_exact_row_bounds() {
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
            // The standard LIMIT/OFFSET dialects (MySQL, Postgres, and every
            // other database that isn't given its own pagination_strategy
            // arm) bound the query the same way SQL Server's TOP does.
            (Some(DatabaseType::Postgres), "SELECT * FROM events LIMIT 100", Some(100)),
            (Some(DatabaseType::Mysql), "SELECT * FROM events LIMIT 50", Some(50)),
            (Some(DatabaseType::Mysql), "SELECT * FROM events LIMIT 100 OFFSET 100", Some(100)),
            (Some(DatabaseType::ClickHouse), "SELECT * FROM events LIMIT 10 BY user_id", None),
            (Some(DatabaseType::ClickHouse), "SELECT * FROM events LIMIT 10 OFFSET 5 BY user_id", None),
            (Some(DatabaseType::ClickHouse), "SELECT * FROM events LIMIT 10 WITH TIES", None),
            (Some(DatabaseType::DuckDb), "SELECT * FROM events LIMIT 10%", None),
            (Some(DatabaseType::DuckDb), "SELECT * FROM events LIMIT 10 PERCENT", None),
            // Dameng accepts MySQL-style LIMIT alongside its ROWNUM pagination
            // (#13502); the other ROWNUM dialects reject LIMIT syntax, so a
            // top-level LIMIT must not bound them.
            (Some(DatabaseType::Dameng), "SELECT * FROM events LIMIT 1000", Some(1000)),
            (Some(DatabaseType::Dameng), "SELECT * FROM events LIMIT 1000 OFFSET 50", Some(1000)),
            (Some(DatabaseType::Dameng), "SELECT * FROM events LIMIT 50, 1000", Some(1000)),
            (Some(DatabaseType::Dameng), "SELECT * FROM (SELECT * FROM events LIMIT 5) t", None),
            (Some(DatabaseType::Oracle), "SELECT * FROM events LIMIT 100", None),
            (Some(DatabaseType::OceanbaseOracle), "SELECT * FROM events LIMIT 100", None),
            (None, "SELECT * FROM events LIMIT 100", Some(100)),
            (Some(DatabaseType::Postgres), "SELECT * FROM events", None),
        ] {
            let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.to_string(),
                query_base_sql: sql.to_string(),
                database_type,
                pagination: QueryPagination { limit: 100, offset: 0, session_id: None },
                use_agent_cursor: false,
                first_page_uses_actual_sql: false,
                execution_hint: None,
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
            execution_hint: None,
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
            execution_hint: None,
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
            tie_breaker_column_indexes: Vec::new(),
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
            tie_breaker_column_indexes: Vec::new(),
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
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT * FROM admin LIMIT 100) t ORDER BY `login_name` ASC;");
    }

    #[test]
    fn postgres_sort_appends_tie_breaker_columns_after_the_sort_column() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT * FROM sales ORDER BY id DESC".to_string(),
            database_type: Some(DatabaseType::Postgres),
            result_columns: vec!["id".to_string(), "kdrq".to_string(), "spmc".to_string()],
            column_index: 1,
            column: "kdrq".to_string(),
            direction: QuerySortDirection::Desc,
            tie_breaker_column_indexes: vec![0],
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT * FROM sales ORDER BY id DESC) t(\"id\", \"kdrq\", \"spmc\") ORDER BY \"kdrq\" DESC, \"id\" ASC;"
        );
    }

    #[test]
    fn mysql_sort_appends_hidden_key_tie_breaker_by_name() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT kdrq, spmc, `id` AS `__DBX_PK_0` FROM sales".to_string(),
            database_type: Some(DatabaseType::Mysql),
            result_columns: vec!["kdrq".to_string(), "spmc".to_string(), "__DBX_PK_0".to_string()],
            column_index: 0,
            column: "kdrq".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: vec![2],
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT kdrq, spmc, `id` AS `__DBX_PK_0` FROM sales) t ORDER BY `kdrq` ASC, `__DBX_PK_0` ASC;"
        );
    }

    #[test]
    fn duplicate_label_sort_appends_tie_breaker_ordinals() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "select c1, t.* from dbx_eval_t t order by c1".to_string(),
            database_type: Some(DatabaseType::Oracle),
            result_columns: vec!["C1".to_string(), "C1".to_string(), "C2".to_string()],
            column_index: 2,
            column: "C2".to_string(),
            direction: QuerySortDirection::Desc,
            tie_breaker_column_indexes: vec![1],
        });

        assert_eq!(result.sql.unwrap(), "select c1, t.* from dbx_eval_t t ORDER BY 3 DESC, 2 ASC;");
    }

    #[test]
    fn sort_ignores_out_of_range_repeated_and_sort_column_tie_breakers() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT a, b FROM t".to_string(),
            database_type: Some(DatabaseType::Postgres),
            result_columns: vec!["a".to_string(), "b".to_string()],
            column_index: 1,
            column: "b".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: vec![5, 1, 0, 0],
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT a, b FROM t) t(\"a\", \"b\") ORDER BY \"b\" ASC, \"a\" ASC;"
        );
    }

    #[test]
    fn hive_family_sort_uses_derived_table_alias_without_column_list() {
        for database_type in [DatabaseType::Argo, DatabaseType::Hive, DatabaseType::Impala] {
            for direction in [QuerySortDirection::Asc, QuerySortDirection::Desc] {
                let result = build_sorted_query_sql(SortedQuerySqlOptions {
                    original_sql: "SELECT id, name FROM users;".to_string(),
                    database_type: Some(database_type),
                    result_columns: vec!["id".to_string(), "name".to_string()],
                    column_index: 1,
                    column: "name".to_string(),
                    direction,
                    tie_breaker_column_indexes: Vec::new(),
                });

                assert_eq!(
                    result,
                    ok(format!("SELECT * FROM (SELECT id, name FROM users) t ORDER BY `name` {};", direction.as_sql())),
                    "{database_type:?} {direction:?}"
                );
            }
        }
    }

    #[test]
    fn hive_family_sort_preserves_star_queries_and_existing_ordering() {
        for database_type in [DatabaseType::Argo, DatabaseType::Hive, DatabaseType::Impala] {
            let result = build_sorted_query_sql(SortedQuerySqlOptions {
                original_sql: " SELECT * FROM users WHERE active = 1 ORDER BY name DESC LIMIT 100; ".to_string(),
                database_type: Some(database_type),
                result_columns: vec!["id".to_string(), "name".to_string()],
                column_index: 0,
                column: "id".to_string(),
                direction: QuerySortDirection::Asc,
                tie_breaker_column_indexes: Vec::new(),
            });

            assert_eq!(
                result,
                ok("SELECT * FROM (SELECT * FROM users WHERE active = 1 ORDER BY name DESC LIMIT 100) t ORDER BY `id` ASC;".to_string()),
                "{database_type:?}"
            );
        }
    }

    #[test]
    fn hive_family_sort_quotes_result_aliases_without_renaming_them() {
        for database_type in [DatabaseType::Argo, DatabaseType::Hive, DatabaseType::Impala] {
            for (column, quoted_column) in [
                ("display_name", "`display_name`"),
                ("order", "`order`"),
                ("display name", "`display name`"),
                ("a.b", "`a.b`"),
                ("姓名", "`姓名`"),
                ("user`name", "`user``name`"),
                ("\"name\"", "`\"name\"`"),
            ] {
                let original_sql = format!("SELECT id, name AS {quoted_column} FROM users");
                let result = build_sorted_query_sql(SortedQuerySqlOptions {
                    original_sql: original_sql.clone(),
                    database_type: Some(database_type),
                    result_columns: vec!["id".to_string(), column.to_string()],
                    column_index: 1,
                    column: "name".to_string(),
                    direction: QuerySortDirection::Desc,
                    tie_breaker_column_indexes: Vec::new(),
                });

                assert_eq!(
                    result,
                    ok(format!("SELECT * FROM ({original_sql}) t ORDER BY {quoted_column} DESC;")),
                    "{database_type:?} {column:?}"
                );
            }
        }
    }

    #[test]
    fn hive_family_sort_falls_back_to_requested_column_for_out_of_range_index() {
        for database_type in [DatabaseType::Argo, DatabaseType::Hive, DatabaseType::Impala] {
            for result_columns in [vec!["id".to_string(), "display name".to_string()], Vec::new()] {
                let result = build_sorted_query_sql(SortedQuerySqlOptions {
                    original_sql: "SELECT id, name AS `display name` FROM users".to_string(),
                    database_type: Some(database_type),
                    result_columns,
                    column_index: usize::MAX,
                    column: "display name".to_string(),
                    direction: QuerySortDirection::Asc,
                    tie_breaker_column_indexes: Vec::new(),
                });

                assert_eq!(
                    result,
                    ok("SELECT * FROM (SELECT id, name AS `display name` FROM users) t ORDER BY `display name` ASC;"
                        .to_string()),
                    "{database_type:?}"
                );
            }
        }
    }

    #[test]
    fn hive_family_sort_rejects_duplicate_derived_column_names_without_using_ordinals() {
        for database_type in [DatabaseType::Argo, DatabaseType::Hive, DatabaseType::Impala] {
            for result_columns in [["id", "id", "name"], ["ID", "id", "name"], ["姓名", "姓名", "name"]] {
                for column_index in [0, 1, 2, usize::MAX] {
                    let result = build_sorted_query_sql(SortedQuerySqlOptions {
                        original_sql: "SELECT a.id, b.id, a.name FROM a JOIN b ON a.id = b.id".to_string(),
                        database_type: Some(database_type),
                        result_columns: result_columns.iter().map(|column| column.to_string()).collect(),
                        column_index,
                        column: "name".to_string(),
                        direction: QuerySortDirection::Desc,
                        tie_breaker_column_indexes: Vec::new(),
                    });

                    assert_eq!(result, err("unsupported"), "{database_type:?} {result_columns:?} {column_index}");
                }
            }
        }
    }

    #[test]
    fn hive_family_sort_preserves_statement_rejection_boundaries() {
        for database_type in [DatabaseType::Argo, DatabaseType::Hive, DatabaseType::Impala] {
            for (original_sql, reason) in [
                ("", "empty"),
                (" \n\t", "empty"),
                (";", "empty"),
                ("SELECT 1; SELECT 2;", "multi"),
                ("WITH cte AS (SELECT 1 AS id) INSERT INTO users SELECT id FROM cte", "with"),
                ("SHOW TABLES", "not_select"),
                ("UPDATE users SET id = 2", "not_select"),
            ] {
                let result = build_sorted_query_sql(SortedQuerySqlOptions {
                    original_sql: original_sql.to_string(),
                    database_type: Some(database_type),
                    result_columns: vec!["id".to_string()],
                    column_index: 0,
                    column: "id".to_string(),
                    direction: QuerySortDirection::Asc,
                    tie_breaker_column_indexes: Vec::new(),
                });

                assert_eq!(result, err(reason), "{database_type:?} {original_sql:?}");
            }
        }
    }

    #[test]
    fn hive_family_sort_fix_preserves_other_dialects_column_alias_lists() {
        for (database_type, expected_suffix) in [
            (None, "t(\"id\", \"id_2\") ORDER BY \"id_2\" DESC;"),
            (Some(DatabaseType::Jdbc), "t(id, id_2) ORDER BY id_2 DESC;"),
            (Some(DatabaseType::Postgres), "t(\"id\", \"id_2\") ORDER BY \"id_2\" DESC;"),
            (Some(DatabaseType::Spark), "t(`id`, `id_2`) ORDER BY `id_2` DESC;"),
            (Some(DatabaseType::Kyuubi), "t(`id`, `id_2`) ORDER BY `id_2` DESC;"),
            (Some(DatabaseType::Databricks), "t(`id`, `id_2`) ORDER BY `id_2` DESC;"),
        ] {
            let result = build_sorted_query_sql(SortedQuerySqlOptions {
                original_sql: "SELECT a.id, b.id FROM a JOIN b ON a.id = b.id".to_string(),
                database_type,
                result_columns: vec!["id".to_string(), "id".to_string()],
                column_index: 1,
                column: "id".to_string(),
                direction: QuerySortDirection::Desc,
                tie_breaker_column_indexes: Vec::new(),
            });

            assert_eq!(
                result,
                ok(format!("SELECT * FROM (SELECT a.id, b.id FROM a JOIN b ON a.id = b.id) {expected_suffix}")),
                "{database_type:?}"
            );
        }
    }

    #[test]
    fn builds_saphana_sorted_query_without_derived_column_alias_list() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT ID, NAME, AMOUNT FROM DBX_ISSUE_7274_SORT".to_string(),
            database_type: Some(DatabaseType::SapHana),
            result_columns: vec!["ID".to_string(), "NAME".to_string(), "AMOUNT".to_string()],
            column_index: 1,
            column: "NAME".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT ID, NAME, AMOUNT FROM DBX_ISSUE_7274_SORT) t ORDER BY \"NAME\" ASC;"
        );
    }

    #[test]
    fn builds_iris_sorted_query_without_derived_column_alias_list() {
        // Caché/IRIS rejects `t(col, col)` derived alias lists (SQLCODE -25) and
        // a quoted ORDER BY name becomes a string literal when delimited
        // identifiers are disabled, so the wrap must stay alias-free and
        // unquoted (#8340).
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT ID, Name FROM SQLUser.CT_Country".to_string(),
            database_type: Some(DatabaseType::Iris),
            result_columns: vec!["ID".to_string(), "Name".to_string()],
            column_index: 1,
            column: "Name".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });
        let sql = result.sql.unwrap();
        assert!(!sql.contains(") t("), "derived column alias list must not be emitted: {sql}");
        assert_eq!(sql, "SELECT * FROM (SELECT ID, Name FROM SQLUser.CT_Country) t ORDER BY Name ASC;");
    }

    #[test]
    fn builds_iris_sorted_query_by_ordinal_for_duplicate_columns() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id".to_string(),
            database_type: Some(DatabaseType::Iris),
            result_columns: vec!["ID".to_string(), "id".to_string()],
            column_index: 1,
            column: "id".to_string(),
            direction: QuerySortDirection::Desc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id) t ORDER BY 2 DESC;"
        );
    }

    #[test]
    fn mysql_sort_preserves_directives_at_outermost_start() {
        for prefix in [
            "/*sets:allsets*/",
            "/*master*/",
            "/*slave:set_1781591902_7*/",
            "/*future-route:anywhere*/",
            "/*proxy*/\n",
            "/*+ MAX_EXECUTION_TIME(1000) */\n",
            "/*@global:true*/\n",
            "/*& tenant:'test' */\n",
        ] {
            let result = build_sorted_query_sql(SortedQuerySqlOptions {
                original_sql: format!("{prefix}select @@server_id;"),
                database_type: Some(DatabaseType::Mysql),
                result_columns: vec!["@@server_id".to_string()],
                column_index: 0,
                column: "@@server_id".to_string(),
                direction: QuerySortDirection::Asc,
                tie_breaker_column_indexes: Vec::new(),
            });

            assert!(result.ok, "{prefix}: {result:?}");
            assert_eq!(
                result.sql.unwrap(),
                format!("{prefix}SELECT * FROM (select @@server_id) t ORDER BY `@@server_id` ASC;")
            );
        }
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
            tie_breaker_column_indexes: Vec::new(),
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
            tie_breaker_column_indexes: Vec::new(),
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
            tie_breaker_column_indexes: Vec::new(),
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
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT id, name FROM users) t([id], [name]) ORDER BY [name] ASC;"
        );
    }

    // 词法扫描漏检的结尾 ORDER BY 无法从排序包装里剥离，直接拒绝而不是生成非法 SQL。
    #[test]
    fn sqlserver_sort_rejects_lexically_hidden_order_by() {
        for original in ["SELECT * FROM t WHERE p = 'C:\\' ORDER BY id", "SELECT id FROM #t ORDER BY id"] {
            let result = build_sorted_query_sql(SortedQuerySqlOptions {
                original_sql: original.to_string(),
                database_type: Some(DatabaseType::SqlServer),
                result_columns: vec!["id".to_string()],
                column_index: 0,
                column: "id".to_string(),
                direction: QuerySortDirection::Asc,
                tie_breaker_column_indexes: Vec::new(),
            });

            assert!(!result.ok, "must refuse the unsafe wrap: {original}");
            assert_eq!(result.reason.as_deref(), Some("unsupported"), "{original}");
        }
    }

    #[test]
    fn sqlserver_sort_wraps_top_with_lexically_hidden_order_by() {
        // T-SQL 允许派生表在带 TOP / OFFSET-FETCH 时保留 ORDER BY（Msg 1033 豁免），
        // 排序包装应照常生成而不是拒绝。
        for original in [
            "SELECT TOP (100) * FROM #Orders ORDER BY id",
            "SELECT * FROM #Orders ORDER BY id OFFSET 10 ROWS FETCH NEXT 20 ROWS ONLY",
        ] {
            let result = build_sorted_query_sql(SortedQuerySqlOptions {
                original_sql: original.to_string(),
                database_type: Some(DatabaseType::SqlServer),
                result_columns: vec!["id".to_string()],
                column_index: 0,
                column: "id".to_string(),
                direction: QuerySortDirection::Asc,
                tie_breaker_column_indexes: Vec::new(),
            });

            assert!(result.ok, "must keep the wrap legal: {original}");
            let sql = result.sql.unwrap();
            assert!(sql.contains("ORDER BY"), "{original} -> {sql}");
        }
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
            tie_breaker_column_indexes: Vec::new(),
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
            tie_breaker_column_indexes: Vec::new(),
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
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(result.sql.unwrap(), "SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id ORDER BY 1 ASC;");
    }

    #[test]
    fn oracle_sort_with_duplicate_labels_does_not_wrap_the_query() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "select c1, t.* from dbx_eval_t t order by c1".to_string(),
            database_type: Some(DatabaseType::Oracle),
            result_columns: vec!["C1".to_string(), "C1".to_string(), "C2".to_string()],
            column_index: 2,
            column: "C2".to_string(),
            direction: QuerySortDirection::Desc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(result.sql.unwrap(), "select c1, t.* from dbx_eval_t t ORDER BY 3 DESC;");
    }

    #[test]
    fn oracle_sort_with_duplicate_labels_rejects_row_limiting_clause() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT c1, t.* FROM dbx_eval_t t FETCH FIRST 10 ROWS ONLY".to_string(),
            database_type: Some(DatabaseType::Oracle),
            result_columns: vec!["C1".to_string(), "C1".to_string(), "C2".to_string()],
            column_index: 0,
            column: "C1".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert!(!result.ok);
        assert_eq!(result.reason.as_deref(), Some("unsupported"));
    }

    #[test]
    fn oracle_sort_with_case_distinct_quoted_labels_keeps_the_derived_table() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT id AS \"x\", id AS \"X\" FROM t WHERE ROWNUM <= 10".to_string(),
            database_type: Some(DatabaseType::Oracle),
            result_columns: vec!["x".to_string(), "X".to_string()],
            column_index: 1,
            column: "X".to_string(),
            direction: QuerySortDirection::Desc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT id AS \"x\", id AS \"X\" FROM t WHERE ROWNUM <= 10) t ORDER BY \"X\" DESC;"
        );
    }

    #[test]
    fn oracle_sort_without_duplicate_labels_keeps_the_derived_table() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT * FROM dbx_eval_t".to_string(),
            database_type: Some(DatabaseType::Oracle),
            result_columns: vec!["C1".to_string(), "C2".to_string()],
            column_index: 1,
            column: "C2".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT * FROM dbx_eval_t) t ORDER BY \"C2\" ASC;");
    }

    #[test]
    fn mysql_sort_with_duplicate_labels_does_not_wrap_the_query() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "/*+ MAX_EXECUTION_TIME(1000) */ SELECT t.id, t.* FROM dbx_eval_t t ORDER BY t.id;"
                .to_string(),
            database_type: Some(DatabaseType::Mysql),
            result_columns: vec!["id".to_string(), "id".to_string(), "name".to_string(), "qty".to_string()],
            column_index: 2,
            column: "name".to_string(),
            direction: QuerySortDirection::Desc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(
            result.sql.unwrap(),
            "/*+ MAX_EXECUTION_TIME(1000) */ SELECT t.id, t.* FROM dbx_eval_t t ORDER BY 3 DESC;"
        );
    }

    #[test]
    fn mysql_sort_treats_labels_differing_only_in_case_as_duplicates() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT a.ID, b.id FROM a JOIN b ON b.a_id = a.id".to_string(),
            database_type: Some(DatabaseType::Mysql),
            result_columns: vec!["ID".to_string(), "id".to_string()],
            column_index: 1,
            column: "id".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(result.sql.unwrap(), "SELECT a.ID, b.id FROM a JOIN b ON b.a_id = a.id ORDER BY 2 ASC;");
    }

    #[test]
    fn mysql_sort_with_duplicate_labels_rejects_limit() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT t.id, t.* FROM dbx_eval_t t LIMIT 500".to_string(),
            database_type: Some(DatabaseType::Mysql),
            result_columns: vec!["id".to_string(), "id".to_string(), "name".to_string()],
            column_index: 2,
            column: "name".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert!(!result.ok);
        assert_eq!(result.reason.as_deref(), Some("unsupported"));
    }

    #[test]
    fn goldendb_sort_with_duplicate_labels_does_not_wrap_the_query() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "/*+ MAX_EXECUTION_TIME(1000) */ SELECT t.id, t.* FROM dbx_eval_t t ORDER BY t.id;"
                .to_string(),
            database_type: Some(DatabaseType::Goldendb),
            result_columns: vec!["id".to_string(), "id".to_string(), "name".to_string(), "qty".to_string()],
            column_index: 2,
            column: "name".to_string(),
            direction: QuerySortDirection::Desc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(
            result.sql.unwrap(),
            "/*+ MAX_EXECUTION_TIME(1000) */ SELECT t.id, t.* FROM dbx_eval_t t ORDER BY 3 DESC;"
        );
    }

    #[test]
    fn goldendb_sort_treats_labels_differing_only_in_case_as_duplicates() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT a.ID, b.id FROM a JOIN b ON b.a_id = a.id".to_string(),
            database_type: Some(DatabaseType::Goldendb),
            result_columns: vec!["ID".to_string(), "id".to_string()],
            column_index: 1,
            column: "id".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(result.sql.unwrap(), "SELECT a.ID, b.id FROM a JOIN b ON b.a_id = a.id ORDER BY 2 ASC;");
    }

    #[test]
    fn goldendb_sort_without_duplicate_labels_wraps_in_derived_table_without_column_aliases() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT id, name FROM users".to_string(),
            database_type: Some(DatabaseType::Goldendb),
            result_columns: vec!["id".to_string(), "name".to_string()],
            column_index: 1,
            column: "name".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT id, name FROM users) t ORDER BY `name` ASC;");
    }

    #[test]
    fn builds_saphana_sorted_query_by_ordinal_for_duplicate_columns() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id".to_string(),
            database_type: Some(DatabaseType::SapHana),
            result_columns: vec!["ID".to_string(), "ID".to_string()],
            column_index: 1,
            column: "ID".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id) t ORDER BY 2 ASC;"
        );
    }

    #[test]
    fn postgres_sort_keeps_hidden_primary_key_alias() {
        let result = build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: "SELECT name, score, \"id\" AS \"__DBX_PK_0\" FROM t1".to_string(),
            database_type: Some(DatabaseType::Postgres),
            result_columns: vec!["name".to_string(), "score".to_string(), "__DBX_PK_0".to_string()],
            column_index: 1,
            column: "score".to_string(),
            direction: QuerySortDirection::Asc,
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(
            result.sql.unwrap(),
            "SELECT * FROM (SELECT name, score, \"id\" AS \"__DBX_PK_0\" FROM t1) t(\"name\", \"score\", \"__DBX_PK_0\") ORDER BY \"score\" ASC;"
        );
    }

    #[test]
    fn derived_column_aliases_keep_underscores_of_safe_names() {
        assert_eq!(
            build_derived_column_aliases(&["_id".to_string(), "count(*)".to_string(), "total_".to_string()]),
            vec!["_id".to_string(), "count".to_string(), "total_".to_string()]
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
            tie_breaker_column_indexes: Vec::new(),
        });

        assert_eq!(result.sql.unwrap(), "SELECT * FROM (SELECT id, name FROM users) t(id, name) ORDER BY id ASC;");
    }

    fn sorted_cte_sql(
        original_sql: &str,
        database_type: Option<DatabaseType>,
        result_columns: &[&str],
        column_index: usize,
        direction: QuerySortDirection,
        tie_breaker_column_indexes: Vec<usize>,
    ) -> QuerySqlBuildResult {
        build_sorted_query_sql(SortedQuerySqlOptions {
            original_sql: original_sql.to_string(),
            database_type,
            result_columns: result_columns.iter().map(|column| column.to_string()).collect(),
            column_index,
            column: result_columns.get(column_index).map(|column| column.to_string()).unwrap_or_default(),
            direction,
            tie_breaker_column_indexes,
        })
    }

    #[test]
    fn sorts_with_query_by_appending_order_by_to_main_query() {
        for database_type in [
            None,
            Some(DatabaseType::Postgres),
            Some(DatabaseType::Mysql),
            Some(DatabaseType::SqlServer),
            Some(DatabaseType::Oracle),
            Some(DatabaseType::Dameng),
            Some(DatabaseType::Sqlite),
            Some(DatabaseType::ClickHouse),
            Some(DatabaseType::Hive),
        ] {
            let result = sorted_cte_sql(
                "WITH t AS (SELECT a, b, c FROM src) SELECT a, b, sum(c) AS total FROM t GROUP BY a, b",
                database_type,
                &["a", "b", "total"],
                2,
                QuerySortDirection::Desc,
                Vec::new(),
            );

            assert_eq!(
                result,
                ok("WITH t AS (SELECT a, b, c FROM src) SELECT a, b, sum(c) AS total FROM t GROUP BY a, b ORDER BY 3 DESC;"
                    .to_string()),
                "{database_type:?}"
            );
        }
    }

    #[test]
    fn sorts_with_query_by_replacing_its_trailing_order_by() {
        let result = sorted_cte_sql(
            "WITH cte AS (SELECT id, name FROM users) SELECT id, name FROM cte ORDER BY id DESC;",
            Some(DatabaseType::Postgres),
            &["id", "name"],
            1,
            QuerySortDirection::Asc,
            vec![0],
        );

        assert_eq!(
            result,
            ok("WITH cte AS (SELECT id, name FROM users) SELECT id, name FROM cte ORDER BY 2 ASC, 1 ASC;".to_string())
        );
    }

    #[test]
    fn sorts_with_query_keeping_order_by_inside_the_cte() {
        let result = sorted_cte_sql(
            "WITH top_users AS (SELECT TOP 5 id, name FROM users ORDER BY id) SELECT id, name FROM top_users",
            Some(DatabaseType::SqlServer),
            &["id", "name"],
            1,
            QuerySortDirection::Desc,
            Vec::new(),
        );

        assert_eq!(
            result,
            ok("WITH top_users AS (SELECT TOP 5 id, name FROM users ORDER BY id) SELECT id, name FROM top_users ORDER BY 2 DESC;"
                .to_string())
        );
    }

    #[test]
    fn sorts_recursive_with_query() {
        for database_type in [Some(DatabaseType::Postgres), Some(DatabaseType::Mysql), Some(DatabaseType::Sqlite)] {
            let result = sorted_cte_sql(
                "WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 5) SELECT n FROM nums",
                database_type,
                &["n"],
                0,
                QuerySortDirection::Desc,
                Vec::new(),
            );

            assert_eq!(
                result,
                ok("WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM nums WHERE n < 5) SELECT n FROM nums ORDER BY 1 DESC;"
                    .to_string()),
                "{database_type:?}"
            );
        }
    }

    #[test]
    fn sorts_with_query_whose_main_query_is_a_union() {
        let result = sorted_cte_sql(
            "WITH a AS (SELECT 1 AS id), b AS (SELECT 2 AS id) SELECT id FROM a UNION ALL SELECT id FROM b",
            Some(DatabaseType::Postgres),
            &["id"],
            0,
            QuerySortDirection::Desc,
            Vec::new(),
        );

        assert_eq!(
            result,
            ok("WITH a AS (SELECT 1 AS id), b AS (SELECT 2 AS id) SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY 1 DESC;"
                .to_string())
        );
    }

    #[test]
    fn sorts_with_query_with_limit_by_wrapping_the_whole_statement() {
        // A CTE whose main query ends in a row limit cannot take an appended
        // ORDER BY (`... LIMIT 10 ORDER BY` is a syntax error), so engines that
        // accept WITH inside a derived table wrap the whole statement and sort
        // the limited result set (#13639).
        let result = sorted_cte_sql(
            "with tmp_fr as (select 1 as a) select a from tmp_fr limit 10",
            Some(DatabaseType::Postgres),
            &["a"],
            0,
            QuerySortDirection::Asc,
            Vec::new(),
        );

        assert_eq!(
            result,
            ok("SELECT * FROM (with tmp_fr as (select 1 as a) select a from tmp_fr limit 10) t(\"a\") ORDER BY \"a\" ASC;"
                .to_string())
        );
    }

    #[test]
    fn sorts_with_query_with_fetch_or_lock_by_wrapping_on_capable_engines() {
        let result = sorted_cte_sql(
            "WITH cte AS (SELECT 1 AS id) SELECT id FROM cte FETCH FIRST 10 ROWS ONLY",
            Some(DatabaseType::Postgres),
            &["id"],
            0,
            QuerySortDirection::Desc,
            Vec::new(),
        );
        assert_eq!(
            result,
            ok("SELECT * FROM (WITH cte AS (SELECT 1 AS id) SELECT id FROM cte FETCH FIRST 10 ROWS ONLY) t(\"id\") ORDER BY \"id\" DESC;"
                .to_string())
        );

        // A locking clause rides along into the wrapper: the lock applies to
        // the inner query and the outer sort keeps the limited rows (#13639).
        let result = sorted_cte_sql(
            "WITH cte AS (SELECT 1 AS id) SELECT id FROM cte LIMIT 5 FOR UPDATE",
            Some(DatabaseType::Postgres),
            &["id"],
            0,
            QuerySortDirection::Asc,
            Vec::new(),
        );
        assert_eq!(
            result,
            ok("SELECT * FROM (WITH cte AS (SELECT 1 AS id) SELECT id FROM cte LIMIT 5 FOR UPDATE) t(\"id\") ORDER BY \"id\" ASC;"
                .to_string())
        );
    }

    #[test]
    fn derived_table_cte_exclusions_track_the_count_path_special_cases() {
        // The count path already hoists the CTE out for Hive (#8535) and wraps
        // Db2 specially because both engines reject `WITH` inside a derived
        // table; the sort wrapper must not feed them that shape.
        for database_type in [DatabaseType::Hive, DatabaseType::Argo, DatabaseType::Impala, DatabaseType::Db2] {
            assert!(
                !derived_table_allows_cte(Some(database_type)),
                "{database_type:?} must stay excluded from CTE-in-derived-table sorting"
            );
        }
        for database_type in [DatabaseType::Postgres, DatabaseType::Mysql, DatabaseType::Sqlite] {
            assert!(derived_table_allows_cte(Some(database_type)));
        }
    }

    #[test]
    fn rejects_with_query_sorting_for_cte_rejecting_engines() {
        // Hive rejects WITH inside subquery blocks outright and Db2's
        // fullselect grammar has no nested WITH (SQL0199N), so a row-limited
        // CTE stays unsupported there instead of producing a server error.
        for (original_sql, database_type) in [
            ("WITH cte AS (SELECT 1 AS id) SELECT id FROM cte LIMIT 10", DatabaseType::Hive),
            ("WITH cte AS (SELECT 1 AS id) SELECT id FROM cte FETCH FIRST 10 ROWS ONLY", DatabaseType::Db2),
        ] {
            let result =
                sorted_cte_sql(original_sql, Some(database_type), &["id"], 0, QuerySortDirection::Asc, Vec::new());
            assert_eq!(result, err("unsupported"), "unexpected sort result for {database_type:?}");
        }
    }

    #[test]
    fn sorts_with_query_with_limit_by_wrapping_for_mysql() {
        let result = sorted_cte_sql(
            "with tmp as (select 1 as a) select a from tmp limit 10",
            Some(DatabaseType::Mysql),
            &["a"],
            0,
            QuerySortDirection::Asc,
            Vec::new(),
        );

        assert_eq!(
            result,
            ok("SELECT * FROM (with tmp as (select 1 as a) select a from tmp limit 10) t ORDER BY `a` ASC;"
                .to_string())
        );
    }

    #[test]
    fn rejects_with_query_sorting_when_order_by_cannot_be_appended() {
        for (original_sql, database_type, reason) in [
            // Engines that reject WITH inside a derived table have no wrapper
            // fallback, so a row-limited CTE main query stays unsupported.
            ("WITH cte AS (SELECT 1 AS id) SELECT id FROM cte LIMIT 10", Some(DatabaseType::Oracle), "unsupported"),
            (
                "WITH cte AS (SELECT 1 AS id) SELECT id FROM cte FETCH FIRST 10 ROWS ONLY",
                Some(DatabaseType::Oracle),
                "unsupported",
            ),
            ("WITH cte AS (SELECT 1 AS id) SELECT TOP 10 id FROM cte", Some(DatabaseType::SqlServer), "unsupported"),
            (
                "WITH cte AS (SELECT 1 AS id) SELECT id FROM cte FOR UPDATE",
                Some(DatabaseType::SqlServer),
                "unsupported",
            ),
            ("WITH cte AS (SELECT 1 AS id) SELECT id INTO #ids FROM cte", Some(DatabaseType::SqlServer), "with"),
            (
                "WITH cte AS (SELECT 1 AS id) DELETE FROM users WHERE id IN (SELECT id FROM cte)",
                Some(DatabaseType::Postgres),
                "with",
            ),
        ] {
            let result = sorted_cte_sql(original_sql, database_type, &["id"], 0, QuerySortDirection::Asc, Vec::new());

            assert_eq!(result, err(reason), "{original_sql:?}");
        }
    }

    // -----------------------------------------------------------------------
    // Dedup query ORDER BY injection (DISTINCT / GROUP BY)
    // -----------------------------------------------------------------------

    #[test]
    fn dedup_count_detects_distinct_query_without_order_by() {
        assert_eq!(dedup_projection_count_without_order_by("SELECT DISTINCT a, b, c FROM t"), Some(vec![1, 2, 3]));
    }

    #[test]
    fn dedup_count_detects_group_by_query() {
        assert_eq!(
            dedup_projection_count_without_order_by("SELECT city, COUNT(*) FROM users GROUP BY city"),
            Some(vec![1])
        );
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
        assert_eq!(result.sql.unwrap(), "SELECT dept, SUM(salary) FROM employees GROUP BY dept ORDER BY 1 LIMIT 50;");
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
        assert_eq!(
            dedup_projection_count_without_order_by("SELECT DISTINCT a AS x, b AS y, c AS z FROM t"),
            Some(vec![1, 2, 3])
        );
    }

    #[test]
    fn dedup_count_handles_expressions() {
        assert_eq!(
            dedup_projection_count_without_order_by(
                "SELECT DISTINCT a + b AS sum_col, CASE WHEN c > 0 THEN 'Y' ELSE 'N' END AS flag FROM t"
            ),
            Some(vec![1, 2])
        );
    }

    #[test]
    fn dedup_count_handles_aggregate_with_alias() {
        assert_eq!(
            dedup_projection_count_without_order_by(
                "SELECT city, COUNT(*) AS cnt, AVG(salary) AS avg_sal FROM users GROUP BY city"
            ),
            Some(vec![1])
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
            "SELECT dept, SUM(salary) AS total, COUNT(*) AS head_count FROM emp GROUP BY dept ORDER BY 1 LIMIT 50 OFFSET 100;"
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
    fn group_by_order_by_skips_clickhouse_aggregate_states() {
        let result = build_paginated_query_sql(PaginatedQuerySqlOptions {
            original_sql:
                "SELECT city, dept, argMaxState(name, hired_at) AS latest_hire, sumState(salary) AS payroll FROM employees GROUP BY city, dept"
                    .to_string(),
            database_type: Some(DatabaseType::ClickHouse),
            limit: 100,
            offset: 0,
        });

        assert!(result.ok);
        assert_eq!(
            result.sql.unwrap(),
            "SELECT city, dept, argMaxState(name, hired_at) AS latest_hire, sumState(salary) AS payroll FROM employees GROUP BY city, dept ORDER BY 1, 2 LIMIT 100;"
        );
    }

    #[test]
    fn group_by_order_by_matches_key_by_output_alias() {
        assert_eq!(
            dedup_projection_count_without_order_by(
                "SELECT SUM(salary) AS total, dept AS team FROM employees GROUP BY team"
            ),
            Some(vec![2])
        );
    }

    #[test]
    fn group_by_order_by_accepts_positional_keys() {
        assert_eq!(
            dedup_projection_count_without_order_by("SELECT city, dept, COUNT(*) FROM employees GROUP BY 1, 2"),
            Some(vec![1, 2])
        );
    }

    #[test]
    fn group_by_order_by_falls_back_when_key_is_not_projected() {
        assert_eq!(
            dedup_projection_count_without_order_by(
                "SELECT COUNT(*) AS cnt, SUM(salary) AS total FROM employees GROUP BY city"
            ),
            Some(vec![1, 2])
        );
    }

    #[test]
    fn group_by_order_by_falls_back_for_wildcard_projection() {
        assert_eq!(
            dedup_projection_count_without_order_by("SELECT e.*, COUNT(*) FROM employees e GROUP BY city"),
            Some(vec![1, 2])
        );
    }

    #[test]
    fn union_query_is_not_treated_as_dedup() {
        assert_eq!(dedup_projection_count_without_order_by("SELECT a FROM t1 UNION SELECT b FROM t2"), None);
    }

    #[test]
    fn gaussdb_execution_hint_flows_into_count_and_page_sql() {
        let gaussdb = |sql: &str, limit: usize, offset: usize| {
            build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
                sql: sql.into(),
                query_base_sql: sql.into(),
                database_type: Some(DatabaseType::Gaussdb),
                pagination: QueryPagination { limit, offset, session_id: None },
                use_agent_cursor: false,
                first_page_uses_actual_sql: true,
                execution_hint: Some("/*+ set(query_dop 8) */".to_string()),
            })
        };

        // Plain statement: the hint lands after the outer SELECT of page and count SQL.
        let plan = gaussdb("SELECT id FROM users WHERE active = 1", 20, 0);
        assert_eq!(plan.sql_to_execute, "SELECT /*+ set(query_dop 8) */ id FROM users WHERE active = 1 LIMIT 20;");
        assert_eq!(
            plan.page_sql.as_deref(),
            Some("SELECT /*+ set(query_dop 8) */ id FROM users WHERE active = 1 LIMIT 20;")
        );
        assert_eq!(
            plan.count_sql.as_deref(),
            Some(
                "SELECT /*+ set(query_dop 8) */ COUNT(*) AS dbx_total_rows FROM (SELECT id FROM users WHERE active = 1) dbx_count;"
            )
        );

        // A user-written LIMIT forces the `dbx_page` wrapper; the hint stays on the outer SELECT.
        let plan = gaussdb("SELECT id FROM users WHERE active = 1 LIMIT 1000", 20, 20);
        assert_eq!(
            plan.sql_to_execute,
            "SELECT /*+ set(query_dop 8) */ * FROM (SELECT id FROM users WHERE active = 1 LIMIT 1000) dbx_page LIMIT 20 OFFSET 20;"
        );

        // CTEs keep the hint on the main projection, not inside the CTE body.
        let plan = gaussdb("WITH recent AS (SELECT id FROM users) SELECT * FROM recent", 10, 0);
        assert_eq!(
            plan.sql_to_execute,
            "WITH recent AS (SELECT id FROM users) SELECT /*+ set(query_dop 8) */ * FROM recent LIMIT 10;"
        );
        assert_eq!(
            plan.count_sql.as_deref(),
            Some(
                "SELECT /*+ set(query_dop 8) */ COUNT(*) AS dbx_total_rows FROM (WITH recent AS (SELECT id FROM users) SELECT * FROM recent) dbx_count;"
            )
        );
    }

    #[test]
    fn gaussdb_execution_hint_is_skipped_without_setting_or_on_other_dialects() {
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT id FROM users".to_string(),
            query_base_sql: "SELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Gaussdb),
            pagination: QueryPagination { limit: 20, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: true,
            execution_hint: None,
        });
        assert_eq!(plan.sql_to_execute, "SELECT id FROM users LIMIT 20;");
        assert!(plan.page_sql.as_deref().is_some_and(|sql| !sql.contains("query_dop")));
        assert!(plan.count_sql.as_deref().is_some_and(|sql| !sql.contains("query_dop")));

        // MySQL keeps its own derived-table quoting; with no hint the SQL is unchanged.
        let plan = build_query_pagination_execution_plan(QueryPaginationExecutionPlanOptions {
            sql: "SELECT id FROM users".to_string(),
            query_base_sql: "SELECT id FROM users".to_string(),
            database_type: Some(DatabaseType::Mysql),
            pagination: QueryPagination { limit: 20, offset: 0, session_id: None },
            use_agent_cursor: false,
            first_page_uses_actual_sql: true,
            execution_hint: None,
        });
        assert_eq!(plan.sql_to_execute, "SELECT id FROM users LIMIT 20;");
        assert_eq!(
            plan.count_sql.as_deref(),
            Some("SELECT COUNT(*) AS dbx_total_rows FROM (SELECT id FROM users) `dbx_count`;")
        );
    }
}
