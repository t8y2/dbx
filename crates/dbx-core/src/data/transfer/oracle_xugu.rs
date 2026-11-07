//! Oracle → native Xugu table transfer. All conversion and validation stays
//! pair-local: neither the generic mapper nor either database's driver changes.
use super::*;
use sqlparser::{
    ast::{ColumnOption, CreateIndex, CreateTable, Expr, Ident, IndexColumn, ObjectName, Statement, TableConstraint},
    dialect::OracleDialect,
    parser::Parser,
    tokenizer::{Token, TokenWithSpan, Tokenizer},
};
use std::collections::BTreeSet;

static EXACT_NUMBER_TEXT: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").expect("exact Oracle numeric projection")
});

static EXACT_TEMPORAL_TEXT: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"^([0-9]{4})-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})? (AD|BC)$")
        .expect("exact Oracle temporal projection")
});

pub(crate) fn is_pair(source: &DatabaseType, target: &DatabaseType) -> bool {
    *source == DatabaseType::Oracle && *target == DatabaseType::Xugu
}

/// Map only domains whose bounds are known. Unconstrained or unusual NUMBER
/// definitions must not silently acquire a default precision or scale.
pub(super) fn numeric_type(column: &db::ColumnInfo) -> Result<String, String> {
    let raw = column.data_type.trim();
    if !raw.split('(').next().is_some_and(|base| base.trim().eq_ignore_ascii_case("NUMBER")) {
        return Err(format!("Oracle column '{}' is not a NUMBER", column.name));
    }
    let args = parameters(raw);
    let p = column.numeric_precision.or_else(|| args.first().copied());
    let s = column.numeric_scale.or_else(|| args.get(1).copied()).or_else(|| (!args.is_empty()).then_some(0));
    if args.first().is_some_and(|value| Some(*value) != p) || args.get(1).is_some_and(|value| Some(*value) != s) {
        return Err(format!("Oracle NUMBER metadata disagrees for '{}'", column.name));
    }
    match (p, s) {
        (Some(precision @ 1..=38), Some(scale)) if (0..=precision).contains(&scale) => {
            Ok(format!("NUMERIC({precision},{scale})"))
        }
        _ => Err(format!("Oracle column '{}': NUMBER precision or scale cannot be mapped safely to Xugu", column.name)),
    }
}

/// Refuse a generated table definition if it cannot be reconciled with the
/// complete source DDL. Exact case matters for quoted Oracle identifiers.
pub(super) fn validate_source_definition(
    ddl: &str,
    schema: &str,
    table: &str,
    columns: &[db::ColumnInfo],
) -> Result<(), String> {
    let (definition, _) = parse_source(ddl)?;
    ensure_identity(&definition.name, schema, table)?;
    let planned: BTreeSet<_> = definition.columns.iter().map(|column| effective(&column.name)).collect();
    let actual: BTreeSet<_> = columns.iter().map(|column| column.name.clone()).collect();
    if columns.is_empty()
        || actual.len() != columns.len()
        || planned.len() != definition.columns.len()
        || actual != planned
    {
        return Err(format!("Oracle source table '{table}' has incomplete or conflicting column metadata"));
    }
    Ok(())
}

/// Validate the whole fetched batch before emitting any INSERT. Values that
/// the native Xugu SQL path may silently alter must not be reported as copied.
pub(super) fn validate_rows(columns: &[db::ColumnInfo], rows: &[Vec<serde_json::Value>]) -> Result<(), String> {
    for row in rows {
        if row.len() != columns.len() {
            return Err("Incomplete Oracle transfer row".into());
        }
        for (column, value) in columns.iter().zip(row) {
            let kind = column.data_type.to_ascii_uppercase();
            let base = kind.split(['(', ' ']).next().unwrap_or_default();
            if matches!(base, "CHAR" | "NCHAR" | "VARCHAR2" | "NVARCHAR2" | "CLOB" | "NCLOB") {
                if let Some(text) = value.as_str() {
                    if text.contains('\0') || text.chars().any(|ch| u32::from(ch) > 0xffff) {
                        return Err(format!(
                            "Oracle column '{}' contains text that cannot yet be copied losslessly",
                            column.name
                        ));
                    }
                    if matches!(base, "CHAR" | "NCHAR" | "VARCHAR2" | "NVARCHAR2") && text.ends_with(' ') {
                        return Err(format!(
                            "Oracle column '{}' contains trailing spaces that Xugu may remove",
                            column.name
                        ));
                    }
                } else if !value.is_null() {
                    return Err(format!("Oracle column '{}' did not return a text value", column.name));
                }
            }
            if value.is_null() {
                continue;
            }
            if matches!(base, "DATE" | "TIMESTAMP") {
                let temporal = value.as_str().and_then(|text| EXACT_TEMPORAL_TEXT.captures(text));
                if temporal
                    .as_ref()
                    .is_none_or(|parts| &parts[1] == "0000" || (&parts[1] == "0001" && &parts[2] == "BC"))
                {
                    // Xugu's documented BC range ends at 0002-01-01 BC;
                    // Oracle also accepts 0001 BC. Refuse before CREATE or
                    // overwrite clear rather than changing the stored year.
                    return Err(format!(
                        "Oracle temporal column '{}' contains a date outside Xugu's supported range or an invalid temporal projection",
                        column.name
                    ));
                }
            }
            if matches!(base, "RAW" | "BLOB") {
                let hex =
                    value.as_str().and_then(|value| value.strip_prefix("0x").or_else(|| value.strip_prefix("0X")));
                if hex.is_none_or(|hex| hex.len() % 2 != 0 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())) {
                    return Err(format!(
                        "Oracle binary column '{}' did not return complete hexadecimal data",
                        column.name
                    ));
                }
            }
            if base == "NUMBER" {
                let text = value
                    .as_str()
                    .ok_or_else(|| format!("Oracle NUMBER '{}' lost its exact text projection", column.name))?;
                if !EXACT_NUMBER_TEXT.is_match(text) {
                    return Err(format!("Invalid Oracle NUMBER representation for '{}'", column.name));
                }
            }
            if matches!(base, "BINARY_FLOAT" | "BINARY_DOUBLE") {
                // Native Oracle FLOAT values can arrive as JSON numbers or
                // decimal strings. Accept both finite representations, but
                // reject NaN/Infinity and overflowing exponents before writes.
                let finite = value
                    .as_f64()
                    .or_else(|| {
                        value
                            .as_str()
                            .filter(|text| EXACT_NUMBER_TEXT.is_match(text))
                            .and_then(|text| text.parse::<f64>().ok())
                    })
                    .is_some_and(f64::is_finite);
                if !finite {
                    return Err(format!(
                        "Oracle floating-point column '{}' contains a non-finite or invalid value",
                        column.name
                    ));
                }
            }
        }
    }
    Ok(())
}

