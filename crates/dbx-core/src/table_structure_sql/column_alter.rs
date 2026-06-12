use super::column_format::{clickhouse_column_type, column_data_type, column_definition};
use super::comments::build_sqlserver_column_comment_sql;
use super::dialect::{capabilities_for, database_label, StructureDialect};
use super::types::{EditableStructureColumn, SingleColumnAlterSqlOptions, TableStructureSqlResult};
use super::util::{
    clean, format_default_for_sql, normalize_default, original_comment, original_default, qualified_table, quote_ident,
    quote_string,
};
use crate::table_structure_sql::ColumnExtra;

pub fn build_single_column_alter_sql(options: SingleColumnAlterSqlOptions) -> TableStructureSqlResult {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let database_label = database_label(options.database_type);
    let mut warnings = Vec::new();
    let mut statements = Vec::new();

    if options.column.marked_for_drop {
        let Some(original) = &options.column.original else {
            warnings.push("No original column info available.".to_string());
            return TableStructureSqlResult { statements, warnings };
        };
        if !capabilities.drop_column {
            warnings.push(format!("Dropping columns is not supported for {database_label} from this editor."));
            return TableStructureSqlResult { statements, warnings };
        }
        if original.is_primary_key {
            warnings.push(format!("Primary key column \"{}\" cannot be dropped from this editor.", original.name));
            return TableStructureSqlResult { statements, warnings };
        }
        statements.push(format!("ALTER TABLE {table} DROP COLUMN {};", quote_ident(dialect, &original.name)));
        return TableStructureSqlResult { statements, warnings };
    }

    let Some(original) = &options.column.original else {
        warnings.push(
            "This column has no original state — ALTER statements are only available for existing columns.".to_string(),
        );
        return TableStructureSqlResult { statements, warnings };
    };

    if !has_existing_column_attribute_change(&options.column) && !has_column_extra_change(&options.column) {
        warnings.push("No changes detected for this column.".to_string());
        return TableStructureSqlResult { statements, warnings };
    }

    let has_rename = options.column.name != original.name;
    let has_attribute_change = options.column.data_type.trim() != original.data_type.trim()
        || options.column.is_nullable != original.is_nullable
        || normalize_default(Some(&options.column.default_value)) != original_default(&options.column)
        || clean(&options.column.comment) != original_comment(&options.column);

    if has_rename && !capabilities.rename_column {
        warnings.push(format!("Renaming columns is not supported for {database_label} from this editor."));
    }
    if has_attribute_change && !capabilities.alter_existing_column && dialect != StructureDialect::Sqlite {
        warnings.push(format!("Editing existing columns is not supported for {database_label} yet."));
    }

    if (has_rename && !capabilities.rename_column)
        || (has_attribute_change && !capabilities.alter_existing_column && dialect != StructureDialect::Sqlite)
    {
        return TableStructureSqlResult { statements, warnings };
    }

    match dialect {
        StructureDialect::Mysql => statements.extend(build_mysql_existing_column_sql(&table, &options.column, "")),
        StructureDialect::Postgres => statements.extend(build_postgres_existing_column_sql(&table, &options.column)),
        StructureDialect::Oracle => {
            statements.extend(build_oracle_like_existing_column_sql(dialect, &table, &options.column))
        }
        StructureDialect::H2 => statements.extend(build_h2_existing_column_sql(&table, &options.column)),
        StructureDialect::ClickHouse => {
            statements.extend(build_clickhouse_existing_column_sql(&table, &options.column, ""))
        }
        StructureDialect::SqlServer => statements.extend(build_sqlserver_existing_column_sql(
            &table,
            &options.column,
            options.schema.as_deref(),
            &options.table_name,
        )),
        StructureDialect::Sqlite => {
            statements.extend(build_sqlite_existing_column_sql(&table, &options.column, &mut warnings))
        }
        _ => warnings.push(format!("Editing existing columns is not supported for {database_label} yet.")),
    }

    TableStructureSqlResult { statements, warnings }
}

fn is_column_extra_empty(extra: &ColumnExtra) -> bool {
    !extra.auto_increment.unwrap_or(false)
        && !extra.on_update_current_timestamp.unwrap_or(false)
        && extra.identity.is_none()
}

