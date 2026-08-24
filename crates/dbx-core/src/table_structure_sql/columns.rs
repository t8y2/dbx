use super::column_alter::{
    build_clickhouse_existing_column_sql, build_dameng_existing_column_sql, build_doris_existing_column_sql,
    build_h2_existing_column_sql, build_informix_existing_column_sql, build_iris_existing_column_sql,
    build_mysql_existing_column_clause, build_oracle_like_existing_column_sql, build_oscar_existing_column_sql,
    build_postgres_existing_column_sql, build_questdb_existing_column_sql, build_sqlite_existing_column_sql,
    build_sqlserver_existing_column_sql, build_xugu_existing_column_sql, dameng_drops_identity,
    has_column_extra_change, has_existing_column_attribute_change, validate_dameng_existing_identity_change,
};
use super::column_format::{
    column_definition, has_dameng_identity, is_dameng_identity_compatible_type, is_mysql_character_data_type,
    original_is_mysql_generated_column, original_mysql_generated_clause,
};
use super::comments::build_sqlserver_column_comment_sql;
use super::dialect::{capabilities_for, database_label, is_oracle_like, StructureDialect};
use super::types::{EditableStructureColumn, TableStructureSqlOptions};
use super::util::{
    clean, is_protected_manticore_id_column, normalize_default, original_comment, original_default, qualified_table,
    quote_ident, quote_string,
};
use crate::models::connection::DatabaseType;
use std::collections::HashSet;

