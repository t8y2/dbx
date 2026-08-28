//! Column type rewrite pipeline for cross-database DDL generation.
//!
//! Order:
//! 1. Caller-applied user field mappings (highest priority — not handled here)
//! 2. Target [`DdlDialectProfile::type_map`] (data-driven)
//! 3. [`TypeMappingMatrix`] between source/target [`DialectKind`] when available
//! 4. Generic normalization (strip display width when profile disallows it)

use crate::models::connection::DatabaseType;
use crate::sql_dialect::ddl_profile::{profile_for, DdlDialectProfile};
use crate::sql_dialect::descriptor::{DialectKind, TypeMappingMatrix};
use crate::types::ColumnInfo;

/// Split `INT(11)` / `DECIMAL(10,2)` / `VARCHAR` into base + params.
pub fn split_type_base_params(source_type: &str) -> (String, Option<String>) {
    let trimmed = source_type.trim();
    let upper = trimmed.to_ascii_uppercase();
    match upper.find('(') {
        Some(i) => {
            let base = upper[..i].trim().to_string();
            let end = upper.rfind(')').unwrap_or(upper.len());
            let params = upper[i + 1..end].trim().to_string();
            (base, Some(params))
        }
        None => (upper, None),
    }
}

fn first_length_param(params: Option<&str>) -> Option<u32> {
    params.and_then(|p| p.split(',').next()).and_then(|p| p.trim().parse::<u32>().ok())
}

/// Strip Oracle-specific length-unit qualifiers (`CHAR` / `BYTE`) from a
/// parenthesized length slice such as `(50 CHAR)` → `(50)`.
///
/// Oracle allows character columns to declare their length unit explicitly:
/// `VARCHAR2(50 CHAR)` (characters) or `VARCHAR2(50 BYTE)` (bytes). The unit
/// qualifier is Oracle-only syntax — MySQL's `VARCHAR(n)` always means
/// characters and rejects `VARCHAR(50 CHAR)` with ERROR 1064. Stripping the
/// qualifier here keeps the generated target DDL valid while preserving the
/// numeric length.
///
/// Only single numeric parameters followed by `CHAR`/`BYTE` are touched;
/// precision/scale lists (`(10,2)`) and enum/set lists (`('a','b')`) are
/// returned unchanged.
pub fn normalize_len_params(parenthesized: &str) -> String {
    let Some(open) = parenthesized.find('(') else {
        return parenthesized.to_string();
    };
    let Some(close) = parenthesized.rfind(')') else {
        return parenthesized.to_string();
    };
    if open >= close {
        return parenthesized.to_string();
    }
    // Keep any prefix (base type or whitespace) so a full type string such as
    // `varchar(50)` round-trips as-is instead of losing its base name.
    format!("{}({})", &parenthesized[..open], strip_length_unit(&parenthesized[open + 1..close]))
}

/// Strip a trailing `CHAR`/`BYTE` unit from a single length parameter,
/// e.g. `50 CHAR` → `50`. Multi-part or non-numeric parameters are unchanged.
fn strip_length_unit(params: &str) -> String {
    let trimmed = params.trim();
    if trimmed.is_empty() || trimmed.contains(',') {
        return trimmed.to_string();
    }
    let upper = trimmed.to_ascii_uppercase();
    for unit in ["CHAR", "BYTE"] {
        if let Some(head) = upper.strip_suffix(unit) {
            let head = head.trim_end();
            if !head.is_empty() && head.bytes().all(|b| b.is_ascii_digit()) {
                return head.to_string();
            }
        }
    }
    trimmed.to_string()
}

fn apply_template(template: &str, params: Option<&str>, max_varchar_len: Option<u32>) -> String {
    if !template.contains("{}") {
        return template.to_string();
    }
    // Prefer full params for DECIMAL(p,s); single length for TEXT({})
    if template.starts_with("DECIMAL") || template.starts_with("NUMERIC") {
        return match params {
            Some(p) if !p.is_empty() => template.replacen("{}", p, 1),
            _ => template.replace("({})", "").replace("{}", ""),
        };
    }
    let mut len = first_length_param(params).unwrap_or(255);
    if let Some(max) = max_varchar_len {
        len = len.clamp(1, max);
    } else {
        len = len.max(1);
    }
    template.replacen("{}", &len.to_string(), 1)
}