pub(super) fn has_column_extra_change(column: &EditableStructureColumn) -> bool {
    let Some(original) = &column.original else { return false };
    let current_extra = column.extra.as_ref();
    match (current_extra, original.extra.as_deref()) {
        // Neither has extra → no change
        (None, None | Some("")) => false,
        // Current extra is empty (all None) → no effective extra
        (Some(curr), _) if is_column_extra_empty(curr) => false,
        // Extra added or removed
        (Some(_), None | Some("")) => true,
        (None, Some(_)) => true,
        // Both have extra → check auto_increment and on_update_current_timestamp flags
        (Some(curr), Some(orig)) => {
            let orig_lower = orig.to_lowercase();
            let curr_has_ai = curr.auto_increment.unwrap_or(false);
            let orig_has_ai = orig_lower.contains("auto_increment");
            let curr_has_on_update = curr.on_update_current_timestamp.unwrap_or(false);
            let orig_has_on_update = orig_lower.contains("on update");
            let curr_has_identity = curr.identity.is_some();
            // identity is harder to detect in free-form original.extra, so treat it as changed if present
            curr_has_ai != orig_has_ai || curr_has_on_update != orig_has_on_update || curr_has_identity
        }
    }
}

pub(super) fn build_mysql_existing_column_sql(
    table: &str,
    column: &EditableStructureColumn,
    position_clause: &str,
) -> Vec<String> {
    let original_name = column.original.as_ref().map(|original| original.name.as_str()).unwrap_or(&column.name);
    let operation = if column.name == original_name {
        format!("MODIFY COLUMN {}", column_definition(StructureDialect::Mysql, column))
    } else {
        format!(
            "CHANGE COLUMN {} {}",
            quote_ident(StructureDialect::Mysql, original_name),
            column_definition(StructureDialect::Mysql, column)
        )
    };
    vec![format!("ALTER TABLE {table} {operation}{position_clause};")]
}

pub(super) fn build_postgres_existing_column_sql(table: &str, column: &EditableStructureColumn) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let mut statements = Vec::new();
    let current_name = &column.name;
    if column.name != original.name {
        statements.push(format!(
            "ALTER TABLE {table} RENAME COLUMN {} TO {};",
            quote_ident(StructureDialect::Postgres, &original.name),
            quote_ident(StructureDialect::Postgres, &column.name)
        ));
    }
    if column.data_type.trim() != original.data_type.trim() {
        statements.push(format!(
            "ALTER TABLE {table} ALTER COLUMN {} TYPE {};",
            quote_ident(StructureDialect::Postgres, current_name),
            column_data_type(StructureDialect::Postgres, column)
        ));
    }
    if column.is_nullable != original.is_nullable {
        let action = if column.is_nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
        statements.push(format!(
            "ALTER TABLE {table} ALTER COLUMN {} {action};",
            quote_ident(StructureDialect::Postgres, current_name)
        ));
    }
    if normalize_default(Some(&column.default_value)) != original_default(column) {
        let default_value = normalize_default(Some(&column.default_value));
        let action = if default_value.is_empty() {
            "DROP DEFAULT".to_string()
        } else {
            format!(
                "SET DEFAULT {}",
                format_default_for_sql(StructureDialect::Postgres, &column.data_type, &default_value)
            )
        };
        statements.push(format!(
            "ALTER TABLE {table} ALTER COLUMN {} {action};",
            quote_ident(StructureDialect::Postgres, current_name)
        ));
    }
    if clean(&column.comment) != original_comment(column) {
        let comment_value =
            if clean(&column.comment).is_empty() { "NULL".to_string() } else { quote_string(&clean(&column.comment)) };
        statements.push(format!(
            "COMMENT ON COLUMN {table}.{} IS {comment_value};",
            quote_ident(StructureDialect::Postgres, current_name)
        ));
    }
    statements
}

pub(super) fn build_oracle_like_existing_column_sql(
    dialect: StructureDialect,
    table: &str,
    column: &EditableStructureColumn,
) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let mut statements = Vec::new();
    let mut current_name = original.name.clone();
    if column.name != original.name {
        statements.push(format!(
            "ALTER TABLE {table} RENAME COLUMN {} TO {};",
            quote_ident(dialect, &original.name),
            quote_ident(dialect, &column.name)
        ));
        current_name = column.name.clone();
    }
    let type_changed = column.data_type.trim() != original.data_type.trim();
    let nullable_changed = column.is_nullable != original.is_nullable;
    let default_changed = normalize_default(Some(&column.default_value)) != original_default(column);
    if type_changed || nullable_changed || default_changed {
        let data_type = column_data_type(dialect, column);
        let mut parts = vec![quote_ident(dialect, &current_name), data_type];
        // Always include nullability so the statement is self-contained (required by Dameng).
        if !column.is_nullable {
            parts.push("NOT NULL".to_string());
        } else {
            parts.push("NULL".to_string());
        }
        let default_value = normalize_default(Some(&column.default_value));
        if !default_value.is_empty() {
            parts.push(format!("DEFAULT {}", format_default_for_sql(dialect, &column.data_type, &default_value)));
        } else if default_changed {
            // User cleared the default — explicitly drop it.
            parts.push("DEFAULT NULL".to_string());
        }
        statements.push(format!("ALTER TABLE {table} MODIFY ({});", parts.join(" ")));
    }
    if clean(&column.comment) != original_comment(column) {
        let comment_value =
            if clean(&column.comment).is_empty() { "NULL".to_string() } else { quote_string(&clean(&column.comment)) };
        statements
            .push(format!("COMMENT ON COLUMN {table}.{} IS {comment_value};", quote_ident(dialect, &current_name)));
    }
    statements
}

