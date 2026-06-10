// SQL → Elasticsearch `_search` DSL translator.
//
// ES SQL's `_sql` endpoint refuses several common shapes — `LIKE` on a `text`
// field with no `.keyword` sub-field, `SELECT *` returning an array field
// like `host.ip`, ... — even though the same intent is easy to express with
// the raw query DSL. So instead of delegating to ES SQL (or its
// `_sql/translate` cousin, which lives in the same engine), we parse the
// SQL ourselves with `sqlparser-rs` and emit a `_search` body.

use serde_json::{json, Map, Value as Json};
use sqlparser::ast::{
    BinaryOperator, Expr, OrderByExpr, OrderByKind, Query, Select, SelectItem, SetExpr, Statement, TableFactor,
    UnaryOperator, Value as SqlValue,
};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

const AUTO_PAGED_SELECT_STAR_SIZE: usize = 100;

pub struct TranslatedSelectStar {
    pub index: String,
    pub body: Json,
    /// User wrote `LIMIT N` (no OFFSET) — explicit row cap.
    pub user_limited: bool,
    /// SQL had OFFSET — signals this came from the pagination plan.
    pub from_plan_pagination: bool,
}

/// Try to translate a `SELECT * FROM <index> [WHERE …] [ORDER BY …]
/// [LIMIT N] [OFFSET M]` statement into a `_search` body.
///
/// Returns `Ok(None)` if the statement isn't a recognised `SELECT *` shape
/// (caller should fall back to a different path). Returns `Err` if it IS a
/// `SELECT *` but a clause is unsupported (so the caller surfaces a clear
/// error rather than silently downgrading).
pub fn translate_select_star(sql: &str) -> Result<Option<TranslatedSelectStar>, String> {
    let dialect = GenericDialect {};
    let statements = Parser::parse_sql(&dialect, sql).map_err(|e| format!("SQL parse error: {e}"))?;
    let Some(stmt) = statements.first() else {
        return Ok(None);
    };
    let Statement::Query(query) = stmt else {
        return Ok(None);
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Ok(None);
    };
    if !is_select_star(select) {
        return Ok(None);
    }
    let Some(index) = single_table_name(select)? else {
        return Ok(None);
    };

    let mut body: Map<String, Json> = Map::new();
    if let Some(where_expr) = &select.selection {
        body.insert("query".to_string(), translate_predicate(where_expr)?);
    }
    if let Some(order_by) = &query.order_by {
        if let OrderByKind::Expressions(items) = &order_by.kind {
            if let Some(sort) = translate_order_by(items)? {
                body.insert("sort".to_string(), sort);
            }
        }
    }

    let (limit, offset) = extract_limit_offset(query)?;
    let user_limited = limit.is_some() && offset.is_none();
    let from_plan_pagination = offset.is_some();
    let effective_size = limit.unwrap_or(AUTO_PAGED_SELECT_STAR_SIZE);
    let effective_from = offset.unwrap_or(0);
    body.insert("size".to_string(), json!(effective_size));
    if effective_from > 0 {
        body.insert("from".to_string(), json!(effective_from));
    }

    Ok(Some(TranslatedSelectStar { index, body: Json::Object(body), user_limited, from_plan_pagination }))
}

fn is_select_star(select: &Select) -> bool {
    select.projection.len() == 1 && matches!(select.projection.first(), Some(SelectItem::Wildcard(_)))
}

fn single_table_name(select: &Select) -> Result<Option<String>, String> {
    if select.from.len() != 1 {
        return Ok(None);
    }
    let table = &select.from[0];
    if !table.joins.is_empty() {
        return Err("JOINs are not supported in Elasticsearch SQL translation".to_string());
    }
    let TableFactor::Table { name, .. } = &table.relation else {
        return Ok(None);
    };
    let joined = name
        .0
        .iter()
        .map(|part| match part {
            sqlparser::ast::ObjectNamePart::Identifier(ident) => ident.value.clone(),
            other => format!("{other}"),
        })
        .collect::<Vec<_>>()
        .join(".");
    Ok(Some(joined))
}

