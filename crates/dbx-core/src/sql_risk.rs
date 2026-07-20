use std::ops::ControlFlow;

use serde::{Deserialize, Serialize};
use sqlparser::ast::{
    visit_expressions, BinaryOperator, Expr, FromTable, OnConflictAction, OnInsert, Query, SetExpr, SqliteOnConflict,
    Statement, UnaryOperator, Value,
};
use sqlparser::dialect::{
    ClickHouseDialect, DuckDbDialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect,
};
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Token, Tokenizer};

use crate::models::connection::DatabaseType;

/// SQL risk level for agent tool safety classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SqlRisk {
    /// SELECT, SHOW, DESCRIBE, EXPLAIN, WITH (pure read CTE)
    ReadOnly,
    /// INSERT, UPDATE, DELETE, MERGE, REPLACE, CALL/EXEC
    Write,
    /// CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE
    Ddl,
    /// BEGIN, COMMIT, ROLLBACK should not be issued by agent
    Transaction,
}

impl std::fmt::Display for SqlRisk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SqlRisk::ReadOnly => write!(f, "read-only"),
            SqlRisk::Write => write!(f, "write"),
            SqlRisk::Ddl => write!(f, "DDL"),
            SqlRisk::Transaction => write!(f, "transaction"),
        }
    }
}

/// Normalize database dialect string to a canonical form for sqlparser.
/// Mirrors the logic in `sql_analysis::normalize_dialect`.
fn normalize_dialect(dialect: &str) -> &'static str {
    match dialect.to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" | "redshift" | "opengauss" | "gaussdb" | "kingbase" | "highgo" | "vastbase"
        | "kwdb" => "postgres",
        "mysql" | "mariadb" | "doris" | "starrocks" | "manticoresearch" | "oceanbase" => "mysql",
        "sqlite" => "sqlite",
        "sqlserver" | "mssql" => "sqlserver",
        "clickhouse" => "clickhouse",
        "duckdb" => "duckdb",
        _ => "generic",
    }
}