pub(super) fn build_column_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let database_label = database_label(options.database_type);
    let active_columns: Vec<_> = options.columns.iter().filter(|column| !column.marked_for_drop).collect();
    if dialect == StructureDialect::Dameng {
        let identity_columns: Vec<_> = active_columns.iter().filter(|column| has_dameng_identity(column)).collect();
        if identity_columns.len() > 1
            || identity_columns.iter().any(|column| {
                column.extra.as_ref().and_then(|extra| extra.identity.as_ref()).and_then(|identity| identity.increment)
                    == Some(0)
            })
        {
            return Vec::new();
        }
        let mut valid_identity_changes = true;
        for column in &active_columns {
            if has_dameng_identity(column) && !is_dameng_identity_compatible_type(&column.data_type) {
                warnings.push(format!(
                    "Dameng identity column \"{}\" must use tinyint, smallint, int, integer, bigint, number, numeric, or decimal/dec with scale 0.",
                    column.name
                ));
                valid_identity_changes = false;
            } else if column.original.is_some() && !validate_dameng_existing_identity_change(column, warnings) {
                valid_identity_changes = false;
            }
        }
        if !valid_identity_changes {
            return Vec::new();
        }
    }
    if is_oracle_like(dialect)
        && active_columns.is_empty()
        && options.columns.iter().any(|column| column.marked_for_drop)
    {
        warnings.push("Oracle does not allow dropping all columns from a table. Keep at least one column or drop the table instead.".to_string());
        return Vec::new();
    }
    let has_original_column_positions = active_columns.iter().any(|column| column.original_position.is_some());
    let mut simulated_column_order =
        if has_original_column_positions { original_active_column_order(&active_columns) } else { Vec::new() };
    // Pre-compute the minimal set of existing columns that really need an explicit move.
    // For MySQL/ClickHouse we keep the largest already-ordered subset in place and only
    // emit FIRST/AFTER SQL for columns outside that subset.
    let reordered_existing_column_ids =
        if has_original_column_positions && matches!(dialect, StructureDialect::Mysql | StructureDialect::ClickHouse) {
            planned_existing_column_move_ids(&active_columns)
        } else {
            HashSet::new()
        };
    let mysql_primary_key_change = if options.database_type == Some(DatabaseType::Mysql) && !options.is_gaussdb_m_mode {
        primary_key_change(options)
    } else {
        None
    };
    // MySQL validates AUTO_INCREMENT against the statement's final index layout. Keep the
    // dependent column and key clauses together so no implicit commit exposes an invalid middle state.
    let mysql_coalesced_primary_key_change = mysql_primary_key_change
        .as_ref()
        .filter(|change| options.columns.iter().any(|column| mysql_auto_increment_touches_primary_key(column, change)));
    let mut mysql_primary_key_column_clauses = Vec::new();
    let mut statements = Vec::new();
    // DM8 owns identity at table level, so remove the old identity before any per-column ADD,
    // even when the target column appears earlier in the submitted draft.
    if dialect == StructureDialect::Dameng
        && options.columns.iter().any(|column| !column.marked_for_drop && dameng_drops_identity(column))
    {
        statements.push(format!("ALTER TABLE {table} DROP IDENTITY;"));
    }

    for column in &options.columns {
        if column.marked_for_drop {
            let Some(original) = &column.original else {
                continue;
            };
            if !capabilities.drop_column {
                warnings.push(format!("Dropping columns is not supported for {database_label} from this editor."));
                continue;
            }
            if original.is_primary_key {
                warnings.push(format!("Primary key column \"{}\" cannot be dropped from this editor.", original.name));
                continue;
            }
            if is_protected_manticore_id_column(dialect, &original.name) {
                warnings.push("Manticore Search id column cannot be dropped from this editor.".to_string());
                continue;
            }
            statements.push(build_drop_column_sql(dialect, &table, &original.name));
            continue;
        }

        let active_index = active_columns.iter().position(|active| active.id == column.id).unwrap_or(0);
        let position_clause = if has_original_column_positions {
            column_position_clause(dialect, &active_columns, active_index)
        } else {
            String::new()
        };
        let desired_previous_column_id = active_previous_column_id(&active_columns, active_index);
        // A position change only matters when this column is part of the planned move set
        // and its predecessor still differs in the simulated order.
        let has_position_change = has_original_column_positions
            && matches!(dialect, StructureDialect::Mysql | StructureDialect::ClickHouse)
            && reordered_existing_column_ids.contains(&column.id)
            && column.original.is_some()
            && column.original_position.is_some()
            && simulated_column_position_changed(&simulated_column_order, &column.id, desired_previous_column_id);

        if column.original.is_none() {
            if !capabilities.add_column {
                warnings.push(format!("Adding columns is not supported for {database_label} from this editor."));
                continue;
            }
            if dialect == StructureDialect::SqlServer
                && has_sqlserver_identity(column)
                && !is_sqlserver_identity_compatible_type(&column.data_type)
            {
                warnings.push(format!(
                    "SQL Server identity column \"{}\" must use tinyint, smallint, int, bigint, or decimal/numeric with scale 0.",
                    column.name
                ));
                continue;
            }
            if !capabilities.comment && !clean(&column.comment).is_empty() {
                warnings.push(format!(
                    "Column comments are not supported for {database_label} from this editor; the comment for \"{}\" was ignored.",
                    column.name
                ));
            }
            if mysql_coalesced_primary_key_change
                .is_some_and(|change| mysql_auto_increment_touches_primary_key(column, change))
            {
                mysql_primary_key_column_clauses.push(format!(
                    "ADD COLUMN {}{position_clause}",
                    column_definition(StructureDialect::Mysql, column)
                ));
            } else {
                statements.extend(build_add_column_sql(
                    dialect,
                    options.database_type,
                    capabilities.comment,
                    &table,
                    column,
                    &position_clause,
                    options.schema.as_deref(),
                    &options.table_name,
                ));
            }
            if has_original_column_positions
                && matches!(dialect, StructureDialect::Mysql | StructureDialect::ClickHouse)
            {
                apply_simulated_column_position(&mut simulated_column_order, &column.id, desired_previous_column_id);
            }
            continue;
        }

        if !has_existing_column_attribute_change(column) && !has_column_extra_change(column) && !has_position_change {
            continue;
        }
        let original = column.original.as_ref().unwrap();
        let has_rename = column.name != original.name;
        let has_comment_change = clean(&column.comment) != original_comment(column);
        let has_attribute_change = column.data_type.trim() != original.data_type.trim()
            || column.is_nullable != original.is_nullable
            || normalize_default(Some(&column.default_value)) != original_default(column)
            || (has_comment_change && capabilities.comment)
            || (is_mysql_character_data_type(&column.data_type)
                && (column.character_set.trim() != original.character_set.as_deref().unwrap_or("")
                    || column.collation.trim() != original.collation.as_deref().unwrap_or("")))
            || has_column_extra_change(column);
        if has_comment_change && !capabilities.comment {
            warnings.push(format!(
                "Column comments are not supported for {database_label} from this editor; the comment change for \"{}\" was ignored.",
                original.name
            ));
        }
        if has_position_change && !capabilities.reorder_column {
            warnings.push(format!("Reordering columns is not supported for {database_label} from this editor."));
        }
        if has_rename && !capabilities.rename_column {
            warnings.push(format!("Renaming columns is not supported for {database_label} from this editor."));
        }
        if has_attribute_change && !capabilities.alter_existing_column && dialect != StructureDialect::Sqlite {
            warnings.push(format!("Editing existing columns is not supported for {database_label} yet."));
        }
        if (has_position_change && !capabilities.reorder_column)
            || (has_rename && !capabilities.rename_column)
            || (has_attribute_change && !capabilities.alter_existing_column && dialect != StructureDialect::Sqlite)
        {
            continue;
        }
        if dialect == StructureDialect::Mysql
            && original_is_mysql_generated_column(column)
            && original_mysql_generated_clause(column).is_none()
        {
            warnings.push(format!(
                "Column \"{}\" is generated, but its generation expression could not be loaded; no ALTER statement was generated to avoid removing the generated-column definition.",
                original.name
            ));
            continue;
        }
        if !has_rename && !has_attribute_change && !has_position_change {
            continue;
        }

        match dialect {
            StructureDialect::Mysql => {
                let clause =
                    build_mysql_existing_column_clause(column, if has_position_change { &position_clause } else { "" });
                if mysql_coalesced_primary_key_change
                    .is_some_and(|change| mysql_auto_increment_touches_primary_key(column, change))
                {
                    mysql_primary_key_column_clauses.push(clause);
                } else {
                    statements.push(format!("ALTER TABLE {table} {clause};"));
                }
            }
            StructureDialect::Doris => statements.extend(build_doris_existing_column_sql(&table, column, "")),
            StructureDialect::Postgres => statements.extend(build_postgres_existing_column_sql(&table, column)),
            StructureDialect::Oracle => {
                if options.database_type == Some(crate::models::connection::DatabaseType::Iris) {
                    statements.extend(build_iris_existing_column_sql(&table, column));
                } else if options.database_type == Some(crate::models::connection::DatabaseType::Xugu) {
                    statements.extend(build_xugu_existing_column_sql(&table, column));
                } else {
                    statements.extend(build_oracle_like_existing_column_sql(dialect, &table, column))
                }
            }
            StructureDialect::Dameng => {
                statements.extend(build_dameng_existing_column_sql(&table, column, false, warnings))
            }
            // 神通 MODIFY 语法与 Oracle 有差异（NULL/NOT NULL 须单独一条），用专属实现。
            StructureDialect::Oscar => statements.extend(build_oscar_existing_column_sql(dialect, &table, column)),
            StructureDialect::H2 => statements.extend(build_h2_existing_column_sql(&table, column)),
            StructureDialect::ClickHouse => statements.extend(build_clickhouse_existing_column_sql(
                &table,
                column,
                if has_position_change { &position_clause } else { "" },
            )),
            StructureDialect::Informix => statements.extend(build_informix_existing_column_sql(&table, column)),
            StructureDialect::SqlServer => statements.extend(build_sqlserver_existing_column_sql(
                &table,
                column,
                options.schema.as_deref(),
                &options.table_name,
                warnings,
            )),
            StructureDialect::Sqlite => statements.extend(build_sqlite_existing_column_sql(&table, column, warnings)),
            StructureDialect::Questdb => statements.extend(build_questdb_existing_column_sql(&table, column)),
            _ => warnings.push(format!("Editing existing columns is not supported for {database_label} yet.")),
        }
        if has_position_change {
            apply_simulated_column_position(&mut simulated_column_order, &column.id, desired_previous_column_id);
        }
    }

    if let Some(change) = mysql_coalesced_primary_key_change {
        let mut clauses = Vec::new();
        if !change.old_ids.is_empty() {
            clauses.push("DROP PRIMARY KEY".to_string());
        }
        clauses.append(&mut mysql_primary_key_column_clauses);
        if !change.new_names.is_empty() {
            let pk_list = change
                .new_names
                .iter()
                .map(|name| quote_ident(StructureDialect::Mysql, name))
                .collect::<Vec<_>>()
                .join(", ");
            clauses.push(format!("ADD PRIMARY KEY ({pk_list})"));
        }
        statements.push(format!("ALTER TABLE {table} {};", clauses.join(", ")));
    } else {
        // Keep the existing key while column DDL validates. This avoids leaving a table
        // without a key when an incoming key column cannot be made valid.
        statements.extend(build_primary_key_sql(options, dialect, &table, warnings));
    }

    statements
}

