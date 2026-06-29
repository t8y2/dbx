use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

use regex::Regex;
use sqlparser::ast::{
    Expr, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr, Ident, JoinConstraint, JoinOperator,
    ObjectName, ObjectNamePart, OrderByKind, Query, Select, SelectItem, SetExpr, Statement, TableFactor,
    TableWithJoins,
};
use sqlparser::dialect::{
    ClickHouseDialect, DuckDbDialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect,
};
use sqlparser::parser::Parser;
use sqlparser::tokenizer::Span;

use crate::sql::{starts_with_duckdb_result_sql_keyword, starts_with_executable_sql_keyword};

static CLICKHOUSE_STRICTNESS_FIRST_JOIN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(ANY|ALL|SEMI|ANTI|ASOF)\s+(LEFT|RIGHT|FULL|INNER|CROSS)(\s+OUTER)?\s+JOIN\b")
        .expect("valid ClickHouse join strictness regex")
});
static POSTGRES_DEFAULT_PRIVILEGES_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*ALTER\s+DEFAULT\s+PRIVILEGES\b").expect("valid PostgreSQL default privileges regex")
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqlReferenceAnalysis {
    pub tables: Vec<SqlTableReference>,
    pub columns: Vec<SqlColumnReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqlTableReference {
    pub name: String,
    pub schema: Option<String>,
    pub alias: Option<String>,
    pub span: SqlTextSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqlColumnReference {
    pub name: String,
    pub qualifier: Option<String>,
    pub span: SqlTextSpan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqlTextSpan {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
}

impl From<Span> for SqlTextSpan {
    fn from(span: Span) -> Self {
        Self {
            start_line: span.start.line as usize,
            start_column: span.start.column as usize,
            end_line: span.end.line as usize,
            end_column: span.end.column as usize,
        }
    }
}

#[derive(Default)]
struct Analyzer {
    tables: Vec<SqlTableReference>,
    columns: Vec<SqlColumnReference>,
}

pub fn analyze_sql_references(sql: &str, dialect: Option<&str>) -> Result<SqlReferenceAnalysis, String> {
    let normalized_dialect = normalize_dialect(dialect);
    if normalized_dialect == "duckdb" && starts_with_duckdb_parser_gap_sql(sql) {
        return Ok(SqlReferenceAnalysis { tables: vec![], columns: vec![] });
    }
    if normalized_dialect == "postgres" && starts_with_postgres_parser_gap_sql(sql) {
        return Ok(SqlReferenceAnalysis { tables: vec![], columns: vec![] });
    }
    let parser_sql = if normalized_dialect == "clickhouse" {
        normalize_clickhouse_join_order_for_parser(sql)
    } else {
        sql.to_string()
    };

    let statements = match normalized_dialect.as_str() {
        "postgres" => Parser::parse_sql(&PostgreSqlDialect {}, &parser_sql),
        "mysql" => Parser::parse_sql(&MySqlDialect {}, &parser_sql),
        "sqlite" => Parser::parse_sql(&SQLiteDialect {}, &parser_sql),
        "sqlserver" => Parser::parse_sql(&MsSqlDialect {}, &parser_sql),
        "clickhouse" => Parser::parse_sql(&ClickHouseDialect {}, &parser_sql),
        "duckdb" => Parser::parse_sql(&DuckDbDialect {}, &parser_sql),
        _ => Parser::parse_sql(&GenericDialect {}, &parser_sql),
    }
    .map_err(|err| err.to_string())?;

    let mut analyzer = Analyzer::default();
    for statement in statements {
        analyzer.visit_statement(&statement);
    }

    Ok(SqlReferenceAnalysis { tables: analyzer.tables, columns: analyzer.columns })
}

fn starts_with_duckdb_parser_gap_sql(sql: &str) -> bool {
    starts_with_duckdb_result_sql_keyword(sql)
        && starts_with_executable_sql_keyword(sql, &["FROM", "SUMMARIZE", "SUMMARISE", "PIVOT", "UNPIVOT"])
}

fn starts_with_postgres_parser_gap_sql(sql: &str) -> bool {
    POSTGRES_DEFAULT_PRIVILEGES_RE.is_match(sql)
}

fn normalize_clickhouse_join_order_for_parser(sql: &str) -> String {
    CLICKHOUSE_STRICTNESS_FIRST_JOIN_RE
        .replace_all(sql, |captures: &regex::Captures<'_>| {
            let matched_len = captures.get(0).map(|value| value.as_str().len()).unwrap_or(0);
            let strictness = captures.get(1).map(|value| value.as_str()).unwrap_or("");
            let join_type = captures.get(2).map(|value| value.as_str()).unwrap_or("");
            let outer = captures.get(3).map(|value| value.as_str()).unwrap_or("");
            let mut normalized = match strictness.to_ascii_uppercase().as_str() {
                "SEMI" | "ANTI" => format!("{join_type}{outer} {strictness} JOIN"),
                _ => format!("{join_type}{outer} JOIN"),
            };
            if normalized.len() < matched_len {
                normalized.push_str(&" ".repeat(matched_len - normalized.len()));
            }
            normalized
        })
        .into_owned()
}

fn normalize_dialect(dialect: Option<&str>) -> String {
    match dialect.unwrap_or("generic").to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" | "redshift" | "opengauss" | "gaussdb" | "highgo" | "questdb" => {
            "postgres".to_string()
        }
        "mysql" | "mariadb" | "doris" | "starrocks" | "manticoresearch" | "oceanbase" => "mysql".to_string(),
        "sqlite" => "sqlite".to_string(),
        "sqlserver" | "mssql" => "sqlserver".to_string(),
        "clickhouse" => "clickhouse".to_string(),
        "duckdb" => "duckdb".to_string(),
        _ => "generic".to_string(),
    }
}