/// Resolve dialect string to a sqlparser Dialect trait object.
fn resolve_dialect(dialect: &str) -> Box<dyn sqlparser::dialect::Dialect> {
    match dialect {
        "postgres" => Box::new(PostgreSqlDialect {}),
        "mysql" => Box::new(MySqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        "sqlserver" => Box::new(MsSqlDialect {}),
        "clickhouse" => Box::new(ClickHouseDialect {}),
        "duckdb" => Box::new(DuckDbDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

/// Classify a single SQL statement into a risk level using AST analysis.
fn classify_statement(stmt: &Statement, detect_select_into: bool) -> SqlRisk {
    match stmt {
        // Pure reads
        Statement::Query(query) => {
            if query_is_write_capable(query, detect_select_into) {
                SqlRisk::Write
            } else {
                SqlRisk::ReadOnly
            }
        }
        Statement::Explain { analyze, statement, .. } => {
            if *analyze {
                classify_statement(statement, detect_select_into)
            } else {
                SqlRisk::ReadOnly
            }
        }
        Statement::ExplainTable { .. } => SqlRisk::ReadOnly,

        // Show/Describe variants
        Statement::ShowTables { .. }
        | Statement::ShowColumns { .. }
        | Statement::ShowDatabases { .. }
        | Statement::ShowSchemas { .. }
        | Statement::ShowCreate { .. }
        | Statement::ShowVariables { .. }
        | Statement::ShowStatus { .. }
        | Statement::ShowProcessList { .. } => SqlRisk::ReadOnly,

        // Write operations
        Statement::Insert { .. } | Statement::Update { .. } | Statement::Delete { .. } | Statement::Merge { .. } => {
            SqlRisk::Write
        }

        // DDL operations
        Statement::CreateTable { .. }
        | Statement::CreateView { .. }
        | Statement::CreateIndex { .. }
        | Statement::CreateSchema { .. }
        | Statement::CreateSequence { .. }
        | Statement::CreateRole { .. }
        | Statement::CreateType { .. }
        | Statement::AlterTable { .. }
        | Statement::AlterIndex { .. }
        | Statement::AlterView { .. }
        | Statement::Drop { .. }
        | Statement::Truncate { .. } => SqlRisk::Ddl,

        // Grant/Revoke
        Statement::Grant { .. } | Statement::Revoke { .. } => SqlRisk::Ddl,

        // Transaction control
        Statement::StartTransaction { .. } | Statement::Commit { .. } | Statement::Rollback { .. } => {
            SqlRisk::Transaction
        }

        // COPY FROM mutates data; keep COPY conservative because sqlparser does
        // not expose enough dialect-specific direction detail here.
        Statement::Copy { .. } => SqlRisk::Write,

        // SQLite/DuckDB PRAGMA statements can mutate database/session state.
        Statement::Pragma { .. } => SqlRisk::Write,

        // Catch-all: conservative write classification
        _ => SqlRisk::Write,
    }
}

fn statement_is_dangerous(stmt: &Statement, detect_select_into: bool) -> bool {
    match stmt {
        Statement::Query(query) => query_is_dangerous(query, detect_select_into),
        Statement::Insert(insert) => {
            insert.replace_into
                || insert.overwrite
                || matches!(insert.or, Some(SqliteOnConflict::Replace))
                || insert.on.as_ref().is_some_and(|on| match on {
                    OnInsert::DuplicateKeyUpdate(_) => true,
                    OnInsert::OnConflict(conflict) => matches!(conflict.action, OnConflictAction::DoUpdate(_)),
                    _ => true,
                })
                || insert.source.as_ref().is_some_and(|query| !matches!(query.body.as_ref(), SetExpr::Values(_)))
        }
        Statement::Update(update) => {
            !update.table.joins.is_empty()
                || update.from.is_some()
                || matches!(update.or, Some(SqliteOnConflict::Replace))
                || update.selection.as_ref().is_none_or(predicate_is_obviously_unbounded)
        }
        Statement::Delete(delete) => {
            let from = match &delete.from {
                FromTable::WithFromKeyword(from) | FromTable::WithoutKeyword(from) => from,
            };
            !delete.tables.is_empty()
                || delete.using.is_some()
                || from.len() != 1
                || from.first().is_none_or(|table| !table.joins.is_empty())
                || delete.selection.as_ref().is_none_or(predicate_is_obviously_unbounded)
        }
        Statement::Merge { .. } => true,
        Statement::Explain { analyze: true, statement, .. } => statement_is_dangerous(statement, detect_select_into),
        _ => !matches!(classify_statement(stmt, detect_select_into), SqlRisk::ReadOnly),
    }
}

fn predicate_is_obviously_unbounded(expr: &Expr) -> bool {
    if expr_contains_subquery(expr) {
        return true;
    }
    if !expr_contains_column_reference(expr) {
        return true;
    }

    match expr {
        Expr::Nested(expr) => predicate_is_obviously_unbounded(expr),
        Expr::Value(value) => value_is_truthy(&value.value),
        Expr::UnaryOp { op: UnaryOperator::Not, expr } => predicate_is_obviously_false(expr),
        Expr::BinaryOp { left, op: BinaryOperator::And, right } => {
            predicate_is_obviously_unbounded(left) && predicate_is_obviously_unbounded(right)
        }
        Expr::BinaryOp { left, op: BinaryOperator::Or, right } => {
            or_contains_conjunctive_branch(expr)
                || or_contains_complementary_null_checks(expr)
                || or_contains_complementary_comparisons(expr)
                || or_contains_complementary_in_lists(expr)
                || or_contains_complementary_between_checks(expr)
                || predicate_is_obviously_unbounded(left)
                || predicate_is_obviously_unbounded(right)
        }
        Expr::BinaryOp { left, op, right } if is_comparison_operator(op) => constant_comparison_truth(left, op, right)
            .unwrap_or_else(|| {
                left == right
                    && matches!(
                        op,
                        BinaryOperator::Eq | BinaryOperator::GtEq | BinaryOperator::LtEq | BinaryOperator::Spaceship
                    )
            }),
        Expr::IsNotDistinctFrom(left, right) => strip_nested_expr(left) == strip_nested_expr(right),
        Expr::IsTrue(expr) | Expr::IsNotFalse(expr) => predicate_is_obviously_unbounded(expr),
        Expr::Like { negated: false, any: false, expr, pattern, escape_char: None }
        | Expr::ILike { negated: false, any: false, expr, pattern, escape_char: None } => {
            expr_contains_column_reference(expr) && like_pattern_matches_all(pattern)
        }
        _ => false,
    }
}

fn or_contains_conjunctive_branch(expr: &Expr) -> bool {
    match strip_nested_expr(expr) {
        Expr::BinaryOp { left, op: BinaryOperator::Or, right } => {
            or_contains_conjunctive_branch(left) || or_contains_conjunctive_branch(right)
        }
        Expr::BinaryOp { op: BinaryOperator::And, .. } => true,
        _ => false,
    }
}

fn expr_contains_column_reference(expr: &Expr) -> bool {
    visit_expressions(expr, |expr| {
        let is_column = match expr {
            Expr::Identifier(identifier) => !is_sql_value_keyword(&identifier.value),
            Expr::CompoundIdentifier(_) => true,
            _ => false,
        };
        if is_column {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })
    .is_break()
}

fn is_sql_value_keyword(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "current_catalog"
            | "current_date"
            | "current_role"
            | "current_schema"
            | "current_time"
            | "current_timestamp"
            | "current_user"
            | "localtime"
            | "localtimestamp"
            | "session_user"
            | "system_user"
            | "user"
    )
}

fn expr_contains_subquery(expr: &Expr) -> bool {
    visit_expressions(expr, |expr| {
        if matches!(expr, Expr::InSubquery { .. } | Expr::Exists { .. } | Expr::Subquery(_)) {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })
    .is_break()
}

fn or_contains_complementary_null_checks(expr: &Expr) -> bool {
    let mut checks = Vec::new();
    collect_or_null_checks(expr, &mut checks);
    checks.iter().enumerate().any(|(index, (candidate, negated))| {
        checks[index + 1..].iter().any(|(other, other_negated)| candidate == other && negated != other_negated)
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PredicateComparisonOperator {
    Eq,
    NotEq,
    Gt,
    GtEq,
    Lt,
    LtEq,
}

struct PredicateComparisonCheck<'a> {
    left: &'a Expr,
    right: &'a Expr,
    operator: PredicateComparisonOperator,
}

fn or_contains_complementary_comparisons(expr: &Expr) -> bool {
    let mut checks = Vec::new();
    collect_or_comparison_checks(expr, &mut checks);
    checks.iter().enumerate().any(|(index, candidate)| {
        checks[index + 1..].iter().any(|other| {
            candidate.left == other.left
                && candidate.right == other.right
                && comparison_operators_are_complementary(candidate.operator, other.operator)
        })
    })
}

fn collect_or_comparison_checks<'a>(expr: &'a Expr, checks: &mut Vec<PredicateComparisonCheck<'a>>) {
    let expr = strip_nested_expr(expr);
    if let Expr::BinaryOp { left, op: BinaryOperator::Or, right } = expr {
        collect_or_comparison_checks(left, checks);
        collect_or_comparison_checks(right, checks);
    } else if let Some(check) = comparison_check(expr, false) {
        checks.push(check);
    }
}

fn comparison_check(expr: &Expr, outer_negated: bool) -> Option<PredicateComparisonCheck<'_>> {
    let expr = strip_nested_expr(expr);
    if let Expr::UnaryOp { op: UnaryOperator::Not, expr } = expr {
        return comparison_check(expr, !outer_negated);
    }
    let Expr::BinaryOp { left, op, right } = expr else {
        return None;
    };
    if !expr_contains_column_reference(expr) {
        return None;
    }

    let mut operator = predicate_comparison_operator(op)?;
    if outer_negated {
        operator = complementary_comparison_operator(operator);
    }
    let (left, right) = (strip_nested_expr(left), strip_nested_expr(right));
    if left <= right {
        Some(PredicateComparisonCheck { left, right, operator })
    } else {
        Some(PredicateComparisonCheck { left: right, right: left, operator: reverse_comparison_operator(operator) })
    }
}

fn predicate_comparison_operator(operator: &BinaryOperator) -> Option<PredicateComparisonOperator> {
    match operator {
        BinaryOperator::Eq | BinaryOperator::Spaceship => Some(PredicateComparisonOperator::Eq),
        BinaryOperator::NotEq => Some(PredicateComparisonOperator::NotEq),
        BinaryOperator::Gt => Some(PredicateComparisonOperator::Gt),
        BinaryOperator::GtEq => Some(PredicateComparisonOperator::GtEq),
        BinaryOperator::Lt => Some(PredicateComparisonOperator::Lt),
        BinaryOperator::LtEq => Some(PredicateComparisonOperator::LtEq),
        _ => None,
    }
}

fn complementary_comparison_operator(operator: PredicateComparisonOperator) -> PredicateComparisonOperator {
    match operator {
        PredicateComparisonOperator::Eq => PredicateComparisonOperator::NotEq,
        PredicateComparisonOperator::NotEq => PredicateComparisonOperator::Eq,
        PredicateComparisonOperator::Gt => PredicateComparisonOperator::LtEq,
        PredicateComparisonOperator::GtEq => PredicateComparisonOperator::Lt,
        PredicateComparisonOperator::Lt => PredicateComparisonOperator::GtEq,
        PredicateComparisonOperator::LtEq => PredicateComparisonOperator::Gt,
    }
}

fn reverse_comparison_operator(operator: PredicateComparisonOperator) -> PredicateComparisonOperator {
    match operator {
        PredicateComparisonOperator::Eq | PredicateComparisonOperator::NotEq => operator,
        PredicateComparisonOperator::Gt => PredicateComparisonOperator::Lt,
        PredicateComparisonOperator::GtEq => PredicateComparisonOperator::LtEq,
        PredicateComparisonOperator::Lt => PredicateComparisonOperator::Gt,
        PredicateComparisonOperator::LtEq => PredicateComparisonOperator::GtEq,
    }
}

fn comparison_operators_are_complementary(
    left: PredicateComparisonOperator,
    right: PredicateComparisonOperator,
) -> bool {
    complementary_comparison_operator(left) == right
}

struct PredicateInListCheck<'a> {
    expr: &'a Expr,
    list: Vec<&'a Expr>,
    negated: bool,
}

fn or_contains_complementary_in_lists(expr: &Expr) -> bool {
    let mut checks = Vec::new();
    collect_or_in_list_checks(expr, &mut checks);
    checks.iter().enumerate().any(|(index, candidate)| {
        checks[index + 1..].iter().any(|other| {
            candidate.expr == other.expr && candidate.list == other.list && candidate.negated != other.negated
        })
    })
}

fn collect_or_in_list_checks<'a>(expr: &'a Expr, checks: &mut Vec<PredicateInListCheck<'a>>) {
    let expr = strip_nested_expr(expr);
    if let Expr::BinaryOp { left, op: BinaryOperator::Or, right } = expr {
        collect_or_in_list_checks(left, checks);
        collect_or_in_list_checks(right, checks);
    } else if let Some(check) = in_list_check(expr, false) {
        checks.push(check);
    }
}

fn in_list_check(expr: &Expr, outer_negated: bool) -> Option<PredicateInListCheck<'_>> {
    match strip_nested_expr(expr) {
        Expr::UnaryOp { op: UnaryOperator::Not, expr } => in_list_check(expr, !outer_negated),
        Expr::InList { expr, list, negated } if expr_contains_column_reference(expr) && !list.is_empty() => {
            let mut normalized_list = list.iter().map(strip_nested_expr).collect::<Vec<_>>();
            if normalized_list.iter().all(|item| matches!(strip_nested_expr(item), Expr::Value(_))) {
                normalized_list.sort_unstable();
                normalized_list.dedup();
            }
            Some(PredicateInListCheck {
                expr: strip_nested_expr(expr),
                list: normalized_list,
                negated: *negated != outer_negated,
            })
        }
        _ => None,
    }
}

struct PredicateBetweenCheck<'a> {
    expr: &'a Expr,
    low: &'a Expr,
    high: &'a Expr,
    negated: bool,
}

fn or_contains_complementary_between_checks(expr: &Expr) -> bool {
    let mut checks = Vec::new();
    collect_or_between_checks(expr, &mut checks);
    checks.iter().enumerate().any(|(index, candidate)| {
        checks[index + 1..].iter().any(|other| {
            candidate.expr == other.expr
                && candidate.low == other.low
                && candidate.high == other.high
                && candidate.negated != other.negated
        })
    })
}

fn collect_or_between_checks<'a>(expr: &'a Expr, checks: &mut Vec<PredicateBetweenCheck<'a>>) {
    let expr = strip_nested_expr(expr);
    if let Expr::BinaryOp { left, op: BinaryOperator::Or, right } = expr {
        collect_or_between_checks(left, checks);
        collect_or_between_checks(right, checks);
    } else if let Some(check) = between_check(expr, false) {
        checks.push(check);
    }
}

