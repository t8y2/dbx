use super::dialect::{is_oracle_like, StructureDialect};
use super::types::{EditableStructureColumn, TableStructureSqlOptions};
use super::util::{clean, format_default_for_sql, normalize_default, quote_ident, quote_string};

/// Drops the `CHARACTER SET` / `COLLATE` inputs of MySQL columns that merely
/// inherit the table's default collation, so the generated DDL does not spell
/// out clauses the server would apply anyway.
///
/// MySQL reports the *effective* collation of every character column and never
/// records whether it was written out explicitly, so "equals the table default"
/// is the only signal available. Omitting the clauses is equivalent to keeping
/// them: a column definition without `CHARACTER SET` takes the table default,
/// which is exactly the value being dropped here. This runs on the DDL inputs
/// only — introspection (`get_columns`) still reports the real values so the
/// structure editor can show the column's current charset and collation.
///
/// The original snapshot is normalized alongside the draft so that an untouched
/// column does not register as a charset change and trigger a needless `MODIFY`.
pub(super) fn strip_inherited_mysql_column_charsets(options: &mut TableStructureSqlOptions) {
    let Some(table_collation) = options.table_collation.as_deref().map(str::trim).filter(|value| !value.is_empty())
    else {
        return;
    };
    let inherits = |collation: &str| collation.trim().eq_ignore_ascii_case(table_collation);
    for column in &mut options.columns {
        if inherits(&column.collation) {
            column.character_set = String::new();
            column.collation = String::new();
        }
        if let Some(original) = column.original.as_mut() {
            if original.collation.as_deref().is_some_and(inherits) {
                original.character_set = None;
                original.collation = None;
            }
        }
    }
}

pub(super) fn column_definition(dialect: StructureDialect, column: &EditableStructureColumn) -> String {
    let data_type = column_data_type(dialect, column);
    let mut parts = vec![quote_ident(dialect, &column.name), data_type];
    // QuestDB SQL Syntax: ```ALTER TABLE tableName ADD COLUMN [IF NOT EXISTS] columnName typeDef```
    if dialect == StructureDialect::Questdb {
        parts.insert(0, "IF NOT EXISTS".to_string());
        return parts.join(" ");
    }
    // CHARACTER SET / COLLATE — MySQL character data types only
    if dialect == StructureDialect::Mysql && is_mysql_character_data_type(&column.data_type) {
        if !column.character_set.trim().is_empty() {
            parts.push(format!("CHARACTER SET {}", quote_ident(dialect, &column.character_set)));
        }
        if !column.collation.trim().is_empty() {
            parts.push(format!("COLLATE {}", quote_ident(dialect, &column.collation)));
        }
    }
    let mysql_generated_clause =
        (dialect == StructureDialect::Mysql).then(|| original_mysql_generated_clause(column)).flatten();
    if let Some(generated_clause) = mysql_generated_clause.as_ref() {
        parts.push(generated_clause.clone());
    }
    if !column.is_nullable && !is_oracle_like(dialect) && dialect != StructureDialect::ClickHouse {
        parts.push("NOT NULL".to_string());
    } else if column.is_nullable
        && dialect == StructureDialect::Mysql
        && mysql_generated_clause.is_none()
        && is_mysql_timestamp_type(&column.data_type)
    {
        parts.push("NULL".to_string());
    }
    if mysql_generated_clause.is_none() {
        if let Some(extra_clause) = column_extra_clause(dialect, column) {
            parts.push(extra_clause);
        }
    }
    let default_value = normalize_default(Some(&column.default_value));
    if mysql_generated_clause.is_none() && !default_value.is_empty() {
        parts.push(format!("DEFAULT {}", format_default_for_sql(dialect, &column.data_type, &default_value)));
    }
    if mysql_generated_clause.is_none() {
        if let Some(on_update) = column.extra.as_ref().and_then(|e| e.on_update_current_timestamp).filter(|v| *v) {
            if on_update && dialect == StructureDialect::Mysql {
                parts.push(mysql_on_update_current_timestamp_clause(&column.data_type));
            }
        }
    }
    if matches!(dialect, StructureDialect::Mysql | StructureDialect::GaussdbM | StructureDialect::Doris)
        && !clean(&column.comment).is_empty()
    {
        parts.push(format!("COMMENT {}", quote_string(&clean(&column.comment))));
    }
    parts.join(" ")
}

