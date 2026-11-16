//! 「预览变更」SQL 生成：把 SQL 编辑器里的一条 DML（UPDATE / INSERT / DELETE）
//! 改写成一条只读 SELECT，用于在执行前干跑预览受影响的数据。
//!
//! 思路：不手工重建 sqlparser AST，而是复用 sqlparser 对表达式 / 表 / WHERE 的
//! 方言正确渲染（`Display` round-trip），只在外层做字符串装配：
//!   UPDATE t SET a = 123 WHERE id = 1
//!     → SELECT *, 123 AS "a (new)" FROM t WHERE id = 1
//! `SELECT *` 展开受影响行全部当前值，新值列（别名后缀 ` (new)`）追加在末尾；
//! SET 表达式直接搬运（在行上下文中按旧值求值即得新值，`SET a = a + 1` 也能算对）。
//! 注意：SET / VALUES 表达式会在预览 SELECT 中重新求值，带副作用的表达式
//! （推进序列、volatile 函数）在预览中同样生效，非确定性函数的预览值可能与实际执行不同。
//!
//! 无法安全改写的语句返回 Err（错误信息为英文，前端直接以 toast 展示，仍可正常执行原语句）。

use sqlparser::ast::{AssignmentTarget, Expr, Ident, ObjectNamePart, SetExpr, Statement, TableWithJoins};
use sqlparser::dialect::{
    ClickHouseDialect, DuckDbDialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect,
    SparkSqlDialect,
};
use sqlparser::parser::Parser;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmlChangePreviewSqlOptions {
    /// 用户写的一条 DML 语句（通常是当前语句）。
    pub sql: String,
    /// 连接类型（决定解析方言 / 默认标识符引号）。
    pub database_type: Option<String>,
    /// 连接的标识符引号字符（如 `"`、`` ` ``、`[`），None 时按方言回退。
    pub identifier_quote: Option<String>,
    /// 目标表的列（按 ordinal 顺序）。提供且为单表 UPDATE 时，新值列紧跟其原值列。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmlChangePreviewTableRef {
    pub catalog: Option<String>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmlChangePreviewSqlResult {
    /// 生成的只读 SELECT。
    pub sql: String,
    /// 语句类型：update / insert / delete。
    pub operation: String,
    /// 是否有「新值」列（仅 UPDATE 有，INSERT 的列本身即新值）。
    pub has_new_value_columns: bool,
    /// 语句目标表引用（供前端拉取列元数据以交错展示新值列）。
    pub tables: Vec<DmlChangePreviewTableRef>,
}

fn normalize_dialect(database_type: Option<&str>) -> &'static str {
    match database_type.unwrap_or("generic").to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" | "redshift" | "opengauss" | "gaussdb" | "highgo" | "uxdb" | "questdb" => "postgres",
        "mysql" | "mariadb" | "doris" | "starrocks" | "manticoresearch" | "oceanbase" | "tidb" => "mysql",
        "sqlite" => "sqlite",
        "sqlserver" | "mssql" => "sqlserver",
        "clickhouse" => "clickhouse",
        "duckdb" => "duckdb",
        "spark" | "sparksql" => "spark",
        _ => "generic",
    }
}

fn parse_statements(sql: &str, dialect_key: &str) -> Result<Vec<Statement>, String> {
    match dialect_key {
        "postgres" => Parser::parse_sql(&PostgreSqlDialect {}, sql),
        "mysql" => Parser::parse_sql(&MySqlDialect {}, sql),
        "sqlite" => Parser::parse_sql(&SQLiteDialect {}, sql),
        "sqlserver" => Parser::parse_sql(&MsSqlDialect {}, sql),
        "clickhouse" => Parser::parse_sql(&ClickHouseDialect {}, sql),
        "duckdb" => Parser::parse_sql(&DuckDbDialect {}, sql),
        "spark" => Parser::parse_sql(&SparkSqlDialect {}, sql),
        _ => Parser::parse_sql(&GenericDialect {}, sql),
    }
    .map_err(|error| format!("Failed to parse the statement: {error}"))
}

