use super::column_alter::{
    build_clickhouse_existing_column_sql, build_h2_existing_column_sql, build_informix_existing_column_sql,
    build_mysql_existing_column_sql, build_oracle_like_existing_column_sql, build_postgres_existing_column_sql,
    build_questdb_existing_column_sql, build_sqlite_existing_column_sql, build_sqlserver_existing_column_sql,
    has_column_extra_change, has_existing_column_attribute_change,
};
use super::column_format::column_definition;
use super::comments::build_sqlserver_column_comment_sql;
use super::dialect::{capabilities_for, database_label, StructureDialect};
use super::types::{EditableStructureColumn, TableStructureSqlOptions};
use super::util::{
    clean, is_protected_manticore_id_column, normalize_default, original_comment, original_default, qualified_table,
    quote_ident, quote_string,
};
use std::collections::HashSet;

pub(super) fn build_column_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let database_label = database_label(options.database_type);
    let active_columns: Vec<_> = options.columns.iter().filter(|column| !column.marked_for_drop).collect();
    if dialect == StructureDialect::Oracle
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
    let mut statements = Vec::new();

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
            statements.extend(build_add_column_sql(
                dialect,
                options.database_type,
                &table,
                column,
                &position_clause,
                options.schema.as_deref(),
                &options.table_name,
            ));
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
        let has_attribute_change = column.data_type.trim() != original.data_type.trim()
            || column.is_nullable != original.is_nullable
            || normalize_default(Some(&column.default_value)) != original_default(column)
            || clean(&column.comment) != original_comment(column)
            || has_column_extra_change(column);
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

        match dialect {
            StructureDialect::Mysql => statements.extend(build_mysql_existing_column_sql(
                &table,
                column,
                if has_position_change { &position_clause } else { "" },
            )),
            StructureDialect::Postgres => statements.extend(build_postgres_existing_column_sql(&table, column)),
            StructureDialect::Oracle => {
                statements.extend(build_oracle_like_existing_column_sql(dialect, &table, column))
            }
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

    // Emit primary key constraint changes after individual column changes
    statements.extend(build_primary_key_sql(options, dialect, &table, warnings));

    statements
}

pub(super) fn build_primary_key_sql(
    options: &TableStructureSqlOptions,
    dialect: StructureDialect,
    table: &str,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);

    let old_pk_names: Vec<&str> = options
        .columns
        .iter()
        .filter(|c| c.original.as_ref().is_some_and(|o| o.is_primary_key))
        .map(|c| c.name.as_str())
        .collect();

    let new_pk_names: Vec<&str> =
        options.columns.iter().filter(|c| !c.marked_for_drop && c.is_primary_key).map(|c| c.name.as_str()).collect();

    if old_pk_names == new_pk_names {
        return Vec::new();
    }

    if !capabilities.alter_primary_key {
        warnings.push(format!(
            "Changing primary keys is not supported for {} from this editor.",
            database_label(options.database_type)
        ));
        return Vec::new();
    }

    let mut statements = Vec::new();

    if !old_pk_names.is_empty() {
        match dialect {
            StructureDialect::Postgres => {
                let raw_table = options.table_name.split('.').next_back().unwrap_or(&options.table_name);
                let pk_name = format!("{}_pkey", clean(raw_table));
                statements.push(format!("ALTER TABLE {table} DROP CONSTRAINT {};", quote_ident(dialect, &pk_name)));
            }
            StructureDialect::Mysql => {
                statements.push(format!("ALTER TABLE {table} DROP PRIMARY KEY;"));
            }
            _ => {}
        }
    }

    if !new_pk_names.is_empty() {
        let pk_list = new_pk_names.iter().map(|n| quote_ident(dialect, n)).collect::<Vec<_>>().join(", ");
        statements.push(format!("ALTER TABLE {table} ADD PRIMARY KEY ({pk_list});"));
    }

    statements
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
    table: &str,
    column: &EditableStructureColumn,
    position_clause: &str,
    schema: Option<&str>,
    table_name: &str,
) -> Vec<String> {
    let definition = column_definition(dialect, column);
    let mut statements = if dialect == StructureDialect::Oracle || dialect == StructureDialect::Informix {
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
    if matches!(dialect, StructureDialect::Postgres | StructureDialect::Oracle) && !clean(&column.comment).is_empty() {
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