fn parameters(kind: &str) -> Vec<i32> {
    kind.split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(args, _)| args.split(',').filter_map(|value| value.split_whitespace().next()?.parse().ok()).collect())
        .unwrap_or_default()
}

fn effective(name: &Ident) -> String {
    if name.quote_style.is_some() {
        name.value.clone()
    } else {
        name.value.to_uppercase()
    }
}

fn quote(name: &str) -> String {
    quote_identifier(name, &DatabaseType::Xugu)
}

fn ensure_identity(name: &ObjectName, schema: &str, table: &str) -> Result<(), String> {
    let parts = name
        .0
        .iter()
        .map(|part| part.as_ident().map(effective).ok_or("Expected a plain Oracle object identity"))
        .collect::<Result<Vec<_>, _>>()?;
    if matches!(parts.as_slice(), [name] if name == table)
        || matches!(parts.as_slice(), [owner, name] if owner == schema && name == table)
    {
        Ok(())
    } else {
        Err(format!("Oracle DDL belongs to another object, not {schema}.{table}"))
    }
}

// DBMS_METADATA emits enabled constraints with Oracle-only markers. Remove
// only the explicit default forms, at token boundaries; DISABLE/NOVALIDATE,
// storage options and quoted identifiers are never discarded.
fn portable_tokens(sql: &str) -> Result<Vec<TokenWithSpan>, String> {
    let mut tokens =
        Tokenizer::new(&OracleDialect {}, sql).tokenize_with_location().map_err(|error| error.to_string())?;
    tokens.retain(|token| !matches!(token.token, Token::Whitespace(_)));
    let word = |token: Option<&TokenWithSpan>, expected: &str| matches!(token.map(|token| &token.token), Some(Token::Word(word)) if word.quote_style.is_none() && word.value.eq_ignore_ascii_case(expected));
    let mut output = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        if word(tokens.get(index), "USING")
            && word(tokens.get(index + 1), "INDEX")
            && word(tokens.get(index + 2), "ENABLE")
        {
            // A named index or physical options must be handled explicitly,
            // not silently treated as the default backing index.
            index += 2;
        }
        if word(tokens.get(index), "ENABLE") {
            let previous = output.last().map(|token: &TokenWithSpan| &token.token);
            let enabled_not_null = word(output.last(), "NULL") && word(output.iter().rev().nth(1), "NOT");
            let at_boundary = matches!(
                tokens.get(index + 1).map(|token| &token.token),
                None | Some(Token::Comma | Token::RParen | Token::SemiColon)
            );
            if at_boundary && (enabled_not_null || previous == Some(&Token::RParen)) {
                index += 1;
                continue;
            }
            return Err("Oracle constraint ENABLE options require manual conversion".into());
        }
        output.push(tokens[index].clone());
        index += 1;
    }
    Ok(output)
}

fn parse_source(ddl: &str) -> Result<(CreateTable, Vec<CreateIndex>), String> {
    let mut table = None;
    let mut indexes = Vec::new();
    for fragment in split_sql_statements_for_database(ddl, DatabaseType::Oracle) {
        let mut statements = Parser::new(&OracleDialect {})
            .with_tokens_with_locations(portable_tokens(&fragment)?)
            .parse_statements()
            .map_err(|error| format!("Cannot parse complete Oracle table DDL: {error}"))?;
        if statements.len() != 1 {
            return Err("Expected a complete Oracle table DDL fragment".into());
        }
        match statements.remove(0) {
            Statement::CreateTable(definition) if table.is_none() => table = Some(definition),
            Statement::CreateIndex(index) => indexes.push(index),
            // Comments are re-emitted from the same column/table metadata as
            // the preview; never execute a source script verbatim on Xugu.
            Statement::Comment { .. } => (),
            _ => {
                return Err(
                    "Oracle source DDL contains an object or clause not supported by table-only Xugu transfer".into()
                )
            }
        }
    }
    let table = table.ok_or("Missing complete Oracle CREATE TABLE definition")?;
    if table.columns.is_empty()
        || table.or_replace
        || table.temporary
        || table.external
        || table.global.is_some()
        || table.query.is_some()
        || table.like.is_some()
        || table.clone.is_some()
        || table.partition_by.is_some()
        || table.partition_of.is_some()
        || table.on_commit.is_some()
        || table.on_cluster.is_some()
        || table.primary_key.is_some()
        || table.order_by.is_some()
        || table.cluster_by.is_some()
        || table.clustered_by.is_some()
        || table.inherits.is_some()
        || table.file_format.is_some()
        || table.location.is_some()
    {
        return Err("Oracle temporary, external, partitioned or query-defined tables require manual conversion".into());
    }
    Ok((table, indexes))
}

/// No guessed defaults for unbounded NUMBER, Oracle decimal FLOAT, local-time
/// zones, UDTs, LONG, spatial, or generated/identity columns in this phase.
pub(super) fn column_type(column: &db::ColumnInfo) -> Result<String, String> {
    let raw = column.data_type.trim().to_ascii_uppercase();
    let kind = normalize_xugu_type_name(&raw);
    let args = parameters(&raw);
    let fail = || {
        format!(
            "Oracle column '{}': type '{}' cannot yet be transferred to Xugu without loss",
            column.name, column.data_type
        )
    };
    if column.extra.as_deref().is_some_and(|extra| {
        let extra = extra.to_ascii_uppercase();
        extra.contains("IDENTITY") || extra.contains("GENERATED") || extra.contains("VIRTUAL")
    }) {
        return Err(fail());
    }
    match kind.as_str() {
        "NUMBER" => numeric_type(column),
        "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" => {
            let length = column
                .character_maximum_length
                .filter(|length| *length > 0)
                .or_else(|| args.first().copied())
                .filter(|n| (1..=60000).contains(n))
                .ok_or_else(fail)?;
            let name = if matches!(kind.as_str(), "CHAR" | "NCHAR") { "CHAR" } else { "VARCHAR" };
            Ok(format!("{name}({length})"))
        }
        "RAW" => {
            let length = column
                .character_maximum_length
                .filter(|length| *length > 0)
                .or_else(|| args.first().copied())
                .filter(|n| (1..=65535).contains(n))
                .ok_or_else(fail)?;
            Ok(format!("BINARY({length})"))
        }
        "CLOB" | "NCLOB" => Ok("CLOB".into()),
        "BLOB" => Ok("BLOB".into()),
        "BINARY_FLOAT" => Ok("FLOAT".into()),
        "BINARY_DOUBLE" => Ok("DOUBLE".into()),
        "DATE" => Ok("DATETIME(0)".into()),
        "TIMESTAMP" => {
            let precision = args.first().copied().or(column.numeric_scale).unwrap_or(6);
            if !(0..=6).contains(&precision) {
                return Err(fail());
            }
            Ok(format!("DATETIME({precision})"))
        }
        _ => Err(fail()),
    }
}

