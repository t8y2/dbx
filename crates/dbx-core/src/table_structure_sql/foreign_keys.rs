use super::dialect::{database_label, StructureDialect};
use super::types::{EditableStructureForeignKey, ForeignKeyInfo, TableStructureSqlOptions};
use super::util::{clean, qualified_new_table, qualified_table, quote_ident, quote_new_ident};

pub(super) fn build_foreign_key_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    build_foreign_key_sql_with_mode(options, warnings, false)
}

pub(super) fn build_foreign_key_sql_for_new_table(
    options: &TableStructureSqlOptions,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    build_foreign_key_sql_with_mode(options, warnings, true)
}

fn build_foreign_key_sql_with_mode(
    options: &TableStructureSqlOptions,
    warnings: &mut Vec<String>,
    for_new_table: bool,
) -> Vec<String> {
    if options.foreign_keys.is_empty() {
        return Vec::new();
    }

    let database_label = database_label(options.database_type);
    let capabilities = super::dialect::capabilities_for(options.database_type, options.driver_profile.as_deref());
    let dialect = capabilities.dialect;
    if !capabilities.foreign_key {
        if has_foreign_key_edits(&options.foreign_keys) {
            warnings.push(format!("Editing foreign keys is not supported for {database_label} from this editor."));
        }
        return Vec::new();
    }

    let table = if for_new_table {
        qualified_new_table(options.database_type, dialect, options.schema.as_deref(), &options.table_name)
    } else {
        qualified_table(dialect, options.schema.as_deref(), &options.table_name)
    };
    let mut statements = Vec::new();

    for foreign_key in &options.foreign_keys {
        if foreign_key.marked_for_drop {
            if let Some(original) = &foreign_key.original {
                statements.push(drop_foreign_key_sql(dialect, &table, &original.name));
            }
            continue;
        }

        if let Some(original) = &foreign_key.original {
            if !has_foreign_key_change(foreign_key, original) {
                continue;
            }
            statements.push(drop_foreign_key_sql(dialect, &table, &original.name));
        }

        if let Some(sql) =
            create_foreign_key_sql(options.database_type, dialect, &table, foreign_key, warnings, for_new_table)
        {
            statements.push(sql);
        }
    }

    statements
}

fn has_foreign_key_edits(foreign_keys: &[EditableStructureForeignKey]) -> bool {
    foreign_keys.iter().any(|foreign_key| {
        if foreign_key.marked_for_drop {
            return foreign_key.original.is_some();
        }

        match &foreign_key.original {
            Some(original) => has_foreign_key_change(foreign_key, original),
            None => has_foreign_key_definition(foreign_key),
        }
    })
}

fn has_foreign_key_definition(foreign_key: &EditableStructureForeignKey) -> bool {
    !clean(&foreign_key.name).is_empty()
        || !clean(&foreign_key.column).is_empty()
        || !clean(&foreign_key.ref_schema).is_empty()
        || !clean(&foreign_key.ref_table).is_empty()
        || !clean(&foreign_key.ref_column).is_empty()
        || !clean(&foreign_key.on_update).is_empty()
        || !clean(&foreign_key.on_delete).is_empty()
}

fn has_foreign_key_change(foreign_key: &EditableStructureForeignKey, original: &ForeignKeyInfo) -> bool {
    clean(&foreign_key.name) != clean(&original.name)
        || clean(&foreign_key.column) != clean(&original.column)
        || clean(&foreign_key.ref_schema) != clean(original.ref_schema.as_deref().unwrap_or(""))
        || clean(&foreign_key.ref_table) != clean(&original.ref_table)
        || clean(&foreign_key.ref_column) != clean(&original.ref_column)
        || normalize_action(&foreign_key.on_update) != normalize_action(original.on_update.as_deref().unwrap_or(""))
        || normalize_action(&foreign_key.on_delete) != normalize_action(original.on_delete.as_deref().unwrap_or(""))
}

