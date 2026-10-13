use super::column_format::has_dameng_identity;
use super::dialect::{capabilities_for, StructureDialect};
use super::indexes::has_existing_index_change;
use super::types::{EditableStructureColumn, TableStructureSqlOptions};
use super::util::{clean, normalize_default, original_default};
use crate::models::connection::DatabaseType;

/// Hard errors for `CREATE INDEX CONCURRENTLY` requests the editor cannot
/// honor safely. Unlike the advisory warnings in [`validate_draft`], these
/// reject the whole save plan: the caller asked for a non-blocking build and
/// the only way to honor that is the requested concurrent DDL, so falling back
/// to blocking index DDL must never happen silently.
///
/// Only real PostgreSQL advertises `index_concurrent`, so stale/forged
/// `concurrently` flags on other engines are ignored here (they cannot express
/// a concurrent request in the first place).
pub(super) fn validate_concurrent_index_scope(options: &TableStructureSqlOptions) -> Vec<String> {
    let mut errors = Vec::new();
    let capabilities = capabilities_for(options.database_type, options.driver_profile.as_deref());
    if !capabilities.index_concurrent || capabilities.dialect != StructureDialect::Postgres {
        return errors;
    }
    for index in options.indexes.iter().filter(|index| !index.marked_for_drop) {
        if !index.concurrently {
            continue;
        }
        if index.original.is_some() {
            errors.push(format!(
                "CREATE INDEX CONCURRENTLY is only supported for newly created indexes. Editing an existing index \"{}\" with Concurrent enabled is not supported.",
                index.name
            ));
        } else if options.partitioned {
            errors.push(
                "CREATE INDEX CONCURRENTLY is not supported on PostgreSQL partitioned parent tables. Create indexes concurrently on individual partitions and attach them separately."
                    .to_string(),
            );
        }
    }
    errors
}

pub fn validate_draft(options: &TableStructureSqlOptions) -> Vec<String> {
    let mut warnings = Vec::new();
    let active_columns: Vec<_> = options.columns.iter().filter(|column| !column.marked_for_drop).collect();
    validate_columns(&active_columns, &mut warnings);
    validate_dameng_identity(options, &active_columns, &mut warnings);
    validate_mysql_literal_defaults(options, &active_columns, &mut warnings);
    validate_gin_opclass_warnings(options, &mut warnings);
    for index in options
        .indexes
        .iter()
        .filter(|index| !index.marked_for_drop && (index.original.is_none() || has_existing_index_change(index)))
    {
        if clean(&index.name).is_empty() {
            warnings.push("Index name cannot be empty.".to_string());
        }
        if index.columns.iter().map(|column| clean(column)).filter(|column| !column.is_empty()).count() == 0 {
            warnings.push(format!(
                "Index \"{}\" needs at least one column.",
                if index.name.is_empty() { "(new)" } else { &index.name }
            ));
        }
    }
    warnings
}

pub(super) fn validate_mysql_literal_defaults(
    options: &TableStructureSqlOptions,
    columns: &[&EditableStructureColumn],
    warnings: &mut Vec<String>,
) {
    for column in columns {
        if let Some(warning) = mysql_literal_default_error(
            options.database_type,
            options.driver_profile.as_deref(),
            options.is_gaussdb_m_mode,
            column,
        ) {
            warnings.push(warning);
        }
    }
}

/// MySQL rejects a literal default on BLOB, TEXT, GEOMETRY and JSON columns
/// with `ERROR 1101`. The DDL runs statement by statement, so letting it
/// through leaves the earlier statements of the batch applied. MySQL 8.0.13
/// and later accept an expression default written in parentheses, such as
/// `('')`, which the generator passes through unchanged, so only a value that
/// would be rendered as a literal is refused. MariaDB accepts the literal form
/// and is not checked.
///
/// A column is only checked when the draft would emit its default: a new
/// column, or an existing one whose type or default changed. An unchanged
/// default on an existing column came from the server, and refusing it would
/// block unrelated edits to the table.
pub(super) fn mysql_literal_default_error(
    database_type: Option<DatabaseType>,
    driver_profile: Option<&str>,
    is_gaussdb_m_mode: bool,
    column: &EditableStructureColumn,
) -> Option<String> {
    if database_type != Some(DatabaseType::Mysql)
        || is_gaussdb_m_mode
        || driver_profile.is_some_and(|profile| profile.trim().eq_ignore_ascii_case("mariadb"))
    {
        return None;
    }
    let base_type = column.data_type.split('(').next().unwrap_or_default().trim().to_ascii_lowercase();
    if !is_mysql_type_without_literal_default(&base_type) {
        return None;
    }
    let default_value = normalize_default(Some(&column.default_value));
    if default_value.is_empty() || (default_value.starts_with('(') && default_value.ends_with(')')) {
        return None;
    }
    if let Some(original) = &column.original {
        if column.data_type.trim() == original.data_type.trim() && default_value == original_default(column) {
            return None;
        }
    }
    Some(format!(
        "MySQL does not allow a literal default on {base_type} column \"{}\". Remove the default, or on MySQL 8.0.13 or later use an expression default such as ('').",
        column.name
    ))
}