/// Strip MySQL-style display width: `INT(11)` → `INT`, keep `DECIMAL(10,2)` / `VARCHAR(100)`.
///
/// When keeping length/precision params, original casing is preserved (passthrough-ish).
/// When stripping display width, the base is uppercased as a normalized form.
pub fn strip_display_width_if_needed(source_type: &str, profile: &DdlDialectProfile) -> String {
    if profile.supports_display_width {
        return source_type.trim().to_string();
    }
    let trimmed = source_type.trim();
    let (base, params) = split_type_base_params(trimmed);
    let Some(params) = params else {
        return trimmed.to_string();
    };
    // Keep types where parentheses are meaningful precision/length for most targets.
    let keep_params = matches!(
        base.as_str(),
        "VARCHAR"
            | "CHARACTER VARYING"
            | "CHAR"
            | "CHARACTER"
            | "NVARCHAR"
            | "NVARCHAR2"
            | "VARCHAR2"
            | "DECIMAL"
            | "NUMERIC"
            | "NUMBER"
            | "FLOAT"
            | "DOUBLE"
            | "TIME"
            | "TIMESTAMP"
            | "DATETIME"
            | "ENUM"
            | "SET"
    );
    if keep_params {
        // Reconstruct from the original slice so casing stays source-faithful.
        let orig_base = trimmed.split('(').next().unwrap_or(trimmed).trim();
        let open = trimmed.find('(').unwrap_or(orig_base.len());
        let close = trimmed.rfind(')').unwrap_or(trimmed.len());
        let orig_params = if open < close { trimmed[open + 1..close].trim() } else { params.as_str() };
        format!("{orig_base}({orig_params})")
    } else {
        // INT(11), BIGINT(20), TINYINT(2), YEAR(4), … — normalized uppercase base.
        base
    }
}

/// Special-case: TINYINT(1) often means boolean on MySQL-like sources.
fn tinyint1_as_boolean_key(base: &str, params: Option<&str>) -> Option<&'static str> {
    if base.eq_ignore_ascii_case("TINYINT") && params == Some("1") {
        Some("BOOL")
    } else {
        None
    }
}

fn sqlserver_decimal_type(params: Option<&str>) -> String {
    let Some(params) = params else {
        return "DECIMAL".to_string();
    };
    let values = params.split(',').map(str::trim).collect::<Vec<_>>();
    let Ok(precision) = values.first().copied().unwrap_or_default().parse::<u32>() else {
        return "DECIMAL".to_string();
    };
    let precision = precision.clamp(1, 38);
    if values.len() == 1 {
        return format!("DECIMAL({precision})");
    }
    let Ok(scale) = values[1].parse::<u32>() else {
        return format!("DECIMAL({precision})");
    };
    format!("DECIMAL({precision},{})", scale.min(precision))
}

fn sqlserver_length_type(target_type: &str, params: Option<&str>, max_length: u32) -> String {
    let Some(param) = params.map(str::trim).filter(|param| !param.is_empty()) else {
        return if matches!(target_type, "VARCHAR" | "NVARCHAR" | "VARBINARY") {
            format!("{target_type}(MAX)")
        } else {
            target_type.to_string()
        };
    };
    if param.eq_ignore_ascii_case("MAX") {
        return match target_type {
            "NCHAR" => "NVARCHAR(MAX)".to_string(),
            "CHAR" => "VARCHAR(MAX)".to_string(),
            "BINARY" => "VARBINARY(MAX)".to_string(),
            _ => format!("{target_type}(MAX)"),
        };
    }
    match param.parse::<u32>() {
        Ok(length) if length > max_length => match target_type {
            "NCHAR" | "NVARCHAR" => "NVARCHAR(MAX)".to_string(),
            "BINARY" | "VARBINARY" => "VARBINARY(MAX)".to_string(),
            _ => "VARCHAR(MAX)".to_string(),
        },
        Ok(length) => format!("{target_type}({})", length.max(1)),
        Err(_) => format!("{target_type}(MAX)"),
    }
}

fn sqlserver_temporal_type(target_type: &str, params: Option<&str>) -> String {
    match params.and_then(|param| param.trim().parse::<u32>().ok()) {
        Some(precision) => format!("{target_type}({})", precision.min(7)),
        None => target_type.to_string(),
    }
}