fn quote_identifier(name: &str, quote: Option<&str>, dialect_key: &str) -> String {
    if let Some(value) = quote {
        if value == "`" || value == "\"" || value == "'" {
            return format!("{value}{name}{value}");
        }
        if value == "[" {
            return format!("[{name}]");
        }
    }
    match dialect_key {
        "mysql" => format!("`{name}`"),
        _ => format!("\"{name}\""),
    }
}

/// 从赋值目标里取出列名（`t.a` → `a`）。
fn assignment_target_column(target: &AssignmentTarget) -> Option<&Ident> {
    match target {
        AssignmentTarget::ColumnName(object_name) => object_name.0.last().and_then(ObjectNamePart::as_ident),
        AssignmentTarget::Tuple(_) => None,
    }
}

fn unsupported(reason: &str) -> String {
    format!("Preview is not supported: {reason}")
}

/// UPDATE → SELECT <列交错展开> FROM … WHERE …
///
/// 提供目标表列清单且为单表时，按「原列, 原列 (new)」逐列交错展开，使新值列紧跟
/// 其原值列；否则退化为 `SELECT *, <SET 表达式> AS "列 (new)", …`（追加在末尾）。
fn build_update_preview(
    update: &sqlparser::ast::Update,
    dialect_key: &str,
    quote: Option<&str>,
    columns: Option<&[String]>,
) -> Result<String, String> {
    // 收集 SET 新值表达式：同列重复赋值取最后一次，但保持首次出现的列序。
    #[derive(Clone)]
    struct SetItem {
        column: String,
        expr: String,
    }
    let mut set_items: Vec<SetItem> = Vec::new();
    let mut set_order: Vec<String> = Vec::new(); // 小写列名 → 顺序
    for assignment in &update.assignments {
        let Some(column) = assignment_target_column(&assignment.target) else {
            return Err(unsupported("UPDATE assignment target is not a single column"));
        };
        let column_name = column.value.clone();
        let key = column_name.to_lowercase();
        if let Some(position) = set_order.iter().position(|existing| *existing == key) {
            set_order.remove(position);
            set_items.remove(position);
        }
        set_order.push(key);
        set_items.push(SetItem { column: column_name, expr: assignment.value.to_string() });
    }

    // Postgres `UPDATE … FROM …`：同一目标行可能匹配多行来源，真实 UPDATE 只更新一次，
    // 而改写出的 SELECT 会把该行显示多次（跨连接重复计数），直接拒绝预览。
    if let Some(from_kind) = &update.from {
        let extra_count = match from_kind {
            sqlparser::ast::UpdateTableFromKind::BeforeSet(list)
            | sqlparser::ast::UpdateTableFromKind::AfterSet(list) => list.len(),
        };
        if extra_count > 0 {
            return Err(unsupported("UPDATE ... FROM"));
        }
    }
    let from_sql = update.table.to_string();

    let render_new_value = |item: &SetItem| -> String {
        format!("{} AS {}", item.expr, quote_identifier(&format!("{} (new)", item.column), quote, dialect_key))
    };
    let append_items: Vec<String> = set_items.iter().map(render_new_value).collect();

    // 单表 + 提供了列清单 → 交错展开（新值列紧跟原值列）。
    let single_table = update.table.joins.is_empty() && update.from.is_none();
    let select_items = if single_table {
        match columns {
            Some(column_list) if !column_list.is_empty() => {
                let mut projection: Vec<String> = Vec::new();
                let mut placed: Vec<String> = Vec::new();
                for column in column_list {
                    projection.push(quote_identifier(column, quote, dialect_key));
                    let key = column.to_lowercase();
                    if let Some(position) = set_order.iter().position(|existing| *existing == key) {
                        projection.push(render_new_value(&set_items[position]));
                        placed.push(key);
                    }
                }
                // SET 列未在列清单中（大小写差异 / 虚拟列等）追加到末尾，避免遗漏。
                for (index, key) in set_order.iter().enumerate() {
                    if !placed.contains(key) {
                        projection.push(render_new_value(&set_items[index]));
                    }
                }
                projection.join(", ")
            }
            _ => {
                if append_items.is_empty() {
                    "*".to_string()
                } else {
                    format!("*, {}", append_items.join(", "))
                }
            }
        }
    } else if append_items.is_empty() {
        "*".to_string()
    } else {
        format!("*, {}", append_items.join(", "))
    };

    let mut sql = format!("SELECT {select_items} FROM {from_sql}");
    if let Some(selection) = &update.selection {
        sql.push_str(&format!(" WHERE {selection}"));
    }
    if !update.order_by.is_empty() {
        let order_by = update.order_by.iter().map(|item| item.to_string()).collect::<Vec<_>>().join(", ");
        sql.push_str(&format!(" ORDER BY {order_by}"));
    }
    if let Some(limit) = &update.limit {
        sql.push_str(&format!(" LIMIT {limit}"));
    }
    Ok(sql)
}