fn is_mysql_type_without_literal_default(base_type: &str) -> bool {
    matches!(
        base_type,
        "tinytext"
            | "text"
            | "mediumtext"
            | "longtext"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "json"
            | "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
            | "geomcollection"
    )
}

pub(super) fn validate_dameng_identity(
    options: &TableStructureSqlOptions,
    columns: &[&EditableStructureColumn],
    warnings: &mut Vec<String>,
) {
    if capabilities_for(options.database_type, options.driver_profile.as_deref()).dialect != StructureDialect::Dameng {
        return;
    }

    let identity_columns: Vec<_> = columns.iter().filter(|column| has_dameng_identity(column)).collect();
    if identity_columns.len() > 1 {
        warnings.push("Dameng tables can have only one identity column.".to_string());
    }
    for column in identity_columns {
        if column.extra.as_ref().and_then(|extra| extra.identity.as_ref()).and_then(|identity| identity.increment)
            == Some(0)
        {
            warnings.push(format!("Dameng identity column \"{}\" increment cannot be 0.", column.name));
        }
    }
}

pub(super) fn validate_columns(columns: &[&EditableStructureColumn], warnings: &mut Vec<String>) {
    let mut names = std::collections::HashSet::new();
    for column in columns {
        if clean(&column.name).is_empty() {
            warnings.push("Column name cannot be empty.".to_string());
        }
        if clean(&column.data_type).is_empty() {
            warnings.push(format!(
                "Column \"{}\" type cannot be empty.",
                if column.name.is_empty() { "(new)" } else { &column.name }
            ));
        }
        let key = clean(&column.name).to_lowercase();
        if !key.is_empty() && !names.insert(key) {
            warnings.push(format!("Column \"{}\" is duplicated.", column.name));
        }
    }
}

/// PostgreSQL GIN indexes on varchar/text/character columns without an explicit
/// operator class are a common trap: the default `array_ops` class is rarely what
/// the user wants, and `gin_trgm_ops` (from `pg_trgm` extension) or similar
/// classes are almost always needed. This is a warning, not an error, because
/// the default class may be deliberate in some cases.
fn validate_gin_opclass_warnings(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) {
    let capabilities = capabilities_for(options.database_type, options.driver_profile.as_deref());
    if capabilities.dialect != StructureDialect::Postgres {
        return;
    }

    // Build a lookup: column name (lowercased) → data type for active columns.
    let col_types: std::collections::HashMap<String, &str> = options
        .columns
        .iter()
        .filter(|col| !col.marked_for_drop)
        .map(|col| (clean(&col.name).to_lowercase(), col.data_type.as_str()))
        .collect();

    let text_like = |dt: &str| -> bool {
        let lower = dt.to_lowercase();
        lower == "text"
            || lower.starts_with("character varying")
            || lower.starts_with("varchar")
            || lower.starts_with("character")
            || lower == "char"
    };

    for index in options.indexes.iter().filter(|idx| {
        !idx.marked_for_drop
            && clean(&idx.index_type).eq_ignore_ascii_case("GIN")
            && (idx.original.is_none() || has_existing_index_change(idx))
    }) {
        for (i, col) in index.columns.iter().enumerate() {
            let col_name = clean(col);
            if col_name.is_empty() {
                continue;
            }
            // Expression columns are not matched against table column types.
            let is_expr =
                index.original.as_ref().and_then(|orig| orig.key_is_expression.get(i).copied()).unwrap_or(false);
            if is_expr {
                continue;
            }
            // Check if this column has a text-like type.
            let Some(dt) = col_types.get(&col_name.to_lowercase()) else {
                continue;
            };
            if !text_like(dt) {
                continue;
            }
            // Check if opclass is explicitly provided.
            let has_opclass =
                index.column_opclasses.get(i).and_then(|o| o.as_deref()).map(|v| !clean(v).is_empty()).unwrap_or(false);
            if !has_opclass {
                warnings.push(format!(
                    "GIN index \"{}\" on column \"{}\" (type {}) has no operator class specified. Consider adding an operator class, e.g. `gin_trgm_ops` (requires pg_trgm extension) for text search.",
                    index.name, col_name, dt
                ));
            }
        }
    }
}