pub(super) fn original_mysql_generated_clause(column: &EditableStructureColumn) -> Option<String> {
    let extra = column.original.as_ref()?.extra.as_deref()?.trim();
    let normalized = extra.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    (normalized.starts_with("generated ") && normalized.contains(" as (")).then(|| extra.to_string())
}

pub(super) fn original_is_mysql_generated_column(column: &EditableStructureColumn) -> bool {
    let Some(extra) = column.original.as_ref().and_then(|original| original.extra.as_deref()) else {
        return false;
    };
    let mut tokens = extra.split_whitespace();
    let first = tokens.next();
    first.is_some_and(|token| token.eq_ignore_ascii_case("generated"))
        || matches!(first, Some(token) if token.eq_ignore_ascii_case("virtual")
            || token.eq_ignore_ascii_case("stored")
            || token.eq_ignore_ascii_case("persistent"))
            && tokens.next().is_some_and(|token| token.eq_ignore_ascii_case("generated"))
}

pub(super) fn column_extra_clause(dialect: StructureDialect, column: &EditableStructureColumn) -> Option<String> {
    let extra = column.extra.as_ref()?;
    match dialect {
        StructureDialect::Sqlite => {
            if extra.auto_increment.unwrap_or(false) && column.is_primary_key {
                Some("AUTOINCREMENT".to_string())
            } else {
                None
            }
        }
        StructureDialect::Mysql => {
            let mut clauses = Vec::new();
            if extra.auto_increment.unwrap_or(false) {
                clauses.push("AUTO_INCREMENT".to_string());
            }
            if clauses.is_empty() {
                None
            } else {
                Some(clauses.join(" "))
            }
        }
        StructureDialect::Postgres | StructureDialect::H2 => {
            if let Some(identity) = &extra.identity {
                let generation = identity.generation.as_deref().unwrap_or("BY DEFAULT");
                let mut clause = format!("GENERATED {generation} AS IDENTITY");
                if identity.seed.is_some() || identity.increment.is_some() {
                    let start = identity.seed.unwrap_or(1);
                    let inc = identity.increment.unwrap_or(1);
                    clause.push_str(&format!(" (START WITH {start} INCREMENT BY {inc})"));
                }
                Some(clause)
            } else {
                None
            }
        }
        StructureDialect::SqlServer => {
            if extra.auto_increment.unwrap_or(false) || extra.identity.is_some() {
                let seed = extra.identity.as_ref().and_then(|i| i.seed).unwrap_or(1);
                let increment = extra.identity.as_ref().and_then(|i| i.increment).unwrap_or(1);
                Some(format!("IDENTITY({seed}, {increment})"))
            } else {
                None
            }
        }
        StructureDialect::Dameng => {
            if extra.auto_increment.unwrap_or(false) || extra.identity.is_some() {
                let seed = extra.identity.as_ref().and_then(|i| i.seed).unwrap_or(1);
                let increment = extra.identity.as_ref().and_then(|i| i.increment).unwrap_or(1);
                Some(format!("IDENTITY({seed}, {increment})"))
            } else {
                None
            }
        }
        _ => None,
    }
}

pub(super) fn has_dameng_identity(column: &EditableStructureColumn) -> bool {
    column.extra.as_ref().is_some_and(|extra| extra.auto_increment.unwrap_or(false) || extra.identity.is_some())
}

pub(super) fn is_dameng_identity_compatible_type(data_type: &str) -> bool {
    let trimmed = data_type.trim();
    let (base_type, params) = match trimmed.find('(') {
        Some(open_index) => {
            let close_index = trimmed.rfind(')').unwrap_or(trimmed.len());
            (&trimmed[..open_index], trimmed.get(open_index + 1..close_index).unwrap_or(""))
        }
        None => (trimmed, ""),
    };
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    if matches!(normalized.as_str(), "tinyint" | "smallint" | "int" | "integer" | "bigint") {
        return true;
    }
    if !matches!(normalized.as_str(), "number" | "numeric" | "decimal" | "dec") {
        return false;
    }
    let normalized_params = params.split_whitespace().collect::<String>();
    if normalized_params.is_empty() {
        return true;
    }
    let parts = normalized_params.split(',').collect::<Vec<_>>();
    match parts.as_slice() {
        [precision] => precision.parse::<u32>().is_ok(),
        [precision, scale] => precision.parse::<u32>().is_ok() && *scale == "0",
        _ => false,
    }
}