/// INSERT … VALUES → SELECT 值行 UNION ALL …（列名来自插入列，直观展示即将插入的行）。
fn build_insert_preview(
    insert: &sqlparser::ast::Insert,
    dialect_key: &str,
    quote: Option<&str>,
) -> Result<String, String> {
    // MySQL `INSERT INTO t SET a=1, b=2`
    if !insert.assignments.is_empty() {
        let items: Vec<String> = insert
            .assignments
            .iter()
            .map(|assignment| {
                let col = assignment_target_column(&assignment.target)
                    .ok_or_else(|| unsupported("INSERT ... SET assignment target is not a single column"))?;
                Ok(format!("{} AS {}", assignment.value, quote_identifier(&col.value, quote, dialect_key)))
            })
            .collect::<Result<Vec<_>, String>>()?;
        if items.is_empty() {
            return Err(unsupported("INSERT ... SET has no assignments"));
        }
        return Ok(format!("SELECT {}", items.join(", ")));
    }

    let Some(source) = &insert.source else {
        return Err(unsupported("INSERT has no source"));
    };

    match source.body.as_ref() {
        SetExpr::Values(values) => {
            let column_names: Vec<String> = insert
                .columns
                .iter()
                .filter_map(|column| {
                    column.0.last().and_then(ObjectNamePart::as_ident).map(|ident| ident.value.clone())
                })
                .collect();
            if !column_names.is_empty() && values.rows.iter().any(|row| row.content.len() != column_names.len()) {
                return Err(unsupported("INSERT VALUES row length does not match the column list"));
            }
            let render_row = |row_exprs: &[Expr]| -> String {
                let cells: Vec<String> = row_exprs
                    .iter()
                    .enumerate()
                    .map(|(index, expr)| {
                        let expr_text = expr.to_string();
                        if column_names.is_empty() {
                            expr_text
                        } else {
                            format!("{expr_text} AS {}", quote_identifier(&column_names[index], quote, dialect_key))
                        }
                    })
                    .collect();
                format!("SELECT {}", cells.join(", "))
            };
            let rows = values.rows.iter().collect::<Vec<_>>();
            let Some(first) = rows.first() else {
                return Err(unsupported("INSERT VALUES is empty"));
            };
            let mut sql = render_row(&first.content);
            for row in rows.iter().skip(1) {
                sql.push_str(" UNION ALL ");
                sql.push_str(&render_row(&row.content));
            }
            Ok(sql)
        }
        _ => {
            // INSERT … SELECT：预览 = 源查询（即将会插入的行）。
            Ok(source.to_string())
        }
    }
}

/// DELETE → SELECT * FROM … WHERE …（标明将删除的行；无「新值」列）。
fn build_delete_preview(
    delete: &sqlparser::ast::Delete,
    _dialect_key: &str,
    _quote: Option<&str>,
) -> Result<String, String> {
    let from_sql = match &delete.from {
        sqlparser::ast::FromTable::WithFromKeyword(tables) | sqlparser::ast::FromTable::WithoutKeyword(tables) => {
            tables.iter().map(|table: &TableWithJoins| table.to_string()).collect::<Vec<_>>().join(", ")
        }
    };
    if from_sql.is_empty() {
        return Err(unsupported("DELETE has no FROM"));
    }
    let mut sql = format!("SELECT * FROM {from_sql}");
    if let Some(using) = &delete.using {
        if !using.is_empty() {
            let using_sql = using.iter().map(|table| table.to_string()).collect::<Vec<_>>().join(", ");
            sql.push_str(&format!(", {using_sql}"));
        }
    }
    if let Some(selection) = &delete.selection {
        sql.push_str(&format!(" WHERE {selection}"));
    }
    if !delete.order_by.is_empty() {
        let order_by = delete.order_by.iter().map(|item| item.to_string()).collect::<Vec<_>>().join(", ");
        sql.push_str(&format!(" ORDER BY {order_by}"));
    }
    if let Some(limit) = &delete.limit {
        sql.push_str(&format!(" LIMIT {limit}"));
    }
    Ok(sql)
}