fn drop_foreign_key_sql(dialect: StructureDialect, table: &str, name: &str) -> String {
    match dialect {
        StructureDialect::Mysql => format!("ALTER TABLE {table} DROP FOREIGN KEY {};", quote_ident(dialect, name)),
        StructureDialect::Postgres | StructureDialect::Oracle => {
            format!("ALTER TABLE {table} DROP CONSTRAINT {};", quote_ident(dialect, name))
        }
        _ => unreachable!("foreign key SQL requested for unsupported dialect"),
    }
}

fn create_foreign_key_sql(
    database_type: Option<crate::models::connection::DatabaseType>,
    dialect: StructureDialect,
    table: &str,
    foreign_key: &EditableStructureForeignKey,
    warnings: &mut Vec<String>,
    for_new_table: bool,
) -> Option<String> {
    let name = clean(&foreign_key.name);
    let columns = identifier_list(&foreign_key.column);
    let ref_table = clean(&foreign_key.ref_table);
    let ref_columns = identifier_list(&foreign_key.ref_column);
    if name.is_empty() || columns.is_empty() || ref_table.is_empty() || ref_columns.is_empty() {
        warnings.push("Foreign key name, column, referenced table, and referenced column are required.".to_string());
        return None;
    }
    if columns.len() != ref_columns.len() {
        warnings.push(format!("Foreign key \"{name}\" must have the same number of local and referenced columns."));
        return None;
    }

    let ref_target = if clean(&foreign_key.ref_schema).is_empty() {
        quote_ident(dialect, &ref_table)
    } else {
        format!("{}.{}", quote_ident(dialect, &foreign_key.ref_schema), quote_ident(dialect, &ref_table))
    };

    let constraint_name =
        if for_new_table { quote_new_ident(database_type, dialect, &name) } else { quote_ident(dialect, &name) };
    let local_columns =
        columns
            .iter()
            .map(|column| {
                if for_new_table {
                    quote_new_ident(database_type, dialect, column)
                } else {
                    quote_ident(dialect, column)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
    let referenced_columns =
        ref_columns.iter().map(|column| quote_ident(dialect, column)).collect::<Vec<_>>().join(", ");
    let mut sql = format!(
        "ALTER TABLE {table} ADD CONSTRAINT {constraint_name} FOREIGN KEY ({local_columns}) REFERENCES {ref_target} ({referenced_columns})"
    );

    if let Some(action) = action_clause(dialect, "ON DELETE", &foreign_key.on_delete, warnings) {
        sql.push(' ');
        sql.push_str(&action);
    }
    if let Some(action) = action_clause(dialect, "ON UPDATE", &foreign_key.on_update, warnings) {
        sql.push(' ');
        sql.push_str(&action);
    }
    sql.push(';');
    Some(sql)
}

fn action_clause(dialect: StructureDialect, prefix: &str, value: &str, warnings: &mut Vec<String>) -> Option<String> {
    let action = normalize_action(value);
    if action.is_empty() {
        return None;
    }
    if dialect == StructureDialect::Oracle {
        if prefix == "ON UPDATE" {
            if action != "NO ACTION" {
                warnings.push(format!("Oracle does not support {prefix} {action}."));
            }
            return None;
        }
        return match action.as_str() {
            "CASCADE" | "SET NULL" => Some(format!("{prefix} {action}")),
            "NO ACTION" => None,
            _ => {
                warnings.push(format!("Unsupported Oracle foreign key action \"{}\".", clean(value)));
                None
            }
        };
    }
    match action.as_str() {
        "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION" => Some(format!("{prefix} {action}")),
        _ => {
            warnings.push(format!("Unsupported foreign key action \"{}\".", clean(value)));
            None
        }
    }
}

fn normalize_action(value: &str) -> String {
    clean(value).split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase()
}

fn identifier_list(value: &str) -> Vec<String> {
    value.split(',').map(clean).filter(|value| !value.is_empty()).collect()
}
