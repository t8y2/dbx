//! Native MySQL → native Xugu only. Do not reuse MySQL DDL on Xugu, or change
//! the generic type mapper: other transfer pairs have different contracts.
use super::*;
use sqlparser::{
    ast::{ColumnOption, CreateTableOptions, Expr, IndexColumn, SqlOption, Statement, TableConstraint},
    dialect::MySqlDialect,
    parser::Parser,
};

pub(crate) fn is_pair(source: &DatabaseType, target: &DatabaseType) -> bool {
    *source == DatabaseType::Mysql && *target == DatabaseType::Xugu
}

fn quote(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// The declared domain, not the values in the first page, decides the mapping.
/// In particular TINYINT(1) is an integer (it can store 2), not a Boolean.
pub(super) fn column_type(column: &db::ColumnInfo) -> Result<String, String> {
    let raw = column.data_type.to_ascii_uppercase();
    let base = raw.split(['(', ' ']).next().unwrap_or_default();
    let unsigned = raw.split_whitespace().any(|part| part == "UNSIGNED" || part == "ZEROFILL");
    let parameters = raw.split_once('(').and_then(|(_, rest)| rest.split_once(')')).map(|(args, _)| args);
    let first = parameters.and_then(|p| p.split(',').next()).and_then(|p| p.trim().parse::<i32>().ok());
    let length = column.character_maximum_length.or(first);
    let fail = || {
        format!(
            "MySQL column '{}': type '{}' cannot be transferred to Xugu without loss",
            column.name, column.data_type
        )
    };
    let sized = |name: &str, length: Option<i32>, max: i32| -> Result<String, String> {
        match length {
            Some(n) if n > 0 && n <= max => Ok(format!("{name}({n})")),
            _ => Err(fail()),
        }
    };
    if column_is_auto_increment(column) && matches!(base, "TINYINT" | "SMALLINT" | "MEDIUMINT") {
        return Ok("INTEGER".into());
    }
    Ok(match base {
        "TINYINT" if unsigned => "SMALLINT".into(),
        "TINYINT" => "TINYINT".into(),
        "SMALLINT" if unsigned => "INTEGER".into(),
        "SMALLINT" => "SMALLINT".into(),
        "MEDIUMINT" => "INTEGER".into(),
        "INT" | "INTEGER" if unsigned => "BIGINT".into(),
        "INT" | "INTEGER" => "INTEGER".into(),
        "BIGINT" if unsigned => "NUMERIC(20,0)".into(),
        "BIGINT" => "BIGINT".into(),
        "DECIMAL" | "NUMERIC" => {
            let p = column.numeric_precision.or(first).unwrap_or(10);
            let s = column
                .numeric_scale
                .or_else(|| parameters.and_then(|v| v.split(',').nth(1)).and_then(|v| v.trim().parse().ok()))
                .unwrap_or(0);
            if !(1..=38).contains(&p) || !(0..=p).contains(&s) {
                return Err(fail());
            }
            format!("NUMERIC({p},{s})")
        }
        "FLOAT" if first.is_some_and(|n| n > 24) && parameters.is_some_and(|p| !p.contains(',')) => "DOUBLE".into(),
        "FLOAT" => "FLOAT".into(),
        "DOUBLE" | "REAL" => "DOUBLE".into(),
        "BOOL" | "BOOLEAN" => "TINYINT".into(),
        "BIT" => sized("BIT", first.or(Some(1)), 64)?,
        "CHAR" => sized("CHAR", length, 60000)?,
        "VARCHAR" => sized("VARCHAR", length, 60000)?,
        "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" => "CLOB".into(),
        "BINARY" | "VARBINARY" => sized("BINARY", length, 65535)?,
        "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => "BLOB".into(),
        "JSON" => "JSON".into(),
        "YEAR" => "SMALLINT".into(),
        // MySQL TIME is a duration up to ±838 hours, not a time of day.
        "TIME" => "INTERVAL HOUR(3) TO SECOND(6)".into(),
        "DATE" => "DATE".into(),
        "DATETIME" | "TIMESTAMP" => {
            let scale = first.or(column.numeric_scale).unwrap_or(0);
            if !(0..=6).contains(&scale) {
                return Err(fail());
            }
            // MySQL TIMESTAMP's session-local value is copied explicitly. Do not
            // introduce Xugu TIMESTAMP's implicit current-time default.
            format!("DATETIME({scale})")
        }
        "ENUM" => sized("VARCHAR", length, 60000)?,
        // SET constraints, GIS, generated columns, and arbitrary type names need
        // their own proven conversion. Never fall back to the source spelling.
        _ => return Err(fail()),
    })
}

fn default_sql(expr: &Expr, column: &db::ColumnInfo, mapped: &str) -> Result<String, String> {
    use sqlparser::ast::{UnaryOperator, Value};
    match expr {
        Expr::Nested(inner) => default_sql(inner, column, mapped),
        Expr::Value(value) => match &value.value {
            Value::Null => Ok("NULL".into()),
            Value::Number(n, _) => Ok(n.clone()),
            Value::SingleQuotedString(s) | Value::DoubleQuotedString(s) => {
                validate_text_value(column, s)?;
                Ok(value_literal(&serde_json::Value::String(s.clone()), Some(mapped)))
            }
            Value::Boolean(value) => Ok(if *value { "1" } else { "0" }.into()),
            Value::HexStringLiteral(value) if is_binary_transfer_column_type(mapped) => Ok(format!("X'{value}'")),
            Value::SingleQuotedByteStringLiteral(value)
                if mapped.starts_with("BIT(") && value.bytes().all(|b| b == b'0' || b == b'1') =>
            {
                let width = mapped
                    .strip_prefix("BIT(")
                    .and_then(|n| n.strip_suffix(')'))
                    .and_then(|n| n.parse::<usize>().ok())
                    .ok_or("Invalid mapped Xugu BIT width")?;
                if value.len() > width {
                    return Err(format!("MySQL BIT default exceeds the width of '{}'", column.name));
                }
                // MySQL left-pads a short numeric bit literal, whereas Xugu
                // right-pads it. SHOW CREATE removes MySQL's leading zeros.
                Ok(format!("B'{value:0>width$}'"))
            }
            _ => Err(format!("Unsupported MySQL default on column '{}'", column.name)),
        },
        Expr::UnaryOp { op: UnaryOperator::Minus | UnaryOperator::Plus, expr: inner } if matches!(inner.as_ref(), Expr::Value(value) if matches!(value.value, Value::Number(..))) => {
            Ok(expr.to_string())
        }
        _ if is_current_timestamp(expr) && (mapped.starts_with("DATETIME") || mapped.starts_with("TIMESTAMP")) => {
            // Xugu has no CURRENT_TIMESTAMP(p) overload. The DATETIME(p)
            // column retains the declared precision of the default value.
            Ok("CURRENT_TIMESTAMP".into())
        }
        _ => Err(format!("MySQL default expression on '{}' needs manual conversion: {expr}", column.name)),
    }
}

fn is_current_timestamp(expr: &Expr) -> bool {
    let text = expr.to_string().to_ascii_uppercase();
    text == "CURRENT_TIMESTAMP"
        || text == "CURRENT_TIMESTAMP()"
        || (0..=6).any(|p| text == format!("CURRENT_TIMESTAMP({p})"))
}

fn key_columns(columns: &[IndexColumn]) -> Result<String, String> {
    columns
        .iter()
        .map(|column| {
            let Expr::Identifier(name) = &column.column.expr else {
                return Err("MySQL prefix/expression indexes require manual conversion".into());
            };
            if column.operator_class.is_some() {
                return Err("Unsupported MySQL index operator class".into());
            }
            let direction = if column.column.options.asc == Some(false) { " DESC" } else { "" };
            Ok(format!("{}{direction}", quote(&name.value)))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|v| v.join(", "))
}

/// Parse the entire SHOW CREATE result, fail closed on unhandled clauses, and
/// use exact column names from its AST. This is shared by preview and execution.
pub(super) fn prepare(
    sql: &str,
    columns: &[db::ColumnInfo],
    schema: &str,
    table: &str,
) -> Result<ddl_plan::PreparedTableDdl, String> {
    if sql.contains('\0') || schema.contains('\0') || table.contains('\0') {
        return Err("MySQL DDL contains NUL characters; refusing unsafe Xugu SQL text".into());
    }
    if sql.chars().any(|ch| u32::from(ch) > 0xffff) {
        return Err("MySQL DDL contains supplementary Unicode characters; refusing lossy Xugu transfer".into());
    }
    // MySQL hides partitioning and newer features inside executable comments.
    // Ignoring such comments would silently lose source structure.
    if sql.contains("/*!") {
        return Err("MySQL executable DDL comments require manual conversion".into());
    }
    let mut statements =
        Parser::parse_sql(&MySqlDialect {}, sql).map_err(|e| format!("Cannot parse complete MySQL table DDL: {e}"))?;
    if statements.len() != 1 {
        return Err("Expected exactly one MySQL CREATE TABLE statement".into());
    }
    let Statement::CreateTable(create) = statements.remove(0) else {
        return Err("Expected MySQL CREATE TABLE".into());
    };
    if create.temporary || create.query.is_some() || create.like.is_some() || create.partition_by.is_some() {
        return Err("MySQL temporary/partitioned/query-defined tables require manual conversion".into());
    }
    if columns.is_empty() || create.columns.len() != columns.len() {
        return Err("Incomplete MySQL column metadata; refusing reduced table DDL".into());
    }
    let full_table = format!("{}.{}", quote(schema), quote(table));
    let options = create.table_options.to_string();
    let seed = Regex::new(r"(?i)(?:^|\s)AUTO_INCREMENT\s*=\s*(\d+)")
        .unwrap()
        .captures(&options)
        .map(|c| c[1].parse::<i64>().map_err(|_| "MySQL auto-increment seed exceeds Xugu identity range".to_string()))
        .transpose()?
        .unwrap_or(1);
    let mut lines = Vec::new();
    let mut post = Vec::new();
    for definition in &create.columns {
        let column = columns
            .iter()
            .find(|c| c.name == definition.name.value)
            .ok_or_else(|| format!("Missing MySQL metadata for column '{}'", definition.name.value))?;
        let mapped = column_type(column)?;
        let name = quote(&column.name);
        let mut line = format!("  {name} {mapped}");
        let auto_increment = definition.options.iter().any(|option| matches!(&option.option,
            ColumnOption::DialectSpecific(tokens) if tokens.iter().map(ToString::to_string).collect::<String>().eq_ignore_ascii_case("AUTO_INCREMENT")));
        if auto_increment {
            if !matches!(mapped.as_str(), "INTEGER" | "BIGINT") {
                return Err(format!("MySQL auto-increment column '{}' needs an INTEGER/BIGINT target", column.name));
            }
            line.push_str(&format!(" IDENTITY({seed},1)"));
        }
        for option in &definition.options {
            match &option.option {
                ColumnOption::NotNull => line.push_str(" NOT NULL"),
                ColumnOption::Null => line.push_str(" NULL"),
                ColumnOption::Default(expr) => {
                    line.push_str(&format!(" DEFAULT {}", default_sql(expr, column, &mapped)?))
                }
                ColumnOption::DialectSpecific(tokens)
                    if tokens
                        .iter()
                        .map(ToString::to_string)
                        .collect::<String>()
                        .eq_ignore_ascii_case("AUTO_INCREMENT") => {}
                ColumnOption::Comment(comment) => {
                    post.push(format!("COMMENT ON COLUMN {full_table}.{name} IS {}", quote_string_literal(comment)))
                }
                ColumnOption::CharacterSet(_) | ColumnOption::Collation(_) => {}
                _ => {
                    return Err(format!("MySQL column '{}' has an unsupported option: {}", column.name, option.option))
                }
            }
        }
        if column.data_type.to_ascii_uppercase().contains("UNSIGNED") {
            line.push_str(&format!(" CHECK ({name} >= 0)"));
        }
        if column.data_type.to_ascii_uppercase().starts_with("ENUM") {
            let values = column
                .enum_values
                .as_ref()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| format!("Missing MySQL ENUM members for '{}'", column.name))?;
            line.push_str(&format!(
                " CHECK ({name} IN ({}))",
                values.iter().map(|v| quote_string_literal(v)).collect::<Vec<_>>().join(", ")
            ));
        }
        lines.push(line);
    }
    for constraint in &create.constraints {
        match constraint {
            TableConstraint::PrimaryKey(key) => lines.push(format!("  PRIMARY KEY ({})", key_columns(&key.columns)?)),
            TableConstraint::Unique(key) => lines.push(format!("  UNIQUE ({})", key_columns(&key.columns)?)),
            TableConstraint::Index(index) => {
                if index.index_type.as_ref().is_some_and(|t| t.to_string() != "BTREE")
                    || !index.index_options.is_empty()
                {
                    return Err("MySQL non-BTREE or option-bearing indexes require manual conversion".into());
                }
                let name = index.name.as_ref().ok_or("Missing MySQL index name")?;
                // Xugu index names are schema-wide; MySQL index names are table-local.
                let target_index_name = format!("{table}_{}", name.value);
                if target_index_name.chars().count() > 128 {
                    return Err("Mapped Xugu index name exceeds 128 characters".into());
                }
                post.push(format!(
                    // Xugu takes a simple index name; the qualified ON table
                    // determines the owner. A schema-qualified index name is
                    // rejected with E19260 (unexpected '.', expecting ON).
                    "CREATE INDEX {} ON {full_table} ({})",
                    quote(&target_index_name),
                    key_columns(&index.columns)?
                ));
            }
            // Do not silently drop FK/CHECK enforcement or invent a translated
            // expression. These are explicit preflight failures in phase one.
            _ => return Err(format!("MySQL table constraint requires manual conversion: {constraint}")),
        }
    }
    // MySQL SHOW CREATE puts COMMENT='...' in the plain table options,
    // unlike dialects that populate CreateTable.comment directly.
    let table_comment = create.comment.as_ref().or_else(|| match &create.table_options {
        CreateTableOptions::Plain(options) => options.iter().rev().find_map(|option| match option {
            SqlOption::Comment(comment) => Some(comment),
            _ => None,
        }),
        _ => None,
    });
    if let Some(comment) = table_comment {
        post.push(format!("COMMENT ON TABLE {full_table} IS {}", quote_string_literal(&comment.to_string())));
    }
    let mut ddl = format!("-- MySQL engines, character sets and collations are not copied; target Xugu semantics apply.\nCREATE TABLE {full_table} (\n{}\n);", lines.join(",\n"));
    for statement in post {
        ddl.push_str(&format!("\n{statement};"));
    }
    Ok(ddl_plan::PreparedTableDdl {
        ddl,
        reused_source_ddl: false,
        deferred_fk_alters: vec![],
        deferred_fk_names: vec![],
        source_evidence: None,
    })
}

fn validate_text_value(column: &db::ColumnInfo, value: &str) -> Result<(), String> {
    // The native SQL transport cannot carry an embedded zero byte in a text
    // literal. Never remove it or pass a statement that may be truncated.
    if value.contains('\0') {
        return Err(format!(
            "MySQL column '{}' contains a NUL character; native Xugu SQL text cannot preserve it",
            column.name
        ));
    }
    // The native Xugu SQL path may silently discard supplementary characters.
    // Until a lossless wire encoding is proven, fail instead of reporting a
    // successful transfer with changed text. This guard is pair-local.
    if value.chars().any(|ch| u32::from(ch) > 0xffff) {
        return Err(format!(
            "MySQL column '{}' contains supplementary Unicode characters; native Xugu text transfer is not yet lossless",
            column.name
        ));
    }
    let kind = column.data_type.to_ascii_uppercase();
    if trims_trailing_spaces(column) && value.ends_with(' ') {
        return Err(format!(
            "MySQL column '{}' contains trailing spaces; Xugu CHAR/VARCHAR would remove them",
            column.name
        ));
    }
    if matches!(kind.split('(').next(), Some("DATE" | "DATETIME" | "TIMESTAMP"))
        && (value.starts_with("0000-") || value.get(5..7) == Some("00") || value.get(8..10) == Some("00"))
    {
        return Err(format!("MySQL zero/partial date in '{}': refusing to invent a replacement", column.name));
    }
    Ok(())
}

/// Check declared target capacity before append/overwrite. Values that happen
/// to fit on today's first page do not establish schema compatibility.
pub(super) fn validate_target(source: &[db::ColumnInfo], target: &[db::ColumnInfo]) -> Result<(), String> {
    for column in source {
        let matches = target.iter().filter(|t| t.name == column.name).collect::<Vec<_>>();
        let [destination] = matches.as_slice() else {
            return Err(format!("Missing or ambiguous Xugu target column '{}'", column.name));
        };
        let expected = column_type(column)?;
        let wanted = normalize_xugu_type_name(&expected);
        let actual = normalize_xugu_type_name(&destination.data_type);
        let canonical = |name: &str| {
            match name {
                "INT" => "INTEGER",
                "DECIMAL" | "NUMBER" => "NUMERIC",
                "VARBINARY" => "BINARY",
                _ => name,
            }
            .to_string()
        };
        if canonical(&wanted) != canonical(&actual) {
            return Err(format!(
                "Xugu target column '{}' must accept {expected}, found {}",
                column.name, destination.data_type
            ));
        }
        let params = |kind: &str| -> Vec<i32> {
            kind.split_once('(')
                .and_then(|(_, v)| v.split_once(')'))
                .map(|(v, _)| v.split(',').filter_map(|s| s.trim().parse().ok()).collect())
                .unwrap_or_default()
        };
        let wanted_params = params(&expected);
        let actual_params = params(&destination.data_type);
        if matches!(wanted.as_str(), "CHAR" | "VARCHAR" | "BINARY" | "BIT") {
            let available = destination
                .character_maximum_length
                .or(if wanted == "BIT" { destination.numeric_precision } else { None })
                .or_else(|| actual_params.first().copied());
            if available.is_none_or(|n| n < wanted_params.first().copied().unwrap_or(1)) {
                return Err(format!("Xugu target column '{}' is shorter than {expected}", column.name));
            }
        }
        if wanted == "NUMERIC" {
            let p = destination
                .numeric_precision
                .or_else(|| actual_params.first().copied())
                .ok_or("Missing Xugu numeric precision")?;
            let s = destination
                .numeric_scale
                .or_else(|| actual_params.get(1).copied())
                .ok_or("Missing Xugu numeric scale")?;
            if s < wanted_params[1] || p - s < wanted_params[0] - wanted_params[1] {
                return Err(format!("Xugu target column '{}' cannot hold {expected}", column.name));
            }
        }
        if wanted == "DATETIME" {
            let available = destination.numeric_scale.or_else(|| actual_params.first().copied());
            if available.is_none_or(|n| n < wanted_params[0]) {
                return Err(format!(
                    "Xugu target column '{}' cannot preserve {expected} fractional seconds",
                    column.name
                ));
            }
        }
        if wanted == "HOUR TO SECOND" {
            let leading = destination.numeric_precision.or_else(|| actual_params.first().copied());
            // The two parenthesized qualifiers are intentionally parsed
            // separately; splitting at the first ')' only sees HOUR(3).
            let trailing = destination.numeric_scale.or_else(|| {
                destination
                    .data_type
                    .to_ascii_uppercase()
                    .split_once("SECOND(")
                    .and_then(|(_, tail)| tail.split_once(')'))
                    .and_then(|(n, _)| n.trim().parse::<i32>().ok())
            });
            if leading.is_none_or(|n| n < 3) || trailing.is_none_or(|n| n < 6) {
                return Err(format!(
                    "Xugu target column '{}' cannot preserve MySQL TIME range and fractional seconds",
                    column.name
                ));
            }
        }
        if column.is_nullable && !destination.is_nullable {
            return Err(format!("Nullable MySQL column '{}' has a NOT NULL Xugu target", column.name));
        }
        if destination.extra.as_deref().is_some_and(|extra| extra.to_ascii_lowercase().contains("generated")) {
            return Err(format!("Xugu target column '{}' is generated", column.name));
        }
    }
    for column in target {
        if !source.iter().any(|s| s.name == column.name) && !target_column_can_be_omitted(column, &DatabaseType::Xugu) {
            return Err(format!("Required Xugu target column '{}' has no MySQL source", column.name));
        }
    }
    Ok(())
}

/// The generic Xugu column model does not expose DATETIME/INTERVAL qualifiers.
/// Read only the permission-scoped catalog for this transfer pair, including
/// when the target was just created, before allowing data writes or truncation.
pub(super) async fn enrich_target_temporal_precision(
    state: &AppState,
    pool: &str,
    schema: &str,
    table: &str,
    columns: &mut [db::ColumnInfo],
) -> Result<(), String> {
    if !columns.iter().any(|c| matches!(normalize_xugu_type_name(&c.data_type).as_str(), "DATETIME" | "HOUR TO SECOND"))
    {
        return Ok(());
    }
    let sql = format!(
        "SELECT c.COL_NAME,c.SCALE FROM ALL_COLUMNS c \
         JOIN ALL_TABLES t ON c.DB_ID=t.DB_ID AND c.TABLE_ID=t.TABLE_ID \
         JOIN ALL_SCHEMAS s ON t.DB_ID=s.DB_ID AND t.SCHEMA_ID=s.SCHEMA_ID \
         WHERE s.DB_ID=CURRENT_DB_ID AND s.SCHEMA_NAME={} AND t.TABLE_NAME={}",
        quote_string_literal(schema),
        quote_string_literal(table)
    );
    let result = execute_read_on_pool(state, pool, &sql).await?;
    for column in columns {
        let kind = normalize_xugu_type_name(&column.data_type);
        if !matches!(kind.as_str(), "DATETIME" | "HOUR TO SECOND") {
            continue;
        }
        let matches = result
            .rows
            .iter()
            .filter(|row| row.first().and_then(json_scalar_to_string).as_deref() == Some(column.name.as_str()))
            .collect::<Vec<_>>();
        let [row] = matches.as_slice() else {
            return Err(format!("Missing or ambiguous Xugu temporal metadata for '{}'", column.name));
        };
        let scale = row
            .get(1)
            .and_then(json_scalar_to_string)
            .and_then(|v| v.parse::<i32>().ok())
            .filter(|n| *n >= 0)
            .ok_or_else(|| format!("Missing Xugu temporal precision for '{}'", column.name))?;
        if kind == "DATETIME" {
            column.numeric_scale = Some(scale);
        } else {
            column.numeric_precision = Some(scale / 65536);
            column.numeric_scale = Some(scale % 65536);
        }
    }
    Ok(())
}

fn text_column(column: &db::ColumnInfo) -> bool {
    matches!(
        column.data_type.to_ascii_uppercase().split(['(', ' ']).next(),
        Some("CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" | "JSON")
    )
}

fn trims_trailing_spaces(column: &db::ColumnInfo) -> bool {
    matches!(column.data_type.to_ascii_uppercase().split(['(', ' ']).next(), Some("CHAR" | "VARCHAR" | "ENUM"))
}

fn unsafe_text_predicate(column: &db::ColumnInfo) -> String {
    let name = quote(&column.name);
    // A binary comparison is essential: source text collations must not ignore
    // the zero byte. Binary columns use HEX projection and are not scanned here.
    // Check both transport limits in one source scan before overwrite clears.
    let trailing = if trims_trailing_spaces(column) {
        format!(" OR RIGHT(CAST({name} AS BINARY), 1) = 0x20")
    } else {
        String::new()
    };
    format!("(LOCATE(0x00, CAST({name} AS BINARY)) > 0 OR HEX({name}) REGEXP '^(..)*F[0-4][89AB][0-9A-F][89AB][0-9A-F][89AB][0-9A-F]'{trailing})")
}

fn value_literal(value: &serde_json::Value, kind: Option<&str>) -> String {
    if let Some(text) = value.as_str() {
        if kind.is_some_and(|k| matches!(normalize_xugu_type_name(k).as_str(), "CHAR" | "VARCHAR" | "CLOB" | "JSON")) {
            // Native Xugu ordinary string literals retain backslashes. The
            // generic formatter's MySQL-style backslash escaping changes text
            // and JSON escapes, so keep this correction local to this pair.
            return quote_string_literal(text);
        }
    }
    escape_value_typed(value, &DatabaseType::Xugu, kind)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn write_batches(
    columns: &[String],
    column_types: &[Option<String>],
    rows: &[Vec<serde_json::Value>],
    table: &str,
    schema: &str,
    catalog: Option<&str>,
    limits: SqlBatchLimits,
    quote_column_names: bool,
) -> Result<Vec<String>, String> {
    let value_rows = rows
        .iter()
        .map(|row| {
            let values = row
                .iter()
                .enumerate()
                .map(|(i, value)| value_literal(value, column_types.get(i).and_then(|t| t.as_deref())))
                .collect::<Vec<_>>()
                .join(", ");
            format!("({values})")
        })
        .collect::<Vec<_>>();
    // Reuse the existing statement-size limits, batching and Xugu VALUES
    // syntax; only the pair's value literals differ.
    generate_insert_sql_batches_from_value_rows(
        columns,
        &value_rows,
        table,
        schema,
        &DatabaseType::Xugu,
        catalog,
        limits,
        false,
        quote_column_names,
        None,
    )
    .map(|batches| batches.into_iter().map(|(sql, _)| sql).collect())
}

fn source_scan_from(request: &TransferRequest, table: &str) -> Result<(String, Option<String>), String> {
    match transfer_table_filter_for(request, table)? {
        Some(TransferTableFilter::Query(query)) => Ok((format!("({query}) AS dbx_source"), None)),
        Some(TransferTableFilter::Predicate(predicate)) => {
            Ok((format!("{}.{}", quote(&request.source_database), quote(table)), Some(predicate)))
        }
        None => Ok((format!("{}.{}", quote(&request.source_database), quote(table)), None)),
    }
}

/// Project wire-sensitive MySQL values to text on the source server. SQL NULL
/// remains NULL; empty binary and JSON null stay distinct from SQL NULL.
pub(super) fn project_page(sql: &str, columns: &[db::ColumnInfo]) -> Result<String, String> {
    let prefix =
        format!("SELECT {} FROM ", columns.iter().map(|column| quote(&column.name)).collect::<Vec<_>>().join(", "));
    let tail = sql.strip_prefix(&prefix).ok_or("Unexpected generated MySQL projection; refusing to rewrite SQL")?;
    let projection = columns
        .iter()
        .map(|column| {
            let name = quote(&column.name);
            let kind = column.data_type.to_ascii_uppercase();
            let base = kind.split(['(', ' ']).next().unwrap_or_default();
            let expr = match base {
                "BIT" => {
                    let width = kind
                        .split_once('(')
                        .and_then(|(_, p)| p.trim_end_matches(')').parse::<u32>().ok())
                        .unwrap_or(1);
                    format!("LPAD(BIN({name} + 0), {width}, '0')")
                }
                "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
                    format!("CASE WHEN {name} IS NULL THEN NULL ELSE CONCAT('0x', HEX({name})) END")
                }
                "DECIMAL" | "NUMERIC" | "BIGINT" | "TIME" | "DATE" | "DATETIME" | "TIMESTAMP" | "JSON" => {
                    format!("CAST({name} AS CHAR)")
                }
                _ => name.clone(),
            };
            format!("{expr} AS {name}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!("SELECT {projection} FROM {tail}"))
}

pub(super) fn validate_rows(columns: &[db::ColumnInfo], rows: &[Vec<serde_json::Value>]) -> Result<(), String> {
    for row in rows {
        if row.len() != columns.len() {
            return Err("Incomplete MySQL transfer row".into());
        }
        for (column, value) in columns.iter().zip(row) {
            if let Some(value) = value.as_str() {
                validate_text_value(column, value)?;
            }
        }
    }
    Ok(())
}

/// Doris/SelectDB/StarRocks/OceanBase-MySQL/TiDB/Manticore/Dolt connections are
/// saved as `db_type=mysql` plus a `driver_profile` and deliberately surface as
/// MySQL in the transfer dialog; this pair's contract is a native MySQL server
/// only, so any of those profiles must be rejected before the first query.
fn profile_allows_native_mysql_pair(config: &ConnectionConfig) -> bool {
    let db_type = &config.db_type;
    let profile = config.driver_profile.as_deref();
    !(db::doris::is_profile(db_type, profile)
        || db::starrocks::is_profile(db_type, profile)
        || db::oceanbase_mysql::is_profile(db_type, profile)
        || db::tidb::is_profile(db_type, profile)
        || db::manticoresearch::is_profile(db_type, profile)
        || db::dolt::is_config(config))
}

/// Run before the overwrite pre-pass, not just before CREATE TABLE. Reading an
/// unsupported source must never clear an existing target first.
pub(crate) fn preflight<'a>(
    state: &'a AppState,
    request: &'a TransferRequest,
    source_pool: &'a str,
    target_pool: &'a str,
) -> futures::future::BoxFuture<'a, Result<(), String>> {
    // Keep metadata's large async implementation out of the runner's future
    // layout (including downstream consumers' default recursion limit).
    Box::pin(async move {
        let source_is_plain_mysql = {
            let configs = state.configs.read().await;
            configs.get(&request.source_connection_id).is_some_and(profile_allows_native_mysql_pair)
        };
        if !source_is_plain_mysql {
            return Err("MySQL → Xugu currently requires a native MySQL server: MySQL-compatible product \
                 profiles (Doris/SelectDB/StarRocks/OceanBase/TiDB/Manticore/Dolt) are not enabled \
                 for this pair"
                .into());
        }
        let version = execute_read_on_pool(
            state,
            source_pool,
            "SELECT VERSION(), @@auto_increment_increment, @@auto_increment_offset",
        )
        .await?;
        let row = version.rows.first().ok_or("Missing MySQL server metadata")?;
        if row.first().and_then(json_scalar_to_string).is_none_or(|v| v.to_ascii_lowercase().contains("mariadb")) {
            return Err("MySQL → Xugu currently requires a native MySQL server".into());
        }
        if row.get(1).and_then(json_scalar_to_string).as_deref() != Some("1")
            || row.get(2).and_then(json_scalar_to_string).as_deref() != Some("1")
        {
            return Err("MySQL → Xugu currently requires auto_increment_increment=1 and auto_increment_offset=1".into());
        }
        for table in &request.tables {
            let columns = get_columns_for_transfer(
                state,
                source_pool,
                &request.source_connection_id,
                &request.source_database,
                &request.source_schema,
                table,
                None,
            )
            .await?;
            let ddl = crate::schema::get_table_transfer_ddl_core(
                state,
                &request.source_connection_id,
                &request.source_database,
                &request.source_schema,
                table,
            )
            .await?;
            prepare(&ddl, &columns, &request.target_schema, table)?;
            let target_name = request.target_table_name(table);
            let target_tables = crate::schema::list_tables_core(
                state,
                &request.target_connection_id,
                &request.target_database,
                &request.target_schema,
                Some(&target_name),
                None,
                None,
                Some(&["TABLE".into()]),
                None,
            )
            .await?;
            if target_tables.iter().any(|t| t.name == target_name) {
                let mut target_columns = get_columns_for_transfer(
                    state,
                    target_pool,
                    &request.target_connection_id,
                    &request.target_database,
                    &request.target_schema,
                    &target_name,
                    None,
                )
                .await?;
                enrich_target_temporal_precision(
                    state,
                    target_pool,
                    &request.target_schema,
                    &target_name,
                    &mut target_columns,
                )
                .await?;
                validate_target(&columns, &target_columns)?;
            } else if !request.create_table || matches!(request.content, TransferContent::DataOnly) {
                return Err(format!("Xugu target table '{target_name}' does not exist; target has not been modified"));
            }
            if !should_copy_data(&request.content) {
                continue;
            }
            let (scan_from, filter) = source_scan_from(request, table)?;
            let extra_filter = filter.as_ref().map(|p| format!(" AND ({p})")).unwrap_or_default();
            let text_checks = columns.iter().filter(|c| text_column(c)).map(unsafe_text_predicate).collect::<Vec<_>>();
            if !text_checks.is_empty() {
                let sql =
                    format!("SELECT 1 FROM {scan_from} WHERE ({}){extra_filter} LIMIT 1", text_checks.join(" OR "));
                if !execute_read_on_pool(state, source_pool, &sql).await?.rows.is_empty() {
                    return Err(format!("MySQL table '{table}' contains NUL, supplementary Unicode characters, or CHAR/VARCHAR trailing spaces; current native Xugu text transfer cannot preserve them. Target has not been modified"));
                }
            }
            let predicates = columns
                .iter()
                .filter(|c| {
                    matches!(
                        c.data_type.to_ascii_uppercase().split('(').next(),
                        Some("DATE" | "DATETIME" | "TIMESTAMP")
                    )
                })
                .map(|c| {
                    let n = quote(&c.name);
                    format!("({n} IS NOT NULL AND (YEAR({n})=0 OR MONTH({n})=0 OR DAY({n})=0))")
                })
                .collect::<Vec<_>>();
            if !predicates.is_empty() {
                let sql =
                    format!("SELECT 1 FROM {scan_from} WHERE ({}){extra_filter} LIMIT 1", predicates.join(" OR "));
                if !execute_read_on_pool(state, source_pool, &sql).await?.rows.is_empty() {
                    return Err(format!(
                        "MySQL table '{table}' contains zero/partial dates; target has not been modified"
                    ));
                }
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn col(name: &str, kind: &str) -> db::ColumnInfo {
        db::ColumnInfo { name: name.into(), data_type: kind.into(), is_nullable: true, ..Default::default() }
    }

    #[test]
    fn native_pair_only() {
        assert!(is_pair(&DatabaseType::Mysql, &DatabaseType::Xugu));
        for engine in [DatabaseType::Postgres, DatabaseType::Doris, DatabaseType::StarRocks, DatabaseType::Xugu] {
            assert!(!is_pair(&engine, &DatabaseType::Xugu));
            assert!(!is_pair(&DatabaseType::Xugu, &engine));
        }
    }

    fn profile_config(db_type: &str, driver_profile: Option<&str>) -> ConnectionConfig {
        serde_json::from_value(json!({
            "id": "test",
            "name": "test",
            "db_type": db_type,
            "driver_profile": driver_profile,
            "host": "",
            "port": 3306,
            "username": "",
            "password": "",
        }))
        .expect("test connection config")
    }

    #[test]
    fn native_mysql_pair_rejects_compatible_product_profiles() {
        assert!(profile_allows_native_mysql_pair(&profile_config("mysql", None)));
        for profile in ["doris", "selectdb", "starrocks", "oceanbase", "tidb", "manticoresearch", "dolt"] {
            let config = profile_config("mysql", Some(profile));
            assert!(!profile_allows_native_mysql_pair(&config), "profile {profile} must be rejected");
        }
        assert!(!profile_allows_native_mysql_pair(&profile_config("doris", None)));
    }

    #[test]
    fn integer_domains_are_not_guessed_from_display_width() {
        for (source, expected) in [
            ("tinyint(1)", "TINYINT"),
            ("tinyint unsigned", "SMALLINT"),
            ("smallint unsigned", "INTEGER"),
            ("mediumint unsigned", "INTEGER"),
            ("int unsigned", "BIGINT"),
            ("bigint unsigned", "NUMERIC(20,0)"),
            ("bigint", "BIGINT"),
            ("int(11) zerofill", "BIGINT"),
            ("year", "SMALLINT"),
        ] {
            assert_eq!(column_type(&col("v", source)).unwrap(), expected, "{source}");
        }
    }

    #[test]
    fn precision_is_preserved_or_rejected_never_clamped() {
        for (source, expected) in [
            ("decimal(38,18)", "NUMERIC(38,18)"),
            ("numeric(20,0)", "NUMERIC(20,0)"),
            ("datetime(6)", "DATETIME(6)"),
            ("timestamp(3)", "DATETIME(3)"),
            ("time(6)", "INTERVAL HOUR(3) TO SECOND(6)"),
            ("bit(64)", "BIT(64)"),
            ("float(53)", "DOUBLE"),
        ] {
            assert_eq!(column_type(&col("v", source)).unwrap(), expected);
        }
        for source in
            ["decimal(65,30)", "decimal(39,0)", "decimal(2,3)", "varchar(65535)", "geometry", "set('a','b')", "mystery"]
        {
            assert!(column_type(&col("v", source)).is_err(), "{source}");
        }
    }

    #[test]
    fn text_binary_json_types() {
        for (source, expected) in [
            ("char(10)", "CHAR(10)"),
            ("varchar(60000)", "VARCHAR(60000)"),
            ("longtext", "CLOB"),
            ("tinytext", "CLOB"),
            ("mediumtext", "CLOB"),
            ("binary(16)", "BINARY(16)"),
            ("varbinary(100)", "BINARY(100)"),
            ("longblob", "BLOB"),
            ("json", "JSON"),
        ] {
            assert_eq!(column_type(&col("v", source)).unwrap(), expected);
        }
    }

    #[test]
    fn complete_ddl_preserves_case_identity_seed_keys_comments_and_literals() {
        let columns = vec![col("ID", "int"), col("Text", "varchar(40)")];
        let ddl = prepare("CREATE TABLE `Source` (`ID` int NOT NULL AUTO_INCREMENT, `Text` varchar(40) DEFAULT 'Source.a' COMMENT 'it''s text', PRIMARY KEY (`ID`), UNIQUE KEY `uq_text` (`Text`), KEY `ix_text` (`Text`)) ENGINE=InnoDB AUTO_INCREMENT=501 DEFAULT CHARSET=utf8mb4", &columns, "Dst", "MixedCase").unwrap().ddl;
        assert!(ddl.contains("CREATE TABLE `Dst`.`MixedCase`"), "{ddl}");
        assert!(ddl.contains("IDENTITY(501,1)"), "{ddl}");
        assert!(ddl.contains("DEFAULT 'Source.a'"), "{ddl}");
        assert!(ddl.contains("PRIMARY KEY (`ID`)"), "{ddl}");
        assert!(ddl.contains("UNIQUE (`Text`)"), "{ddl}");
        assert!(ddl.contains("`MixedCase_ix_text`"), "{ddl}");
        assert!(ddl.contains("IS 'it''s text'"), "{ddl}");
        assert!(!ddl.contains("ENGINE="));
    }

    #[test]
    fn mysql_plain_table_comment_options_are_preserved() {
        for option in ["COMMENT='中文 it''s table'", "COMMENT '中文 it''s table'"] {
            let ddl =
                prepare(&format!("CREATE TABLE t (id int) ENGINE=InnoDB {option}"), &[col("id", "int")], "Dst", "t")
                    .unwrap()
                    .ddl;
            assert!(ddl.contains("COMMENT ON TABLE `Dst`.`t` IS '中文 it''s table';"), "{ddl}");
        }
    }

    #[test]
    fn unsupported_structure_is_not_silently_reduced() {
        for definition in [
            "CREATE TABLE t (v int GENERATED ALWAYS AS (1) STORED)",
            "CREATE TABLE t (v int, CHECK (v > 0))",
            "CREATE TABLE t (v int, FOREIGN KEY(v) REFERENCES p(v))",
            "CREATE TABLE t (v varchar(10), KEY i (v(2)))",
            "CREATE TABLE t (v varchar(10), FULLTEXT KEY i (v))",
            "CREATE TABLE t (v int) /*!50100 PARTITION BY HASH(v) PARTITIONS 2 */",
            "CREATE TABLE t (v int); DROP TABLE p",
            "CREATE TEMPORARY TABLE t (v int)",
            "CREATE TABLE t (v datetime ON UPDATE CURRENT_TIMESTAMP)",
        ] {
            assert!(
                prepare(
                    definition,
                    &[col(
                        "v",
                        if definition.contains("varchar") {
                            "varchar(10)"
                        } else if definition.contains("datetime") {
                            "datetime"
                        } else {
                            "int"
                        }
                    )],
                    "D",
                    "t"
                )
                .is_err(),
                "{definition}"
            );
        }
        assert!(prepare("CREATE TABLE t(v int, w int)", &[col("v", "int")], "D", "t").is_err());
        assert!(prepare("CREATE TABLE t(v bigint unsigned AUTO_INCREMENT)", &[col("v", "bigint unsigned")], "D", "t")
            .is_err());
    }

    #[test]
    fn defaults_reject_sql_expressions_and_zero_dates() {
        for definition in [
            "CREATE TABLE t(v date DEFAULT '0000-00-00')",
            "CREATE TABLE t(v date DEFAULT '2024-00-01')",
            "CREATE TABLE t(v date DEFAULT (uuid()))",
        ] {
            assert!(prepare(definition, &[col("v", "date")], "D", "t").is_err());
        }
        let ddl =
            prepare("CREATE TABLE t(v datetime(6) DEFAULT CURRENT_TIMESTAMP(6))", &[col("v", "datetime(6)")], "D", "t")
                .unwrap()
                .ddl;
        assert!(ddl.contains("DATETIME(6) DEFAULT CURRENT_TIMESTAMP"));
        assert!(!ddl.contains("CURRENT_TIMESTAMP("));
    }

    #[test]
    fn projection_preserves_exact_wire_values_and_nulls() {
        let columns = vec![
            col("bits", "bit(64)"),
            col("blob", "blob"),
            col("n", "decimal(38,18)"),
            col("dur", "time(6)"),
            col("j", "json"),
        ];
        let sql = project_page(
            "SELECT `bits`, `blob`, `n`, `dur`, `j` FROM `db`.`t` WHERE `bits` > 0 ORDER BY `bits` LIMIT 2",
            &columns,
        )
        .unwrap();
        assert!(sql.contains("LPAD(BIN(`bits` + 0), 64, '0') AS `bits`"));
        assert!(sql.contains("CASE WHEN `blob` IS NULL THEN NULL ELSE CONCAT('0x', HEX(`blob`)) END"));
        assert!(sql.contains("CAST(`n` AS CHAR)"));
        assert!(sql.ends_with("FROM `db`.`t` WHERE `bits` > 0 ORDER BY `bits` LIMIT 2"));
        for (value, kind, expected) in [
            (json!("00000001"), "BIT(8)", "B'00000001'"),
            (json!("0x00ff"), "BLOB", "X'00ff'"),
            (json!("0x"), "BLOB", "X''"),
            (json!(null), "JSON", "NULL"),
        ] {
            assert_eq!(escape_value_typed(&value, &DatabaseType::Xugu, Some(kind)), expected);
        }
    }

    #[test]
    fn row_validation_keeps_null_empty_and_zero_dates_distinct() {
        let columns = [col("v", "datetime(6)")];
        assert!(validate_rows(&columns, &[vec![json!(null)], vec![json!("2026-10-24 12:34:56.123456")]]).is_ok());
        assert!(validate_rows(&columns, &[vec![json!("0000-00-00 00:00:00")]]).is_err());
        assert!(validate_rows(&columns, &[vec![]]).is_err());
        assert!(validate_rows(&[col("v", "varchar(20)")], &[vec![json!("中文😀")]]).is_err());
        assert!(validate_rows(&[col("v", "varchar(20)")], &[vec![json!("中文")]]).is_ok());
    }

    #[test]
    fn temporal_target_validation_never_assumes_missing_precision_is_lossless() {
        let source = [col("v", "datetime(6)")];
        assert!(validate_target(&source, &[col("v", "DATETIME(6)")]).is_ok());
        assert!(validate_target(&source, &[col("v", "DATETIME(3)")]).is_err());
        assert!(validate_target(&source, &[col("v", "DATETIME")]).is_err());
        assert!(validate_target(&source, &[db::ColumnInfo { numeric_scale: Some(6), ..col("v", "DATETIME") }]).is_ok());
        let source = [col("v", "time(6)")];
        assert!(validate_target(&source, &[col("v", "INTERVAL HOUR(3) TO SECOND(6)")]).is_ok());
        assert!(validate_target(&source, &[col("v", "INTERVAL HOUR(2) TO SECOND(6)")]).is_err());
        assert!(validate_target(&source, &[col("v", "INTERVAL HOUR(3) TO SECOND(3)")]).is_err());
        assert!(validate_target(&source, &[col("v", "INTERVAL HOUR TO SECOND")]).is_err());
        let enriched = db::ColumnInfo {
            numeric_precision: Some(3),
            numeric_scale: Some(6),
            ..col("v", "INTERVAL HOUR TO SECOND")
        };
        assert!(validate_target(&source, &[enriched]).is_ok());
    }

    #[test]
    fn supplementary_unicode_defaults_and_identifiers_fail_closed() {
        assert!(prepare("CREATE TABLE t(v VARCHAR(20) DEFAULT '😀')", &[col("v", "varchar(20)")], "D", "t").is_err());
        assert!(prepare("CREATE TABLE `t😀`(v INT)", &[col("v", "int")], "D", "t").is_err());
    }

    #[test]
    fn nul_text_is_rejected_without_rejecting_binary_zero_bytes() {
        for kind in ["varchar(20)", "text", "enum('a','b')"] {
            let column = col("v", kind);
            assert!(validate_rows(&[column], &[vec![json!("a\0b")]]).unwrap_err().contains("NUL"));
        }
        assert!(validate_rows(&[col("v", "blob")], &[vec![json!("0x0000FF")], vec![json!("0x")]]).is_ok());
        assert!(prepare("CREATE TABLE t(v VARCHAR(20) DEFAULT 'a\0b')", &[col("v", "varchar(20)")], "D", "t")
            .unwrap_err()
            .contains("NUL"));
        assert!(default_sql(
            &Expr::Value(sqlparser::ast::Value::SingleQuotedString("a\0b".into()).into()),
            &col("v", "varchar(20)"),
            "VARCHAR(20)"
        )
        .unwrap_err()
        .contains("NUL"));
        let predicate = unsafe_text_predicate(&col("a`b", "text"));
        assert!(predicate.contains("LOCATE(0x00, CAST(`a``b` AS BINARY)) > 0"));
        assert!(predicate.contains("HEX(`a``b`) REGEXP '^(..)*F"));
    }

    #[test]
    fn target_validation_rejects_loss_before_overwrite() {
        let source = col("v", "decimal(20,6)");
        assert!(validate_target(std::slice::from_ref(&source), &[col("v", "numeric(20,6)")]).is_ok());
        assert!(validate_target(std::slice::from_ref(&source), &[col("v", "numeric(20,3)")]).is_err());
        assert!(validate_target(std::slice::from_ref(&source), &[col("v", "numeric(18,6)")]).is_err());
        assert!(validate_target(&[col("v", "bigint unsigned")], &[col("v", "bigint")]).is_err());
        assert!(validate_target(&[col("v", "varchar(20)")], &[col("v", "varchar(10)")]).is_err());
        assert!(validate_target(&[col("v", "varchar(20)")], &[col("v", "varchar(30)")]).is_ok());
        let target = db::ColumnInfo { is_nullable: false, ..col("v", "numeric(20,6)") };
        assert!(validate_target(&[source], &[target]).is_err());
        assert!(validate_target(
            &[col("v", "int")],
            &[col("v", "int"), db::ColumnInfo { is_nullable: false, ..col("required", "int") }]
        )
        .is_err());
    }

    #[test]
    fn defaults_preserve_bit_binary_negative_and_unicode_literals() {
        for (source_type, definition, expected) in [
            ("bit(8)", "CREATE TABLE t(v BIT(8) DEFAULT b'00000001')", "DEFAULT B'00000001'"),
            ("bit(8)", "CREATE TABLE t(v BIT(8) DEFAULT b'101')", "DEFAULT B'00000101'"),
            ("binary(2)", "CREATE TABLE t(v BINARY(2) DEFAULT X'00FF')", "DEFAULT X'00FF'"),
            ("int", "CREATE TABLE t(v INT DEFAULT -7)", "DEFAULT -7"),
            ("varchar(20)", "CREATE TABLE t(v VARCHAR(20) DEFAULT '中文''值')", "DEFAULT '中文''值'"),
        ] {
            let ddl = prepare(definition, &[col("v", source_type)], "D", "t").unwrap().ddl;
            assert!(ddl.contains(expected), "{ddl}");
        }
    }

    #[test]
    fn current_timestamp_defaults_use_xugu_syntax_with_column_precision() {
        for precision in 0..=6 {
            let kind = format!("datetime({precision})");
            let definition = format!("CREATE TABLE t(v DATETIME({precision}) DEFAULT CURRENT_TIMESTAMP({precision}))");
            let ddl = prepare(&definition, &[col("v", &kind)], "D", "t").unwrap().ddl;
            assert!(ddl.contains(&format!("DATETIME({precision}) DEFAULT CURRENT_TIMESTAMP")), "{ddl}");
            assert!(!ddl.contains("CURRENT_TIMESTAMP("), "{ddl}");
        }
    }

    #[test]
    fn pair_local_text_literals_keep_backslashes_and_json_escapes() {
        let text = json!("C:\\path\\o'clock\nnext");
        let document = json!(r#"{"path":"C:\\tmp","line":"a\nb"}"#);
        assert_eq!(value_literal(&text, Some("VARCHAR(80)")), "'C:\\path\\o''clock\nnext'");
        assert_eq!(value_literal(&document, Some("JSON")), format!("'{}'", document.as_str().unwrap()));
        let columns = vec!["v".into(), "j".into(), "b".into()];
        let kinds = vec![Some("VARCHAR(80)".into()), Some("JSON".into()), Some("BLOB".into())];
        let rows = vec![vec![text, document, json!("0x00ff")], vec![json!(null), json!(null), json!("0x")]];
        let limits = SqlBatchLimits::for_database(&DatabaseType::Xugu, 1);
        let batches = write_batches(&columns, &kinds, &rows, "t", "S", None, limits, true).unwrap();
        assert_eq!(batches.len(), 2);
        assert!(batches[0].contains("'C:\\path\\o''clock\nnext'"), "{}", batches[0]);
        assert!(batches[0].contains("X'00ff'"));
        assert!(batches[1].contains("(NULL, NULL, X'')"));
        assert!(write_batches(&columns, &kinds, &rows, "t", "S", None, limits.with_hard_sql_bytes(Some(10)), true,)
            .is_err());
        // Do not change any other pair's shared formatter as a side effect.
        assert_eq!(escape_value_typed(&json!(r"a\b"), &DatabaseType::Mysql, Some("VARCHAR(20)")), r"'a\\b'");
    }

    #[test]
    fn trailing_spaces_are_rejected_only_for_trimming_target_types() {
        for kind in ["char(20)", "varchar(20)", "enum('a ','b')"] {
            let column = col("v", kind);
            assert!(validate_rows(std::slice::from_ref(&column), &[vec![json!("a ")]]).is_err());
            assert!(unsafe_text_predicate(&column).contains("RIGHT(CAST(`v` AS BINARY), 1) = 0x20"));
        }
        for kind in ["text", "longtext", "json"] {
            let column = col("v", kind);
            assert!(validate_rows(std::slice::from_ref(&column), &[vec![json!("a ")]]).is_ok());
            assert!(!unsafe_text_predicate(&column).contains("RIGHT("));
        }
        assert!(prepare("CREATE TABLE t(v varchar(20) DEFAULT 'a ')", &[col("v", "varchar(20)")], "S", "t").is_err());
        assert!(validate_rows(&[col("v", "varchar(20)")], &[vec![json!(" a b")], vec![json!("")], vec![json!(null)]])
            .is_ok());
    }

    #[test]
    fn enum_members_are_not_replaced_with_arbitrary_length_or_dropped() {
        let column = db::ColumnInfo {
            character_maximum_length: Some(10),
            enum_values: Some(vec!["ready".into(), "it's done".into(), "".into()]),
            ..col("v", "enum('ready','it''s done','')")
        };
        let ddl = prepare("CREATE TABLE t(v enum('ready','it''s done',''))", std::slice::from_ref(&column), "D", "t")
            .unwrap()
            .ddl;
        assert!(ddl.contains("VARCHAR(10) CHECK (`v` IN ('ready', 'it''s done', ''))"), "{ddl}");
        assert!(prepare(
            "CREATE TABLE t(v enum('ready','it''s done',''))",
            &[db::ColumnInfo { enum_values: None, ..column }],
            "D",
            "t"
        )
        .is_err());
    }

    #[test]
    fn projection_handles_keywords_inside_quoted_column_names() {
        let columns = [col("x FROM y", "blob"), col("tick`name", "int")];
        let sql = project_page("SELECT `x FROM y`, `tick``name` FROM `db`.`t` LIMIT 1", &columns).unwrap();
        assert!(sql.ends_with("FROM `db`.`t` LIMIT 1"));
        assert!(sql.contains("HEX(`x FROM y`)"));
        assert!(project_page("SELECT * FROM `db`.`t`", &columns).is_err());
    }

    #[test]
    fn ordinary_indexes_use_xugu_simple_names_on_qualified_tables() {
        let ddl = prepare("CREATE TABLE t(v INT, KEY idx_v(v))", &[col("v", "int")], "Dst", "MixedTable").unwrap().ddl;
        assert!(ddl.contains("CREATE INDEX `MixedTable_idx_v` ON `Dst`.`MixedTable` (`v`)"), "{ddl}");
        assert!(!ddl.contains("CREATE INDEX `Dst`."), "{ddl}");
    }
}