fn between_check(expr: &Expr, outer_negated: bool) -> Option<PredicateBetweenCheck<'_>> {
    match strip_nested_expr(expr) {
        Expr::UnaryOp { op: UnaryOperator::Not, expr } => between_check(expr, !outer_negated),
        Expr::Between { expr, negated, low, high } if expr_contains_column_reference(expr) => {
            Some(PredicateBetweenCheck {
                expr: strip_nested_expr(expr),
                low: strip_nested_expr(low),
                high: strip_nested_expr(high),
                negated: *negated != outer_negated,
            })
        }
        _ => None,
    }
}

fn like_pattern_matches_all(expr: &Expr) -> bool {
    matches!(strip_nested_expr(expr), Expr::Value(value) if matches!(&value.value, Value::SingleQuotedString(pattern) if !pattern.is_empty() && pattern.chars().all(|character| character == '%')))
}

fn collect_or_null_checks<'a>(expr: &'a Expr, checks: &mut Vec<(&'a Expr, bool)>) {
    let expr = strip_nested_expr(expr);
    if let Expr::BinaryOp { left, op: BinaryOperator::Or, right } = expr {
        collect_or_null_checks(left, checks);
        collect_or_null_checks(right, checks);
    } else if let Some(check) = null_check(expr) {
        checks.push(check);
    }
}