fn translate_predicate(expr: &Expr) -> Result<Json, String> {
    match expr {
        Expr::Nested(inner) => translate_predicate(inner),
        Expr::BinaryOp { left, op, right } => translate_binary_op(left, op, right),
        Expr::Like { negated, expr, pattern, .. } | Expr::ILike { negated, expr, pattern, .. } => {
            translate_like(*negated, expr, pattern)
        }
        Expr::InList { expr, list, negated } => translate_in_list(expr, list, *negated),
        Expr::IsNull(inner) => translate_is_null(inner, false),
        Expr::IsNotNull(inner) => translate_is_null(inner, true),
        Expr::Between { expr, negated, low, high } => translate_between(expr, *negated, low, high),
        Expr::UnaryOp { op: UnaryOperator::Not, expr } => {
            let inner = translate_predicate(expr)?;
            Ok(json!({ "bool": { "must_not": [inner] } }))
        }
        other => Err(format!("Unsupported WHERE expression: {other}")),
    }
}

fn translate_binary_op(left: &Expr, op: &BinaryOperator, right: &Expr) -> Result<Json, String> {
    match op {
        BinaryOperator::And => {
            let mut must = Vec::new();
            collect_and(left, &mut must)?;
            collect_and(right, &mut must)?;
            Ok(json!({ "bool": { "must": must } }))
        }
        BinaryOperator::Or => {
            let mut should = Vec::new();
            collect_or(left, &mut should)?;
            collect_or(right, &mut should)?;
            Ok(json!({ "bool": { "should": should, "minimum_should_match": 1 } }))
        }
        BinaryOperator::Eq => term_clause(left, right),
        BinaryOperator::NotEq => {
            let inner = term_clause(left, right)?;
            Ok(json!({ "bool": { "must_not": [inner] } }))
        }
        BinaryOperator::Gt => range_clause(left, right, "gt"),
        BinaryOperator::Lt => range_clause(left, right, "lt"),
        BinaryOperator::GtEq => range_clause(left, right, "gte"),
        BinaryOperator::LtEq => range_clause(left, right, "lte"),
        other => Err(format!("Unsupported operator: {other}")),
    }
}

fn collect_and(expr: &Expr, out: &mut Vec<Json>) -> Result<(), String> {
    if let Expr::BinaryOp { left, op: BinaryOperator::And, right } = expr {
        collect_and(left, out)?;
        collect_and(right, out)?;
    } else {
        out.push(translate_predicate(expr)?);
    }
    Ok(())
}

fn collect_or(expr: &Expr, out: &mut Vec<Json>) -> Result<(), String> {
    if let Expr::BinaryOp { left, op: BinaryOperator::Or, right } = expr {
        collect_or(left, out)?;
        collect_or(right, out)?;
    } else {
        out.push(translate_predicate(expr)?);
    }
    Ok(())
}

fn term_clause(left: &Expr, right: &Expr) -> Result<Json, String> {
    let field = field_path(left)?;
    let value = literal_to_json(right)?;
    Ok(json!({ "term": { field: value } }))
}

fn range_clause(left: &Expr, right: &Expr, key: &str) -> Result<Json, String> {
    let field = field_path(left)?;
    let value = literal_to_json(right)?;
    Ok(json!({ "range": { field: { key: value } } }))
}

fn translate_like(negated: bool, expr: &Expr, pattern: &Expr) -> Result<Json, String> {
    let field = field_path(expr)?;
    let pattern_str = match literal_string(pattern)? {
        Some(s) => s,
        None => return Err("LIKE pattern must be a string literal".to_string()),
    };

    // Optimise the common `prefix%` shape into a `prefix` query — cheaper than
    // `wildcard` and supported on any analyzed text field.
    let is_prefix = !pattern_str.starts_with('%')
        && pattern_str.ends_with('%')
        && !pattern_str[..pattern_str.len() - 1].contains(['%', '_']);
    let query = if is_prefix {
        let prefix = &pattern_str[..pattern_str.len() - 1];
        json!({ "prefix": { field: prefix } })
    } else {
        let es_pattern = sql_like_to_wildcard(&pattern_str);
        json!({
            "wildcard": {
                field: { "value": es_pattern, "case_insensitive": true }
            }
        })
    };

    if negated {
        Ok(json!({ "bool": { "must_not": [query] } }))
    } else {
        Ok(query)
    }
}

fn translate_in_list(expr: &Expr, list: &[Expr], negated: bool) -> Result<Json, String> {
    let field = field_path(expr)?;
    let values: Vec<Json> = list.iter().map(literal_to_json).collect::<Result<_, _>>()?;
    let query = json!({ "terms": { field: values } });
    if negated {
        Ok(json!({ "bool": { "must_not": [query] } }))
    } else {
        Ok(query)
    }
}

