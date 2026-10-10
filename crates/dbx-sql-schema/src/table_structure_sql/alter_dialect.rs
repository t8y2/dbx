//! Product-specific ALTER strategies, independent of wire-compatible CREATE dialects.
use super::{
    dialect::StructureDialect,
    types::*,
    util::{
        clean, format_default_for_sql, normalize_default, original_comment, original_default, qualified_table,
        quote_ident, quote_string,
    },
};
use crate::models::connection::DatabaseType;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarRocksAlterOptions {
    pub server_version: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub column_names: Vec<String>,
    #[serde(default)]
    pub reorder_columns: bool,
    #[serde(default)]
    pub position_column_order: bool,
    pub sort_columns: Option<Vec<String>>,
    pub sort_column_names: Option<Vec<String>>,
    #[serde(default)]
    pub key_columns: Vec<String>,
    #[serde(default)]
    pub partition_columns: Vec<String>,
    #[serde(default)]
    pub partition_expression_columns: Vec<String>,
    #[serde(default)]
    pub distribution_columns: Vec<String>,
    pub distribution: Option<super::starrocks_layout::StarRocksDistributionChange>,
    pub partition_kind: Option<String>,
    #[serde(default)]
    pub colocated: bool,
    #[serde(default)]
    pub automatic_bucket_scaling: bool,
    pub layout: Option<super::starrocks_layout::StarRocksLayoutChanges>,
}

pub(super) fn is_starrocks(options: &TableStructureSqlOptions) -> bool {
    !options.is_gaussdb_m_mode
        && (options.database_type == Some(DatabaseType::StarRocks)
            || (options.database_type == Some(DatabaseType::Mysql)
                && options.driver_profile.as_deref().is_some_and(|value| value.eq_ignore_ascii_case("starrocks"))))
}

trait AlterTableDialect {
    fn build(&self, options: &TableStructureSqlOptions) -> TableStructureSqlResult;
}

pub(super) fn build(
    options: &TableStructureSqlOptions,
    context: Option<StarRocksAlterOptions>,
) -> TableStructureSqlResult {
    StarRocksAlter(context.unwrap_or_default()).build(options)
}

