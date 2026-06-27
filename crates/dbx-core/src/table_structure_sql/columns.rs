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

pub(super) fn build_column_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let database_label = database_label(options.database_type);
    let active_columns: Vec<_> = options.columns.iter().filter(|column| !column.marked_for_drop).collect();
    let has_original_column_positions = active_columns.iter().any(|column| column.original_position.is_some());
    let mut simulated_column_order =
        if has_original_column_positions { original_active_column_order(&active_columns) } else { Vec::new() };
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
        let has_position_change = has_original_column_positions
            && matches!(dialect, StructureDialect::Mysql | StructureDialect::ClickHouse)
            && column.original.is_some()
            && column.original_position.is_some()
            && simulated_column_position_changed(&simulated_column_order, &column.id, desired_previous_column_id);

        if column.original.is_none() {
            if !capabilities.add_column {
                warnings.push(format!("Adding columns is not supported for {database_label} from this editor."));
                continue;
            }
            statements.extend(build_add_column_sql(
                dialect,
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

pub(super) fn build_add_column_sql(
    dialect: StructureDialect,
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
        let add_keyword = if dialect == StructureDialect::SqlServer { "ADD" } else { "ADD COLUMN" };
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
