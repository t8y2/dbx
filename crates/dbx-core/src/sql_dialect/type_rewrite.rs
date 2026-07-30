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

/// Rewrite a source column type for `target` database.
///
/// User field mappings must be applied by the caller *before* this function.
pub fn rewrite_column_type(source_type: &str, target: DatabaseType, source_dialect: Option<DialectKind>) -> String {
    let profile = profile_for(target);
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
        // No Access type map: display width stripped
        let t = rewrite_column_type("int(11)", DatabaseType::SqlServer, Some(DialectKind::Mysql));
        assert_eq!(t, "INT");
    }

    #[test]
    fn mysql_keeps_display_width() {
        let t = rewrite_column_type("int(11)", DatabaseType::Mysql, None);
        assert_eq!(t, "int(11)");
    }
}