pub fn build_dml_change_preview_sql(options: DmlChangePreviewSqlOptions) -> Result<DmlChangePreviewSqlResult, String> {
    let dialect_key = normalize_dialect(options.database_type.as_deref());
    let statements = parse_statements(&options.sql, dialect_key)?;
    let statement = match statements.len() {
        0 => return Err(unsupported("no statement to preview")),
        1 => &statements[0],
        _ => return Err(unsupported("only one statement can be previewed at a time")),
    };
    let quote = options.identifier_quote.as_deref();
    let columns = options.columns.as_deref();
    match statement {
        Statement::Update(update) => Ok(DmlChangePreviewSqlResult {
            sql: build_update_preview(update, dialect_key, quote, columns)?,
            operation: "update".to_string(),
            has_new_value_columns: true,
            tables: vec![update_primary_table_ref(update)],
        }),
        Statement::Insert(insert) => Ok(DmlChangePreviewSqlResult {
            sql: build_insert_preview(insert, dialect_key, quote)?,
            operation: "insert".to_string(),
            has_new_value_columns: true,
            tables: vec![insert_table_ref(insert)],
        }),
        Statement::Delete(delete) => Ok(DmlChangePreviewSqlResult {
            sql: build_delete_preview(delete, dialect_key, quote)?,
            operation: "delete".to_string(),
            has_new_value_columns: false,
            tables: vec![delete_table_ref(delete)],
        }),
        _ => Err(unsupported("only UPDATE / INSERT / DELETE statements can be previewed")),
    }
}

fn object_name_table_ref(name: &sqlparser::ast::ObjectName) -> DmlChangePreviewTableRef {
    let names: Vec<String> =
        name.0.iter().filter_map(|part| part.as_ident().map(|ident| ident.value.clone())).collect();
    match names.len() {
        4 => DmlChangePreviewTableRef {
            catalog: Some(names[0].clone()),
            database: Some(names[1].clone()),
            schema: Some(names[2].clone()),
            table: Some(names[3].clone()),
        },
        3 => DmlChangePreviewTableRef {
            catalog: None,
            database: Some(names[0].clone()),
            schema: Some(names[1].clone()),
            table: Some(names[2].clone()),
        },
        2 => DmlChangePreviewTableRef {
            catalog: None,
            database: None,
            schema: Some(names[0].clone()),
            table: Some(names[1].clone()),
        },
        1 => DmlChangePreviewTableRef { catalog: None, database: None, schema: None, table: names.into_iter().next() },
        _ => DmlChangePreviewTableRef { catalog: None, database: None, schema: None, table: None },
    }
}

fn update_primary_table_ref(update: &sqlparser::ast::Update) -> DmlChangePreviewTableRef {
    match &update.table.relation {
        sqlparser::ast::TableFactor::Table { name, .. } => object_name_table_ref(name),
        _ => DmlChangePreviewTableRef { catalog: None, database: None, schema: None, table: None },
    }
}

fn insert_table_ref(insert: &sqlparser::ast::Insert) -> DmlChangePreviewTableRef {
    match &insert.table {
        sqlparser::ast::TableObject::TableName(name) => object_name_table_ref(name),
        _ => DmlChangePreviewTableRef { catalog: None, database: None, schema: None, table: None },
    }
}