fn null_check(expr: &Expr) -> Option<(&Expr, bool)> {
    null_check_with_negation(expr, false)
}

fn null_check_with_negation(expr: &Expr, outer_negated: bool) -> Option<(&Expr, bool)> {
    match strip_nested_expr(expr) {
        Expr::UnaryOp { op: UnaryOperator::Not, expr } => null_check_with_negation(expr, !outer_negated),
        Expr::IsNull(expr) => Some((strip_nested_expr(expr), outer_negated)),
        Expr::IsNotNull(expr) => Some((strip_nested_expr(expr), !outer_negated)),
        _ => None,
    }
}

fn strip_nested_expr(mut expr: &Expr) -> &Expr {
    while let Expr::Nested(inner) = expr {
        expr = inner;
    }
    expr
}

fn predicate_is_obviously_false(expr: &Expr) -> bool {
    match expr {
        Expr::Nested(expr) => predicate_is_obviously_false(expr),
        Expr::Value(value) => value_is_falsy(&value.value),
        Expr::UnaryOp { op: UnaryOperator::Not, expr } => predicate_is_obviously_unbounded(expr),
        Expr::BinaryOp { left, op: BinaryOperator::And, right } => {
            predicate_is_obviously_false(left) || predicate_is_obviously_false(right)
        }
        Expr::BinaryOp { left, op: BinaryOperator::Or, right } => {
            predicate_is_obviously_false(left) && predicate_is_obviously_false(right)
        }
        Expr::BinaryOp { left, op, right } if is_comparison_operator(op) => {
            constant_comparison_truth(left, op, right).is_some_and(|result| !result)
                || (left == right && matches!(op, BinaryOperator::NotEq | BinaryOperator::Gt | BinaryOperator::Lt))
        }
        Expr::IsDistinctFrom(left, right) => strip_nested_expr(left) == strip_nested_expr(right),
        Expr::IsFalse(expr) | Expr::IsNotTrue(expr) => predicate_is_obviously_unbounded(expr),
        _ => false,
    }
}

fn is_comparison_operator(operator: &BinaryOperator) -> bool {
    matches!(
        operator,
        BinaryOperator::Eq
            | BinaryOperator::NotEq
            | BinaryOperator::Gt
            | BinaryOperator::Lt
            | BinaryOperator::GtEq
            | BinaryOperator::LtEq
            | BinaryOperator::Spaceship
    )
}

fn constant_comparison_truth(left: &Expr, operator: &BinaryOperator, right: &Expr) -> Option<bool> {
    let (Expr::Value(left), Expr::Value(right)) = (left, right) else {
        return None;
    };
    match operator {
        BinaryOperator::Eq | BinaryOperator::Spaceship => Some(left.value == right.value),
        BinaryOperator::NotEq => Some(left.value != right.value),
        BinaryOperator::Gt | BinaryOperator::Lt | BinaryOperator::GtEq | BinaryOperator::LtEq => {
            let (Value::Number(left, _), Value::Number(right, _)) = (&left.value, &right.value) else {
                return None;
            };
            let left = left.parse::<f64>().ok()?;
            let right = right.parse::<f64>().ok()?;
            Some(match operator {
                BinaryOperator::Gt => left > right,
                BinaryOperator::Lt => left < right,
                BinaryOperator::GtEq => left >= right,
                BinaryOperator::LtEq => left <= right,
                _ => unreachable!(),
            })
        }
        _ => None,
    }
}

fn value_is_truthy(value: &Value) -> bool {
    match value {
        Value::Boolean(value) => *value,
        Value::Number(value, _) => value.parse::<f64>().is_ok_and(|number| number != 0.0),
        _ => false,
    }
}

fn value_is_falsy(value: &Value) -> bool {
    match value {
        Value::Boolean(value) => !*value,
        Value::Number(value, _) => value.parse::<f64>().is_ok_and(|number| number == 0.0),
        Value::Null => true,
        _ => false,
    }
}

const SIDE_EFFECT_SELECT_FUNCTIONS: &[&str] = &[
    "lo_create",
    "lo_import",
    "lo_unlink",
    "nextval",
    "pg_advisory_lock",
    "pg_advisory_unlock",
    "pg_advisory_unlock_all",
    "pg_advisory_xact_lock",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_terminate_backend",
    "pg_try_advisory_lock",
    "pg_try_advisory_xact_lock",
    "setval",
];

fn query_is_write_capable(query: &Query, detect_select_into: bool) -> bool {
    query
        .with
        .as_ref()
        .is_some_and(|with| with.cte_tables.iter().any(|cte| query_is_write_capable(&cte.query, detect_select_into)))
        || set_expr_is_write_capable(&query.body, detect_select_into)
        || !query.locks.is_empty()
        || query_calls_known_side_effect_function(query)
}

fn set_expr_is_write_capable(expr: &SetExpr, detect_select_into: bool) -> bool {
    match expr {
        SetExpr::Select(select) => detect_select_into && select.into.is_some(),
        SetExpr::Query(query) => query_is_write_capable(query, detect_select_into),
        SetExpr::SetOperation { left, right, .. } => {
            set_expr_is_write_capable(left, detect_select_into) || set_expr_is_write_capable(right, detect_select_into)
        }
        SetExpr::Insert(_) | SetExpr::Update(_) | SetExpr::Delete(_) | SetExpr::Merge(_) => true,
        SetExpr::Values(_) | SetExpr::Table(_) => false,
    }
}

fn query_is_dangerous(query: &Query, detect_select_into: bool) -> bool {
    query
        .with
        .as_ref()
        .is_some_and(|with| with.cte_tables.iter().any(|cte| query_is_dangerous(&cte.query, detect_select_into)))
        || set_expr_is_dangerous(&query.body, detect_select_into)
        || !query.locks.is_empty()
        || query_calls_known_side_effect_function(query)
}