/// Convert common source types to native SQL Server types before the generic
/// mapping matrix runs. This is source-dialect aware because names such as
/// `timestamp` mean a date/time in MySQL/PostgreSQL but `rowversion` in SQL Server.
fn rewrite_cross_dialect_to_sqlserver(source_type: &str, source: DialectKind) -> Option<String> {
    if source == DialectKind::SqlServer {
        return None;
    }

    let source_upper = source_type.trim().to_ascii_uppercase();
    // MySQL places UNSIGNED/ZEROFILL after an optional parameter list, so it
    // cannot be recovered from `raw_base` alone (`INT(11) UNSIGNED`). ZEROFILL
    // also implies UNSIGNED in MySQL.
    let mysql_unsigned = source_upper.split_whitespace().any(|part| matches!(part, "UNSIGNED" | "ZEROFILL"));
    let (raw_base, params) = split_type_base_params(source_type);
    let base = raw_base
        .split_whitespace()
        .filter(|part| !part.eq_ignore_ascii_case("UNSIGNED") && !part.eq_ignore_ascii_case("ZEROFILL"))
        .collect::<Vec<_>>()
        .join(" ");
    let params = params.as_deref();

    let mapped = match source {
        DialectKind::Mysql => match base.as_str() {
            "BOOL" | "BOOLEAN" => "BIT".to_string(),
            "TINYINT" if params == Some("1") && !mysql_unsigned => "BIT".to_string(),
            // Preserve the complete MySQL value range. SQL Server TINYINT is
            // unsigned, while MySQL TINYINT is signed unless explicitly marked.
            "TINYINT" if mysql_unsigned => "TINYINT".to_string(),
            "TINYINT" => "SMALLINT".to_string(),
            "SMALLINT" if mysql_unsigned => "INT".to_string(),
            "SMALLINT" => "SMALLINT".to_string(),
            "MEDIUMINT" => "INT".to_string(),
            "INT" | "INTEGER" if mysql_unsigned => "BIGINT".to_string(),
            "INT" | "INTEGER" => "INT".to_string(),
            "BIGINT" if mysql_unsigned => "DECIMAL(20,0)".to_string(),
            "BIGINT" => "BIGINT".to_string(),
            "DECIMAL" | "NUMERIC" => sqlserver_decimal_type(params),
            "FLOAT" | "DOUBLE" | "DOUBLE PRECISION" | "REAL" => "FLOAT".to_string(),
            "CHAR" | "VARCHAR" => sqlserver_length_type(&base, params, 8000),
            "NCHAR" | "NVARCHAR" => sqlserver_length_type(&base, params, 4000),
            "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "JSON" | "ENUM" | "SET" => "NVARCHAR(MAX)".to_string(),
            "BINARY" | "VARBINARY" => sqlserver_length_type(&base, params, 8000),
            "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => "VARBINARY(MAX)".to_string(),
            "DATE" => "DATE".to_string(),
            "TIME" => sqlserver_temporal_type("TIME", params),
            "DATETIME" | "TIMESTAMP" => sqlserver_temporal_type("DATETIME2", params),
            "YEAR" => "SMALLINT".to_string(),
            "GEOMETRY" => "GEOMETRY".to_string(),
            _ => return None,
        },
        DialectKind::Postgres => match base.as_str() {
            "BOOL" | "BOOLEAN" => "BIT".to_string(),
            "SMALLINT" | "INT2" | "SMALLSERIAL" => "SMALLINT".to_string(),
            "INTEGER" | "INT" | "INT4" | "SERIAL" => "INT".to_string(),
            "BIGINT" | "INT8" | "BIGSERIAL" => "BIGINT".to_string(),
            "NUMERIC" | "DECIMAL" => sqlserver_decimal_type(params),
            "REAL" | "FLOAT4" => "REAL".to_string(),
            "DOUBLE PRECISION" | "FLOAT8" => "FLOAT".to_string(),
            "CHAR" | "CHARACTER" | "VARCHAR" | "CHARACTER VARYING" => {
                sqlserver_length_type("NVARCHAR", params.or(Some("MAX")), 4000)
            }
            "TEXT" | "JSON" | "JSONB" | "ARRAY" => "NVARCHAR(MAX)".to_string(),
            "BIT VARYING" | "VARBIT" => "VARBINARY(MAX)".to_string(),
            "BYTEA" => "VARBINARY(MAX)".to_string(),
            "UUID" => "UNIQUEIDENTIFIER".to_string(),
            "DATE" => "DATE".to_string(),
            "TIME" if source_upper.contains("WITH TIME ZONE") && !source_upper.contains("WITHOUT TIME ZONE") => {
                sqlserver_temporal_type("DATETIMEOFFSET", params)
            }
            "TIME" | "TIME WITHOUT TIME ZONE" => sqlserver_temporal_type("TIME", params),
            "TIMETZ" | "TIME WITH TIME ZONE" => sqlserver_temporal_type("DATETIMEOFFSET", params),
            "TIMESTAMP" if source_upper.contains("WITH TIME ZONE") && !source_upper.contains("WITHOUT TIME ZONE") => {
                sqlserver_temporal_type("DATETIMEOFFSET", params)
            }
            "TIMESTAMP" | "TIMESTAMP WITHOUT TIME ZONE" => sqlserver_temporal_type("DATETIME2", params),
            "TIMESTAMPTZ" | "TIMESTAMP WITH TIME ZONE" => sqlserver_temporal_type("DATETIMEOFFSET", params),
            "XML" => "XML".to_string(),
            "MONEY" => "MONEY".to_string(),
            "INET" | "CIDR" | "MACADDR" | "MACADDR8" | "INTERVAL" => "NVARCHAR(100)".to_string(),
            _ if base.ends_with("[]") => "NVARCHAR(MAX)".to_string(),
            _ => return None,
        },
        DialectKind::Sqlite | DialectKind::DuckDb => match base.as_str() {
            "BOOL" | "BOOLEAN" => "BIT".to_string(),
            "TINYINT" => "TINYINT".to_string(),
            "SMALLINT" => "SMALLINT".to_string(),
            "INT" | "INTEGER" => "BIGINT".to_string(),
            "REAL" | "DOUBLE" | "DOUBLE PRECISION" | "FLOAT" => "FLOAT".to_string(),
            "DECIMAL" | "NUMERIC" => sqlserver_decimal_type(params),
            "CHAR" | "VARCHAR" => sqlserver_length_type("NVARCHAR", params.or(Some("MAX")), 4000),
            "TEXT" | "JSON" => "NVARCHAR(MAX)".to_string(),
            "BLOB" | "BYTEA" => "VARBINARY(MAX)".to_string(),
            "DATE" => "DATE".to_string(),
            "TIME" => sqlserver_temporal_type("TIME", params),
            "DATETIME" | "TIMESTAMP" => sqlserver_temporal_type("DATETIME2", params),
            "UUID" => "UNIQUEIDENTIFIER".to_string(),
            _ => return None,
        },
        _ => return None,
    };
    Some(mapped)
}