fn translate_is_null(expr: &Expr, negated: bool) -> Result<Json, String> {
    let field = field_path(expr)?;
    let exists = json!({ "exists": { "field": field } });
    if negated {
        // IS NOT NULL → field exists
        Ok(exists)
    } else {
        Ok(json!({ "bool": { "must_not": [exists] } }))
    }
}

fn translate_between(expr: &Expr, negated: bool, low: &Expr, high: &Expr) -> Result<Json, String> {
    let field = field_path(expr)?;
    let lo = literal_to_json(low)?;
    let hi = literal_to_json(high)?;
    let query = json!({ "range": { field: { "gte": lo, "lte": hi } } });
    if negated {
        Ok(json!({ "bool": { "must_not": [query] } }))
    } else {
        Ok(query)
    }
}

fn translate_order_by(items: &[OrderByExpr]) -> Result<Option<Json>, String> {
    let mut sort = Vec::new();
    for item in items {
        let field = field_path(&item.expr)?;
        let order = if item.options.asc.unwrap_or(true) { "asc" } else { "desc" };
        sort.push(json!({ field: { "order": order } }));
    }
    if sort.is_empty() {
        Ok(None)
    } else {
        Ok(Some(Json::Array(sort)))
    }
}

fn extract_limit_offset(query: &Query) -> Result<(Option<usize>, Option<usize>), String> {
    let limit = match &query.limit_clause {
        Some(sqlparser::ast::LimitClause::LimitOffset { limit, .. }) => {
            limit.as_ref().map(usize_literal).transpose()?
        }
        _ => None,
    };
    let offset = match &query.limit_clause {
        Some(sqlparser::ast::LimitClause::LimitOffset { offset: Some(off), .. }) => Some(usize_literal(&off.value)?),
        _ => None,
    };
    Ok((limit, offset))
}

fn usize_literal(expr: &Expr) -> Result<usize, String> {
    match expr {
        Expr::Value(v) => match &v.value {
            SqlValue::Number(n, _) => n.parse::<usize>().map_err(|e| format!("Invalid number: {e}")),
            other => Err(format!("Expected integer literal, got {other:?}")),
        },
        other => Err(format!("Expected integer literal, got {other}")),
    }
}

fn field_path(expr: &Expr) -> Result<String, String> {
    match expr {
        Expr::Identifier(ident) => Ok(ident.value.clone()),
        Expr::CompoundIdentifier(parts) => Ok(parts.iter().map(|p| p.value.clone()).collect::<Vec<_>>().join(".")),
        other => Err(format!("Expected column name, got {other}")),
    }
}

fn literal_to_json(expr: &Expr) -> Result<Json, String> {
    let Expr::Value(v) = expr else {
        return Err(format!("Expected literal value, got {expr}"));
    };
    match &v.value {
        SqlValue::SingleQuotedString(s) | SqlValue::DoubleQuotedString(s) => Ok(Json::String(s.clone())),
        SqlValue::Number(n, _) => serde_json::from_str::<Json>(n).map_err(|e| format!("Invalid number {n}: {e}")),
        SqlValue::Boolean(b) => Ok(Json::Bool(*b)),
        SqlValue::Null => Ok(Json::Null),
        other => Err(format!("Unsupported literal: {other:?}")),
    }
}

fn literal_string(expr: &Expr) -> Result<Option<String>, String> {
    let Expr::Value(v) = expr else {
        return Err(format!("Expected string literal, got {expr}"));
    };
    Ok(match &v.value {
        SqlValue::SingleQuotedString(s) | SqlValue::DoubleQuotedString(s) => Some(s.clone()),
        _ => None,
    })
}

/// Convert SQL LIKE pattern to ES wildcard pattern.
/// SQL: `%` = any chars, `_` = single char. Backslash escapes both.
/// ES wildcard: `*` = any chars, `?` = single char. `\` escapes `*` / `?` / `\`.
fn sql_like_to_wildcard(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut chars = pattern.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                if let Some(&next) = chars.peek() {
                    out.push(next);
                    chars.next();
                }
            }
            '%' => out.push('*'),
            '_' => out.push('?'),
            '*' | '?' => {
                // Escape ES wildcard metacharacters that the user wrote literally.
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}