fn set_expr_is_dangerous(expr: &SetExpr, detect_select_into: bool) -> bool {
    match expr {
        SetExpr::Select(select) => detect_select_into && select.into.is_some(),
        SetExpr::Query(query) => query_is_dangerous(query, detect_select_into),
        SetExpr::SetOperation { left, right, .. } => {
            set_expr_is_dangerous(left, detect_select_into) || set_expr_is_dangerous(right, detect_select_into)
        }
        SetExpr::Insert(statement)
        | SetExpr::Update(statement)
        | SetExpr::Delete(statement)
        | SetExpr::Merge(statement) => statement_is_dangerous(statement, detect_select_into),
        SetExpr::Values(_) | SetExpr::Table(_) => false,
    }
}

fn query_calls_known_side_effect_function(query: &Query) -> bool {
    visit_expressions(query, |expr| {
        let is_side_effect = if let Expr::Function(function) = expr {
            function.name.0.last().and_then(|part| part.as_ident()).is_some_and(|name| {
                SIDE_EFFECT_SELECT_FUNCTIONS.iter().any(|candidate| name.value.eq_ignore_ascii_case(candidate))
            })
        } else {
            false
        };
        if is_side_effect {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })
    .is_break()
}

/// Classify SQL risk using sqlparser AST analysis.
///
/// If parsing fails (non-standard SQL, non-SQL databases), falls back to
/// keyword-based `query_execution_sql::is_write_sql()`.
///
/// Multi-statement input: returns the highest risk level across all statements.
pub fn classify_sql_risk(sql: &str, dialect: &str) -> Result<SqlRisk, String> {
    let normalized = normalize_dialect(dialect);
    classify_sql_risk_with_database(sql, normalized, None)
}

/// Classify SQL risk using both the parser dialect and the concrete database
/// type so dialect-specific write forms cannot be mistaken for read queries.
pub fn classify_sql_risk_for_database(sql: &str, database_type: DatabaseType) -> Result<SqlRisk, String> {
    let database_type_name = format!("{database_type:?}");
    let normalized = normalize_dialect(&database_type_name);
    classify_sql_risk_with_database(sql, normalized, Some(database_type))
}

/// Return whether MCP must require the central dangerous-operation permission.
/// Parse failures fail closed for writes. Safe-write mode permits plain INSERT
/// and single-table UPDATE/DELETE statements with an effective predicate;
/// broader or opaque mutations require central high-risk permission.
pub fn is_dangerous_sql_for_database(sql: &str, database_type: DatabaseType) -> bool {
    let database_type_name = format!("{database_type:?}");
    let normalized = normalize_dialect(&database_type_name);
    let parser_dialect = resolve_dialect(normalized);
    let detect_select_into = supports_select_into_table_creation(database_type);
    let has_locking_clause = sql_contains_top_level_locking_clause(sql, parser_dialect.as_ref());
    // PostgreSQL-family and SQL Server SELECT INTO forms are represented in
    // the AST. Their text fallback also matches ordinary INSERT INTO, so only
    // use it for dialect-specific writes that the selected AST cannot express
    // (notably MySQL INTO OUTFILE/DUMPFILE and executable comments).
    let has_unparsed_dialect_specific_write =
        !detect_select_into && crate::query_execution_sql::has_dialect_specific_write(sql, database_type);

    match Parser::parse_sql(parser_dialect.as_ref(), sql) {
        Ok(statements) if !statements.is_empty() => {
            has_locking_clause
                || has_unparsed_dialect_specific_write
                || statements.iter().any(|statement| statement_is_dangerous(statement, detect_select_into))
        }
        _ => has_locking_clause || crate::query_execution_sql::is_write_sql_for_database(sql, database_type),
    }
}

/// MCP requests must select their database through the explicit request scope.
/// A `USE` statement mutates pooled/session state and could redirect later SQL,
/// so it is forbidden independently of read/write and high-risk permissions.
pub fn mcp_sql_has_forbidden_database_switch(sql: &str, database_type: DatabaseType) -> bool {
    let database_type_name = format!("{database_type:?}");
    let normalized = normalize_dialect(&database_type_name);
    let dialect = resolve_dialect(normalized);
    if sql_has_use_statement(sql, dialect.as_ref()) {
        return true;
    }

    if matches!(
        database_type,
        DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::ManticoreSearch
            | DatabaseType::Goldendb
    ) {
        let executable_comments_expanded = crate::query_execution_sql::strip_sql_comments(sql);
        return sql_has_use_statement(&executable_comments_expanded, dialect.as_ref());
    }
    false
}

fn sql_has_use_statement(sql: &str, dialect: &dyn sqlparser::dialect::Dialect) -> bool {
    if let Ok(statements) = Parser::parse_sql(dialect, sql) {
        return statements.iter().any(|statement| matches!(statement, Statement::Use(_)));
    }

    let Ok(tokens) = Tokenizer::new(dialect, sql).tokenize() else {
        return false;
    };
    let mut statement_start = true;
    for token in tokens {
        match token {
            Token::Whitespace(_) => {}
            Token::SemiColon => statement_start = true,
            Token::Word(word) if statement_start => {
                if word.value.eq_ignore_ascii_case("use") {
                    return true;
                }
                statement_start = false;
            }
            Token::EOF => {}
            _ if statement_start => statement_start = false,
            _ => {}
        }
    }
    false
}

fn supports_select_into_table_creation(database_type: DatabaseType) -> bool {
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
            | DatabaseType::SqlServer
    )
}

