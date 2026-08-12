use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
use sqlparser::keywords::Keyword;
use sqlparser::parser::{Parser, ParserError};
use sqlparser::tokenizer::{Span, Token, TokenWithSpan, Tokenizer};

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
    pub scopes: Vec<SqlReferenceScope>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqlTableReference {
    pub name: String,
    pub schema: Option<String>,
    pub alias: Option<String>,
    pub span: SqlTextSpan,
    pub scope_id: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqlColumnReference {
    pub name: String,
    pub qualifier: Option<String>,
    pub span: SqlTextSpan,
    pub scope_id: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqlReferenceScope {
    pub id: usize,
    pub parent_id: Option<usize>,
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
    scopes: Vec<SqlReferenceScope>,
    scope_stack: Vec<usize>,
    cte_scope_stack: Vec<HashSet<String>>,
    next_scope_id: usize,
    is_sqlserver: bool,
}

pub fn analyze_sql_references(sql: &str, dialect: Option<&str>) -> Result<SqlReferenceAnalysis, String> {
    let normalized_dialect = normalize_dialect(dialect);
    if normalized_dialect == "duckdb" && starts_with_duckdb_parser_gap_sql(sql) {
        return Ok(SqlReferenceAnalysis { tables: vec![], columns: vec![], scopes: vec![] });
    }
    if normalized_dialect == "postgres" && starts_with_postgres_parser_gap_sql(sql) {
        return Ok(SqlReferenceAnalysis { tables: vec![], columns: vec![], scopes: vec![] });
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
        "sqlserver" => parse_sqlserver(&parser_sql),
        "clickhouse" => Parser::parse_sql(&ClickHouseDialect {}, &parser_sql),
        "duckdb" => Parser::parse_sql(&DuckDbDialect {}, &parser_sql),
        _ => Parser::parse_sql(&GenericDialect {}, &parser_sql),
    }
    .map_err(|err| err.to_string())?;

    let mut analyzer = Analyzer { is_sqlserver: normalized_dialect == "sqlserver", ..Analyzer::default() };
    for statement in statements {
        analyzer.visit_statement(&statement);
    }

    Ok(SqlReferenceAnalysis { tables: analyzer.tables, columns: analyzer.columns, scopes: analyzer.scopes })
}

fn parse_sqlserver(sql: &str) -> Result<Vec<Statement>, ParserError> {
    let dialect = MsSqlDialect {};
    let mut tokens = Tokenizer::new(&dialect, sql).tokenize_with_location()?;
    normalize_sqlserver_create_proc_tokens(&mut tokens);
    match Parser::new(&dialect).with_tokens_with_locations(tokens).parse_statements() {
        Ok(statements) => Ok(statements),
        Err(error) => {
            let mut fallback_tokens = Tokenizer::new(&dialect, sql).tokenize_with_location()?;
            normalize_sqlserver_create_proc_tokens(&mut fallback_tokens);
            let mut changed = normalize_sqlserver_cursor_tokens(&mut fallback_tokens);
            changed |= normalize_sqlserver_alter_table_add_tokens(&mut fallback_tokens);
            changed |= remove_sqlserver_query_hint_tokens(&mut fallback_tokens);
            if changed {
                if let Ok(statements) =
                    Parser::new(&dialect).with_tokens_with_locations(fallback_tokens).parse_statements()
                {
                    return Ok(statements);
                }
            }
            Err(error)
        }
    }
}

fn normalize_sqlserver_cursor_tokens(tokens: &mut Vec<TokenWithSpan>) -> bool {
    let mut removals = Vec::new();
    let mut index = 0usize;

    while let Some(statement_start) = next_significant_token_index(tokens, index) {
        if matches!(tokens[statement_start].token, Token::EOF) {
            break;
        }
        if matches!(tokens[statement_start].token, Token::SemiColon) {
            index = statement_start + 1;
            continue;
        }

        let statement_end = sqlserver_statement_end_index(tokens, statement_start);
        let significant_indexes = tokens
            .iter()
            .enumerate()
            .take(statement_end)
            .skip(statement_start)
            .filter_map(|(index, token)| (!matches!(token.token, Token::Whitespace(_))).then_some(index))
            .collect::<Vec<_>>();

        if let Some(removal) = sqlserver_cursor_option_removal(tokens, &significant_indexes) {
            removals.push(removal);
        }

        index = statement_end.saturating_add(1);
    }

    let changed = !removals.is_empty();
    for removal in removals.into_iter().rev() {
        tokens.drain(removal);
    }
    changed
}

fn sqlserver_cursor_option_removal(tokens: &[TokenWithSpan], indexes: &[usize]) -> Option<std::ops::Range<usize>> {
    if indexes.len() < 4
        || !unquoted_token_word_eq(&tokens[indexes[0]], "DECLARE")
        || !is_sqlserver_named_cursor(&tokens[indexes[1]])
        || !unquoted_token_word_eq(&tokens[indexes[2]], "CURSOR")
    {
        return None;
    }

    let mut position = 3usize;
    if indexes.get(position).is_some_and(|index| {
        unquoted_token_word_eq(&tokens[*index], "LOCAL") || unquoted_token_word_eq(&tokens[*index], "GLOBAL")
    }) {
        position += 1;
    }
    if indexes.get(position).is_some_and(|index| unquoted_token_word_eq(&tokens[*index], "FAST_FORWARD")) {
        position += 1;
    }
    if position == 3 || !indexes.get(position).is_some_and(|index| unquoted_token_word_eq(&tokens[*index], "FOR")) {
        return None;
    }

    let query_position = position + 1;
    let query_start = *indexes.get(query_position)?;
    if (!unquoted_token_word_eq(&tokens[query_start], "SELECT")
        && !unquoted_token_word_eq(&tokens[query_start], "WITH"))
        || sqlserver_cursor_query_has_forbidden_clause(tokens, &indexes[query_position..])
    {
        return None;
    }

    Some(indexes[3]..indexes[position])
}

fn is_sqlserver_named_cursor(token: &TokenWithSpan) -> bool {
    let Token::Word(word) = &token.token else {
        return false;
    };
    !word.value.starts_with('@') && (word.quote_style.is_some() || word.keyword == Keyword::NoKeyword)
}

fn sqlserver_cursor_query_has_forbidden_clause(tokens: &[TokenWithSpan], indexes: &[usize]) -> bool {
    let mut depth = 0usize;
    for (position, index) in indexes.iter().copied().enumerate() {
        match tokens[index].token {
            Token::LParen => depth += 1,
            Token::RParen => depth = depth.saturating_sub(1),
            _ if depth == 0
                && (unquoted_token_word_eq(&tokens[index], "INTO")
                    || unquoted_token_word_eq(&tokens[index], "COMPUTE")
                    || unquoted_token_word_eq(&tokens[index], "FOR")
                        && indexes
                            .get(position + 1)
                            .is_some_and(|index| unquoted_token_word_eq(&tokens[*index], "BROWSE"))) =>
            {
                return true;
            }
            _ => {}
        }
    }
    false
}

fn unquoted_token_word_eq(token: &TokenWithSpan, expected: &str) -> bool {
    matches!(&token.token, Token::Word(word) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(expected))
}

fn normalize_sqlserver_alter_table_add_tokens(tokens: &mut Vec<TokenWithSpan>) -> bool {
    let mut insertions = Vec::new();
    let mut index = 0usize;

    while index < tokens.len() {
        if unquoted_token_keyword(&tokens[index]) != Some(Keyword::ALTER) {
            index += 1;
            continue;
        }
        let Some(table_index) = next_significant_token_index(tokens, index + 1) else {
            break;
        };
        if unquoted_token_keyword(&tokens[table_index]) != Some(Keyword::TABLE) {
            index += 1;
            continue;
        }

        let statement_end = sqlserver_statement_end_index(tokens, table_index + 1);
        let Some(add_index) = sqlserver_alter_table_add_index(tokens, table_index + 1, statement_end) else {
            index = statement_end.saturating_add(1);
            continue;
        };
        let add_token = tokens[add_index].clone();
        let mut depth = 0usize;
        for token_index in add_index + 1..statement_end {
            match tokens[token_index].token {
                Token::LParen => depth += 1,
                Token::RParen => depth = depth.saturating_sub(1),
                Token::Comma if depth == 0 => {
                    let Some(next_index) = next_significant_token_index(tokens, token_index + 1) else {
                        continue;
                    };
                    if next_index >= statement_end {
                        continue;
                    }
                    if is_sqlserver_alter_table_operation_starter(&tokens[next_index]) {
                        break;
                    }
                    insertions.push((next_index, add_token.clone()));
                }
                _ => {}
            }
        }
        index = statement_end.saturating_add(1);
    }

    let changed = !insertions.is_empty();
    for (index, token) in insertions.into_iter().rev() {
        tokens.insert(index, token);
    }
    changed
}

fn sqlserver_statement_end_index(tokens: &[TokenWithSpan], start: usize) -> usize {
    let mut depth = 0usize;
    for (index, token) in tokens.iter().enumerate().skip(start) {
        match token.token {
            Token::LParen => depth += 1,
            Token::RParen => depth = depth.saturating_sub(1),
            Token::SemiColon | Token::EOF if depth == 0 => return index,
            _ => {}
        }
    }
    tokens.len()
}

fn sqlserver_alter_table_add_index(tokens: &[TokenWithSpan], start: usize, end: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (index, token) in tokens.iter().enumerate().take(end).skip(start) {
        match token.token {
            Token::LParen => depth += 1,
            Token::RParen => depth = depth.saturating_sub(1),
            _ if depth == 0 && unquoted_token_keyword(token) == Some(Keyword::ADD) => return Some(index),
            _ => {}
        }
    }
    None
}

fn is_sqlserver_alter_table_operation_starter(token: &TokenWithSpan) -> bool {
    let Token::Word(word) = &token.token else {
        return false;
    };
    if word.quote_style.is_some() {
        return false;
    }

    matches!(
        word.value.to_ascii_uppercase().as_str(),
        "ADD"
            | "ALTER"
            | "DISABLE"
            | "DROP"
            | "ENABLE"
            | "NOCHECK"
            | "PARTITION"
            | "REBUILD"
            | "RENAME"
            | "REPLICA"
            | "SET"
            | "SWAP"
            | "SWITCH"
    )
}

fn remove_sqlserver_query_hint_tokens(tokens: &mut Vec<TokenWithSpan>) -> bool {
    let mut depth = 0usize;
    let mut ranges = Vec::new();

    for index in 0..tokens.len() {
        match &tokens[index].token {
            Token::LParen => depth += 1,
            Token::RParen => depth = depth.saturating_sub(1),
            Token::Word(word)
                if depth == 0 && word.quote_style.is_none() && word.value.eq_ignore_ascii_case("OPTION") =>
            {
                if let Some(range) = sqlserver_query_hint_range(tokens, index) {
                    if sqlserver_query_hint_removal_parses_statement(tokens, range) {
                        ranges.push(range);
                    }
                }
            }
            _ => {}
        }
    }

    let removed = !ranges.is_empty();
    for (start, end) in ranges.into_iter().rev() {
        tokens.drain(start..=end);
    }
    removed
}

fn sqlserver_query_hint_removal_parses_statement(tokens: &[TokenWithSpan], range: (usize, usize)) -> bool {
    let statement_start = tokens[..range.0]
        .iter()
        .rposition(|token| matches!(token.token, Token::SemiColon))
        .map_or(0, |index| index + 1);
    let statement_end = next_significant_token_index(tokens, range.1 + 1).unwrap_or(tokens.len() - 1);
    let mut statement_tokens = tokens[statement_start..=statement_end].to_vec();

    if parse_sqlserver_tokens(statement_tokens.clone()).is_ok() {
        return false;
    }

    statement_tokens.drain(range.0 - statement_start..=range.1 - statement_start);
    parse_sqlserver_tokens(statement_tokens).is_ok()
}

fn parse_sqlserver_tokens(tokens: Vec<TokenWithSpan>) -> Result<Vec<Statement>, ParserError> {
    Parser::new(&MsSqlDialect {}).with_tokens_with_locations(tokens).parse_statements()
}

fn sqlserver_query_hint_range(tokens: &[TokenWithSpan], option_index: usize) -> Option<(usize, usize)> {
    let open_index = next_significant_token_index(tokens, option_index + 1)?;
    if !matches!(tokens[open_index].token, Token::LParen) {
        return None;
    }

    let close_index = matching_parenthesis_index(tokens, open_index)?;
    let hint_index = next_significant_token_index(tokens, open_index + 1)?;
    if hint_index >= close_index || !is_sqlserver_query_hint_starter(&tokens[hint_index]) {
        return None;
    }

    if let Some(next_index) = next_significant_token_index(tokens, close_index + 1) {
        if !matches!(tokens[next_index].token, Token::SemiColon | Token::EOF) {
            return None;
        }
    }

    Some((option_index, close_index))
}

fn next_significant_token_index(tokens: &[TokenWithSpan], mut index: usize) -> Option<usize> {
    while index < tokens.len() {
        if !matches!(tokens[index].token, Token::Whitespace(_)) {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn matching_parenthesis_index(tokens: &[TokenWithSpan], open_index: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (index, token) in tokens.iter().enumerate().skip(open_index) {
        match token.token {
            Token::LParen => depth += 1,
            Token::RParen => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn is_sqlserver_query_hint_starter(token: &TokenWithSpan) -> bool {
    let Token::Word(word) = &token.token else {
        return false;
    };
    if word.quote_style.is_some() {
        return false;
    }

    matches!(
        word.value.to_ascii_uppercase().as_str(),
        "CONCAT"
            | "DISABLE"
            | "DISABLE_OPTIMIZED_PLAN_FORCING"
            | "EXPAND"
            | "FAST"
            | "FOR"
            | "FORCE"
            | "HASH"
            | "IGNORE_NONCLUSTERED_COLUMNSTORE_INDEX"
            | "KEEP"
            | "KEEPFIXED"
            | "LABEL"
            | "LOOP"
            | "MAX_GRANT_PERCENT"
            | "MAXDOP"
            | "MAXRECURSION"
            | "MERGE"
            | "MIN_GRANT_PERCENT"
            | "NO_PERFORMANCE_SPOOL"
            | "OPTIMIZE"
            | "ORDER"
            | "PARAMETERIZATION"
            | "QUERYTRACEON"
            | "RECOMPILE"
            | "ROBUST"
            | "TABLE"
            | "USE"
    )
}

fn normalize_sqlserver_create_proc_tokens(tokens: &mut [TokenWithSpan]) {
    let significant_indexes: Vec<usize> = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (!matches!(token.token, Token::Whitespace(_))).then_some(index))
        .collect();

    for (position, index) in significant_indexes.iter().copied().enumerate() {
        if token_keyword(&tokens[index]) != Some(Keyword::CREATE) {
            continue;
        }

        let mut proc_position = position + 1;
        if significant_indexes.get(proc_position).and_then(|index| token_keyword(&tokens[*index])) == Some(Keyword::OR)
        {
            proc_position += 1;
            if significant_indexes.get(proc_position).and_then(|index| token_keyword(&tokens[*index]))
                != Some(Keyword::ALTER)
            {
                continue;
            }
            proc_position += 1;
        }

        let Some(proc_index) = significant_indexes.get(proc_position).copied() else {
            continue;
        };
        let Token::Word(word) = &mut tokens[proc_index].token else {
            continue;
        };
        // SQL Server documents PROC as a contextual synonym for PROCEDURE after CREATE.
        if word.quote_style.is_none() && word.value.eq_ignore_ascii_case("proc") {
            word.keyword = Keyword::PROCEDURE;
        }
    }
}

fn token_keyword(token: &TokenWithSpan) -> Option<Keyword> {
    match &token.token {
        Token::Word(word) => Some(word.keyword),
        _ => None,
    }
}

fn unquoted_token_keyword(token: &TokenWithSpan) -> Option<Keyword> {
    match &token.token {
        Token::Word(word) if word.quote_style.is_none() => Some(word.keyword),
        _ => None,
    }
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
        "postgres" | "postgresql" | "redshift" | "opengauss" | "gaussdb" | "highgo" | "uxdb" | "questdb" => {
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
        match statement {
            Statement::Query(query) => self.visit_query_in_new_scope(query, None),
            Statement::Declare { stmts } if self.is_sqlserver => {
                for declaration in stmts {
                    if let Some(query) = &declaration.for_query {
                        self.visit_query_in_new_scope(query, None);
                    }
                }
            }
            _ => {}
        }
    }

    fn visit_query_in_new_scope(&mut self, query: &Query, parent_id: Option<usize>) {
        let scope_id = self.next_scope_id;
        self.next_scope_id += 1;
        self.scopes.push(SqlReferenceScope { id: scope_id, parent_id });
        self.scope_stack.push(scope_id);
        self.cte_scope_stack.push(HashSet::new());
        self.visit_query(query);
        self.cte_scope_stack.pop();
        self.scope_stack.pop();
    }

    fn visit_child_query(&mut self, query: &Query) {
        self.visit_query_in_new_scope(query, self.current_scope_id());
    }

    fn current_scope_id(&self) -> Option<usize> {
        self.scope_stack.last().copied()
    }

    fn add_visible_cte(&mut self, ident: &Ident) {
        let key = self.cte_name_key(ident);
        if let Some(visible_ctes) = self.cte_scope_stack.last_mut() {
            visible_ctes.insert(key);
        }
    }

    fn is_visible_cte(&self, name: &ObjectName) -> bool {
        if name.0.len() != 1 {
            return false;
        }
        let Some(ident) = name.0.first().and_then(ObjectNamePart::as_ident) else {
            return false;
        };
        let key = self.cte_name_key(ident);
        self.cte_scope_stack.iter().rev().any(|visible_ctes| visible_ctes.contains(&key))
    }

    fn cte_name_key(&self, ident: &Ident) -> String {
        if self.is_sqlserver || ident.quote_style.is_none() {
            ident.value.to_ascii_lowercase()
        } else {
            ident.value.clone()
        }
    }

    fn visit_query(&mut self, query: &Query) {
        if let Some(with) = &query.with {
            for cte in &with.cte_tables {
                // Add each name before its body: recursive/self and earlier CTEs are visible, later CTEs are not.
                self.add_visible_cte(&cte.alias.name);
                self.visit_child_query(&cte.query);
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
            SetExpr::Query(query) => self.visit_child_query(query),
            SetExpr::SetOperation { left, right, .. } => {
                self.visit_set_expr_in_child_scope(left);
                self.visit_set_expr_in_child_scope(right);
            }
            _ => {}
        }
    }

    fn visit_set_expr_in_child_scope(&mut self, set_expr: &SetExpr) {
        let scope_id = self.next_scope_id;
        self.next_scope_id += 1;
        self.scopes.push(SqlReferenceScope { id: scope_id, parent_id: self.current_scope_id() });
        self.scope_stack.push(scope_id);
        self.visit_set_expr(set_expr);
        self.scope_stack.pop();
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
                // Qualified names remain physical objects even when their final component matches a visible CTE.
                if args.is_none() && !self.is_visible_cte(name) {
                    if let Some(table) = table_reference_from_name(
                        name,
                        alias.as_ref().map(|a| a.name.value.clone()),
                        self.current_scope_id(),
                    ) {
                        self.tables.push(table);
                    }
                }
            }
            TableFactor::Derived { subquery, .. } => self.visit_child_query(subquery),
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
                self.visit_child_query(subquery);
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
                self.visit_function_call_args(&function.name, &function.args);
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
            Expr::Subquery(query) | Expr::Exists { subquery: query, .. } => self.visit_child_query(query),
            _ => {}
        }
    }

    fn visit_function_args(&mut self, args: &FunctionArguments) {
        self.visit_function_args_skipping(args, |_, _| false);
    }

    fn visit_function_call_args(&mut self, name: &ObjectName, args: &FunctionArguments) {
        let sqlserver_datepart_function = self.is_sqlserver.then(|| sqlserver_datepart_function_name(name)).flatten();
        self.visit_function_args_skipping(args, |index, arg| {
            index == 0
                && sqlserver_datepart_function
                    .is_some_and(|function_name| is_sqlserver_datepart_argument(function_name, arg))
        });
    }

    fn visit_function_args_skipping(
        &mut self,
        args: &FunctionArguments,
        mut should_skip: impl FnMut(usize, &FunctionArg) -> bool,
    ) {
        match args {
            FunctionArguments::Subquery(query) => self.visit_child_query(query),
            FunctionArguments::List(list) => {
                for (index, arg) in list.args.iter().enumerate() {
                    if !should_skip(index, arg) {
                        self.visit_function_arg(arg);
                    }
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
        if let Some(scope_id) = self.current_scope_id() {
            self.columns.push(SqlColumnReference {
                name: ident.value.clone(),
                qualifier,
                span: ident.span.into(),
                scope_id,
            });
        }
    }
}

fn table_reference_from_name(
    name: &ObjectName,
    alias: Option<String>,
    scope_id: Option<usize>,
) -> Option<SqlTableReference> {
    let parts: Vec<&Ident> = name.0.iter().filter_map(ObjectNamePart::as_ident).collect();
    let table = parts.last()?;
    let schema = if parts.len() >= 2 { parts.get(parts.len() - 2).map(|ident| ident.value.clone()) } else { None };

    Some(SqlTableReference { name: table.value.clone(), schema, alias, span: table.span.into(), scope_id: scope_id? })
}

fn object_name_last_ident(name: &ObjectName) -> Option<&Ident> {
    name.0.iter().rev().find_map(ObjectNamePart::as_ident)
}

fn sqlserver_datepart_function_name(name: &ObjectName) -> Option<&str> {
    if name.0.len() != 1 {
        return None;
    }

    let ident = name.0.first()?.as_ident()?;
    ["DATEADD", "DATEDIFF", "DATEDIFF_BIG", "DATEPART", "DATENAME"]
        .iter()
        .copied()
        .find(|function_name| ident.value.eq_ignore_ascii_case(function_name))
}

fn is_sqlserver_datepart_argument(function_name: &str, arg: &FunctionArg) -> bool {
    let FunctionArg::Unnamed(FunctionArgExpr::Expr(Expr::Identifier(ident))) = arg else {
        return false;
    };
    if ident.quote_style.is_some() {
        return false;
    }

    // SQL Server parses datepart tokens as identifiers, but these built-ins treat the first token as grammar, not a column.
    let datepart = ident.value.as_str();
    let common_datepart = is_datepart(
        datepart,
        &[
            "year",
            "yy",
            "yyyy",
            "quarter",
            "qq",
            "q",
            "month",
            "mm",
            "m",
            "dayofyear",
            "dy",
            "y",
            "day",
            "dd",
            "d",
            "week",
            "wk",
            "ww",
            "hour",
            "hh",
            "minute",
            "mi",
            "n",
            "second",
            "ss",
            "s",
            "millisecond",
            "ms",
            "microsecond",
            "mcs",
            "nanosecond",
            "ns",
        ],
    );
    let weekday_datepart = is_datepart(datepart, &["weekday", "dw", "w"]);
    let extended_datepart = is_datepart(datepart, &["tzoffset", "tz", "iso_week", "isowk", "isoww"]);

    match function_name {
        "DATEADD" | "DATEDIFF" | "DATEDIFF_BIG" => common_datepart || weekday_datepart,
        "DATEPART" => common_datepart || weekday_datepart || extended_datepart,
        "DATENAME" => common_datepart || weekday_datepart || extended_datepart,
        _ => false,
    }
}

fn is_datepart(value: &str, valid_dateparts: &[&str]) -> bool {
    valid_dateparts.iter().any(|datepart| value.eq_ignore_ascii_case(datepart))
}