struct StarRocksAlter(StarRocksAlterOptions);
impl AlterTableDialect for StarRocksAlter {
    fn build(&self, options: &TableStructureSqlOptions) -> TableStructureSqlResult {
        let mut warnings = super::validation::validate_draft(options);
        let mut statements = Vec::new();
        let mut changes = Vec::new();
        let table = qualified_table(StructureDialect::Mysql, options.schema.as_deref(), &options.table_name);
        let quote = |name: &str| quote_ident(StructureDialect::Mysql, name);
        let version = super::create_dialect::parse_version(self.0.server_version.as_deref());
        let at_least = |minimum| version.is_some_and(|current| current >= minimum);
        let supported_model = matches!(self.0.model.as_deref(), Some("primary" | "duplicate"));
        let contains = |names: &[String], name: &str| names.iter().any(|value| value.eq_ignore_ascii_case(name));
        let locked = |column: &EditableStructureColumn| {
            column.original.as_ref().is_some_and(|original| {
                !supported_model
                    || contains(&self.0.partition_columns, &original.name)
                    || contains(&self.0.distribution_columns, &original.name)
                    || (self.0.model.as_deref() == Some("primary") && contains(&self.0.key_columns, &original.name))
                    || original.extra.as_deref().is_some_and(|extra| {
                        let lower = extra.to_ascii_lowercase();
                        lower.contains("auto_increment") || lower.contains("generated")
                    })
            })
        };
        // Unchanged catalog indexes/constraints may be present, but cannot be edited through this strategy.
        for index in &options.indexes {
            if index.original.is_none() || index.marked_for_drop || super::indexes::has_existing_index_change(index) {
                warnings.push("StarRocks index definitions cannot be changed from this editor.".into());
            }
        }
        let foreign_sql = super::foreign_keys::build_foreign_key_sql(options, &mut warnings);
        let trigger_sql = super::triggers::build_trigger_sql(options, &mut warnings);
        if !foreign_sql.is_empty() || !trigger_sql.is_empty() {
            warnings.push("StarRocks foreign keys and triggers cannot be changed from this editor.".into());
        }
        if options.mysql_engine.is_some() {
            warnings.push("StarRocks does not support MySQL storage engine settings.".into());
        }
        for column in &options.columns {
            if column.marked_for_drop && column.original.is_none() {
                continue;
            }
            let Some(original) = &column.original else {
                if !supported_model {
                    warnings.push(
                        "Adding StarRocks columns requires confirmed PRIMARY or DUPLICATE table metadata.".into(),
                    );
                }
                if column.is_primary_key
                    || column.extra.as_ref().is_some_and(|extra| {
                        extra.auto_increment == Some(true) || extra.on_update_current_timestamp == Some(true)
                    })
                {
                    warnings.push("New StarRocks columns cannot change keys or use MySQL extra properties.".into());
                }
                // CREATE accepts UUID generators, but ADD cannot backfill these varying defaults.
                static UUID_DEFAULT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                    regex::Regex::new(r"(?i)^\s*\(*\s*uuid(?:_numeric)?\s*\(\s*\)\s*\)*\s*$").unwrap()
                });
                if UUID_DEFAULT.is_match(&column.default_value) {
                    warnings.push(format!("StarRocks ADD COLUMN '{}' does not support uuid() or uuid_numeric() defaults. Use a literal or NULL; UUID defaults are only available when creating a table.", column.name));
                }
                changes.push(format!("ADD COLUMN {}", definition(column, false)));
                continue;
            };
            if column.is_primary_key != original.is_primary_key {
                warnings.push("StarRocks key membership cannot be changed from this editor.".into());
            }
            if column.marked_for_drop {
                if locked(column) || contains(&self.0.key_columns, &original.name) || original.is_primary_key {
                    warnings.push(format!("StarRocks key, partition, distribution or protected column '{}' cannot be dropped from this editor.", original.name));
                }
                changes.push(format!("DROP COLUMN {}", quote(&original.name)));
                continue;
            }
            let default_changed = normalize_default(Some(&column.default_value)) != original_default(column);
            if default_changed {
                warnings.push(format!("StarRocks cannot change the default value of existing column '{}'. Set defaults when creating a table or adding a column.", original.name));
            }
            let definition_changed = !column.data_type.trim().eq_ignore_ascii_case(original.data_type.trim())
                || column.is_nullable != original.is_nullable
                || default_changed;
            let comment_changed = clean(&column.comment) != original_comment(column);
            if column.name != original.name {
                if !at_least((3, 3, 2)) {
                    warnings.push("Renaming StarRocks columns requires confirmed version 3.3.2 or newer.".into());
                }
                if options.columns.iter().any(|other| {
                    other.id != column.id
                        && (other.name.eq_ignore_ascii_case(&column.name)
                            || other.original.as_ref().is_some_and(|old| old.name.eq_ignore_ascii_case(&column.name)))
                }) {
                    warnings
                        .push("Rename StarRocks columns separately when names collide with original columns.".into());
                }
                if options
                    .columns
                    .iter()
                    .any(|other| other.original.is_none() && other.name.eq_ignore_ascii_case(&original.name))
                {
                    warnings.push("StarRocks does not support reusing a renamed column name.".into());
                }
                statements.push(format!(
                    "ALTER TABLE {table} RENAME COLUMN {} TO {};",
                    quote(&original.name),
                    quote(&column.name)
                ));
            }
            if definition_changed {
                if locked(column) {
                    warnings.push(format!("StarRocks column '{}' requires key/partition/aggregation metadata or is protected from definition changes.", original.name));
                }
                if original.is_nullable && !column.is_nullable {
                    warnings.push("StarRocks cannot change a nullable column to NOT NULL.".into());
                }
                changes.push(format!(
                    "MODIFY COLUMN {}",
                    definition(column, contains(&self.0.key_columns, &original.name))
                ));
            }
            // Comment-only ALTER is synchronous and must not resubmit a complete definition.
            if comment_changed && !definition_changed {
                statements.push(format!(
                    "ALTER TABLE {table} MODIFY COLUMN {} COMMENT {};",
                    quote(&column.name),
                    quote_string(&clean(&column.comment))
                ));
            }
            if column.extra.as_ref().is_some_and(|extra| {
                extra.on_update_current_timestamp == Some(true)
                    || (extra.auto_increment == Some(true)
                        && !original.extra.as_deref().unwrap_or("").to_ascii_lowercase().contains("auto_increment"))
            }) {
                warnings.push("StarRocks column extra properties cannot be changed from this editor.".into());
            }
        }
        if clean(options.table_comment.as_deref().unwrap_or(""))
            != clean(options.original_table_comment.as_deref().unwrap_or(""))
        {
            if !at_least((3, 1, 0)) {
                warnings.push("StarRocks table comments require confirmed version 3.1 or newer.".into());
            }
            statements.push(format!(
                "ALTER TABLE {table} COMMENT = {};",
                quote_string(&clean(options.table_comment.as_deref().unwrap_or("")))
            ));
        }
        build_column_order(options, &self.0, &mut changes, &mut warnings);
        if let Some(sort_columns) = &self.0.sort_column_names {
            if !statements.is_empty() || !changes.is_empty() || self.0.layout.is_some() {
                warnings.push("Save StarRocks sort-key changes separately from other table edits.".into());
            }
            validate_sort_columns(options, &self.0, sort_columns, &mut warnings);
            changes.push(format!("ORDER BY ({})", sort_columns.iter().map(|name| quote_ident(StructureDialect::Mysql, name)).collect::<Vec<_>>().join(", ")));
        }
        // Submit one asynchronous schema-change job, after synchronous metadata changes.
        if !changes.is_empty() {
            statements.push(format!("ALTER TABLE {table} {};", changes.join(", ")));
        }
        let layout_statements = super::starrocks_layout::build(options, &self.0, &mut warnings);
        if !layout_statements.is_empty() && !statements.is_empty() {
            warnings.push("Save StarRocks layout operations separately from column and table-comment changes; wait for schema-change completion before the next operation.".into());
        }
        statements.extend(layout_statements);
        if !warnings.is_empty() {
            statements.clear();
        }
        TableStructureSqlResult { statements, warnings }
    }
}