/// Rewrite a source column type for `target` database.
///
/// User field mappings must be applied by the caller *before* this function.
pub fn rewrite_column_type(source_type: &str, target: DatabaseType, source_dialect: Option<DialectKind>) -> String {
    let profile = profile_for(target);
    if target == DatabaseType::SqlServer {
        let source = source_dialect.unwrap_or(DialectKind::SqlServer);
        if source == DialectKind::SqlServer {
            // Same-dialect metadata already contains a valid native type. The
            // generic display-width normalizer would otherwise truncate valid
            // SQL Server parameters such as VARBINARY(MAX), DATETIME2(7), and
            // DATETIMEOFFSET(7).
            return source_type.trim().to_string();
        }
        if let Some(mapped) = rewrite_cross_dialect_to_sqlserver(source_type, source) {
            return mapped;
        }
    }
    let (base, params) = split_type_base_params(source_type);

    // Profile type_map (includes synthetic BOOL for TINYINT(1) when mapped)
    let lookup_key = tinyint1_as_boolean_key(&base, params.as_deref()).unwrap_or(base.as_str());
    if let Some(template) = profile.lookup_type(lookup_key) {
        return apply_template(template, params.as_deref(), profile.max_varchar_len);
    }
    // Also try original base if we used BOOL alias miss
    if lookup_key != base && profile.lookup_type(&base).is_some() {
        if let Some(template) = profile.lookup_type(&base) {
            return apply_template(template, params.as_deref(), profile.max_varchar_len);
        }
    }

    // Dialect-kind matrix
    if let Some(src) = source_dialect {
        let target_kind = DialectKind::from_database_type(target);
        let matrix = TypeMappingMatrix::for_dialects(src, target_kind);
        let (converted, _) = matrix.convert_type(source_type);
        if converted != source_type {
            return strip_display_width_if_needed(&converted, &profile);
        }
    }

    strip_display_width_if_needed(source_type, &profile)
}