fn was_primary_key_column(column: &EditableStructureColumn) -> bool {
    column.original.as_ref().is_some_and(|original| original.is_primary_key)
}

/// Columns that should appear in `ADD PRIMARY KEY (...)` (must remain on the table).
fn appears_in_add_primary_key(column: &EditableStructureColumn) -> bool {
    column.is_primary_key && !column.marked_for_drop
}

struct PrimaryKeyChange<'a> {
    old_ids: HashSet<&'a str>,
    new_ids: HashSet<&'a str>,
    new_names: Vec<&'a str>,
}

fn primary_key_change(options: &TableStructureSqlOptions) -> Option<PrimaryKeyChange<'_>> {
    if options.columns.iter().any(|column| column.marked_for_drop && was_primary_key_column(column)) {
        return None;
    }

    let old_ids: HashSet<&str> = options
        .columns
        .iter()
        .filter(|column| was_primary_key_column(column))
        .map(|column| column.id.as_str())
        .collect();
    let new_ids: HashSet<&str> = options
        .columns
        .iter()
        .filter(|column| appears_in_add_primary_key(column))
        .map(|column| column.id.as_str())
        .collect();
    if old_ids == new_ids {
        return None;
    }

    let new_names = options
        .columns
        .iter()
        .filter(|column| appears_in_add_primary_key(column))
        .map(|column| column.name.as_str())
        .collect();
    Some(PrimaryKeyChange { old_ids, new_ids, new_names })
}