fn definition(column: &EditableStructureColumn, key: bool) -> String {
    let mut parts = vec![quote_ident(StructureDialect::Mysql, &column.name), column.data_type.trim().to_string()];
    if key {
        parts.push("KEY".into());
    }
    parts.push(if column.is_nullable { "NULL" } else { "NOT NULL" }.into());
    let default = normalize_default(Some(&column.default_value));
    if !default.is_empty() {
        let value = if default.starts_with('\'') && default.ends_with('\'') {
            default
        } else {
            format_default_for_sql(StructureDialect::Mysql, &column.data_type, &default)
        };
        parts.push(format!("DEFAULT {value}"));
    }
    parts.push(format!("COMMENT {}", quote_string(&clean(&column.comment))));
    parts.join(" ")
}


// Position clauses are unambiguous: never use ORDER BY to change column order.
fn build_column_order(options: &TableStructureSqlOptions, context: &StarRocksAlterOptions, changes: &mut Vec<String>, warnings: &mut Vec<String>) {
    if context.reorder_columns {
        warnings.push("The legacy StarRocks ORDER BY column-reorder path is disabled. Refresh the editor and backend before changing column order.".into());
        return;
    }
    if !context.position_column_order { return; }
    let existing: Vec<_> = options.columns.iter().filter(|column| column.original.is_some() && !column.marked_for_drop).collect();
    let mut original = existing.clone();
    original.sort_by_key(|column| column.original_position.unwrap_or(usize::MAX));
    original.extend(options.columns.iter().filter(|column| column.original.is_none() && !column.marked_for_drop));
    let desired: Vec<_> = options.columns.iter().filter(|column| !column.marked_for_drop).collect();
    if desired.iter().map(|column| &column.id).eq(original.iter().map(|column| &column.id)) { return; }
    if context.model.as_deref() != Some("duplicate") {
        warnings.push("Physical column reordering is currently supported only for confirmed StarRocks DUPLICATE tables.".into());
    }
    if !changes.is_empty() || options.columns.iter().any(|column| column.original.is_none() || column.marked_for_drop) {
        warnings.push("Save StarRocks column definition changes, additions and deletions separately from column reordering.".into());
    }
    let source: std::collections::HashSet<_> = context.column_names.iter().map(|name| name.to_lowercase()).collect();
    let supplied: std::collections::HashSet<_> = existing.iter().map(|column| column.original.as_ref().unwrap().name.to_lowercase()).collect();
    let positions: std::collections::HashSet<_> = existing.iter().filter_map(|column| column.original_position).collect();
    if source.is_empty() || source.len() != context.column_names.len() || source != supplied
        || existing.len() != source.len() || positions.len() != existing.len() {
        warnings.push("StarRocks reordering requires all existing columns and their original positions; refresh table metadata first.".into());
    }
    let is_key = |column: &EditableStructureColumn| {
        context.key_columns.iter().any(|key| key.eq_ignore_ascii_case(&column.original.as_ref().unwrap().name))
    };
    let mut saw_value = false;
    for column in &existing {
        if is_key(column) {
            if saw_value {
                warnings.push("StarRocks key columns must precede all value columns; key columns may be reordered among themselves.".into());
                break;
            }
        } else {
            saw_value = true;
        }
    }
    let protected = |column: &EditableStructureColumn| {
        let name = &column.original.as_ref().unwrap().name;
        // Move other columns around expression sources: even a position-only MODIFY
        // can be rejected when the source backs a hidden generated partition column.
        context.partition_expression_columns.iter().any(|source| source.eq_ignore_ascii_case(name))
            || (!is_key(column) && context.partition_columns.iter().chain(&context.distribution_columns).any(|key| key.eq_ignore_ascii_case(name)))
            || column.original.as_ref().unwrap().extra.as_deref().is_some_and(|extra| {
                let lower = extra.to_lowercase(); lower.contains("generated") || lower.contains("auto_increment")
            })
    };
    if !original.iter().filter(|column| column.original.is_some()).filter(|column| protected(column)).map(|column| &column.id)
        .eq(existing.iter().filter(|column| protected(column)).map(|column| &column.id)) {
        warnings.push("Keep StarRocks partition-expression source columns, non-key partition/distribution columns and generated/auto-increment columns in their original relative order.".into());
    }
    if !warnings.is_empty() { return; }
    let mut simulated: Vec<_> = original.iter().map(|column| column.id.clone()).collect();
    for (index, column) in existing.iter().enumerate() {
        if protected(column) { continue; }
        let position = simulated.iter().position(|id| id == &column.id).unwrap();
        let predecessor = index.checked_sub(1).map(|previous| &existing[previous].id);
        let current_predecessor = position.checked_sub(1).map(|previous| &simulated[previous]);
        if current_predecessor == predecessor { continue; }
        let placement = if index == 0 { "FIRST".into() } else {
            format!("AFTER {}", quote_ident(StructureDialect::Mysql, &existing[index - 1].name))
        };
        changes.push(format!("MODIFY COLUMN {} {placement}", definition(column, is_key(column))));
        simulated.remove(position);
        let insert = predecessor.map(|id| simulated.iter().position(|value| value == id).unwrap() + 1).unwrap_or(0);
        simulated.insert(insert, column.id.clone());
    }
    if !simulated.iter().eq(existing.iter().map(|column| &column.id)) {
        warnings.push("This field order would require modifying a protected StarRocks column.".into());
    }
}