/// Whether the column metadata indicates auto-increment / identity / serial.
pub fn column_is_auto_increment(col: &ColumnInfo) -> bool {
    col.extra.as_deref().is_some_and(|extra| {
        let lower = extra.to_ascii_lowercase();
        lower.contains("auto_increment") || lower.contains("identity") || lower.contains("serial")
    })
}

/// Whether a rewritten type looks integer-like (for PK auto-inc heuristics).
pub fn type_looks_integer(mapped_type: &str) -> bool {
    let lower = mapped_type.to_ascii_lowercase();
    lower.contains("int")
        || lower.contains("integer")
        || lower.contains("serial")
        || lower.eq_ignore_ascii_case("counter")
        || lower.eq_ignore_ascii_case("byte")
        || lower.starts_with("decimal")
        || lower.starts_with("number")
        || lower.starts_with("numeric")
}

/// Build column type + optional auto-inc contribution using profile only (no DatabaseType branches).
pub fn apply_auto_inc_to_column_def(
    profile: &DdlDialectProfile,
    quoted_name: &str,
    _mapped_type: &str,
    col: &ColumnInfo,
    is_integer_like: bool,
) -> AutoIncColumnBuild {
    let wants_auto = col.is_primary_key && (column_is_auto_increment(col) || is_integer_like);

    match profile.auto_inc {
        crate::sql_dialect::ddl_profile::AutoIncSyntax::ReplaceTypeWith(type_name)
            if wants_auto && col.is_primary_key =>
        {
            let mut def = format!("{quoted_name} {type_name}");
            if !col.is_nullable {
                def.push_str(" NOT NULL");
            }
            AutoIncColumnBuild::Complete { def, skip_default: true }
        }
        crate::sql_dialect::ddl_profile::AutoIncSyntax::Suffix(suffix) if col.is_primary_key && is_integer_like => {
            AutoIncColumnBuild::AppendSuffix { suffix, skip_default: false, postgres_sequence: false }
        }
        crate::sql_dialect::ddl_profile::AutoIncSyntax::PostgresSequence if col.is_primary_key && is_integer_like => {
            AutoIncColumnBuild::AppendSuffix { suffix: "", skip_default: false, postgres_sequence: true }
        }
        _ => AutoIncColumnBuild::Normal { skip_default: false },
    }
}