impl Analyzer {
    fn visit_statement(&mut self, statement: &Statement) {
        if let Statement::Query(query) = statement {
            self.visit_query(query);
        }
    }

    fn visit_query(&mut self, query: &Query) {
        if let Some(with) = &query.with {
            for cte in &with.cte_tables {
                self.visit_query(&cte.query);
            }
        }
        self.visit_set_expr(&query.body);
        if let Some(order_by) = &query.order_by {
            if let OrderByKind::Expressions(exprs) = &order_by.kind {
                for expr in exprs {
                    self.visit_expr(&expr.expr);
                }
            }
        }
    }

    fn visit_set_expr(&mut self, set_expr: &SetExpr) {
        match set_expr {
            SetExpr::Select(select) => self.visit_select(select),
            SetExpr::Query(query) => self.visit_query(query),
            SetExpr::SetOperation { left, right, .. } => {
                self.visit_set_expr(left);
                self.visit_set_expr(right);
            }
            _ => {}
        }
    }

    fn visit_select(&mut self, select: &Select) {
        for table in &select.from {
            self.visit_table_with_joins(table);
        }

        for item in &select.projection {
            match item {
                SelectItem::UnnamedExpr(expr)
                | SelectItem::ExprWithAlias { expr, .. }
                | SelectItem::ExprWithAliases { expr, .. } => self.visit_expr(expr),
                _ => {}
            }
        }

        if let Some(expr) = &select.prewhere {
            self.visit_expr(expr);
        }
        if let Some(expr) = &select.selection {
            self.visit_expr(expr);
        }
        if let GroupByExpr::Expressions(exprs, _) = &select.group_by {
            for expr in exprs {
                self.visit_expr(expr);
            }
        }
        for expr in &select.cluster_by {
            self.visit_expr(expr);
        }
        for expr in &select.distribute_by {
            self.visit_expr(expr);
        }
        for expr in &select.sort_by {
            self.visit_expr(&expr.expr);
        }
        if let Some(expr) = &select.having {
            self.visit_expr(expr);
        }
        if let Some(expr) = &select.qualify {
            self.visit_expr(expr);
        }
    }