pub(super) fn column_data_type(dialect: StructureDialect, column: &EditableStructureColumn) -> String {
    if dialect == StructureDialect::ClickHouse {
        return clickhouse_column_type(column);
    }
    if dialect == StructureDialect::ManticoreSearch {
        return manticore_column_type(column);
    }
    if dialect == StructureDialect::Questdb {
        return questdb_column_type(column);
    }
    let normalized = normalize_column_data_type(dialect, &column.data_type);
    // Dameng only recognizes its built-in type keywords in the canonical
    // upper-case form: a lower-case `varchar(50)` in DDL is stored as a
    // USER-DEFINED type instead of VARCHAR (issue #7343). Uppercase after the
    // dialect-specific normalization so its rewrites still apply.
    if dialect == StructureDialect::Dameng {
        return normalized.to_uppercase();
    }
    normalized
}

fn manticore_column_type(column: &EditableStructureColumn) -> String {
    let data_type = normalize_column_data_type(StructureDialect::ManticoreSearch, &column.data_type);
    let normalized = data_type.trim().to_ascii_lowercase();
    if normalized == "json" {
        let Some(extra) = column.extra.as_ref() else {
            return data_type;
        };
        if extra.manticore_secondary_index.unwrap_or(false) {
            return format!("{data_type} secondary_index='1'");
        }
        return data_type;
    }
    if !matches!(normalized.as_str(), "text" | "string") {
        return data_type;
    }

    let Some(extra) = column.extra.as_ref() else {
        return data_type;
    };
    let mut parts = vec![data_type];
    if extra.manticore_stored.unwrap_or(false) {
        parts.push("stored".to_string());
    }
    if extra.manticore_attribute.unwrap_or(false) {
        parts.push("attribute".to_string());
    }
    if extra.manticore_indexed.unwrap_or(false) {
        parts.push("indexed".to_string());
    }
    parts.join(" ")
}

pub(super) fn normalize_column_data_type(dialect: StructureDialect, data_type: &str) -> String {
    let trimmed = data_type.trim();
    #[cfg(feature = "duckdb-sidecar")]
    if dialect == StructureDialect::DuckDb {
        if let Some(normalized) = normalize_duckdb_type_modifiers(trimmed) {
            return normalized;
        }
    }
    let Some(open_index) = trimmed.find('(') else {
        return trimmed.to_string();
    };
    if !trimmed.ends_with(')') {
        return trimmed.to_string();
    }

    let base_type = trimmed[..open_index].trim();
    let params = trimmed[open_index + 1..trimmed.len() - 1].trim();
    if base_type.is_empty() || params.is_empty() {
        return trimmed.to_string();
    }

    if dialect == StructureDialect::Mysql {
        if let Some(normalized) = normalize_mysql_numeric_attribute_type(base_type, params) {
            return normalized;
        }
    }

    if is_oracle_like(dialect) && is_oracle_lengthless_type(base_type) {
        // Dameng/Oracle integer aliases do not accept MySQL-style display widths like INTEGER(11).
        return base_type.to_string();
    }

    if dialect == StructureDialect::SqlServer && is_sqlserver_lengthless_type(base_type) {
        // SQL Server exact integer and legacy LOB types do not accept MySQL-style display widths.
        return base_type.to_string();
    }

    if dialect == StructureDialect::SqlServer && is_sqlserver_float_with_scale(base_type, params) {
        // SQL Server float only accepts a single integer mantissa bit count (1–53),
        // not comma-separated precision/scale like float(10,2).
        return base_type.to_string();
    }

    if is_temporal_precision_type(dialect, base_type) {
        return if is_valid_temporal_precision(params, dialect) {
            format!("{base_type}({params})")
        } else {
            base_type.to_string()
        };
    }

    trimmed.to_string()
}