fn unsupported_primary_key_change_warning(options: &TableStructureSqlOptions, change: &PrimaryKeyChange<'_>) -> String {
    let action = if change.old_ids.is_empty() { "Adding" } else { "Changing" };
    format!("{action} primary keys is not supported for {} from this editor.", database_label(options.database_type))
}

pub(super) fn validate_primary_key_change_scope(options: &TableStructureSqlOptions) -> Vec<String> {
    if let Some(original) = options
        .columns
        .iter()
        .find(|column| column.marked_for_drop && was_primary_key_column(column))
        .and_then(|column| column.original.as_ref())
    {
        return vec![format!("Primary key column \"{}\" cannot be dropped from this editor.", original.name)];
    }

    let Some(change) = primary_key_change(options) else { return Vec::new() };
    let capabilities = capabilities_for(options.database_type);
    let supported =
        if change.old_ids.is_empty() { capabilities.add_primary_key } else { capabilities.alter_primary_key };
    if supported {
        Vec::new()
    } else {
        vec![unsupported_primary_key_change_warning(options, &change)]
    }
}

fn mysql_auto_increment_touches_primary_key(column: &EditableStructureColumn, change: &PrimaryKeyChange<'_>) -> bool {
    column.extra.as_ref().is_some_and(|extra| extra.auto_increment.unwrap_or(false))
        && (change.old_ids.contains(column.id.as_str()) || change.new_ids.contains(column.id.as_str()))
}