pub(super) fn build_sqlserver_existing_column_sql(
    table: &str,
    column: &EditableStructureColumn,
    schema: Option<&str>,
    table_name: &str,
) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let dialect = StructureDialect::SqlServer;
    let mut statements = Vec::new();
    let mut current_name = original.name.clone();

    // Rename column via sp_rename
    if column.name != original.name {
        let full_obj_path = format!("{table}.{}", quote_ident(dialect, &original.name));
        statements.push(format!(
            "EXEC sp_rename '{full_obj_path}', '{new_name}', 'COLUMN';",
            full_obj_path = full_obj_path.replace('\'', "''"),
            new_name = column.name.replace('\'', "''")
        ));
        current_name = column.name.clone();
    }

    // Build the ALTER COLUMN clause for type + nullability changes
    if column.data_type.trim() != original.data_type.trim() || column.is_nullable != original.is_nullable {
        let null_clause = if column.is_nullable { "NULL" } else { "NOT NULL" };
        statements.push(format!(
            "ALTER TABLE {table} ALTER COLUMN {} {} {null_clause};",
            quote_ident(dialect, &current_name),
            column_data_type(dialect, column)
        ));
    }

    // Default value changes via ADD/DROP CONSTRAINT
    if normalize_default(Some(&column.default_value)) != original_default(column) {
        let default_value = normalize_default(Some(&column.default_value));
        let has_old_default = !column
            .original
            .as_ref()
            .and_then(|o| o.column_default.as_ref())
            .unwrap_or(&String::new())
            .trim()
            .is_empty()
            && !column
                .original
                .as_ref()
                .and_then(|o| o.column_default.as_ref())
                .map(|d| d.trim().eq_ignore_ascii_case("null"))
                .unwrap_or(false);

        if has_old_default {
            statements.push(format!(
                "DECLARE @sql NVARCHAR(MAX);\
                 SELECT @sql = 'ALTER TABLE {table} DROP CONSTRAINT [' + name + ']'\
                 FROM sys.default_constraints\
                 WHERE parent_object_id = OBJECT_ID('{table}') AND parent_column_id = COLUMNPROPERTY(OBJECT_ID('{table}'), '{col_name}', 'ColumnId');\
                 EXEC sp_executesql @sql;",
                table = table.replace('\'', "''"),
                col_name = current_name.replace('\'', "''")
            ));
        }
        if !default_value.is_empty() {
            let short_table =
                table.split('.').next_back().unwrap_or(table).trim_matches(|c: char| c == '[' || c == ']');
            let constraint_name = format!(
                "DF_{short_table}_{col_name}",
                short_table = short_table,
                col_name = current_name.trim_matches(|c: char| c == '[' || c == ']')
            );
            statements.push(format!(
                "ALTER TABLE {table} ADD CONSTRAINT [{constraint_name}] DEFAULT {} FOR {};",
                format_default_for_sql(StructureDialect::SqlServer, &column.data_type, &default_value),
                quote_ident(dialect, &current_name)
            ));
        }
    }

    // Column comment changes via extended properties
    if clean(&column.comment) != original_comment(column) {
        statements.extend(build_sqlserver_column_comment_sql(
            table,
            schema,
            table_name,
            &current_name,
            &column.comment,
        ));
    }

    statements
}