#[cfg(feature = "duckdb-sidecar")]
fn normalize_duckdb_type_modifiers(data_type: &str) -> Option<String> {
    let (raw_base, remainder) = data_type.split_once('(')?;
    let (raw_params, suffix) = remainder.split_once(')')?;
    let params = raw_params.trim();
    if params.is_empty() || params.contains('(') {
        return None;
    }
    let mut base_type = raw_base.trim().to_string();
    let suffix = suffix.split_whitespace().collect::<Vec<_>>().join(" ");
    if !suffix.is_empty() {
        if !matches!(base_type.to_ascii_lowercase().as_str(), "time" | "timestamp")
            || !matches!(suffix.to_ascii_lowercase().as_str(), "with time zone" | "without time zone")
        {
            return None;
        }
        base_type.push(' ');
        base_type.push_str(&suffix);
    }
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "tinyint"
            | "int1"
            | "smallint"
            | "int2"
            | "short"
            | "int16"
            | "integer"
            | "int"
            | "int4"
            | "signed"
            | "integral"
            | "int32"
            | "bigint"
            | "int8"
            | "long"
            | "oid"
            | "int64"
            | "hugeint"
            | "int128"
            | "utinyint"
            | "uint8"
            | "usmallint"
            | "uint16"
            | "uinteger"
            | "uint32"
            | "ubigint"
            | "uint64"
            | "uhugeint"
            | "uint128"
            | "real"
            | "float4"
            | "double"
            | "double precision"
            | "float8"
            | "boolean"
            | "bool"
            | "logical"
            | "blob"
            | "bytea"
            | "binary"
            | "varbinary"
            | "bit"
            | "bitstring"
            | "varint"
            | "bignum"
            | "date"
            | "time"
            | "time without time zone"
            | "time with time zone"
            | "timetz"
            | "timestamptz"
            | "timestamp with time zone"
            | "timestamp_s"
            | "timestamp_ms"
            | "timestamp_ns"
            | "uuid"
            | "guid"
            | "json"
            | "interval"
    ) {
        return Some(base_type);
    }
    if normalized == "float"
        && (!params.bytes().all(|byte| byte.is_ascii_digit())
            || !params.parse::<u64>().is_ok_and(|precision| (1..=53).contains(&precision)))
    {
        return Some(base_type);
    }
    None
}

fn is_oracle_lengthless_type(base_type: &str) -> bool {
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "binary_double"
            | "binary_float"
            | "bigint"
            | "boolean"
            | "bool"
            | "byte"
            | "date"
            | "double"
            | "double precision"
            | "float"
            | "integer"
            | "int"
            | "long"
            | "long raw"
            | "nclob"
            | "real"
            | "smallint"
            | "text"
            | "tinyint"
    )
}

fn is_sqlserver_lengthless_type(base_type: &str) -> bool {
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "bigint"
            | "bit"
            | "date"
            | "datetime"
            | "image"
            | "int"
            | "integer"
            | "money"
            | "ntext"
            | "real"
            | "smalldatetime"
            | "smallint"
            | "smallmoney"
            | "sql_variant"
            | "text"
            | "timestamp"
            | "tinyint"
            | "uniqueidentifier"
            | "xml"
    )
}

/// SQL Server `float` accepts a single integer mantissa bit count (1–53)
/// but rejects comma-separated precision/scale like `float(10,2)`.
fn is_sqlserver_float_with_scale(base_type: &str, params: &str) -> bool {
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    normalized == "float" && params.contains(',')
}

fn normalize_mysql_numeric_attribute_type(base_type: &str, params: &str) -> Option<String> {
    let mut parts: Vec<&str> = base_type.split_whitespace().collect();
    let type_name = parts.first().copied()?.to_ascii_lowercase();
    if !matches!(
        type_name.as_str(),
        "tinyint"
            | "smallint"
            | "mediumint"
            | "int"
            | "integer"
            | "bigint"
            | "real"
            | "double"
            | "float"
            | "decimal"
            | "numeric"
    ) {
        return None;
    }
    let split_index = parts.iter().position(|part| {
        let normalized = part.to_ascii_lowercase();
        matches!(normalized.as_str(), "signed" | "unsigned" | "zerofill")
    })?;
    if !parts[split_index..].iter().all(|part| {
        let normalized = part.to_ascii_lowercase();
        matches!(normalized.as_str(), "signed" | "unsigned" | "zerofill")
    }) {
        return None;
    }

    let attrs = parts.split_off(split_index).join(" ");
    let base = parts.join(" ");
    Some(format!("{base}({params}) {attrs}"))
}

