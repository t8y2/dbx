use super::comments::build_sqlserver_index_comment_sql;
use super::dialect::{capabilities_for, database_label, database_type_for_dialect, dialect_label, StructureDialect};
use super::types::{EditableStructureIndex, TableStructureSqlOptions};
use super::util::{clean, qualified_table, quote_ident, quote_string};
use crate::models::connection::DatabaseType;

pub(super) fn build_index_sql(options: &TableStructureSqlOptions, warnings: &mut Vec<String>) -> Vec<String> {
    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let database_label = database_label(options.database_type);
    let mut statements = Vec::new();

    for index in &options.indexes {
        if index.marked_for_drop {
            let Some(original) = &index.original else {
                continue;
            };
            if !capabilities.drop_index {
                warnings.push(format!("Dropping indexes is not supported for {database_label} from this editor."));
                continue;
            }
            if original.is_primary {
                warnings.push(format!("Primary index \"{}\" cannot be dropped from this editor.", original.name));
                continue;
            }
            statements.push(build_drop_index_sql(
                options.database_type,
                dialect,
                &table,
                options.schema.as_deref(),
                &original.name,
            ));
            continue;
        }

        if let Some(original) = &index.original {
            if !has_existing_index_change(index) {
                continue;
            }
            if !capabilities.rebuild_index || !capabilities.drop_index || !capabilities.create_index {
                warnings
                    .push(format!("Editing existing indexes is not supported for {database_label} from this editor."));
                continue;
            }
            if original.is_primary {
                warnings.push(format!("Primary index \"{}\" cannot be edited from this editor.", original.name));
                continue;
            }
            statements.push(build_drop_index_sql(
                options.database_type,
                dialect,
                &table,
                options.schema.as_deref(),
                &original.name,
            ));
            statements.extend(build_create_index_statements(
                dialect,
                &table,
                index,
                warnings,
                options.schema.as_deref(),
                &options.table_name,
            ));
            continue;
        }

        if !capabilities.create_index {
            warnings.push(format!("Creating indexes is not supported for {database_label} from this editor."));
            continue;
        }
        statements.extend(build_create_index_statements(
            dialect,
            &table,
            index,
            warnings,
            options.schema.as_deref(),
            &options.table_name,
        ));
    }

    statements
}

pub(super) fn has_existing_index_change(index: &EditableStructureIndex) -> bool {
    let Some(original) = &index.original else {
        return false;
    };
    clean(&index.name) != clean(&original.name)
        || index_list_changed(&index.columns, Some(&original.columns))
        || index.is_unique != original.is_unique
        || normalized_index_type(index) != clean(original.index_type.as_deref().unwrap_or("")).to_ascii_uppercase()
        || index_list_changed(&index.included_columns, original.included_columns.as_ref())
        || clean(&index.filter) != clean(original.filter.as_deref().unwrap_or(""))
        || clean(&index.comment) != clean(original.comment.as_deref().unwrap_or(""))
}

pub(super) fn index_list_changed(next: &[String], previous: Option<&Vec<String>>) -> bool {
    let next_clean: Vec<_> = next.iter().map(|value| clean(value)).filter(|value| !value.is_empty()).collect();
    let previous_clean: Vec<_> =
        previous.unwrap_or(&Vec::new()).iter().map(|value| clean(value)).filter(|value| !value.is_empty()).collect();
    next_clean.len() != previous_clean.len()
        || next_clean.iter().enumerate().any(|(index, value)| previous_clean.get(index) != Some(value))
}

pub(super) fn normalized_index_type(index: &EditableStructureIndex) -> String {
    clean(&index.index_type).to_ascii_uppercase()
}

pub(super) fn mysql_index_parts(index_type: &str) -> (String, String) {
    match index_type.to_ascii_uppercase().as_str() {
        "FULLTEXT" | "SPATIAL" => (format!("{} ", index_type.to_ascii_uppercase()), String::new()),
        "RTREE" => ("SPATIAL ".to_string(), String::new()),
        "BTREE" | "HASH" => (String::new(), format!(" USING {}", index_type.to_ascii_uppercase())),
        _ => (String::new(), String::new()),
    }
}