fn classify_sql_risk_with_database(
    sql: &str,
    normalized_dialect: &str,
    database_type: Option<DatabaseType>,
) -> Result<SqlRisk, String> {
    let parser_dialect = resolve_dialect(normalized_dialect);
    let detect_select_into = database_type.is_none();
    let has_locking_clause = sql_contains_top_level_locking_clause(sql, parser_dialect.as_ref());
    let has_dialect_specific_write = database_type
        .is_some_and(|database_type| crate::query_execution_sql::has_dialect_specific_write(sql, database_type));

    match Parser::parse_sql(parser_dialect.as_ref(), sql) {
        Ok(stmts) if !stmts.is_empty() => {
            let mut max_risk = SqlRisk::ReadOnly;
            for stmt in &stmts {
                let risk = classify_statement(stmt, detect_select_into);
                if risk as u8 > max_risk as u8 {
                    max_risk = risk;
                }
            }
            if max_risk == SqlRisk::ReadOnly && (has_dialect_specific_write || has_locking_clause) {
                Ok(SqlRisk::Write)
            } else {
                Ok(max_risk)
            }
        }
        _ => {
            // Fallback: keyword-based classification
            let is_write = database_type.map_or_else(
                || crate::query_execution_sql::is_write_sql(sql),
                |database_type| crate::query_execution_sql::is_write_sql_for_database(sql, database_type),
            );
            if is_write || has_locking_clause {
                Ok(SqlRisk::Write)
            } else {
                Ok(SqlRisk::ReadOnly)
            }
        }
    }
}