pub(super) fn is_temporal_precision_type(dialect: StructureDialect, base_type: &str) -> bool {
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    match dialect {
        StructureDialect::Mysql => matches!(normalized.as_str(), "time" | "datetime" | "timestamp"),
        StructureDialect::Postgres => matches!(
            normalized.as_str(),
            "time"
                | "time without time zone"
                | "time with time zone"
                | "timestamp"
                | "timestamp without time zone"
                | "timestamp with time zone"
        ),
        StructureDialect::SqlServer => matches!(normalized.as_str(), "time" | "datetime2" | "datetimeoffset"),
        StructureDialect::Oracle | StructureDialect::Dameng | StructureDialect::Oscar => {
            matches!(normalized.as_str(), "timestamp" | "timestamp with time zone" | "timestamp with local time zone")
        }
        _ => false,
    }
}

pub(super) fn is_valid_temporal_precision(params: &str, dialect: StructureDialect) -> bool {
    let Ok(value) = params.parse::<u8>() else {
        return false;
    };
    let max = if matches!(dialect, StructureDialect::Oracle | StructureDialect::Dameng | StructureDialect::Oscar) {
        9
    } else {
        6
    };
    value <= max && params == value.to_string()
}

/// Fractional-seconds precision of a MySQL temporal column type, e.g. `3` for
/// `datetime(3)`. MySQL requires every `CURRENT_TIMESTAMP` in a column
/// definition to carry the same precision the column type declares: a
/// `datetime(3) ... DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`
/// definition is rejected with `ERROR 1067 (42000): Invalid default value`
/// while the `(3)`-suffixed clauses succeed. The editor model keeps only an
/// on-update flag, so the precision has to be recovered from the data type.
/// Non-temporal types and invalid precisions fall back to `None` (no suffix).
pub(super) fn mysql_temporal_precision(data_type: &str) -> Option<String> {
    let trimmed = data_type.trim();
    let open_index = trimmed.find('(')?;
    if !trimmed.ends_with(')') {
        return None;
    }
    let base_type = trimmed[..open_index].trim();
    let params = trimmed[open_index + 1..trimmed.len() - 1].trim();
    if !is_temporal_precision_type(StructureDialect::Mysql, base_type)
        || !is_valid_temporal_precision(params, StructureDialect::Mysql)
    {
        return None;
    }
    Some(params.to_string())
}

/// `ON UPDATE CURRENT_TIMESTAMP` clause for a MySQL column, carrying the
/// column's temporal precision (if any) so the clause matches the type.
pub(super) fn mysql_on_update_current_timestamp_clause(data_type: &str) -> String {
    match mysql_temporal_precision(data_type) {
        Some(fsp) => format!("ON UPDATE CURRENT_TIMESTAMP({fsp})"),
        None => "ON UPDATE CURRENT_TIMESTAMP".to_string(),
    }
}

pub(super) fn clickhouse_column_type(column: &EditableStructureColumn) -> String {
    let data_type = column.data_type.trim();
    if column.is_nullable {
        if data_type.to_ascii_lowercase().starts_with("nullable") {
            data_type.to_string()
        } else {
            format!("Nullable({data_type})")
        }
    } else {
        unwrap_clickhouse_nullable_type(data_type)
    }
}