#[derive(Debug)]
pub enum AutoIncColumnBuild {
    /// Full column definition already built (e.g. COUNTER).
    Complete {
        def: String,
        skip_default: bool,
    },
    /// Continue normal type def; optionally append suffix; maybe register PG sequence.
    AppendSuffix {
        suffix: &'static str,
        skip_default: bool,
        postgres_sequence: bool,
    },
    Normal {
        skip_default: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_rewrites_mysql_types() {
        let t = DatabaseType::Access;
        let src = Some(DialectKind::Mysql);
        assert_eq!(rewrite_column_type("int(11)", t, src), "INTEGER");
        assert_eq!(rewrite_column_type("varchar(120)", t, src), "TEXT(120)");
        assert_eq!(rewrite_column_type("tinyint(2)", t, src), "BYTE");
        assert_eq!(rewrite_column_type("tinyint(1)", t, src), "YESNO");
        assert_eq!(rewrite_column_type("datetime", t, src), "DATETIME");
        assert_eq!(rewrite_column_type("longtext", t, src), "LONGTEXT");
    }

    #[test]
    fn sqlserver_keeps_identity_path_not_counter() {
        let profile = profile_for(DatabaseType::SqlServer);
        assert!(matches!(
            profile.auto_inc,
            crate::sql_dialect::ddl_profile::AutoIncSyntax::Suffix(s) if s.contains("IDENTITY")
        ));
        // MySQL display width is not part of the SQL Server type.
        let t = rewrite_column_type("int(11)", DatabaseType::SqlServer, Some(DialectKind::Mysql));
        assert_eq!(t, "INT");
    }

    #[test]
    fn sqlserver_rewrites_common_mysql_types() {
        let target = DatabaseType::SqlServer;
        let source = Some(DialectKind::Mysql);
        let cases = [
            ("tinyint(1)", "BIT"),
            ("tinyint", "SMALLINT"),
            ("tinyint unsigned", "TINYINT"),
            ("tinyint(1) unsigned", "TINYINT"),
            ("tinyint(1) zerofill", "TINYINT"),
            ("smallint unsigned", "INT"),
            ("mediumint unsigned", "INT"),
            ("int(11) unsigned", "BIGINT"),
            ("integer zerofill", "BIGINT"),
            ("bigint unsigned", "DECIMAL(20,0)"),
            ("double", "FLOAT"),
            ("decimal(65,30)", "DECIMAL(38,30)"),
            ("varchar(9000)", "VARCHAR(MAX)"),
            ("nvarchar(5000)", "NVARCHAR(MAX)"),
            ("longtext", "NVARCHAR(MAX)"),
            ("json", "NVARCHAR(MAX)"),
            ("longblob", "VARBINARY(MAX)"),
            ("datetime(9)", "DATETIME2(7)"),
        ];
        for (input, expected) in cases {
            assert_eq!(rewrite_column_type(input, target, source), expected, "{input}");
        }
    }

    #[test]
    fn sqlserver_rewrites_common_postgres_types_without_rewriting_its_own_timestamp() {
        let target = DatabaseType::SqlServer;
        let postgres = Some(DialectKind::Postgres);
        let cases = [
            ("serial", "INT"),
            ("boolean", "BIT"),
            ("character varying(64)", "NVARCHAR(64)"),
            ("text", "NVARCHAR(MAX)"),
            ("bytea", "VARBINARY(MAX)"),
            ("uuid", "UNIQUEIDENTIFIER"),
            ("time(4) with time zone", "DATETIMEOFFSET(4)"),
            ("timestamp(6) without time zone", "DATETIME2(6)"),
            ("timestamp(6) with time zone", "DATETIMEOFFSET(6)"),
            ("jsonb", "NVARCHAR(MAX)"),
        ];
        for (input, expected) in cases {
            assert_eq!(rewrite_column_type(input, target, postgres), expected, "{input}");
        }
        assert_eq!(rewrite_column_type("timestamp", target, Some(DialectKind::SqlServer)), "timestamp");
        assert_eq!(rewrite_column_type("varbinary(max)", target, None), "varbinary(max)");
        assert_eq!(rewrite_column_type("datetime2(7)", target, Some(DialectKind::SqlServer)), "datetime2(7)");
    }

    #[test]
    fn mysql_keeps_display_width() {
        let t = rewrite_column_type("int(11)", DatabaseType::Mysql, None);
        assert_eq!(t, "int(11)");
    }

    #[test]
    fn normalize_len_params_strips_oracle_char_unit() {
        assert_eq!(normalize_len_params("(6 CHAR)"), "(6)");
        assert_eq!(normalize_len_params("(50 char)"), "(50)");
        assert_eq!(normalize_len_params("(50    CHAR)"), "(50)");
        assert_eq!(normalize_len_params("(20 BYTE)"), "(20)");
        assert_eq!(normalize_len_params("(20 byte)"), "(20)");
    }

    #[test]
    fn normalize_len_params_leaves_non_unit_params_untouched() {
        // Plain length without a unit qualifier.
        assert_eq!(normalize_len_params("(50)"), "(50)");
        // Precision/scale must never be disturbed.
        assert_eq!(normalize_len_params("(10,2)"), "(10,2)");
        // Enum/set lists must never be disturbed.
        assert_eq!(normalize_len_params("('a','b')"), "('a','b')");
        // Non-numeric head (defensive) is left alone.
        assert_eq!(normalize_len_params("(MAX CHAR)"), "(MAX CHAR)");
    }

    #[test]
    fn normalize_len_params_handles_malformed_input() {
        assert_eq!(normalize_len_params("varchar(50)"), "varchar(50)");
        assert_eq!(normalize_len_params("no-parens"), "no-parens");
        assert_eq!(normalize_len_params("(unclosed"), "(unclosed");
        assert_eq!(normalize_len_params(")"), ")");
    }
}