pub(super) fn build_primary_key_sql(
    options: &TableStructureSqlOptions,
    dialect: StructureDialect,
    table: &str,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);

    // Membership by draft id (set equality): pure rename / local reorder of the same key
    // columns is not a PK change. A draft that drops a PK column is also rejected here.
    let Some(change) = primary_key_change(options) else { return Vec::new() };

    let supported =
        if change.old_ids.is_empty() { capabilities.add_primary_key } else { capabilities.alter_primary_key };
    if !supported {
        warnings.push(unsupported_primary_key_change_warning(options, &change));
        return Vec::new();
    }

    let persisted_postgres_primary_key_name = if options.database_type == Some(DatabaseType::Postgres)
        && !change.old_ids.is_empty()
    {
        let mut primary_indexes =
            options.indexes.iter().filter_map(|index| index.original.as_ref().filter(|original| original.is_primary));
        match (primary_indexes.next(), primary_indexes.next()) {
            (Some(primary_index), None) if !primary_index.name.is_empty() => Some(primary_index.name.as_str()),
            _ => {
                warnings.push(
                        "Could not determine the existing PostgreSQL primary key constraint name. Refresh the table structure and try again."
                            .to_string(),
                    );
                return Vec::new();
            }
        }
    } else {
        None
    };

    let mut statements = Vec::new();
    if !change.old_ids.is_empty() {
        let Some(drop_sql) = drop_primary_key_statement(dialect, table, options, persisted_postgres_primary_key_name)
        else {
            warnings.push(format!(
                "Changing primary keys is not supported for {} from this editor.",
                database_label(options.database_type)
            ));
            return Vec::new();
        };
        statements.push(drop_sql);
    }

    if !change.new_names.is_empty() {
        let pk_list = change.new_names.iter().map(|name| quote_ident(dialect, name)).collect::<Vec<_>>().join(", ");
        // DM8: ADD [CONSTRAINT name] PRIMARY KEY; anonymous form matches Navicat/DBeaver/MySQL editors.
        let constraint = persisted_postgres_primary_key_name
            .map(|name| format!("CONSTRAINT {} ", quote_ident(dialect, name)))
            .unwrap_or_default();
        statements.push(format!("ALTER TABLE {table} ADD {constraint}PRIMARY KEY ({pk_list});"));
    }

    statements
}

/// Dialect-specific DROP for an existing primary key.
///
/// - MySQL: `DROP PRIMARY KEY`
/// - Dameng (DM8): official `DROP PRIMARY KEY [RESTRICT|CASCADE]`; default RESTRICT
///   (no CASCADE — dependent FKs should not be silently removed).
///   System names (`CONS…`) are not stable; name-based DROP is avoided.
///   Cluster primary keys cannot use this path (DM8 restriction) — left to the server.
/// - Postgres: `DROP CONSTRAINT <persisted primary index name>` for PostgreSQL;
///   other Postgres-compatible engines retain the existing default-name behavior.
fn drop_primary_key_statement(
    dialect: StructureDialect,
    table: &str,
    options: &TableStructureSqlOptions,
    persisted_postgres_primary_key_name: Option<&str>,
) -> Option<String> {
    match dialect {
        StructureDialect::Postgres => {
            let fallback_name;
            let pk_name = if let Some(name) = persisted_postgres_primary_key_name {
                name
            } else {
                let raw_table = options.table_name.split('.').next_back().unwrap_or(&options.table_name);
                fallback_name = format!("{}_pkey", clean(raw_table));
                &fallback_name
            };
            Some(format!("ALTER TABLE {table} DROP CONSTRAINT {};", quote_ident(dialect, pk_name)))
        }
        // 神通 Oscar 实测支持 `ALTER TABLE ... DROP PRIMARY KEY`（与 Dameng/MySQL 一致）。
        StructureDialect::Mysql | StructureDialect::Dameng | StructureDialect::Oscar => {
            Some(format!("ALTER TABLE {table} DROP PRIMARY KEY;"))
        }
        _ => None,
    }
}

