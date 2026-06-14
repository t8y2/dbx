use super::column_format::{column_data_type, column_extra_clause};
use super::comments::{build_sqlserver_column_comment_sql, build_sqlserver_table_comment_sql};
use super::dialect::{capabilities_for, database_label, StructureDialect};
use super::foreign_keys::build_foreign_key_sql;
use super::indexes::build_create_index_statements;
use super::triggers::build_trigger_sql;
use super::types::{TableStructureSqlOptions, TableStructureSqlResult};
use super::util::{clean, format_default_for_sql, normalize_default, qualified_table, quote_ident, quote_string};
use super::validation::validate_columns;

pub fn build_create_table_sql(options: TableStructureSqlOptions) -> TableStructureSqlResult {
    let mut warnings = Vec::new();
    if clean(&options.table_name).is_empty() {
        warnings.push("Table name is required.".to_string());
    }
    let active_columns: Vec<_> = options.columns.iter().filter(|column| !column.marked_for_drop).collect();
    if active_columns.is_empty() {
        warnings.push("At least one column is required.".to_string());
    }
    validate_columns(&active_columns, &mut warnings);
    if !warnings.is_empty() {
        return TableStructureSqlResult { statements: Vec::new(), warnings };
    }

    let capabilities = capabilities_for(options.database_type);
    let dialect = capabilities.dialect;
    let table = qualified_table(dialect, options.schema.as_deref(), &options.table_name);
    let mut statements = Vec::new();
    let mut column_definitions = Vec::new();

    for column in &active_columns {
        let data_type = column_data_type(dialect, column);
        let mut parts = vec![quote_ident(dialect, &column.name), data_type];
        if !column.is_nullable
            && !column.is_primary_key
            && !matches!(dialect, StructureDialect::ClickHouse | StructureDialect::ManticoreSearch)
        {
            parts.push("NOT NULL".to_string());
        }
        if let Some(extra_clause) = column_extra_clause(dialect, column) {
            parts.push(extra_clause);
        }
        let default_value = normalize_default(Some(&column.default_value));
        if !default_value.is_empty() && dialect != StructureDialect::ManticoreSearch {
            parts.push(format!("DEFAULT {}", format_default_for_sql(dialect, &column.data_type, &default_value)));
        }
        if let Some(on_update) = column.extra.as_ref().and_then(|e| e.on_update_current_timestamp).filter(|v| *v) {
            if on_update && dialect == StructureDialect::Mysql {
                parts.push("ON UPDATE CURRENT_TIMESTAMP".to_string());
            }
        }
        if dialect == StructureDialect::Mysql && capabilities.comment && !clean(&column.comment).is_empty() {
            parts.push(format!("COMMENT {}", quote_string(&clean(&column.comment))));
        }
        column_definitions.push(parts.join(" "));
    }

    let pk_columns: Vec<_> = active_columns
        .iter()
        .filter(|column| column.is_primary_key && dialect != StructureDialect::ManticoreSearch)
        .collect();
    if !pk_columns.is_empty() {
        let pk_list = pk_columns.iter().map(|column| quote_ident(dialect, &column.name)).collect::<Vec<_>>().join(", ");
        column_definitions.push(format!("PRIMARY KEY ({pk_list})"));
    }

    statements.push(format!("CREATE TABLE {table} (\n  {}\n);", column_definitions.join(",\n  ")));

    if capabilities.comment {
        let table_comment = clean(options.table_comment.as_deref().unwrap_or(""));
        if !table_comment.is_empty() {
            if dialect == StructureDialect::Mysql {
                if let Some(last) = statements.last_mut() {
                    *last = last.replace(");", &format!(") COMMENT = {};", quote_string(&table_comment)));
                }
            } else if matches!(dialect, StructureDialect::Postgres | StructureDialect::Oracle | StructureDialect::H2) {
                statements.push(format!("COMMENT ON TABLE {table} IS {};", quote_string(&table_comment)));
            } else if dialect == StructureDialect::ClickHouse {
                statements.push(format!("ALTER TABLE {table} MODIFY COMMENT {};", quote_string(&table_comment)));
            } else if dialect == StructureDialect::SqlServer {
                statements.extend(build_sqlserver_table_comment_sql(
                    &table,
                    options.schema.as_deref(),
                    &options.table_name,
                    &table_comment,
                ));
            }
        }
    }

    if capabilities.comment
        && matches!(dialect, StructureDialect::Postgres | StructureDialect::Oracle | StructureDialect::H2)
    {
        for column in &active_columns {
            if !clean(&column.comment).is_empty() {
                statements.push(format!(
                    "COMMENT ON COLUMN {table}.{} IS {};",
                    quote_ident(dialect, &column.name),
                    quote_string(&clean(&column.comment))
                ));
            }
        }
    }
    if capabilities.comment && dialect == StructureDialect::ClickHouse {
        for column in &active_columns {
            if !clean(&column.comment).is_empty() {
                statements.push(format!(
                    "ALTER TABLE {table} COMMENT COLUMN {} {};",
                    quote_ident(dialect, &column.name),
                    quote_string(&clean(&column.comment))
                ));
            }
        }
    }
    if capabilities.comment && dialect == StructureDialect::SqlServer {
        for column in &active_columns {
            if !clean(&column.comment).is_empty() {
                statements.extend(build_sqlserver_column_comment_sql(
                    &table,
                    options.schema.as_deref(),
                    &options.table_name,
                    &column.name,
                    &column.comment,
                ));
            }
        }
    }

    for index in options.indexes.iter().filter(|index| !index.marked_for_drop && !index.is_primary) {
        if !capabilities.create_index {
            warnings.push(format!(
                "Creating indexes is not supported for {} from this editor.",
                database_label(options.database_type)
            ));
            continue;
        }
        statements.extend(build_create_index_statements(
            dialect,
            &table,
            index,
            &mut warnings,
            options.schema.as_deref(),
            &options.table_name,
        ));
    }

    statements.extend(build_foreign_key_sql(&options, &mut warnings));
    statements.extend(build_trigger_sql(&options, &mut warnings));

    TableStructureSqlResult { statements, warnings }
}
