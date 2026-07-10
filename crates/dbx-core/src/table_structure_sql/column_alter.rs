use super::column_format::{clickhouse_column_type, column_data_type, column_definition, is_mysql_character_data_type};
use super::columns::build_drop_column_sql;
use super::comments::build_sqlserver_column_comment_sql;
use super::dialect::{capabilities_for, database_label, StructureDialect};
use super::types::{EditableStructureColumn, SingleColumnAlterSqlOptions, TableStructureSqlResult};
use super::util::{
    clean, format_default_for_sql, is_protected_manticore_id_column, normalize_default, original_comment,
    original_default, qualified_table, quote_ident, quote_string,
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
        if is_protected_manticore_id_column(dialect, &original.name) {
            warnings.push("Manticore Search id column cannot be dropped from this editor.".to_string());
            return TableStructureSqlResult { statements, warnings };
        }
        statements.push(build_drop_column_sql(dialect, &table, &original.name));
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
        || clean(&options.column.comment) != original_comment(&options.column)
        || (is_mysql_character_data_type(&options.column.data_type)
            && (options.column.character_set.trim() != original.character_set.as_deref().unwrap_or("")
                || options.column.collation.trim() != original.collation.as_deref().unwrap_or("")));

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
        StructureDialect::Doris => statements.extend(build_doris_existing_column_sql(&table, &options.column, "")),
        StructureDialect::Postgres => statements.extend(build_postgres_existing_column_sql(&table, &options.column)),
        StructureDialect::Oracle | StructureDialect::Dameng => {
            statements.extend(build_oracle_like_existing_column_sql(dialect, &table, &options.column))
        }
        StructureDialect::H2 => statements.extend(build_h2_existing_column_sql(&table, &options.column)),
        StructureDialect::ClickHouse => {
            statements.extend(build_clickhouse_existing_column_sql(&table, &options.column, ""))
        }
        StructureDialect::Informix => statements.extend(build_informix_existing_column_sql(&table, &options.column)),
        StructureDialect::SqlServer => statements.extend(build_sqlserver_existing_column_sql(
            &table,
            &options.column,
            options.schema.as_deref(),
            &options.table_name,
            &mut warnings,
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
        && !extra.manticore_indexed.unwrap_or(false)
        && !extra.manticore_stored.unwrap_or(false)
        && !extra.manticore_attribute.unwrap_or(false)
        && !extra.manticore_secondary_index.unwrap_or(false)
}

fn original_manticore_extra_flags(extra: &str) -> (bool, bool, bool, bool) {
    let lower = extra.to_lowercase();
    (
        lower.split_whitespace().any(|token| token == "indexed"),
        lower.split_whitespace().any(|token| token == "stored"),
        lower.split_whitespace().any(|token| token == "attribute"),
        lower.contains("secondary_index='1'")
            || lower.contains("secondary_index=\"1\"")
            || lower.contains("secondary_index=1"),
    )
}

fn original_has_auto_increment(extra: &str) -> bool {
    let lower = extra.to_lowercase();
    lower.contains("auto_increment") || lower.contains("autoincrement")
}

fn original_has_identity(extra: &str) -> bool {
    extra.to_lowercase().contains("identity")
}

fn sqlserver_identity_values(extra: &str) -> Option<(Option<i64>, Option<i64>)> {
    let lower = extra.to_lowercase();
    let identity_index = lower.find("identity")?;
    let after_identity = extra.get(identity_index + "identity".len()..)?.trim_start();
    if !after_identity.starts_with('(') {
        return Some((None, None));
    }
    let close_index = after_identity.find(')')?;
    let args = &after_identity[1..close_index];
    let mut parts = args.split(',').map(|part| part.trim().parse::<i64>().ok());
    Some((parts.next().flatten(), parts.next().flatten()))
}

fn sqlserver_identity_matches_original(identity: &super::types::ColumnIdentity, original_extra: &str) -> bool {
    let Some((original_seed, original_increment)) = sqlserver_identity_values(original_extra) else {
        return false;
    };
    identity.seed.unwrap_or(1) == original_seed.unwrap_or(1)
        && identity.increment.unwrap_or(1) == original_increment.unwrap_or(1)
}

fn parse_i64_after_phrase(value: &str, lower: &str, phrase: &str) -> Option<i64> {
    let start = lower.find(phrase)? + phrase.len();
    let rest = value.get(start..)?.trim_start();
    let token = rest.split(|ch: char| ch.is_whitespace() || ch == ')' || ch == ',').find(|part| !part.is_empty())?;
    token.parse::<i64>().ok()
}

fn postgres_identity_values(extra: &str) -> Option<(String, Option<i64>, Option<i64>)> {
    let lower = extra.to_lowercase();
    let generation = if lower.contains("generated always as identity") {
        "ALWAYS".to_string()
    } else if lower.contains("generated by default as identity") {
        "BY DEFAULT".to_string()
    } else {
        return None;
    };
    let seed = parse_i64_after_phrase(extra, &lower, "start with");
    let increment = parse_i64_after_phrase(extra, &lower, "increment by");
    Some((generation, seed, increment))
}

fn identity_matches_original(identity: &super::types::ColumnIdentity, original_extra: &str) -> bool {
    if let Some((generation, original_seed, original_increment)) = postgres_identity_values(original_extra) {
        return identity.generation.as_deref().unwrap_or("BY DEFAULT").eq_ignore_ascii_case(&generation)
            && identity.seed.unwrap_or(1) == original_seed.unwrap_or(1)
            && identity.increment.unwrap_or(1) == original_increment.unwrap_or(1);
    }
    sqlserver_identity_matches_original(identity, original_extra)
}

pub(super) fn has_column_extra_change(column: &EditableStructureColumn) -> bool {
    let Some(original) = &column.original else { return false };
    let current_extra = column.extra.as_ref();
    match (current_extra, original.extra.as_deref()) {
        // Neither has extra → no change
        (None, None | Some("")) => false,
        // Current extra is empty (all None) → changed only if the original had effective extra
        (Some(curr), None | Some("")) if is_column_extra_empty(curr) => false,
        (Some(curr), Some(orig)) if is_column_extra_empty(curr) => {
            let (indexed, stored, attribute, secondary_index) = original_manticore_extra_flags(orig);
            let orig_lower = orig.to_lowercase();
            original_has_auto_increment(orig)
                || orig_lower.contains("on update")
                || original_has_identity(orig)
                || indexed
                || stored
                || attribute
                || secondary_index
        }
        // Extra added or removed
        (Some(_), None | Some("")) => true,
        (None, Some(_)) => true,
        // Both have extra → check auto_increment and on_update_current_timestamp flags
        (Some(curr), Some(orig)) => {
            let orig_lower = orig.to_lowercase();
            let curr_has_ai = curr.auto_increment.unwrap_or(false);
            let orig_has_identity = original_has_identity(orig);
            let orig_has_ai = original_has_auto_increment(orig) || (orig_has_identity && curr_has_ai);
            let curr_has_on_update = curr.on_update_current_timestamp.unwrap_or(false);
            let orig_has_on_update = orig_lower.contains("on update");
            let identity_changed = match (&curr.identity, orig_has_identity) {
                (Some(identity), true) => !identity_matches_original(identity, orig),
                (Some(_), false) => true,
                (None, true) => !curr_has_ai,
                (None, false) => false,
            };
            let curr_manticore = (
                curr.manticore_indexed.unwrap_or(false),
                curr.manticore_stored.unwrap_or(false),
                curr.manticore_attribute.unwrap_or(false),
                curr.manticore_secondary_index.unwrap_or(false),
            );
            let orig_manticore = original_manticore_extra_flags(orig);
            curr_has_ai != orig_has_ai
                || curr_has_on_update != orig_has_on_update
                || identity_changed
                || curr_manticore != orig_manticore
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

pub(super) fn build_doris_existing_column_sql(
    table: &str,
    column: &EditableStructureColumn,
    position_clause: &str,
) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let mut statements = Vec::new();
    let mut current_column = column.clone();

    if column.name != original.name {
        // Doris follows its own lightweight schema-change grammar: no MySQL CHANGE and no TO keyword.
        statements.push(format!(
            "ALTER TABLE {table} RENAME COLUMN {} {};",
            quote_ident(StructureDialect::Doris, &original.name),
            quote_ident(StructureDialect::Doris, &column.name)
        ));
        current_column.name = column.name.clone();
    }

    let type_changed = column.data_type.trim() != original.data_type.trim();
    let nullable_changed = column.is_nullable != original.is_nullable;
    let default_changed = normalize_default(Some(&column.default_value)) != original_default(column);
    let comment_changed = clean(&column.comment) != original_comment(column);
    if type_changed || nullable_changed || default_changed || comment_changed || !position_clause.is_empty() {
        statements.push(format!(
            "ALTER TABLE {table} MODIFY COLUMN {}{position_clause};",
            column_definition(StructureDialect::Doris, &current_column)
        ));
    }

    statements
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

pub(super) fn build_informix_existing_column_sql(table: &str, column: &EditableStructureColumn) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let dialect = StructureDialect::Informix;
    let mut statements = Vec::new();
    let mut current_name = original.name.clone();
    if column.name != original.name {
        statements.push(format!(
            "RENAME COLUMN {table}.{} TO {};",
            quote_ident(dialect, &original.name),
            quote_ident(dialect, &column.name)
        ));
        current_name = column.name.clone();
    }
    let type_changed = column.data_type.trim() != original.data_type.trim();
    let nullable_changed = column.is_nullable != original.is_nullable;
    let default_changed = normalize_default(Some(&column.default_value)) != original_default(column);
    if type_changed || nullable_changed || default_changed {
        let mut parts = vec![quote_ident(dialect, &current_name), column_data_type(dialect, column)];
        if column.is_nullable {
            parts.push("NULL".to_string());
        } else {
            parts.push("NOT NULL".to_string());
        }
        let default_value = normalize_default(Some(&column.default_value));
        if !default_value.is_empty() {
            parts.push(format!("DEFAULT {}", format_default_for_sql(dialect, &column.data_type, &default_value)));
        } else if default_changed {
            parts.push("DEFAULT NULL".to_string());
        }
        statements.push(format!("ALTER TABLE {table} MODIFY ({});", parts.join(" ")));
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
        let default_value = normalize_default(Some(&column.default_value));
        if !default_value.is_empty() {
            parts.push(format!("DEFAULT {}", format_default_for_sql(dialect, &column.data_type, &default_value)));
        } else if default_changed {
            // User cleared the default — explicitly drop it.
            parts.push("DEFAULT NULL".to_string());
        }
        if nullable_changed {
            if column.is_nullable {
                parts.push("NULL".to_string());
            } else {
                parts.push("NOT NULL".to_string());
            }
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
    warnings: &mut Vec<String>,
) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let dialect = StructureDialect::SqlServer;
    let mut statements = Vec::new();
    let mut current_name = original.name.clone();

    if has_sqlserver_identity_change(column) {
        warnings.push(format!(
            "Changing SQL Server IDENTITY for existing column \"{}\" is not supported from this editor.",
            original.name
        ));
    }

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
            let sql_var = sqlserver_default_constraint_sql_var(table, &current_name);
            statements.push(format!(
                "DECLARE {sql_var} NVARCHAR(MAX); \
                 SELECT TOP (1) {sql_var} = N'ALTER TABLE {table} DROP CONSTRAINT ' + QUOTENAME(dc.name) \
                 FROM sys.default_constraints AS dc \
                 WHERE dc.parent_object_id = OBJECT_ID(N'{table}') AND dc.parent_column_id = COLUMNPROPERTY(OBJECT_ID(N'{table}'), N'{col_name}', 'ColumnId'); \
                 IF {sql_var} IS NOT NULL EXEC sp_executesql {sql_var};",
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

fn sqlserver_default_constraint_sql_var(table: &str, column_name: &str) -> String {
    let mut hash = 0x811c_9dc5u32;
    for byte in table.bytes().chain([0]).chain(column_name.bytes()) {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("@dbx_default_sql_{hash:08x}")
}

fn has_sqlserver_identity_change(column: &EditableStructureColumn) -> bool {
    let Some(original) = &column.original else {
        return false;
    };
    let original_extra = original.extra.as_deref().unwrap_or("");
    let original_identity = original_has_identity(original_extra);
    let current_extra = column.extra.as_ref();
    let current_identity =
        current_extra.is_some_and(|extra| extra.auto_increment.unwrap_or(false) || extra.identity.is_some());

    if current_identity != original_identity {
        return true;
    }
    if !current_identity {
        return false;
    }

    current_extra
        .and_then(|extra| extra.identity.as_ref())
        .is_some_and(|identity| !sqlserver_identity_matches_original(identity, original_extra))
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

pub(super) fn build_questdb_existing_column_sql(table: &str, column: &EditableStructureColumn) -> Vec<String> {
    let Some(original) = &column.original else {
        return Vec::new();
    };
    let mut statements = Vec::new();
    let current_name = &column.name;
    if column.name != original.name {
        statements.push(format!(
            "ALTER TABLE {table} RENAME COLUMN {} TO {};",
            quote_ident(StructureDialect::Questdb, &original.name),
            quote_ident(StructureDialect::Questdb, &column.name)
        ));
    }
    if column.data_type.trim() != original.data_type.trim() {
        statements.push(format!(
            "ALTER TABLE {table} ALTER COLUMN {} TYPE {};",
            quote_ident(StructureDialect::Questdb, current_name),
            column_data_type(StructureDialect::Questdb, column)
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
        || (is_mysql_character_data_type(&column.data_type)
            && (column.character_set.trim() != original.character_set.as_deref().unwrap_or("")
                || column.collation.trim() != original.collation.as_deref().unwrap_or("")))
}