    fn visit_table_with_joins(&mut self, table: &TableWithJoins) {
        self.visit_table_factor(&table.relation);
        for join in &table.joins {
            self.visit_table_factor(&join.relation);
            self.visit_join_operator(&join.join_operator);
        }
    }

    fn visit_join_operator(&mut self, operator: &JoinOperator) {
        match operator {
            JoinOperator::Join(constraint)
            | JoinOperator::Inner(constraint)
            | JoinOperator::Left(constraint)
            | JoinOperator::LeftOuter(constraint)
            | JoinOperator::Right(constraint)
            | JoinOperator::RightOuter(constraint)
            | JoinOperator::FullOuter(constraint)
            | JoinOperator::CrossJoin(constraint)
            | JoinOperator::Semi(constraint)
            | JoinOperator::LeftSemi(constraint)
            | JoinOperator::RightSemi(constraint)
            | JoinOperator::Anti(constraint)
            | JoinOperator::LeftAnti(constraint)
            | JoinOperator::RightAnti(constraint)
            | JoinOperator::StraightJoin(constraint) => self.visit_join_constraint(constraint),
            JoinOperator::AsOf { match_condition, constraint } => {
                self.visit_expr(match_condition);
                self.visit_join_constraint(constraint);
            }
            _ => {}
        }
    }

    fn visit_join_constraint(&mut self, constraint: &JoinConstraint) {
        match constraint {
            JoinConstraint::On(expr) => self.visit_expr(expr),
            JoinConstraint::Using(names) => {
                for name in names {
                    if let Some(ident) = object_name_last_ident(name) {
                        self.push_column(None, ident);
                    }
                }
            }
            _ => {}
        }
    }

    fn visit_table_factor(&mut self, factor: &TableFactor) {
        match factor {
            TableFactor::Table { name, alias, args, .. } => {
                if args.is_none() {
                    if let Some(table) = table_reference_from_name(name, alias.as_ref().map(|a| a.name.value.clone())) {
                        self.tables.push(table);
                    }
                }
            }
            TableFactor::Derived { subquery, .. } => self.visit_query(subquery),
            TableFactor::NestedJoin { table_with_joins, .. } => self.visit_table_with_joins(table_with_joins),
            TableFactor::TableFunction { expr, .. } => self.visit_expr(expr),
            TableFactor::Function { args, .. } => {
                for arg in args {
                    self.visit_function_arg(arg);
                }
            }
            TableFactor::UNNEST { array_exprs, .. } => {
                for expr in array_exprs {
                    self.visit_expr(expr);
                }
            }
            _ => {}
        }
    }