pub(super) fn build_h2_existing_column_sql(table: &str, column: &EditableStructureColumn) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let mut statements = Vec::new();
    let mut current_name = original.name.clone();
    if column.name != original.name {
        statements.push(format!(
            "ALTER TABLE {table} ALTER COLUMN {} RENAME TO {};",
            quote_ident(StructureDialect::H2, &original.name),
            quote_ident(StructureDialect::H2, &column.name)
        ));
        current_name = column.name.clone();
    }
    if column.data_type.trim() != original.data_type.trim() {
        statements.push(format!(
            "ALTER TABLE {table} ALTER COLUMN {} SET DATA TYPE {};",
            quote_ident(StructureDialect::H2, &current_name),
            column_data_type(StructureDialect::H2, column)
        ));
    }
    if column.is_nullable != original.is_nullable {
        let action = if column.is_nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
        statements.push(format!(
            "ALTER TABLE {table} ALTER COLUMN {} {action};",
            quote_ident(StructureDialect::H2, &current_name)
        ));
    }
    if normalize_default(Some(&column.default_value)) != original_default(column) {
        let default_value = normalize_default(Some(&column.default_value));
        let action = if default_value.is_empty() {
            "DROP DEFAULT".to_string()
        } else {
            format!("SET DEFAULT {}", format_default_for_sql(StructureDialect::H2, &column.data_type, &default_value))
        };
        statements.push(format!(
            "ALTER TABLE {table} ALTER COLUMN {} {action};",
            quote_ident(StructureDialect::H2, &current_name)
        ));
    }
    if clean(&column.comment) != original_comment(column) {
        let comment_value =
            if clean(&column.comment).is_empty() { "NULL".to_string() } else { quote_string(&clean(&column.comment)) };
        statements.push(format!(
            "COMMENT ON COLUMN {table}.{} IS {comment_value};",
            quote_ident(StructureDialect::H2, &current_name)
        ));
    }
    statements
}

pub(super) fn build_clickhouse_existing_column_sql(
    table: &str,
    column: &EditableStructureColumn,
    position_clause: &str,
) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let mut statements = Vec::new();
    let mut current_name = original.name.clone();
    if column.name != original.name {
        statements.push(format!(
            "ALTER TABLE {table} RENAME COLUMN {} TO {};",
            quote_ident(StructureDialect::ClickHouse, &original.name),
            quote_ident(StructureDialect::ClickHouse, &column.name)
        ));
        current_name = column.name.clone();
    }
    let next_type = clickhouse_column_type(column);
    if next_type != original.data_type.trim()
        || normalize_default(Some(&column.default_value)) != original_default(column)
    {
        let default_value = normalize_default(Some(&column.default_value));
        if !default_value.is_empty() {
            let default_sql = format_default_for_sql(StructureDialect::ClickHouse, &column.data_type, &default_value);
            statements.push(format!(
                "ALTER TABLE {table} MODIFY COLUMN {} {next_type} DEFAULT {default_sql}{position_clause};",
                quote_ident(StructureDialect::ClickHouse, &current_name)
            ));
        } else if !original_default(column).is_empty() {
            statements.push(format!(
                "ALTER TABLE {table} MODIFY COLUMN {} REMOVE DEFAULT;",
                quote_ident(StructureDialect::ClickHouse, &current_name)
            ));
            if next_type != original.data_type.trim() || !position_clause.is_empty() {
                statements.push(format!(
                    "ALTER TABLE {table} MODIFY COLUMN {} {next_type}{position_clause};",
                    quote_ident(StructureDialect::ClickHouse, &current_name)
                ));
            }
        } else {
            statements.push(format!(
                "ALTER TABLE {table} MODIFY COLUMN {} {next_type}{position_clause};",
                quote_ident(StructureDialect::ClickHouse, &current_name)
            ));
        }
    } else if !position_clause.is_empty() {
        statements.push(format!(
            "ALTER TABLE {table} MODIFY COLUMN {} {next_type}{position_clause};",
            quote_ident(StructureDialect::ClickHouse, &current_name)
        ));
    }
    if clean(&column.comment) != original_comment(column) {
        statements.push(format!(
            "ALTER TABLE {table} COMMENT COLUMN {} {};",
            quote_ident(StructureDialect::ClickHouse, &current_name),
            quote_string(&clean(&column.comment))
        ));
    }
    statements
}

pub(super) fn build_sqlite_existing_column_sql(
    table: &str,
    column: &EditableStructureColumn,
    warnings: &mut Vec<String>,
) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let mut statements = Vec::new();
    let unsupported_change = column.data_type.trim() != original.data_type.trim()
        || column.is_nullable != original.is_nullable
        || normalize_default(Some(&column.default_value)) != original_default(column)
        || clean(&column.comment) != original_comment(column);
    if column.name != original.name {
        statements.push(format!(
            "ALTER TABLE {table} RENAME COLUMN {} TO {};",
            quote_ident(StructureDialect::Sqlite, &original.name),
            quote_ident(StructureDialect::Sqlite, &column.name)
        ));
    }
    if unsupported_change {
        warnings.push(format!(
            "SQLite cannot safely alter existing column \"{}\" without rebuilding the table.",
            original.name
        ));
    }
    statements
}

pub(super) fn has_existing_column_attribute_change(column: &EditableStructureColumn) -> bool {
    let Some(original) = &column.original else {
        return false;
    };
    column.name != original.name
        || column.data_type.trim() != original.data_type.trim()
        || column.is_nullable != original.is_nullable
        || normalize_default(Some(&column.default_value)) != original_default(column)
        || clean(&column.comment) != original_comment(column)
}