fn has_sqlserver_identity(column: &EditableStructureColumn) -> bool {
    column.extra.as_ref().is_some_and(|extra| extra.auto_increment.unwrap_or(false) || extra.identity.is_some())
}

fn is_sqlserver_identity_compatible_type(data_type: &str) -> bool {
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
    if !matches!(normalized.as_str(), "decimal" | "numeric") {
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

pub(super) fn build_add_column_sql(
    dialect: StructureDialect,
    database_type: Option<crate::models::connection::DatabaseType>,
    supports_comments: bool,
    table: &str,
    column: &EditableStructureColumn,
    position_clause: &str,
    schema: Option<&str>,
    table_name: &str,
) -> Vec<String> {
    let definition = column_definition(dialect, column);
    let mut statements = if is_oracle_like(dialect) || dialect == StructureDialect::Informix {
        vec![format!("ALTER TABLE {table} ADD ({definition});")]
    } else {
        let add_keyword = if dialect == StructureDialect::SqlServer
            || database_type == Some(crate::models::connection::DatabaseType::Kingbase)
        {
            "ADD"
        } else {
            "ADD COLUMN"
        };
        vec![format!("ALTER TABLE {table} {add_keyword} {definition}{position_clause};")]
    };
    if supports_comments
        && matches!(
            dialect,
            StructureDialect::Postgres | StructureDialect::Oracle | StructureDialect::Dameng | StructureDialect::Oscar
        )
        && !clean(&column.comment).is_empty()
    {
        statements.push(format!(
            "COMMENT ON COLUMN {table}.{} IS {};",
            quote_ident(dialect, &column.name),
            quote_string(&clean(&column.comment))
        ));
    }
    if dialect == StructureDialect::ClickHouse && !clean(&column.comment).is_empty() {
        statements.push(format!(
            "ALTER TABLE {table} COMMENT COLUMN {} {};",
            quote_ident(dialect, &column.name),
            quote_string(&clean(&column.comment))
        ));
    }
    if dialect == StructureDialect::SqlServer && !clean(&column.comment).is_empty() {
        statements.extend(build_sqlserver_column_comment_sql(table, schema, table_name, &column.name, &column.comment));
    }
    statements
}

pub(super) fn build_drop_column_sql(dialect: StructureDialect, table: &str, column_name: &str) -> String {
    if dialect == StructureDialect::Informix {
        return format!("ALTER TABLE {table} DROP ({});", quote_ident(dialect, column_name));
    }
    format!("ALTER TABLE {table} DROP COLUMN {};", quote_ident(dialect, column_name))
}

pub(super) fn column_position_clause(
    dialect: StructureDialect,
    columns: &[&EditableStructureColumn],
    index: usize,
) -> String {
    if !matches!(dialect, StructureDialect::Mysql | StructureDialect::ClickHouse) {
        return String::new();
    }
    if index == 0 {
        return " FIRST".to_string();
    }
    format!(" AFTER {}", quote_ident(dialect, columns.get(index - 1).map(|column| column.name.as_str()).unwrap_or("")))
}

pub(super) fn original_active_column_order(columns: &[&EditableStructureColumn]) -> Vec<String> {
    let mut original_columns: Vec<_> = columns
        .iter()
        .filter(|column| column.original.is_some() && column.original_position.is_some())
        .copied()
        .collect();
    original_columns.sort_by_key(|column| column.original_position.unwrap_or(0));
    original_columns.into_iter().map(|column| column.id.clone()).collect()
}

/// Returns the ids of existing columns that must be explicitly moved to reach the target order.
///
/// The function keeps the longest subsequence of existing columns whose relative order is already
/// correct, and marks only the remaining columns for FIRST/AFTER reordering SQL.
pub(super) fn planned_existing_column_move_ids(columns: &[&EditableStructureColumn]) -> HashSet<String> {
    // Only existing columns with an original position participate in move planning.
    // Newly added columns are positioned directly from the target order.
    let reorderable_columns: Vec<_> = columns
        .iter()
        .filter_map(|column| {
            column
                .original
                .as_ref()
                .zip(column.original_position)
                .map(|_| (column.id.as_str(), column.original_position.unwrap_or(0)))
        })
        .collect();
    if reorderable_columns.len() < 2 {
        return HashSet::new();
    }

    // Map the target order back to original positions, then keep the largest increasing subsequence.
    let original_positions: Vec<_> = reorderable_columns.iter().map(|(_, position)| *position).collect();
    // Columns inside the LIS can stay where they are; everything else needs an explicit move.
    let kept_indices: HashSet<_> = longest_increasing_subsequence_indices(&original_positions).into_iter().collect();

    reorderable_columns
        .into_iter()
        .enumerate()
        .filter(|(index, _)| !kept_indices.contains(index))
        .map(|(_, (column_id, _))| column_id.to_string())
        .collect()
}

/// Returns the indices of one longest increasing subsequence within `values`.
///
/// In the reorder planner, an increasing subsequence represents existing columns whose relative
/// order still matches the original table layout, so they can remain untouched.
fn longest_increasing_subsequence_indices(values: &[usize]) -> Vec<usize> {
    if values.is_empty() {
        return Vec::new();
    }

    // O(n^2) is sufficient here because table editors deal with relatively small column counts
    // and the simpler implementation is easier to maintain.
    let mut lengths = vec![1; values.len()];
    let mut previous = vec![None; values.len()];
    let mut best_end_index = 0;

    for current_index in 0..values.len() {
        for previous_index in 0..current_index {
            if values[previous_index] < values[current_index] && lengths[previous_index] + 1 > lengths[current_index] {
                lengths[current_index] = lengths[previous_index] + 1;
                previous[current_index] = Some(previous_index);
            }
        }

        if lengths[current_index] > lengths[best_end_index] {
            best_end_index = current_index;
        }
    }

    // Reconstruct the subsequence by following the predecessor chain backwards.
    let mut indices = Vec::new();
    let mut cursor = Some(best_end_index);
    while let Some(index) = cursor {
        indices.push(index);
        cursor = previous[index];
    }
    indices.reverse();
    indices
}

pub(super) fn active_previous_column_id<'a>(columns: &[&'a EditableStructureColumn], index: usize) -> Option<&'a str> {
    if index == 0 {
        None
    } else {
        columns.get(index - 1).map(|column| column.id.as_str())
    }
}

pub(super) fn simulated_column_position_changed(
    simulated_column_order: &[String],
    column_id: &str,
    desired_previous_column_id: Option<&str>,
) -> bool {
    let Some(index) = simulated_column_order.iter().position(|id| id == column_id) else {
        return false;
    };
    let current_previous_column_id = if index == 0 { None } else { Some(simulated_column_order[index - 1].as_str()) };
    current_previous_column_id != desired_previous_column_id
}

pub(super) fn apply_simulated_column_position(
    simulated_column_order: &mut Vec<String>,
    column_id: &str,
    desired_previous_column_id: Option<&str>,
) {
    if let Some(index) = simulated_column_order.iter().position(|id| id == column_id) {
        simulated_column_order.remove(index);
    }
    let index = desired_previous_column_id
        .and_then(|previous_id| simulated_column_order.iter().position(|id| id == previous_id).map(|index| index + 1))
        .unwrap_or(0);
    simulated_column_order.insert(index, column_id.to_string());
}