fn sql_contains_top_level_locking_clause(sql: &str, dialect: &dyn sqlparser::dialect::Dialect) -> bool {
    let Ok(tokens) = Tokenizer::new(dialect, sql).tokenize() else {
        return false;
    };
    let mut depth: usize = 0;
    let mut words = Vec::new();
    for token in tokens {
        match token {
            Token::LParen => depth += 1,
            Token::RParen => depth = depth.saturating_sub(1),
            token if depth == 0 => {
                let word = token.to_string();
                if word.chars().all(|character| character.is_ascii_alphabetic() || character == '_') {
                    words.push(word.to_ascii_uppercase());
                }
            }
            _ => {}
        }
    }
    words.windows(2).any(|window| matches!(window, [r#for, lock] if r#for == "FOR" && matches!(lock.as_str(), "UPDATE" | "SHARE")))
        || words.windows(3).any(|window| {
            matches!(window, [r#for, key, share] if r#for == "FOR" && key == "KEY" && share == "SHARE")
        })
        || words.windows(4).any(|window| {
            matches!(window, [r#for, no, key, update] if r#for == "FOR" && no == "NO" && key == "KEY" && update == "UPDATE")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_select_statements() {
        assert_eq!(classify_sql_risk("SELECT * FROM users", "postgres").unwrap(), SqlRisk::ReadOnly);
        assert_eq!(
            classify_sql_risk("SELECT id, name FROM users WHERE active = true", "mysql").unwrap(),
            SqlRisk::ReadOnly
        );
        assert_eq!(classify_sql_risk("SHOW TABLES", "mysql").unwrap(), SqlRisk::ReadOnly);
        assert_eq!(classify_sql_risk("DESCRIBE users", "mysql").unwrap(), SqlRisk::ReadOnly);
        assert_eq!(classify_sql_risk("EXPLAIN SELECT * FROM users", "postgres").unwrap(), SqlRisk::ReadOnly);
    }

    #[test]
    fn classify_cte_read() {
        assert_eq!(
            classify_sql_risk("WITH cte AS (SELECT 1) SELECT * FROM cte", "postgres").unwrap(),
            SqlRisk::ReadOnly
        );
    }

    #[test]
    fn classify_writable_ctes_recursively() {
        for sql in [
            "WITH inserted AS (INSERT INTO users (id) VALUES (1) RETURNING id) SELECT * FROM inserted",
            "WITH updated AS (UPDATE users SET active = true WHERE id = 1 RETURNING id) SELECT * FROM updated",
            "WITH deleted AS (DELETE FROM users WHERE id = 1 RETURNING id) SELECT * FROM deleted",
            "WITH merged AS (MERGE INTO users USING staged_users ON users.id = staged_users.id WHEN MATCHED THEN UPDATE SET active = true RETURNING users.id) SELECT * FROM merged",
            "WITH outer_cte AS (WITH deleted AS (DELETE FROM users WHERE id = 1 RETURNING id) SELECT * FROM deleted) SELECT * FROM outer_cte",
        ] {
            assert_eq!(classify_sql_risk(sql, "postgres").unwrap(), SqlRisk::Write, "expected writable CTE: {sql}");
            assert!(
                crate::query_execution_sql::is_write_sql_for_database(sql, DatabaseType::Postgres),
                "expected writable CTE to trip read-only enforcement: {sql}"
            );
        }
    }

    #[test]
    fn writable_cte_danger_tracks_the_nested_mutation() {
        for sql in [
            "WITH updated AS (UPDATE users SET active = true WHERE id = 1 RETURNING id) SELECT * FROM updated",
            "WITH deleted AS (DELETE FROM users WHERE id = 1 RETURNING id) SELECT * FROM deleted",
            "WITH outer_cte AS (WITH deleted AS (DELETE FROM users WHERE id = 1 RETURNING id) SELECT * FROM deleted) SELECT * FROM outer_cte",
        ] {
            assert!(!is_dangerous_sql_for_database(sql, DatabaseType::Postgres), "expected guarded write: {sql}");
        }

        for sql in [
            "WITH updated AS (UPDATE users SET active = true RETURNING id) SELECT * FROM updated",
            "WITH deleted AS (DELETE FROM users RETURNING id) SELECT * FROM deleted",
            "WITH outer_cte AS (WITH deleted AS (DELETE FROM users RETURNING id) SELECT * FROM deleted) SELECT * FROM outer_cte",
        ] {
            assert!(is_dangerous_sql_for_database(sql, DatabaseType::Postgres), "expected dangerous write: {sql}");
        }
    }

    #[test]
    fn classify_write_statements() {
        assert_eq!(classify_sql_risk("INSERT INTO users VALUES (1)", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(classify_sql_risk("UPDATE users SET name = 'x'", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(classify_sql_risk("DELETE FROM users", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(classify_sql_risk("EXPLAIN ANALYZE DELETE FROM users", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(classify_sql_risk("SELECT * INTO backup_users FROM users", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(
            classify_sql_risk("SELECT * FROM users INTO OUTFILE '/tmp/users.csv'", "mysql").unwrap(),
            SqlRisk::Write
        );
        assert_eq!(classify_sql_risk("/*! DELETE FROM users */", "mysql").unwrap(), SqlRisk::Write);
    }

    #[test]
    fn mcp_forbids_persistent_database_switching_in_every_permission_mode() {
        for (sql, database_type) in [
            ("USE reporting", DatabaseType::Mysql),
            ("-- target database\nUSE reporting", DatabaseType::Mysql),
            ("SELECT 1; USE reporting", DatabaseType::Mysql),
            ("USE [reporting]", DatabaseType::SqlServer),
            ("USE DATABASE reporting", DatabaseType::Snowflake),
            ("/*!50000 USE reporting */", DatabaseType::Mysql),
        ] {
            assert!(mcp_sql_has_forbidden_database_switch(sql, database_type), "expected blocked SQL: {sql}");
        }

        for sql in ["SELECT use FROM feature_flags", "SELECT 'USE reporting'", "SELECT 1"] {
            assert!(!mcp_sql_has_forbidden_database_switch(sql, DatabaseType::Mysql), "expected allowed SQL: {sql}");
        }
        assert!(!mcp_sql_has_forbidden_database_switch("/*!50000 USE reporting */", DatabaseType::Postgres));
    }

    #[test]
    fn classify_known_side_effect_selects_and_copy_as_writes() {
        for sql in [
            "SELECT setval('user_id_seq', 42)",
            "SELECT nextval('user_id_seq')",
            "SELECT pg_terminate_backend(42)",
            "SELECT * FROM users FOR UPDATE",
            "SELECT * FROM users FOR KEY SHARE",
            "COPY users TO '/tmp/users.csv'",
            "COPY (SELECT * FROM users) TO PROGRAM 'cat > /tmp/users.csv'",
        ] {
            assert_eq!(
                classify_sql_risk_for_database(sql, DatabaseType::Postgres).unwrap(),
                SqlRisk::Write,
                "expected write-capable SQL: {sql}"
            );
            assert!(is_dangerous_sql_for_database(sql, DatabaseType::Postgres), "expected high-risk SQL: {sql}");
        }
    }

    #[test]
    fn classify_dialect_specific_select_into_as_write() {
        for sql in [
            "SELECT 3156 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt'",
            "SELECT 3156 INTO DUMPFILE '/var/lib/mysql-files/dbx_ro_probe.bin'",
        ] {
            assert_eq!(classify_sql_risk_for_database(sql, DatabaseType::Mysql).unwrap(), SqlRisk::Write);
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
            assert_eq!(
                classify_sql_risk_for_database("SELECT * INTO copied_users FROM users", database_type).unwrap(),
                SqlRisk::Write,
                "expected PostgreSQL-family SELECT INTO to be a write for {database_type:?}"
            );
        }
        assert_eq!(
            classify_sql_risk_for_database("SELECT * INTO #copied_users FROM users", DatabaseType::SqlServer).unwrap(),
            SqlRisk::Write
        );
        assert_eq!(
            classify_sql_risk_for_database(
                "SELECT 3156 /*!50000 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */",
                DatabaseType::Mysql,
            )
            .unwrap(),
            SqlRisk::Write
        );
    }

    #[test]
    fn typed_classification_preserves_existing_risk_levels() {
        assert_eq!(
            classify_sql_risk_for_database("SELECT * FROM users", DatabaseType::Postgres).unwrap(),
            SqlRisk::ReadOnly
        );
        assert_eq!(
            classify_sql_risk_for_database("CREATE TABLE users (id INT)", DatabaseType::Postgres).unwrap(),
            SqlRisk::Ddl
        );
        assert_eq!(
            classify_sql_risk_for_database("SELECT 1 INTO unsupported", DatabaseType::Sqlite).unwrap(),
            SqlRisk::ReadOnly
        );
    }

    #[test]
    fn classify_ddl_statements() {
        assert_eq!(classify_sql_risk("CREATE TABLE users (id INT)", "postgres").unwrap(), SqlRisk::Ddl);
        assert_eq!(classify_sql_risk("DROP TABLE users", "postgres").unwrap(), SqlRisk::Ddl);
        assert_eq!(classify_sql_risk("ALTER TABLE users ADD COLUMN age INT", "postgres").unwrap(), SqlRisk::Ddl);
        assert_eq!(classify_sql_risk("TRUNCATE TABLE users", "postgres").unwrap(), SqlRisk::Ddl);
    }

    #[test]
    fn high_risk_sql_requires_central_permission_for_unbounded_changes() {
        assert!(is_dangerous_sql_for_database("TRUNCATE TABLE users", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("DELETE FROM users", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("UPDATE users SET active = 0", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE 1 = 1", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("UPDATE users SET active = 0 WHERE TRUE", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE id = id", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE lower(email) = lower(email)",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE NOT (1 = 0)", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("UPDATE users SET active = 0 WHERE 2 > 1", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id IS NULL OR id IS NOT NULL",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id IS NULL OR NOT (((id IS NULL)))",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id IS NOT NULL OR NOT (((id IS NOT NULL)))",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE id = 1 OR id <> 1", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE id != 1 OR 1 = id", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE status = 'disabled' OR status != 'disabled'",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE (id = 1 OR status = 'disabled') OR 1 != id OR id IS NULL",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE id > 1 OR id <= 1", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE 1 >= id OR id > 1", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE id >= 1 OR 1 > id", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id IN (1) OR id NOT IN (1) OR id IS NULL",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id IN (1, 2) OR id NOT IN (2, 1) OR id IS NULL",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id BETWEEN 1 AND 2 OR id NOT BETWEEN 1 AND 2 OR id IS NULL",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id = 1 OR (id <> 1 AND TRUE) OR id IS NULL",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id IS NOT DISTINCT FROM id",
            DatabaseType::Postgres
        ));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE id <=> id", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database(
            "UPDATE users SET active = 0 WHERE name LIKE '%' OR name IS NULL",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "UPDATE users SET active = 0 WHERE name LIKE '%%' OR name IS NULL",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE (id IS NULL OR status = 'disabled') OR id IS NOT NULL",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database("UPDATE users SET active = 0 WHERE abs(1) = 1", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE lower('A') = 'a'", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE coalesce(NULL, 1) = 1", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE LOWER(_utf8mb4'A') = 'a'", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE EXTRACT(YEAR FROM DATE '2026-01-01') = 2026",
            DatabaseType::Postgres
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE DATE '2026-01-01' < CURRENT_DATE",
            DatabaseType::Postgres
        ));
        assert!(is_dangerous_sql_for_database("DELETE FROM users WHERE USER = CURRENT_USER", DatabaseType::Postgres));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id IN (SELECT id FROM archived_users)",
            DatabaseType::Postgres
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE FROM users WHERE EXISTS (SELECT 1 FROM archived_users)",
            DatabaseType::Postgres
        ));
        assert!(!is_dangerous_sql_for_database("DELETE FROM users WHERE id = 1", DatabaseType::Mysql));
        assert!(!is_dangerous_sql_for_database("UPDATE users SET active = 0 WHERE id = 1", DatabaseType::Mysql));
        assert!(!is_dangerous_sql_for_database("UPDATE users SET active = 0 WHERE abs(id) = 1", DatabaseType::Mysql));
        assert!(!is_dangerous_sql_for_database(
            "DELETE FROM users WHERE lower(email) = 'disabled@example.com'",
            DatabaseType::Mysql
        ));
        assert!(!is_dangerous_sql_for_database(
            "DELETE FROM users WHERE EXTRACT(YEAR FROM created_at) = 2026",
            DatabaseType::Postgres
        ));
        assert!(!is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id IS NULL OR status IS NOT NULL",
            DatabaseType::Mysql
        ));
        assert!(!is_dangerous_sql_for_database(
            "DELETE FROM users WHERE (id IS NULL OR NOT (((id IS NULL)))) AND tenant_id = 1",
            DatabaseType::Mysql
        ));
        assert!(!is_dangerous_sql_for_database(
            "DELETE FROM users WHERE (id = 1 OR id <> 1) AND tenant_id = 1",
            DatabaseType::Mysql
        ));
        assert!(!is_dangerous_sql_for_database(
            "DELETE FROM users WHERE status = 'pending' OR status <> 'disabled'",
            DatabaseType::Mysql
        ));
        assert!(!is_dangerous_sql_for_database("DELETE FROM users WHERE id IN (1) OR id IN (2)", DatabaseType::Mysql));
        assert!(!is_dangerous_sql_for_database(
            "DELETE FROM users WHERE id BETWEEN 1 AND 2 OR id BETWEEN 4 AND 5",
            DatabaseType::Mysql
        ));
        assert!(!is_dangerous_sql_for_database(
            "UPDATE users SET active = 0 WHERE name LIKE 'admin%'",
            DatabaseType::Mysql
        ));
        assert!(!is_dangerous_sql_for_database(
            "UPDATE users SET active = 0 WHERE status = 'inactive' AND tenant_id = 1",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "UPDATE users JOIN accounts ON accounts.id = users.account_id SET users.active = 0 WHERE users.id = 1",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "UPDATE users SET active = false FROM accounts WHERE users.account_id = accounts.id",
            DatabaseType::Postgres
        ));
        assert!(is_dangerous_sql_for_database(
            "DELETE users FROM users JOIN accounts ON accounts.id = users.account_id WHERE users.id = 1",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database("REPLACE INTO users (id) VALUES (1)", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database(
            "INSERT INTO users (id) VALUES (1) ON DUPLICATE KEY UPDATE active = 1",
            DatabaseType::Mysql
        ));
        assert!(is_dangerous_sql_for_database(
            "INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET active = true",
            DatabaseType::Postgres
        ));
        assert!(!is_dangerous_sql_for_database("INSERT INTO users (id) VALUES (1)", DatabaseType::Mysql));
        assert!(is_dangerous_sql_for_database(
            "INSERT INTO users (id) SELECT id FROM staged_users",
            DatabaseType::Mysql
        ));
        assert!(!is_dangerous_sql_for_database(
            "INSERT INTO users (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
            DatabaseType::Postgres
        ));
    }

    #[test]
    fn select_into_requires_central_high_risk_permission_for_supported_databases() {
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
            assert!(
                is_dangerous_sql_for_database("SELECT * INTO copied_users FROM users", database_type),
                "expected PostgreSQL-family SELECT INTO to require high-risk permission for {database_type:?}"
            );
        }
        assert!(is_dangerous_sql_for_database("SELECT * INTO #copied_users FROM users", DatabaseType::SqlServer));
        assert!(is_dangerous_sql_for_database("SELECT 1 INTO OUTFILE '/tmp/dbx-probe.txt'", DatabaseType::Mysql));
        assert!(!is_dangerous_sql_for_database("SELECT 1", DatabaseType::Postgres));
        assert!(!is_dangerous_sql_for_database("SELECT 1 INTO unsupported", DatabaseType::Sqlite));
    }

    #[test]
    fn classify_transaction_statements() {
        assert_eq!(classify_sql_risk("BEGIN", "postgres").unwrap(), SqlRisk::Transaction);
        assert_eq!(classify_sql_risk("COMMIT", "postgres").unwrap(), SqlRisk::Transaction);
        assert_eq!(classify_sql_risk("ROLLBACK", "postgres").unwrap(), SqlRisk::Transaction);
    }

    #[test]
    fn classify_multi_statement_returns_highest_risk() {
        // SELECT + INSERT = Write
        assert_eq!(classify_sql_risk("SELECT 1; INSERT INTO users VALUES (1)", "postgres").unwrap(), SqlRisk::Write);
    }

    #[test]
    fn classify_fallback_on_parse_error() {
        // Non-standard SQL should fall back to keyword matching
        assert_eq!(classify_sql_risk("SELECT * FROM users", "generic").unwrap(), SqlRisk::ReadOnly);
    }

    #[test]
    fn classify_unknown_statement_is_write() {
        // Statements not explicitly handled should be conservative (Write)
        // This depends on sqlparser's coverage, but we can test the catch-all
        assert_eq!(classify_sql_risk("GRANT SELECT ON users TO admin", "postgres").unwrap(), SqlRisk::Ddl);
    }
}