pub(super) fn unwrap_clickhouse_nullable_type(data_type: &str) -> String {
    let trimmed = data_type.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("nullable(") && trimmed.ends_with(')') {
        trimmed[trimmed.find('(').unwrap_or(0) + 1..trimmed.len() - 1].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

/// QuestDB 类型处理
/// geohash, decimal 这2种类型才能带()
pub(super) fn questdb_column_type(column: &EditableStructureColumn) -> String {
    let data_type = column.data_type.trim().to_ascii_lowercase();
    let length_types: [&str; 2] = ["geohash", "decimal"];
    match data_type.find('(') {
        Some(pos) => {
            let base_type = &data_type[..pos];
            let params = &data_type[pos..];
            if length_types.contains(&base_type) {
                format!("{}{}", base_type, params)
            } else {
                base_type.to_string()
            }
        }
        None => data_type,
    }
}

/// Returns `true` when the data type is a MySQL character/string type that accepts
/// `CHARACTER SET` and `COLLATE` clauses in column definitions.
///
/// Character types that support per-column charset/collation:
///   `char`, `varchar`, `tinytext`, `text`, `mediumtext`, `longtext`, `enum`, `set`
///
/// Numeric, temporal, spatial, binary/blob, and JSON types do NOT support these clauses.
pub(super) fn is_mysql_character_data_type(data_type: &str) -> bool {
    let trimmed = data_type.trim();
    let base_type = match trimmed.find('(') {
        Some(open_index) => trimmed[..open_index].trim(),
        None => trimmed,
    };
    let normalized = base_type.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    matches!(normalized.as_str(), "char" | "varchar" | "tinytext" | "text" | "mediumtext" | "longtext" | "enum" | "set")
}

/// MySQL silently rewrites a nullable `TIMESTAMP` column to `NOT NULL` when the
/// generated DDL omits an explicit `NULL` keyword — regardless of whether a
/// `DEFAULT` is present. With the (still common) `explicit_defaults_for_timestamp`
/// server default of `OFF`, this can outright fail with `ERROR 1067 (42000):
/// Invalid default value` for any non-first TIMESTAMP column. `DATETIME` is not
/// affected and must not be touched.
pub(super) fn is_mysql_timestamp_type(data_type: &str) -> bool {
    let trimmed = data_type.trim();
    let base_type = match trimmed.find('(') {
        Some(open_index) => trimmed[..open_index].trim(),
        None => trimmed,
    };
    base_type.eq_ignore_ascii_case("timestamp")
}

#[cfg(all(test, feature = "duckdb-sidecar"))]
mod duckdb_type_parameter_tests {
    use super::*;
    use crate::table_structure_sql::{build_create_table_sql, build_table_structure_change_sql};

    #[test]
    fn removes_unsupported_scalar_modifiers() {
        for base_type in [
            "TINYINT",
            "INT1",
            "SMALLINT",
            "INT2",
            "SHORT",
            "INT16",
            "INTEGER",
            "INT",
            "INT4",
            "SIGNED",
            "INTEGRAL",
            "INT32",
            "BIGINT",
            "INT8",
            "LONG",
            "OID",
            "INT64",
            "HUGEINT",
            "INT128",
            "UTINYINT",
            "UINT8",
            "USMALLINT",
            "UINT16",
            "UINTEGER",
            "UINT32",
            "UBIGINT",
            "UINT64",
            "UHUGEINT",
            "UINT128",
            "REAL",
            "FLOAT4",
            "DOUBLE",
            "DOUBLE PRECISION",
            "FLOAT8",
            "BOOLEAN",
            "BOOL",
            "LOGICAL",
            "BLOB",
            "BYTEA",
            "BINARY",
            "VARBINARY",
            "BIT",
            "BITSTRING",
            "VARINT",
            "BIGNUM",
            "DATE",
            "TIME",
            "TIME WITHOUT TIME ZONE",
            "TIME WITH TIME ZONE",
            "TIMETZ",
            "TIMESTAMPTZ",
            "TIMESTAMP WITH TIME ZONE",
            "TIMESTAMP_S",
            "TIMESTAMP_MS",
            "TIMESTAMP_NS",
            "UUID",
            "GUID",
            "JSON",
            "INTERVAL",
        ] {
            for params in ["11", "10,2"] {
                let data_type = format!("{base_type}({params})");
                assert_eq!(normalize_column_data_type(StructureDialect::DuckDb, &data_type), base_type);
            }
        }
        assert_eq!(normalize_column_data_type(StructureDialect::DuckDb, "  integer (11)  "), "integer");
        assert_eq!(
            normalize_column_data_type(StructureDialect::DuckDb, "TIMESTAMP(6) WITH TIME ZONE"),
            "TIMESTAMP WITH TIME ZONE"
        );
        assert_eq!(
            normalize_column_data_type(StructureDialect::DuckDb, "TIME(6) WITHOUT TIME ZONE"),
            "TIME WITHOUT TIME ZONE"
        );
    }

    #[test]
    fn preserves_float_mantissa_bits_and_drops_invalid_float_parameters() {
        for precision in ["1", "24", "25", "53"] {
            let data_type = format!("FLOAT({precision})");
            assert_eq!(normalize_column_data_type(StructureDialect::DuckDb, &data_type), data_type);
        }
        for invalid in ["0", "54", "-1", "1.5", "10,2", "abc", "999999999999999999999999"] {
            assert_eq!(normalize_column_data_type(StructureDialect::DuckDb, &format!("FLOAT({invalid})")), "FLOAT");
        }
    }

    #[test]
    fn preserves_supported_compound_unknown_and_other_dialect_types() {
        for data_type in [
            "INTEGER",
            "DECIMAL(10,2)",
            "NUMERIC(38,0)",
            "DEC(12,3)",
            "VARCHAR(255)",
            "CHAR(1)",
            "BPCHAR(20)",
            "CHARACTER VARYING(20)",
            "CHARACTER(20)",
            "TEXT(20)",
            "STRING(20)",
            "NVARCHAR(20)",
            "TIMESTAMP(9)",
            "DATETIME(3)",
            "TIMESTAMP_US(3)",
            "TIMESTAMP(3) WITHOUT TIME ZONE",
            "DECIMAL(10,2)[]",
            "INTEGER[3]",
            "INTEGER(11)[]",
            "STRUCT(id INTEGER, price DECIMAL(10,2))",
            "MAP(VARCHAR, DECIMAL(10,2))",
            "UNION(id INTEGER, name VARCHAR)",
            "ENUM('a', 'b')",
            "custom_type(10)",
            "main.INTEGER(11)",
            "\"INTEGER\"(11)",
            "INTEGER(",
            "INTEGER()",
            "INTEGER(11) trailing",
            "DECIMAL(39,0)",
            "VARCHAR(-1)",
        ] {
            assert_eq!(normalize_column_data_type(StructureDialect::DuckDb, data_type), data_type);
        }
        for dialect in [StructureDialect::Mysql, StructureDialect::Postgres, StructureDialect::Sqlite] {
            for data_type in ["INTEGER(11)", "FLOAT(10,2)", "DECIMAL(10,2)", "VARCHAR(255)"] {
                assert_eq!(normalize_column_data_type(dialect, data_type), data_type);
            }
        }
    }

    #[test]
    fn normalizes_create_and_add_column_save_paths() {
        let options: TableStructureSqlOptions = serde_json::from_value(serde_json::json!({
            "databaseType": "duckdb", "tableName": "issue_9980",
            "columns": [
                {"id": "new:id", "name": "id", "dataType": "INTEGER(11)", "isNullable": true},
                {"id": "new:ratio", "name": "ratio", "dataType": "FLOAT(10,2)", "isNullable": true},
                {"id": "new:amount", "name": "amount", "dataType": "DECIMAL(10,2)", "isNullable": true},
                {"id": "new:label", "name": "label", "dataType": "VARCHAR(255)", "isNullable": true}
            ]
        }))
        .unwrap();
        let created = build_create_table_sql(options.clone());
        assert!(created.warnings.is_empty(), "{:?}", created.warnings);
        assert_eq!(created.statements, vec![
            "CREATE TABLE \"issue_9980\" (\n  \"id\" INTEGER,\n  \"ratio\" FLOAT,\n  \"amount\" DECIMAL(10,2),\n  \"label\" VARCHAR(255)\n);"
        ]);
        let altered = build_table_structure_change_sql(options);
        assert!(altered.warnings.is_empty(), "{:?}", altered.warnings);
        assert_eq!(
            altered.statements,
            vec![
                "ALTER TABLE \"issue_9980\" ADD COLUMN \"id\" INTEGER;",
                "ALTER TABLE \"issue_9980\" ADD COLUMN \"ratio\" FLOAT;",
                "ALTER TABLE \"issue_9980\" ADD COLUMN \"amount\" DECIMAL(10,2);",
                "ALTER TABLE \"issue_9980\" ADD COLUMN \"label\" VARCHAR(255);",
            ]
        );
    }

    #[test]
    fn retains_existing_column_edit_boundary() {
        let options = serde_json::from_value(serde_json::json!({
            "databaseType": "duckdb", "tableName": "issue_9980",
            "column": {
                "id": "existing:id", "name": "id", "dataType": "INTEGER(11)", "isNullable": true,
                "original": {"name": "id", "data_type": "SMALLINT", "is_nullable": true, "column_default": null}
            }
        }))
        .unwrap();
        let altered = crate::table_structure_sql::build_single_column_alter_sql(options);
        assert!(altered.statements.is_empty());
        assert_eq!(altered.warnings, vec!["Editing existing columns is not supported for duckdb yet."]);
    }
}