fn validate_sort_columns(options: &TableStructureSqlOptions, context: &StarRocksAlterOptions, names: &[String], warnings: &mut Vec<String>) {
    let version = super::create_dialect::parse_version(context.server_version.as_deref());
    let primary = context.model.as_deref() == Some("primary");
    if !matches!(context.model.as_deref(), Some("primary" | "duplicate" | "aggregate" | "unique"))
        || !version.is_some_and(|version| version >= if primary { (3, 0, 0) } else { (3, 3, 0) }) {
        warnings.push("Changing StarRocks sort keys requires confirmed table metadata and version 3.0+ for PRIMARY or 3.3+ for other models.".into());
    }
    if names.is_empty() { warnings.push("Select at least one StarRocks sort column.".into()); }
    let selected: std::collections::HashSet<_> = names.iter().map(|name| name.to_lowercase()).collect();
    let source: std::collections::HashSet<_> = context.column_names.iter().map(|name| name.to_lowercase()).collect();
    if selected.len() != names.len() { warnings.push("StarRocks sort columns must not repeat.".into()); }
    if source.is_empty() || !selected.is_subset(&source) { warnings.push("A sort column is missing. Refresh table metadata first.".into()); }
    if selected == source { warnings.push("Selecting every column is ambiguous with StarRocks schema reordering. Choose fewer columns for a sort-key change.".into()); }
    if matches!(context.model.as_deref(), Some("aggregate" | "unique")) {
        let keys: std::collections::HashSet<_> = context.key_columns.iter().map(|name| name.to_lowercase()).collect();
        if selected != keys { warnings.push("StarRocks AGGREGATE and UNIQUE sort keys must contain exactly all key columns.".into()); }
    }
    for name in names {
        let Some(column) = options.columns.iter().find(|column| column.name == *name && column.original.is_some() && !column.marked_for_drop) else {
            warnings.push(format!("Sort column '{name}' is missing or newly added. Save column changes first.")); continue;
        };
        let base = column.data_type.split('(').next().unwrap_or("").trim().to_lowercase();
        let valid = if primary { matches!(base.as_str(), "boolean" | "tinyint" | "smallint" | "int" | "integer" | "bigint" | "largeint" | "varchar" | "string" | "date" | "datetime") }
            else { matches!(base.as_str(), "boolean" | "tinyint" | "smallint" | "int" | "integer" | "bigint" | "largeint" | "float" | "double" | "decimal" | "decimalv2" | "decimal32" | "decimal64" | "decimal128" | "decimal256" | "char" | "varchar" | "string" | "date" | "datetime") };
        if !valid { warnings.push(format!("Column '{name}' has an unsupported StarRocks sort-key type.")); }
    }
}