fn key_columns(columns: &[IndexColumn], known: &BTreeSet<String>) -> Result<String, String> {
    columns
        .iter()
        .map(|column| {
            let Expr::Identifier(name) = &column.column.expr else {
                return Err("Oracle expression indexes require manual Xugu conversion".into());
            };
            let name = effective(name);
            if !known.contains(&name) || column.operator_class.is_some() || column.column.options.nulls_first.is_some()
            {
                return Err("Oracle index columns/options cannot be verified".into());
            }
            Ok(format!("{}{}", quote(&name), if column.column.options.asc == Some(false) { " DESC" } else { "" }))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|columns| columns.join(", "))
}

fn default_sql(expr: &Expr, column: &db::ColumnInfo) -> Result<String, String> {
    use sqlparser::ast::{UnaryOperator, Value};
    match expr {
        Expr::Nested(inner) => default_sql(inner, column),
        Expr::Value(value) => match &value.value {
            Value::Null => Ok("NULL".into()),
            Value::Number(number, _) => Ok(number.clone()),
            Value::SingleQuotedString(text) | Value::NationalStringLiteral(text) => {
                // Oracle's empty string default is SQL NULL, unlike an empty
                // Xugu CLOB. Do not accidentally create a non-null default.
                if text.is_empty() {
                    return Ok("NULL".into());
                }
                validate_rows(std::slice::from_ref(column), &[vec![text.clone().into()]])?;
                Ok(quote_string_literal(text))
            }
            _ => Err(format!("Unsupported Oracle default on '{}'", column.name)),
        },
        Expr::UnaryOp { op: UnaryOperator::Plus | UnaryOperator::Minus, expr: inner } if matches!(inner.as_ref(), Expr::Value(value) if matches!(value.value, Value::Number(..))) => {
            Ok(expr.to_string())
        }
        _ if expr.to_string().eq_ignore_ascii_case("SYSDATE") && column.data_type.eq_ignore_ascii_case("DATE") => {
            Ok("CURRENT_TIMESTAMP".into())
        }
        _ => Err(format!("Oracle default expression on '{}' requires manual Xugu conversion", column.name)),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare(
    ddl: &str,
    columns: &[db::ColumnInfo],
    source_schema: &str,
    source_table: &str,
    target_schema: &str,
    target_table: &str,
    table_comment: Option<&str>,
) -> Result<ddl_plan::PreparedTableDdl, String> {
    if [ddl, source_schema, source_table, target_schema, target_table]
        .iter()
        .any(|value| value.contains('\0') || value.chars().any(|c| u32::from(c) > 0xffff))
    {
        return Err("Oracle DDL/identifiers contain characters unsupported by native Xugu SQL text".into());
    }
    validate_source_definition(ddl, source_schema, source_table, columns)?;
    let (definition, indexes) = parse_source(ddl)?;
    let known: BTreeSet<_> = columns.iter().map(|column| column.name.clone()).collect();
    let full_table = format!("{}.{}", quote(target_schema), quote(target_table));
    let mut lines = Vec::new();
    for source in definition.columns {
        let name = effective(&source.name);
        let column = columns.iter().find(|column| column.name == name).ok_or("Missing Oracle column metadata")?;
        let mapped = column_type(column)?;
        let declared =
            db::ColumnInfo { name: name.clone(), data_type: source.data_type.to_string(), ..Default::default() };
        if column_type(&declared)? != mapped {
            return Err(format!("Oracle DDL and catalog types disagree for '{name}'"));
        }
        let mut line = format!("  {} {mapped}", quote(&name));
        for option in source.options {
            match option.option {
                ColumnOption::Null => line.push_str(" NULL"),
                ColumnOption::NotNull => line.push_str(" NOT NULL"),
                ColumnOption::Default(expr) => line.push_str(&format!(" DEFAULT {}", default_sql(&expr, column)?)),
                ColumnOption::Unique(unique) if unique.characteristics.is_none() => line.push_str(" UNIQUE"),
                ColumnOption::PrimaryKey(key) if key.characteristics.is_none() => line.push_str(" PRIMARY KEY"),
                _ => {
                    return Err(format!(
                        "Oracle column '{name}' has an unsupported generated/default/constraint option"
                    ))
                }
            }
        }
        lines.push(line);
    }
    for constraint in definition.constraints {
        let (kind, keys) = match constraint {
            TableConstraint::PrimaryKey(key)
                if key.characteristics.is_none() && key.index_options.is_empty() && key.index_type.is_none() =>
            {
                ("PRIMARY KEY", key.columns)
            }
            TableConstraint::Unique(key)
                if key.characteristics.is_none() && key.index_options.is_empty() && key.index_type.is_none() =>
            {
                ("UNIQUE", key.columns)
            }
            _ => {
                return Err(
                    "Oracle foreign keys, CHECK or option-bearing constraints require manual Xugu conversion".into()
                )
            }
        };
        lines.push(format!("  {kind} ({})", key_columns(&keys, &known)?));
    }
    let mut statements = vec![format!("CREATE TABLE {full_table} (\n{}\n)", lines.join(",\n"))];
    for index in indexes {
        ensure_identity(&index.table_name, source_schema, source_table)?;
        if index.using.is_some()
            || !index.include.is_empty()
            || !index.with.is_empty()
            || index.predicate.is_some()
            || !index.index_options.is_empty()
            || !index.alter_options.is_empty()
            || index.nulls_distinct.is_some()
            || index.concurrently
            || index.if_not_exists
        {
            return Err("Oracle specialized index options require manual Xugu conversion".into());
        }
        let name = index
            .name
            .as_ref()
            .and_then(|name| name.0.last())
            .and_then(|part| part.as_ident())
            .map(effective)
            .ok_or("Missing Oracle index name")?;
        statements.push(format!(
            "CREATE {}INDEX {} ON {full_table} ({})",
            if index.unique { "UNIQUE " } else { "" },
            quote(&name),
            key_columns(&index.columns, &known)?
        ));
    }
    let mut comment = |target: String, value: &str| -> Result<(), String> {
        if value.contains('\0') || value.chars().any(|c| u32::from(c) > 0xffff) {
            return Err("Oracle comment cannot be copied losslessly to Xugu".into());
        }
        statements.push(format!("COMMENT ON {target} IS {}", quote_string_literal(value)));
        Ok(())
    };
    if let Some(value) = table_comment.filter(|value| !value.is_empty()) {
        comment(format!("TABLE {full_table}"), value)?;
    }
    for column in columns {
        if let Some(value) = column.comment.as_deref().filter(|value| !value.is_empty()) {
            comment(format!("COLUMN {full_table}.{}", quote(&column.name)), value)?;
        }
    }
    Ok(ddl_plan::PreparedTableDdl {
        ddl: format!(
            "-- Oracle storage, character-set and collation settings are not copied; target Xugu semantics apply.\n{};",
            statements.join(";\n")
        ),
        reused_source_ddl: false,
        deferred_fk_alters: vec![],
        deferred_fk_names: vec![],
        source_evidence: None,
    })
}

/// These are generated transfer reads, not arbitrary user queries. The source
/// projects exact decimal/temporal values before either driver's JSON path.
pub(super) fn cursor_sql(columns: &[db::ColumnInfo], schema: &str, table: &str) -> String {
    let mut projection = columns
        .iter()
        .map(|column| {
            let name = quote_identifier(&column.name, &DatabaseType::Oracle);
            let kind = normalize_xugu_type_name(&column.data_type);
            let expr = match kind.as_str() {
                "NUMBER" => format!("TO_CHAR({name}, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')"),
                "DATE" => format!("TO_CHAR({name}, 'YYYY-MM-DD HH24:MI:SS AD', 'NLS_DATE_LANGUAGE=American')"),
                "TIMESTAMP" => {
                    let precision =
                        parameters(&column.data_type).first().copied().or(column.numeric_scale).unwrap_or(6);
                    let fraction = if precision == 0 { String::new() } else { format!(".FF{precision}") };
                    format!("TO_CHAR({name}, 'YYYY-MM-DD HH24:MI:SS{fraction} AD', 'NLS_DATE_LANGUAGE=American')")
                }
                "RAW" => format!("CASE WHEN {name} IS NULL THEN NULL ELSE '0x' || RAWTOHEX({name}) END"),
                _ => name.clone(),
            };
            format!("{expr} AS {name}")
        })
        .collect::<Vec<_>>();
    // The Oracle wire decoder may expose an empty locator as JSON null.
    // Carry SQL-level NULL/empty/nonempty evidence in the same cursor page;
    // no extra query per row and no LOB substring/truncation is needed.
    for (index, _) in lob_columns(columns) {
        let name = quote_identifier(&columns[index].name, &DatabaseType::Oracle);
        projection.push(format!(
            "CASE WHEN {name} IS NULL THEN 0 WHEN DBMS_LOB.GETLENGTH({name})=0 THEN 1 ELSE 2 END AS \"DBX_LOB_STATE_{index}\""
        ));
    }
    format!("SELECT {} FROM {}", projection.join(", "), qualified_table(table, schema, &DatabaseType::Oracle, None))
}

fn lob_columns(columns: &[db::ColumnInfo]) -> Vec<(usize, bool)> {
    columns
        .iter()
        .enumerate()
        .filter_map(|(index, column)| match normalize_xugu_type_name(&column.data_type).as_str() {
            "BLOB" => Some((index, true)),
            "CLOB" | "NCLOB" => Some((index, false)),
            _ => None,
        })
        .collect()
}

pub(super) fn normalize_lob_rows(
    columns: &[db::ColumnInfo],
    rows: &mut [Vec<serde_json::Value>],
) -> Result<(), String> {
    let lobs = lob_columns(columns);
    for row in rows {
        if row.len() != columns.len() + lobs.len() {
            return Err("Incomplete Oracle LOB state evidence".into());
        }
        for (offset, &(index, binary)) in lobs.iter().enumerate() {
            let state = &row[columns.len() + offset];
            let state = state.as_u64().or_else(|| state.as_str().and_then(|value| value.parse::<u64>().ok()));
            match state {
                Some(0) if row[index].is_null() => (),
                Some(1)
                    if row[index].is_null()
                        || row[index].as_str().is_some_and(|value| {
                            if binary {
                                value.is_empty() || value.eq_ignore_ascii_case("0x")
                            } else {
                                value.is_empty()
                            }
                        }) =>
                {
                    row[index] = serde_json::Value::String(if binary { "0x".into() } else { String::new() });
                }
                Some(2)
                    if row[index]
                        .as_str()
                        .is_some_and(|value| !value.is_empty() && (!binary || !value.eq_ignore_ascii_case("0x"))) => {}
                _ => {
                    return Err(format!(
                        "Oracle LOB '{}' has missing or conflicting state evidence",
                        columns[index].name
                    ))
                }
            }
        }
        row.truncate(columns.len());
    }
    Ok(())
}

pub(super) fn validate_target(source: &[db::ColumnInfo], target: &[db::ColumnInfo]) -> Result<(), String> {
    for column in source {
        let matches = target.iter().filter(|target| target.name == column.name).collect::<Vec<_>>();
        let [destination] = matches.as_slice() else {
            return Err(format!("Missing or ambiguous Xugu column '{}'", column.name));
        };
        let expected = column_type(column)?;
        let wanted = normalize_xugu_type_name(&expected);
        let actual = normalize_xugu_type_name(&destination.data_type);
        let canonical = |kind: &str| {
            match kind {
                "NUMBER" | "DECIMAL" => "NUMERIC",
                "VARBINARY" => "BINARY",
                _ => kind,
            }
            .to_string()
        };
        if canonical(&wanted) != canonical(&actual) {
            return Err(format!(
                "Xugu column '{}' must accept {expected}, found {}",
                column.name, destination.data_type
            ));
        }
        let args = parameters(&expected);
        let actual_args = parameters(&destination.data_type);
        if matches!(wanted.as_str(), "CHAR" | "VARCHAR" | "BINARY")
            && destination
                .character_maximum_length
                .or_else(|| actual_args.first().copied())
                .is_none_or(|length| length < args[0])
        {
            return Err(format!("Xugu column '{}' is shorter than {expected}", column.name));
        }
        if wanted == "NUMERIC" {
            let precision = destination
                .numeric_precision
                .or_else(|| actual_args.first().copied())
                .ok_or("Missing Xugu numeric precision")?;
            let scale = destination
                .numeric_scale
                .or_else(|| actual_args.get(1).copied())
                .ok_or("Missing Xugu numeric scale")?;
            if scale < args[1] || precision - scale < args[0] - args[1] {
                return Err(format!("Xugu column '{}' cannot hold {expected}", column.name));
            }
        }
        if wanted == "DATETIME"
            && destination.numeric_scale.or_else(|| actual_args.first().copied()).is_none_or(|scale| scale < args[0])
        {
            return Err(format!("Xugu column '{}' cannot preserve {expected} precision", column.name));
        }
        if column.is_nullable && !destination.is_nullable {
            return Err(format!("Nullable Oracle column '{}' has a NOT NULL Xugu target", column.name));
        }
        if destination.extra.as_deref().is_some_and(|extra| extra.to_ascii_lowercase().contains("generated")) {
            return Err(format!("Xugu target column '{}' is generated", column.name));
        }
    }
    for column in target {
        if !source.iter().any(|source| source.name == column.name)
            && !target_column_can_be_omitted(column, &DatabaseType::Xugu)
        {
            return Err(format!("Required Xugu column '{}' has no Oracle source", column.name));
        }
    }
    Ok(())
}

/// The regular DDL browser can fall back to a metadata-generated definition.
/// Transfer needs DBMS_METADATA's exact source or an error instead. The flag
/// already exists in the Oracle Agent; keep this stricter use pair-local.
pub(super) async fn source_ddl(
    state: &AppState,
    request: &TransferRequest,
    source_pool: &str,
    table: &str,
) -> Result<String, String> {
    let (_, _, _, timeout) = transfer_pool_context(state, source_pool).await;
    let Some(PoolKind::Agent(client)) = state.pool_handle(source_pool).await else {
        return Err("Exact Oracle DDL requires an Oracle Agent connection".into());
    };
    let ddl: String = client
        .lock()
        .await
        .call_method_with_timeout(
            db::agent_driver::AgentMethod::GetTableDdl,
            serde_json::json!({ "database": request.source_database, "schema": request.source_schema,
            "table": table, "portable": true, "exact_identity": true }),
            query_timeout_duration(timeout),
        )
        .await
        .map_err(|error| format!("Cannot read exact Oracle DDL for '{table}': {error}"))?;
    let (_, indexes) = parse_source(&ddl)?;
    // The Agent's dependent-index enrichment is best-effort for browsing.
    // Compare a permission-scoped catalog inventory so a failed enrichment
    // cannot turn an indexed source into an unindexed successful transfer.
    let expected = execute_read_on_pool(state, source_pool, &format!(
        "SELECT i.INDEX_NAME FROM ALL_INDEXES i WHERE i.TABLE_OWNER={} AND i.TABLE_NAME={} AND i.GENERATED='N' AND NOT EXISTS (SELECT 1 FROM ALL_CONSTRAINTS c WHERE c.OWNER=i.TABLE_OWNER AND c.TABLE_NAME=i.TABLE_NAME AND c.CONSTRAINT_TYPE IN ('P','U') AND c.INDEX_NAME=i.INDEX_NAME AND c.INDEX_OWNER=i.OWNER) ORDER BY i.INDEX_NAME",
        quote_string_literal(&request.source_schema), quote_string_literal(table),
    )).await?;
    validate_index_inventory(table, &indexes, &expected)?;
    Ok(ddl)
}

fn validate_index_inventory(table: &str, indexes: &[CreateIndex], inventory: &db::QueryResult) -> Result<(), String> {
    if inventory.has_more || inventory.truncated {
        return Err(format!("Oracle table '{table}' returned a truncated index inventory"));
    }
    let expected = inventory
        .rows
        .iter()
        .map(|row| {
            row.first()
                .and_then(serde_json::Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .ok_or("Incomplete Oracle index inventory")
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let actual = indexes
        .iter()
        .map(|index| {
            index
                .name
                .as_ref()
                .and_then(|name| name.0.last())
                .and_then(|part| part.as_ident())
                .map(effective)
                .ok_or("Incomplete Oracle index DDL")
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if actual != expected || actual.len() != indexes.len() || expected.len() != inventory.rows.len() {
        return Err(format!(
            "Oracle table '{table}' has incomplete or conflicting index DDL; target has not been modified"
        ));
    }
    Ok(())
}

/// All selected tables are checked before overwrite's clear pass. A complete
/// bounded-memory source scan catches lossy text beyond the first page too.
pub(crate) fn preflight<'a>(
    state: &'a AppState,
    request: &'a TransferRequest,
    source_pool: &'a str,
    target_pool: &'a str,
) -> futures::future::BoxFuture<'a, Result<(), String>> {
    Box::pin(async move {
        if !matches!(state.pool_handle(source_pool).await, Some(PoolKind::Agent(_))) {
            return Err("Oracle → Xugu requires the native Oracle Agent cursor path".into());
        }
        for table in &request.tables {
            if is_cancelled(&request.transfer_id).await {
                return Err("Cancelled".into());
            }
            if transfer_table_filter_for(request, table)?.is_some() {
                return Err("Oracle → Xugu table filters are not enabled".into());
            }
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
            for column in &columns {
                column_type(column)?;
            }
            let ddl = source_ddl(state, request, source_pool, table).await?;
            let target_name = request.target_table_name(table);
            prepare(&ddl, &columns, &request.source_schema, table, &request.target_schema, &target_name, None)?;
            let targets = crate::schema::list_tables_core(
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
            if targets.iter().any(|target| target.name == target_name) {
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
                mysql_xugu::enrich_target_temporal_precision(
                    state,
                    target_pool,
                    &request.target_schema,
                    &target_name,
                    &mut target_columns,
                )
                .await?;
                validate_target(&columns, &target_columns)?;
            } else if !request.create_table || matches!(request.content, TransferContent::DataOnly) {
                return Err(format!("Xugu target '{target_name}' does not exist; target has not been modified"));
            }
            if !should_copy_data(&request.content) {
                continue;
            }
            let mut cursor = AgentTransferCursor::default();
            let sql = cursor_sql(&columns, &request.source_schema, table);
            let checked = async {
                loop {
                    if is_cancelled(&request.transfer_id).await {
                        return Err("Cancelled".into());
                    }
                    let mut page =
                        fetch_agent_transfer_batch(state, source_pool, request, &sql, 1000, &mut cursor).await?;
                    normalize_lob_rows(&columns, &mut page.rows)?;
                    validate_rows(&columns, &page.rows)?;
                    if !page.has_more {
                        break;
                    }
                }
                Ok::<_, String>(())
            }
            .await;
            close_agent_transfer_cursor(state, source_pool, &mut cursor).await;
            checked?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporal_range_is_checked_before_any_target_write() {
        for kind in ["DATE", "TIMESTAMP(0)", "TIMESTAMP(3)", "TIMESTAMP(6)"] {
            let columns = [column("WHEN", kind)];
            for value in [
                "0001-01-01 00:00:00 AD",
                "9999-12-31 23:59:59.999999 AD",
                "0002-01-01 12:34:56.123456 BC",
                "2026-10-28 12:34:56 AD",
            ] {
                assert!(validate_rows(&columns, &[vec![value.into()]]).is_ok(), "{kind}: {value}");
            }
            for value in [
                "0001-01-01 00:00:00 BC",
                "0001-12-31 23:59:59.999999 BC",
                "0000-01-01 00:00:00 AD",
                "2026-10-28 12:34:56",
                "2026-10-28 12:34:56 AD; DELETE FROM T",
            ] {
                assert!(validate_rows(&columns, &[vec![value.into()]]).is_err(), "{kind}: {value}");
            }
            // Preflight visits every row, not just the first or first page.
            assert!(validate_rows(
                &columns,
                &[vec!["2026-10-28 12:34:56 AD".into()], vec!["0001-01-01 00:00:00 BC".into()]],
            )
            .is_err());
            assert!(validate_rows(&columns, &[vec![serde_json::Value::Null]]).is_ok());
            assert!(validate_rows(&columns, &[vec![1.into()]]).is_err());
        }
    }

    #[test]
    fn lob_state_evidence_preserves_empty_locators_without_changing_sql_nulls() {
        let columns =
            vec![column("ID", "NUMBER(10,0)"), column("B", "BLOB"), column("L", "CLOB"), column("N", "NCLOB")];
        let mut rows = vec![
            vec![
                serde_json::json!("1"),
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
                0.into(),
                "0".into(),
                0.into(),
            ],
            vec![
                serde_json::json!("2"),
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
                1.into(),
                "1".into(),
                1.into(),
            ],
            vec![
                serde_json::json!("3"),
                "0x00ff".into(),
                "long".repeat(35000).into(),
                "中文".into(),
                2.into(),
                "2".into(),
                2.into(),
            ],
        ];
        normalize_lob_rows(&columns, &mut rows).unwrap();
        assert_eq!(
            rows[0],
            vec![serde_json::json!("1"), serde_json::Value::Null, serde_json::Value::Null, serde_json::Value::Null]
        );
        assert_eq!(rows[1], vec![serde_json::json!("2"), "0x".into(), "".into(), "".into()]);
        assert_eq!(rows[2][1], "0x00ff");
        assert_eq!(rows[2][2].as_str().unwrap().len(), 140000);
        assert!(validate_rows(&columns, &rows).is_ok());
        for row in [
            vec!["1".into(), serde_json::Value::Null, serde_json::Value::Null, serde_json::Value::Null],
            vec![
                "1".into(),
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
                2.into(),
                0.into(),
                0.into(),
            ],
            vec![
                "1".into(),
                "0xff".into(),
                serde_json::Value::Null,
                serde_json::Value::Null,
                1.into(),
                0.into(),
                0.into(),
            ],
            vec![
                "1".into(),
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
                7.into(),
                0.into(),
                0.into(),
            ],
        ] {
            assert!(normalize_lob_rows(&columns, &mut [row]).is_err());
        }
        let plain = vec![column("N", "NUMBER(10,0)")];
        assert!(normalize_lob_rows(&plain, &mut [vec!["123".into()]]).is_ok());
    }

    #[test]
    fn exact_index_inventory_never_accepts_missing_truncated_or_ambiguous_metadata() {
        let (_, indexes) =
            parse_source(r#"CREATE TABLE "S"."T" ("N" NUMBER(10)); CREATE INDEX "S"."MixedIndex" ON "S"."T" ("N");"#)
                .unwrap();
        let mut inventory: db::QueryResult = serde_json::from_value(serde_json::json!({
            "columns": ["INDEX_NAME"], "rows": [["MixedIndex"]],
            "affected_rows": 0, "execution_time_ms": 0,
        }))
        .unwrap();
        assert!(validate_index_inventory("T", &indexes, &inventory).is_ok());
        inventory.has_more = true;
        assert!(validate_index_inventory("T", &indexes, &inventory).is_err());
        inventory.has_more = false;
        inventory.truncated = true;
        assert!(validate_index_inventory("T", &indexes, &inventory).is_err());
        inventory.truncated = false;
        for rows in [
            vec![],
            vec![vec![serde_json::Value::Null]],
            vec![vec![serde_json::json!(123)]],
            vec![vec![serde_json::json!("MIXEDINDEX")]],
            vec![vec![serde_json::json!("MixedIndex")]; 2],
        ] {
            inventory.rows = rows;
            assert!(validate_index_inventory("T", &indexes, &inventory).is_err());
        }
        inventory.rows = vec![vec![serde_json::json!("MixedIndex")]];
        let duplicate = vec![indexes[0].clone(), indexes[0].clone()];
        assert!(validate_index_inventory("T", &duplicate, &inventory).is_err());
        inventory.rows.clear();
        assert!(validate_index_inventory("T", &[], &inventory).is_ok());
    }

    #[test]
    fn non_finite_oracle_floats_are_rejected_during_preflight() {
        for kind in ["BINARY_FLOAT", "BINARY_DOUBLE"] {
            let columns = vec![column("F", kind)];
            for value in [
                serde_json::json!(0),
                serde_json::json!(-1.25),
                serde_json::json!("1.25"),
                serde_json::json!("-123.125"),
                serde_json::json!("1e-30"),
                serde_json::Value::Null,
            ] {
                assert!(validate_rows(&columns, &[vec![value]]).is_ok());
            }
            for value in [
                serde_json::json!("NaN"),
                serde_json::json!("+Inf"),
                serde_json::json!("-Inf"),
                serde_json::json!("1e400"),
                serde_json::json!("1; DROP TABLE T"),
            ] {
                assert!(validate_rows(&columns, &[vec![value]]).is_err());
            }
        }
    }

    #[test]
    fn only_native_oracle_to_xugu_is_selected() {
        assert!(is_pair(&DatabaseType::Oracle, &DatabaseType::Xugu));
        for source in [DatabaseType::Mysql, DatabaseType::OceanbaseOracle, DatabaseType::Xugu] {
            assert!(!is_pair(&source, &DatabaseType::Xugu));
        }
        assert!(!is_pair(&DatabaseType::Xugu, &DatabaseType::Oracle));
    }

    #[test]
    fn numeric_mapping_never_clamps_or_invents_precision() {
        let mut column = db::ColumnInfo { name: "amount".into(), data_type: "NUMBER".into(), ..Default::default() };
        for (precision, scale, expected) in
            [(1, 0, "NUMERIC(1,0)"), (38, 38, "NUMERIC(38,38)"), (20, 5, "NUMERIC(20,5)")]
        {
            column.numeric_precision = Some(precision);
            column.numeric_scale = Some(scale);
            assert_eq!(numeric_type(&column).unwrap(), expected);
        }
        for (precision, scale) in
            [(None, None), (Some(10), None), (Some(39), Some(0)), (Some(5), Some(-2)), (Some(5), Some(6))]
        {
            column.numeric_precision = precision;
            column.numeric_scale = scale;
            assert!(numeric_type(&column).is_err());
        }
    }

    #[test]
    fn source_definition_must_match_exact_identity_and_column_names() {
        let ddl = r#"CREATE TABLE "Source"."Items" ("Id" NUMBER(10,0), "Text" VARCHAR2(30))"#;
        let columns = vec![
            db::ColumnInfo { name: "Id".into(), ..Default::default() },
            db::ColumnInfo { name: "Text".into(), ..Default::default() },
        ];
        assert!(validate_source_definition(ddl, "Source", "Items", &columns).is_ok());
        assert!(validate_source_definition(ddl, "SOURCE", "Items", &columns).is_err());
        assert!(validate_source_definition(ddl, "Source", "Other", &columns).is_err());
        assert!(validate_source_definition(ddl, "Source", "Items", &columns[..1]).is_err());
        let duplicate = vec![columns[0].clone(), columns[0].clone()];
        assert!(validate_source_definition(ddl, "Source", "Items", &duplicate).is_err());
    }

    #[test]
    fn validate_text_batches_without_treating_binary_as_text() {
        let columns = vec![
            db::ColumnInfo { name: "memo".into(), data_type: "CLOB".into(), ..Default::default() },
            db::ColumnInfo { name: "raw".into(), data_type: "BLOB".into(), ..Default::default() },
        ];
        assert!(validate_rows(&columns, &[vec!["你好".into(), "0x00ff".into()]]).is_ok());
        assert!(validate_rows(&columns, &[vec!["unsafe\0text".into(), serde_json::Value::Null]]).is_err());
        assert!(validate_rows(&columns, &[vec!["😀".into(), serde_json::Value::Null]]).is_err());
        let varchar = vec![db::ColumnInfo { name: "v".into(), data_type: "VARCHAR2".into(), ..Default::default() }];
        assert!(validate_rows(&varchar, &[vec!["trailing ".into()]]).is_err());
        assert!(validate_rows(&columns, &[vec!["missing cell".into()]]).is_err());
    }

    fn column(name: &str, data_type: &str) -> db::ColumnInfo {
        db::ColumnInfo { name: name.into(), data_type: data_type.into(), is_nullable: true, ..Default::default() }
    }

    #[test]
    fn oracle_date_keeps_time_and_timestamp_never_gets_implicit_current_time() {
        assert_eq!(column_type(&column("D", "DATE")).unwrap(), "DATETIME(0)");
        assert_eq!(column_type(&column("T", "TIMESTAMP")).unwrap(), "DATETIME(6)");
        for precision in 0..=6 {
            assert_eq!(
                column_type(&column("T", &format!("TIMESTAMP({precision})"))).unwrap(),
                format!("DATETIME({precision})")
            );
        }
        for kind in [
            "TIMESTAMP(9)",
            "TIMESTAMP WITH TIME ZONE",
            "TIMESTAMP WITH LOCAL TIME ZONE",
            "FLOAT(126)",
            "NUMBER",
            "NUMBER(10,-2)",
            "NUMBER(3,5)",
            "XMLTYPE",
            "SDO_GEOMETRY",
            "BFILE",
            "LONG RAW",
            "ROWID",
        ] {
            assert!(column_type(&column("C", kind)).is_err(), "{kind}");
        }
    }

    #[test]
    fn bounded_numeric_character_and_binary_domains_are_preserved() {
        for (kind, wanted) in [
            ("NUMBER(38,6)", "NUMERIC(38,6)"),
            ("NUMBER(10)", "NUMERIC(10,0)"),
            ("VARCHAR2(50 CHAR)", "VARCHAR(50)"),
            ("NVARCHAR2(50)", "VARCHAR(50)"),
            ("CHAR(10 BYTE)", "CHAR(10)"),
            ("NCHAR(10)", "CHAR(10)"),
            ("RAW(16)", "BINARY(16)"),
            ("CLOB", "CLOB"),
            ("NCLOB", "CLOB"),
            ("BLOB", "BLOB"),
            ("BINARY_FLOAT", "FLOAT"),
            ("BINARY_DOUBLE", "DOUBLE"),
        ] {
            assert_eq!(column_type(&column("C", kind)).unwrap(), wanted);
        }
        for kind in ["VARCHAR2", "RAW", "VARCHAR2(60001)", "RAW(65536)", "NUMBER(39,0)"] {
            assert!(column_type(&column("C", kind)).is_err(), "{kind}");
        }
        let mut number = column("C", "NUMBER(12,3)");
        number.numeric_precision = Some(12);
        number.numeric_scale = Some(2);
        assert!(column_type(&number).is_err());
    }

    #[test]
    fn reads_project_exact_values_with_explicit_nls_and_quoted_identifiers() {
        let columns = vec![
            column("N", "NUMBER(38,6)"),
            column("D", "DATE"),
            column("T", "TIMESTAMP(6)"),
            column("R", "RAW(16)"),
            column("B", "BLOB"),
            column("Mixed\"name", "CLOB"),
        ];
        let sql = cursor_sql(&columns, "Owner", "Table");
        assert!(sql.contains("TO_CHAR(\"N\", 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''') AS \"N\""));
        assert!(sql.contains("YYYY-MM-DD HH24:MI:SS AD"));
        assert!(sql.contains("YYYY-MM-DD HH24:MI:SS.FF6 AD"));
        assert!(sql.contains("CASE WHEN \"R\" IS NULL THEN NULL ELSE '0x' || RAWTOHEX(\"R\") END"));
        assert!(sql.contains("\"B\" AS \"B\""));
        assert!(sql.contains("DBMS_LOB.GETLENGTH(\"B\")=0 THEN 1 ELSE 2 END AS \"DBX_LOB_STATE_4\""));
        assert!(sql.ends_with("FROM \"Owner\".\"Table\""));
        assert!(sql.contains("\"Mixed\"\"name\""));
        assert!(!sql.contains("DBMS_LOB.SUBSTR"));
    }

    #[test]
    fn ddl_maps_constraints_comments_indexes_and_exact_case_without_reusing_source_sql() {
        let ddl = r#"CREATE TABLE "Src"."Items" ("Id" NUMBER(10,0) NOT NULL, "Text" VARCHAR2(30 CHAR) DEFAULT 'ok', PRIMARY KEY ("Id")); CREATE INDEX "Src"."IX" ON "Src"."Items" ("Text" DESC); COMMENT ON TABLE "Src"."Items" IS 'source comment';"#;
        let mut columns = vec![column("Id", "NUMBER(10,0)"), column("Text", "VARCHAR2(30 CHAR)")];
        columns[1].comment = Some("it's a column".into());
        let result = prepare(ddl, &columns, "Src", "Items", "Dst", "Items", Some("table comment")).unwrap();
        assert!(!result.reused_source_ddl);
        assert!(result.ddl.contains("NUMERIC(10,0) NOT NULL"));
        assert!(result.ddl.contains("VARCHAR(30) DEFAULT 'ok'"));
        assert!(result.ddl.contains("PRIMARY KEY"));
        assert!(result.ddl.contains("CREATE INDEX"));
        assert!(result.ddl.contains(" DESC"));
        assert!(result.ddl.contains("'it''s a column'"));
        assert!(result.ddl.contains("'table comment'"));
        assert!(!result.ddl.contains("\"Src\""));
    }

    #[test]
    fn native_oracle_portable_enabled_constraints_are_accepted() {
        let ddl = r#"CREATE TABLE "S"."T" ("ID" NUMBER(10,0) NOT NULL ENABLE, "V" VARCHAR2(30 BYTE), CONSTRAINT "PK_T" PRIMARY KEY ("ID") USING INDEX ENABLE)"#;
        let columns = vec![column("ID", "NUMBER(10,0)"), column("V", "VARCHAR2(30 BYTE)")];
        let result = prepare(ddl, &columns, "S", "T", "D", "T", None);
        assert!(result.is_ok(), "{result:?}");
        assert!(prepare(&ddl.replace("ENABLE", "DISABLE"), &columns, "S", "T", "D", "T", None).is_err());
        assert!(prepare(
            &ddl.replace("USING INDEX ENABLE", "USING INDEX ENABLE NOVALIDATE"),
            &columns,
            "S",
            "T",
            "D",
            "T",
            None
        )
        .is_err());
        let mut wrong = columns.clone();
        wrong[1].data_type = "VARCHAR2(10)".into();
        assert!(prepare(ddl, &wrong, "S", "T", "D", "T", None).is_err());
    }

    #[test]
    fn generated_partitioned_expression_and_foreign_key_shapes_fail_closed() {
        let columns = vec![column("ID", "NUMBER(10,0)")];
        for ddl in [
            "CREATE TABLE S.T (ID NUMBER(10,0) GENERATED ALWAYS AS IDENTITY)",
            "CREATE GLOBAL TEMPORARY TABLE S.T (ID NUMBER(10,0))",
            "CREATE TABLE S.T (ID NUMBER(10,0), CHECK (ID > 0))",
            "CREATE TABLE S.T (ID NUMBER(10,0), FOREIGN KEY(ID) REFERENCES S.P(ID))",
            "CREATE TABLE S.T (ID NUMBER(10,0)); CREATE INDEX IX ON S.T(LOWER(ID))",
            "CREATE TABLE S.T (ID NUMBER(10,0)); DROP TABLE S.P",
            "CREATE TABLE S.T (ID NUMBER(10,0), ID NUMBER(10,0))",
        ] {
            assert!(prepare(ddl, &columns, "S", "T", "D", "T", None).is_err(), "{ddl}");
        }
    }

    #[test]
    fn target_capacity_is_validated_before_overwrite() {
        let source = vec![column("N", "NUMBER(12,3)"), column("V", "VARCHAR2(20)"), column("D", "TIMESTAMP(6)")];
        let target = vec![column("N", "NUMERIC(15,5)"), column("V", "VARCHAR(30)"), column("D", "DATETIME(6)")];
        assert!(validate_target(&source, &target).is_ok());
        for (index, wrong) in [(0, "NUMERIC(12,6)"), (1, "VARCHAR(10)"), (2, "DATETIME(3)"), (2, "DATE")] {
            let mut target = target.clone();
            target[index].data_type = wrong.into();
            assert!(validate_target(&source, &target).is_err(), "{wrong}");
        }
        assert!(validate_target(&source, &target[..2]).is_err());
        let mut target = target;
        target[1].name = "v".into();
        assert!(validate_target(&source, &target).is_err());
    }

    #[test]
    fn row_validation_rejects_lossy_numbers_and_binary_without_touching_nulls() {
        let columns = vec![column("N", "NUMBER(38,6)"), column("B", "BLOB"), column("C", "CLOB")];
        assert!(validate_rows(
            &columns,
            &[
                vec!["123456789012345678901234567890.123456".into(), "0x00ff".into(), "中文\\n'".into()],
                vec![serde_json::Value::Null; 3]
            ]
        )
        .is_ok());
        assert!(validate_rows(&columns, &[vec![serde_json::json!(1.5), "0x00".into(), "ok".into()]]).is_err());
        assert!(validate_rows(&columns, &[vec!["1);DROP TABLE T".into(), "0x00".into(), "ok".into()]]).is_err());
        assert!(validate_rows(&columns, &[vec!["1".into(), "0x0".into(), "ok".into()]]).is_err());
        let mut rows = vec![vec!["1".into(), "0x".into(), "ok".into()]; 1001];
        rows[1000][2] = "bad\0later row".into();
        assert!(validate_rows(&columns, &rows).is_err());
    }
}