pub(super) fn build_drop_index_sql(
    database_type: Option<DatabaseType>,
    dialect: StructureDialect,
    table: &str,
    schema: Option<&str>,
    index_name: &str,
) -> String {
    if database_type == Some(DatabaseType::Iris) {
        return format!("DROP INDEX {} ON TABLE {table};", quote_ident(dialect, index_name));
    }
    if matches!(dialect, StructureDialect::Mysql | StructureDialect::SqlServer) {
        return format!("DROP INDEX {} ON {table};", quote_ident(dialect, index_name));
    }
    if matches!(dialect, StructureDialect::Postgres | StructureDialect::Oracle | StructureDialect::Informix)
        && schema.is_some_and(|schema| !schema.trim().is_empty())
    {
        return format!("DROP INDEX {}.{};", quote_ident(dialect, schema.unwrap()), quote_ident(dialect, index_name));
    }
    format!("DROP INDEX {};", quote_ident(dialect, index_name))
}

pub(super) fn build_create_index_statements(
    dialect: StructureDialect,
    table: &str,
    index: &EditableStructureIndex,
    warnings: &mut Vec<String>,
    schema: Option<&str>,
    table_name: &str,
) -> Vec<String> {
    let capabilities = capabilities_for(database_type_for_dialect(dialect));
    let name = clean(&index.name);
    let columns: Vec<String> =
        index.columns.iter().map(|column| clean(column)).filter(|column| !column.is_empty()).collect();
    if name.is_empty() || columns.is_empty() {
        return Vec::new();
    }

    let unique = if index.is_unique { "UNIQUE " } else { "" };
    let cols = columns.iter().map(|column| quote_ident(dialect, column)).collect::<Vec<_>>().join(", ");
    let idx_type = normalized_index_type(index);
    let mut type_prefix = String::new();
    let mut using_clause = String::new();

    if !idx_type.is_empty() && capabilities.index_type {
        match dialect {
            StructureDialect::Postgres => using_clause = format!(" USING {idx_type}"),
            StructureDialect::SqlServer => type_prefix = format!("{idx_type} "),
            StructureDialect::Mysql => {
                let (prefix, using) = mysql_index_parts(&idx_type);
                type_prefix = prefix;
                using_clause = using;
            }
            StructureDialect::Oracle if idx_type == "BITMAP" => type_prefix = "BITMAP ".to_string(),
            _ => {}
        }
    }

    let included_columns: Vec<String> =
        index.included_columns.iter().map(|column| clean(column)).filter(|column| !column.is_empty()).collect();
    let include_clause = if !included_columns.is_empty()
        && capabilities.index_include
        && matches!(dialect, StructureDialect::Postgres | StructureDialect::SqlServer)
    {
        format!(
            " INCLUDE ({})",
            included_columns.iter().map(|column| quote_ident(dialect, column)).collect::<Vec<_>>().join(", ")
        )
    } else {
        String::new()
    };
    let comment = clean(&index.comment);
    let comment_clause = if !comment.is_empty() && capabilities.index_comment && dialect == StructureDialect::Mysql {
        format!(" COMMENT {}", quote_string(&comment))
    } else {
        String::new()
    };
    let filter = clean(&index.filter);
    let supports_where = capabilities.index_filter
        && matches!(dialect, StructureDialect::Postgres | StructureDialect::SqlServer | StructureDialect::Sqlite);
    let where_clause = if !filter.is_empty() && supports_where { format!(" WHERE {filter}") } else { String::new() };
    let create_sql = if dialect == StructureDialect::Postgres {
        format!(
            "CREATE {unique}{type_prefix}INDEX {} ON {table}{using_clause} ({cols}){include_clause}{where_clause};",
            quote_ident(dialect, &name)
        )
    } else {
        format!(
            "CREATE {unique}{type_prefix}INDEX {}{using_clause} ON {table} ({cols}){include_clause}{where_clause}{comment_clause};",
            quote_ident(dialect, &name)
        )
    };
    let mut statements = vec![create_sql];

    if !comment.is_empty() && capabilities.index_comment && dialect == StructureDialect::Postgres {
        statements.push(format!("COMMENT ON INDEX {} IS {};", quote_ident(dialect, &name), quote_string(&comment)));
    } else if !comment.is_empty() && capabilities.index_comment && dialect == StructureDialect::SqlServer {
        statements.extend(build_sqlserver_index_comment_sql(table, schema, table_name, &name, &comment));
    } else if !comment.is_empty() && capabilities.index_comment && dialect == StructureDialect::Mysql {
        // MySQL comment is embedded inline in the CREATE INDEX statement above
    } else if !comment.is_empty() && capabilities.index_comment {
        warnings.push(format!("Index comments are not supported for {} from this editor.", dialect_label(dialect)));
    }
    statements
}