fn delete_table_ref(delete: &sqlparser::ast::Delete) -> DmlChangePreviewTableRef {
    if let Some(first) = delete.tables.first() {
        return object_name_table_ref(first);
    }
    let tables = match &delete.from {
        sqlparser::ast::FromTable::WithFromKeyword(tables) | sqlparser::ast::FromTable::WithoutKeyword(tables) => {
            tables
        }
    };
    match tables.first().and_then(|table| match &table.relation {
        sqlparser::ast::TableFactor::Table { name, .. } => Some(name),
        _ => None,
    }) {
        Some(name) => object_name_table_ref(name),
        None => DmlChangePreviewTableRef { catalog: None, database: None, schema: None, table: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(sql: &str, database_type: &str) -> Result<DmlChangePreviewSqlResult, String> {
        build_dml_change_preview_sql(DmlChangePreviewSqlOptions {
            sql: sql.to_string(),
            database_type: Some(database_type.to_string()),
            identifier_quote: None,
            columns: None,
        })
    }

    fn preview_with_columns(
        sql: &str,
        database_type: &str,
        columns: Vec<String>,
    ) -> Result<DmlChangePreviewSqlResult, String> {
        build_dml_change_preview_sql(DmlChangePreviewSqlOptions {
            sql: sql.to_string(),
            database_type: Some(database_type.to_string()),
            identifier_quote: None,
            columns: Some(columns),
        })
    }

    #[test]
    fn update_simple_single_table() {
        let result = preview("UPDATE admin_sessions SET public_id = 123 WHERE id = 1", "mysql").unwrap();
        assert_eq!(result.operation, "update");
        assert_eq!(result.sql, "SELECT *, 123 AS `public_id (new)` FROM admin_sessions WHERE id = 1");
    }

    #[test]
    fn update_multiple_assignments_and_expression() {
        let result = preview("UPDATE t SET a = 1, b = a + 1", "postgres").unwrap();
        assert_eq!(result.sql, "SELECT *, 1 AS \"a (new)\", a + 1 AS \"b (new)\" FROM t");
    }

    #[test]
    fn update_deduplicates_same_column_last_wins() {
        let result = preview("UPDATE t SET x = 1, x = 2", "postgres").unwrap();
        assert_eq!(result.sql, "SELECT *, 2 AS \"x (new)\" FROM t");
    }

    #[test]
    fn update_with_alias_and_join() {
        let result = preview("UPDATE a JOIN b ON a.id = b.id SET a.x = b.x WHERE a.id = 1", "mysql").unwrap();
        assert_eq!(result.sql, "SELECT *, b.x AS `x (new)` FROM a JOIN b ON a.id = b.id WHERE a.id = 1");
    }

    #[test]
    fn update_postgres_from_clause_rejected() {
        // `UPDATE … FROM …` 的目标行可能匹配多行来源，跨连接改写会重复计数，应拒绝预览。
        let error = preview("UPDATE t SET x = s.y FROM s WHERE t.id = s.id", "postgres").unwrap_err();
        assert_eq!(error, "Preview is not supported: UPDATE ... FROM");
    }

    #[test]
    fn update_where_missing() {
        let result = preview("UPDATE t SET x = 1", "sqlite").unwrap();
        assert_eq!(result.sql, "SELECT *, 1 AS \"x (new)\" FROM t");
    }

    #[test]
    fn insert_values_with_columns() {
        let result = preview("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y')", "postgres").unwrap();
        assert_eq!(result.sql, "SELECT 1 AS \"a\", 'x' AS \"b\" UNION ALL SELECT 2 AS \"a\", 'y' AS \"b\"");
    }

    #[test]
    fn insert_select_source() {
        let result = preview("INSERT INTO t SELECT id, name FROM src WHERE active", "postgres").unwrap();
        assert_eq!(result.sql, "SELECT id, name FROM src WHERE active");
    }

    #[test]
    fn insert_set_mysql() {
        let result = preview("INSERT INTO t SET a = 1, b = 'x'", "mysql").unwrap();
        assert_eq!(result.sql, "SELECT 1 AS `a`, 'x' AS `b`");
    }

    #[test]
    fn delete_simple() {
        let result = preview("DELETE FROM t WHERE id = 1", "postgres").unwrap();
        assert_eq!(result.operation, "delete");
        assert_eq!(result.sql, "SELECT * FROM t WHERE id = 1");
    }

    #[test]
    fn delete_mysql_multi_table() {
        let result = preview("DELETE d FROM d JOIN logs l ON d.id = l.id WHERE l.ts < '2020-01-01'", "mysql").unwrap();
        assert_eq!(result.sql, "SELECT * FROM d JOIN logs l ON d.id = l.id WHERE l.ts < '2020-01-01'");
    }

    #[test]
    fn rejects_multiple_statements() {
        assert!(preview("UPDATE t SET a = 1; UPDATE t2 SET b = 2", "postgres").is_err());
    }

    #[test]
    fn rejects_non_dml() {
        assert!(preview("SELECT * FROM t", "postgres").is_err());
    }

    #[test]
    fn respects_identifier_quote() {
        let result = build_dml_change_preview_sql(DmlChangePreviewSqlOptions {
            sql: "UPDATE t SET a = 1 WHERE id = 1".to_string(),
            database_type: Some("postgres".to_string()),
            identifier_quote: Some("\"".to_string()),
            columns: None,
        })
        .unwrap();
        assert_eq!(result.sql, "SELECT *, 1 AS \"a (new)\" FROM t WHERE id = 1");
    }

    #[test]
    fn update_sqlserver_bracket_quote() {
        let result = build_dml_change_preview_sql(DmlChangePreviewSqlOptions {
            sql: "UPDATE dbo.t SET a = 1 WHERE id = 1".to_string(),
            database_type: Some("sqlserver".to_string()),
            identifier_quote: Some("[".to_string()),
            columns: None,
        })
        .unwrap();
        assert_eq!(result.sql, "SELECT *, 1 AS [a (new)] FROM dbo.t WHERE id = 1");
    }

    #[test]
    fn update_interleaves_new_value_after_its_original_column() {
        let result = preview_with_columns(
            "UPDATE admin_sessions SET public_id = 123 WHERE id = 1",
            "mysql",
            vec!["id".to_string(), "public_id".to_string(), "session".to_string()],
        )
        .unwrap();
        assert_eq!(
            result.sql,
            "SELECT `id`, `public_id`, 123 AS `public_id (new)`, `session` FROM admin_sessions WHERE id = 1"
        );
        assert_eq!(result.tables.len(), 1);
        assert_eq!(result.tables[0].table.as_deref(), Some("admin_sessions"));
    }

    #[test]
    fn update_interleave_multiple_assignments_keeps_order() {
        let result = preview_with_columns(
            "UPDATE t SET b = 2, a = 1",
            "postgres",
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
        )
        .unwrap();
        assert_eq!(result.sql, "SELECT \"a\", 1 AS \"a (new)\", \"b\", 2 AS \"b (new)\", \"c\" FROM t");
    }

    #[test]
    fn update_interleave_missing_set_column_appends_at_end() {
        let result =
            preview_with_columns("UPDATE t SET z = 9", "postgres", vec!["a".to_string(), "b".to_string()]).unwrap();
        assert_eq!(result.sql, "SELECT \"a\", \"b\", 9 AS \"z (new)\" FROM t");
    }

    #[test]
    fn update_multi_table_ignores_columns_for_append_mode() {
        let result = preview_with_columns(
            "UPDATE a JOIN b ON a.id = b.id SET a.x = b.x WHERE a.id = 1",
            "mysql",
            vec!["a_x".to_string()],
        )
        .unwrap();
        assert_eq!(result.sql, "SELECT *, b.x AS `x (new)` FROM a JOIN b ON a.id = b.id WHERE a.id = 1");
    }

    #[test]
    fn table_refs_extracted_for_dml() {
        let update = preview("UPDATE db.public.t SET a = 1", "postgres").unwrap();
        assert_eq!(update.tables.len(), 1);
        assert_eq!(update.tables[0].database.as_deref(), Some("db"));
        assert_eq!(update.tables[0].schema.as_deref(), Some("public"));
        assert_eq!(update.tables[0].table.as_deref(), Some("t"));

        let insert = preview("INSERT INTO orders (id) VALUES (1)", "postgres").unwrap();
        assert_eq!(insert.tables[0].table.as_deref(), Some("orders"));

        let delete = preview("DELETE FROM t WHERE id = 1", "postgres").unwrap();
        assert_eq!(delete.tables[0].table.as_deref(), Some("t"));
    }
}