    fn visit_expr(&mut self, expr: &Expr) {
        match expr {
            Expr::Identifier(ident) => self.push_column(None, ident),
            Expr::CompoundIdentifier(idents) => {
                if idents.len() >= 2 {
                    let column = idents.last().expect("checked length");
                    let qualifier = idents.get(idents.len() - 2).map(|ident| ident.value.clone());
                    self.push_column(qualifier, column);
                }
            }
            Expr::CompoundFieldAccess { root, .. } | Expr::JsonAccess { value: root, .. } => self.visit_expr(root),
            Expr::IsFalse(expr)
            | Expr::IsNotFalse(expr)
            | Expr::IsTrue(expr)
            | Expr::IsNotTrue(expr)
            | Expr::IsNull(expr)
            | Expr::IsNotNull(expr)
            | Expr::IsUnknown(expr)
            | Expr::IsNotUnknown(expr)
            | Expr::UnaryOp { expr, .. }
            | Expr::Nested(expr) => self.visit_expr(expr),
            Expr::IsDistinctFrom(left, right)
            | Expr::IsNotDistinctFrom(left, right)
            | Expr::BinaryOp { left, right, .. }
            | Expr::AnyOp { left, right, .. }
            | Expr::AllOp { left, right, .. } => {
                self.visit_expr(left);
                self.visit_expr(right);
            }
            Expr::InList { expr, list, .. } => {
                self.visit_expr(expr);
                for item in list {
                    self.visit_expr(item);
                }
            }
            Expr::InSubquery { expr, subquery, .. } => {
                self.visit_expr(expr);
                self.visit_query(subquery);
            }
            Expr::InUnnest { expr, array_expr, .. } => {
                self.visit_expr(expr);
                self.visit_expr(array_expr);
            }
            Expr::Between { expr, low, high, .. } => {
                self.visit_expr(expr);
                self.visit_expr(low);
                self.visit_expr(high);
            }
            Expr::Like { expr, pattern, .. }
            | Expr::ILike { expr, pattern, .. }
            | Expr::SimilarTo { expr, pattern, .. }
            | Expr::RLike { expr, pattern, .. } => {
                self.visit_expr(expr);
                self.visit_expr(pattern);
            }
            Expr::Cast { expr, .. }
            | Expr::Extract { expr, .. }
            | Expr::Ceil { expr, .. }
            | Expr::Floor { expr, .. } => self.visit_expr(expr),
            Expr::AtTimeZone { timestamp, time_zone } => {
                self.visit_expr(timestamp);
                self.visit_expr(time_zone);
            }
            Expr::Position { expr, r#in } => {
                self.visit_expr(expr);
                self.visit_expr(r#in);
            }
            Expr::Function(function) => {
                self.visit_function_args(&function.parameters);
                self.visit_function_args(&function.args);
                if let Some(filter) = &function.filter {
                    self.visit_expr(filter);
                }
                for order in &function.within_group {
                    self.visit_expr(&order.expr);
                }
            }
            Expr::Case { operand, conditions, else_result, .. } => {
                if let Some(operand) = operand {
                    self.visit_expr(operand);
                }
                for condition in conditions {
                    self.visit_expr(&condition.condition);
                    self.visit_expr(&condition.result);
                }
                if let Some(else_result) = else_result {
                    self.visit_expr(else_result);
                }
            }
            Expr::Subquery(query) | Expr::Exists { subquery: query, .. } => self.visit_query(query),
            _ => {}
        }
    }

    fn visit_function_args(&mut self, args: &FunctionArguments) {
        match args {
            FunctionArguments::Subquery(query) => self.visit_query(query),
            FunctionArguments::List(list) => {
                for arg in &list.args {
                    self.visit_function_arg(arg);
                }
                for clause in &list.clauses {
                    if let sqlparser::ast::FunctionArgumentClause::OrderBy(items) = clause {
                        for item in items {
                            self.visit_expr(&item.expr);
                        }
                    }
                }
            }
            FunctionArguments::None => {}
        }
    }

    fn visit_function_arg(&mut self, arg: &FunctionArg) {
        match arg {
            FunctionArg::Named { arg, .. } | FunctionArg::ExprNamed { arg, .. } | FunctionArg::Unnamed(arg) => {
                if let FunctionArgExpr::Expr(expr) = arg {
                    self.visit_expr(expr);
                }
            }
        }
    }

    fn push_column(&mut self, qualifier: Option<String>, ident: &Ident) {
        self.columns.push(SqlColumnReference { name: ident.value.clone(), qualifier, span: ident.span.into() });
    }
}

fn table_reference_from_name(name: &ObjectName, alias: Option<String>) -> Option<SqlTableReference> {
    let parts: Vec<&Ident> = name.0.iter().filter_map(ObjectNamePart::as_ident).collect();
    let table = parts.last()?;
    let schema = if parts.len() >= 2 { parts.get(parts.len() - 2).map(|ident| ident.value.clone()) } else { None };

    Some(SqlTableReference { name: table.value.clone(), schema, alias, span: table.span.into() })
}

fn object_name_last_ident(name: &ObjectName) -> Option<&Ident> {
    name.0.iter().rev().find_map(ObjectNamePart::as_ident)
}
