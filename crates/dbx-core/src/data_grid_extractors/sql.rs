use super::{
    estimated_value_bytes, normalized_name_eq, write_bytes, DataGridExtractError, DataGridExtractErrorCode,
    DataGridExtractWarning, DataGridExtractWarningCode, ExtractContext, WriteMetadata,
    DATA_GRID_EXTRACTOR_MAX_OUTPUT_BYTES,
};
use crate::data_grid_sql::{
    build_column_predicate, build_data_grid_copy_insert_statement, build_data_grid_copy_update_statements,
    format_grid_sql_literal, is_auto_generated_column, is_grid_insert_omitted_column, is_non_identity_generated_column,
    supports_relational_copy_predicates, DataGridCopyInsertStatementOptions, DataGridCopyUpdateStatementOptions,
    DataGridTableMeta,
};
use serde_json::Value;
use std::collections::HashSet;
use std::io::Write;

pub(super) fn write_sql_in_list(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<(), DataGridExtractError> {
    write_bytes(output, b"(")?;
    for (row_index, row) in context.request.rows.iter().enumerate() {
        if row_index > 0 {
            write_bytes(output, b", ")?;
        }
        if context.selected_columns.len() > 1 {
            write_bytes(output, b"(")?;
        }
        for (column_index, source_index) in context.selected_source_indexes.iter().enumerate() {
            if column_index > 0 {
                write_bytes(output, b", ")?;
            }
            let value = &row[*source_index];
            let info = context.selected_column_info[column_index];
            write_bytes(output, format_grid_sql_literal(value, context.request.database_type, info).as_bytes())?;
        }
        if context.selected_columns.len() > 1 {
            write_bytes(output, b")")?;
        }
    }
    write_bytes(output, b")")
}

pub(super) fn write_sql_inserts(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<WriteMetadata, DataGridExtractError> {
    ensure_sql_builder_budget(context)?;
    let data = sql_selected_data(context, false)?;
    let statement = build_data_grid_copy_insert_statement(DataGridCopyInsertStatementOptions {
        database_type: context.request.database_type,
        table_meta: context.request.table_meta.clone(),
        columns: data.columns,
        column_types: Some(data.column_types),
        source_columns: Some(data.source_columns),
        rows: data.rows,
        exclude_primary_keys: context.request.options.sql.exclude_primary_keys_from_insert,
        include_computed_columns: !context.request.options.sql.skip_computed_columns,
        insert_mode: context.request.options.sql.insert_mode,
    })
    .ok_or_else(|| {
        DataGridExtractError::new(
            DataGridExtractErrorCode::NoWritableColumns,
            "No insertable columns remain after applying extractor column rules.",
        )
    })?;
    write_bytes(output, statement.as_bytes())?;
    Ok(sql_metadata(data.omitted_columns))
}

pub(super) fn write_sql_updates(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<WriteMetadata, DataGridExtractError> {
    ensure_sql_builder_budget(context)?;
    let table_meta = context.request.table_meta.as_ref().ok_or_else(|| {
        DataGridExtractError::new(
            DataGridExtractErrorCode::MissingTableMetadata,
            "SQL Updates requires table metadata.",
        )
    })?;
    if table_meta.primary_keys.is_empty() {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::MissingPrimaryKey,
            "SQL Updates requires at least one primary key column.",
        ));
    }
    let mut data = sql_selected_data(context, true)?;
    append_missing_primary_keys(context, table_meta, &mut data.columns, &mut data.source_columns, &mut data.rows)?;

    let primary_key_names = table_meta.primary_keys.iter().map(|name| normalize_name(name)).collect::<HashSet<_>>();
    let writable_count =
        data.source_columns.iter().flatten().filter(|name| !primary_key_names.contains(&normalize_name(name))).count();
    if writable_count == 0 {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::NoWritableColumns,
            "Select at least one writable non-primary-key column for SQL Updates.",
        ));
    }
    let statements = build_data_grid_copy_update_statements(DataGridCopyUpdateStatementOptions {
        database_type: context.request.database_type,
        table_meta: table_meta.clone(),
        columns: data.columns,
        source_columns: Some(data.source_columns),
        rows: data.rows,
    });
    if statements.len() != context.request.rows.len() {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::NullPrimaryKey,
            "One or more selected rows could not produce SQL Updates.",
        ));
    }
    write_bytes(output, statements.join("\n").as_bytes())?;
    Ok(sql_metadata(data.omitted_columns))
}

fn ensure_sql_builder_budget(context: &ExtractContext<'_>) -> Result<(), DataGridExtractError> {
    let value_bytes = context
        .request
        .rows
        .iter()
        .flatten()
        .fold(0usize, |size, value| size.saturating_add(estimated_value_bytes(value)));
    let identifier_bytes = context
        .request
        .table_meta
        .as_ref()
        .map_or(0, |table_meta| {
            table_meta
                .table_name
                .len()
                .saturating_add(table_meta.catalog.as_deref().map_or(0, str::len))
                .saturating_add(table_meta.database.as_deref().map_or(0, str::len))
                .saturating_add(table_meta.schema.as_deref().map_or(0, str::len))
                .saturating_add(table_meta.primary_keys.iter().fold(0usize, |size, key| size.saturating_add(key.len())))
        })
        .saturating_add(context.selected_columns.iter().fold(0usize, |size, column| {
            size.saturating_add(column.display_name.len())
                .saturating_add(column.source_name.as_deref().map_or(0, str::len))
        }));
    let repeats_identifiers_per_row = context.request.extractor == super::DataGridExtractorId::SqlUpdates
        || context.request.options.sql.insert_mode == crate::data_grid_sql::DataGridCopyInsertMode::RowByRow;
    let statement_overhead = identifier_bytes
        .saturating_mul(4)
        .saturating_add(256)
        .saturating_mul(if repeats_identifiers_per_row { context.request.rows.len() } else { 1 });
    let estimated_bytes = value_bytes.saturating_mul(6).saturating_add(statement_overhead);
    if estimated_bytes > DATA_GRID_EXTRACTOR_MAX_OUTPUT_BYTES {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::OutputTooLarge,
            "Estimated SQL clipboard output exceeds 32 MiB; export the data to a file instead.",
        ));
    }
    Ok(())
}

fn append_missing_primary_keys(
    context: &ExtractContext<'_>,
    table_meta: &DataGridTableMeta,
    columns: &mut Vec<String>,
    source_columns: &mut Vec<Option<String>>,
    rows: &mut [Vec<Value>],
) -> Result<(), DataGridExtractError> {
    for primary_key in &table_meta.primary_keys {
        if source_columns.iter().flatten().any(|column| normalized_name_eq(column, primary_key)) {
            continue;
        }
        let column = context
            .request
            .columns
            .iter()
            .find(|column| {
                normalized_name_eq(column.source_name.as_deref().unwrap_or(&column.display_name), primary_key)
            })
            .ok_or_else(|| {
                DataGridExtractError::new(
                    DataGridExtractErrorCode::MissingPrimaryKey,
                    format!("Primary key column '{primary_key}' is not present in the result set."),
                )
            })?;
        if context.request.rows.iter().any(|row| match row.get(column.source_index) {
            Some(value) => value.is_null(),
            None => true,
        }) {
            return Err(DataGridExtractError::new(
                DataGridExtractErrorCode::NullPrimaryKey,
                format!("Primary key column '{primary_key}' contains a NULL value."),
            ));
        }
        columns.push(column.display_name.clone());
        source_columns.push(Some(primary_key.clone()));
        for (row_index, row) in context.request.rows.iter().enumerate() {
            let value = row.get(column.source_index).ok_or_else(|| {
                DataGridExtractError::new(
                    DataGridExtractErrorCode::InvalidColumnMapping,
                    format!("Primary key column '{primary_key}' maps outside row {row_index}."),
                )
            })?;
            rows[row_index].push(value.clone());
        }
    }
    Ok(())
}

struct SqlSelectedData {
    columns: Vec<String>,
    source_columns: Vec<Option<String>>,
    column_types: Vec<Option<String>>,
    rows: Vec<Vec<Value>>,
    omitted_columns: Vec<String>,
}

fn sql_selected_data(context: &ExtractContext<'_>, for_update: bool) -> Result<SqlSelectedData, DataGridExtractError> {
    let mut included = Vec::new();
    let mut omitted = Vec::new();
    let mut included_indexes = Vec::new();
    for (index, column) in context.selected_columns.iter().enumerate() {
        let source_name = column.source_name.as_deref().unwrap_or(&column.display_name);
        let info = context.selected_column_info[index];
        let is_primary_key = context.request.table_meta.as_ref().is_some_and(|meta| {
            meta.primary_keys.iter().any(|primary_key| normalized_name_eq(primary_key, source_name))
        });
        let omit = (!for_update
            && is_grid_insert_omitted_column(
                context.request.database_type,
                info,
                Some(source_name),
                !context.request.options.sql.skip_computed_columns,
            ))
            || (for_update
                && context.request.options.sql.skip_computed_columns
                && info.is_some_and(|column| is_non_identity_generated_column(Some(column))))
            || (context.request.options.sql.skip_generated_columns && info.is_some_and(is_auto_generated_column))
            || (for_update && is_primary_key)
            || (!for_update && context.request.options.sql.exclude_primary_keys_from_insert && is_primary_key);
        if omit {
            omitted.push(source_name.to_string());
        } else {
            included.push(*column);
            included_indexes.push(index);
        }
    }
    if included.is_empty() {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::NoWritableColumns,
            "No writable columns remain after applying extractor column rules.",
        ));
    }
    let columns = included.iter().map(|column| column.display_name.clone()).collect();
    let source_columns = included
        .iter()
        .map(|column| Some(column.source_name.clone().unwrap_or_else(|| column.display_name.clone())))
        .collect();
    let column_types = included_indexes
        .iter()
        .map(|index| context.selected_column_info[*index].map(|info| info.data_type.clone()))
        .collect();
    let rows = context
        .request
        .rows
        .iter()
        .map(|row| included.iter().map(|column| row[column.source_index].clone()).collect())
        .collect();
    Ok(SqlSelectedData { columns, source_columns, column_types, rows, omitted_columns: omitted })
}

pub(super) fn write_where_clause(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<(), DataGridExtractError> {
    // WHERE-clause extraction emits relational SQL predicates and is not meaningful
    // for graph/document/time-series stores. Unlike `write_sql_updates`, this
    // intentionally does NOT auto-append primary keys: the predicate reflects the
    // exact cells the user selected.
    if !supports_relational_copy_predicates(context.request.database_type) {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::UnsupportedDatabase,
            "WHERE-clause extraction is not supported for this database type.",
        ));
    }
    for (row_index, row) in context.request.rows.iter().enumerate() {
        if row_index > 0 {
            write_bytes(output, b" OR ")?;
        }
        if context.request.rows.len() > 1 {
            write_bytes(output, b"(")?;
        }
        for (column_index, source_index) in context.selected_source_indexes.iter().enumerate() {
            if column_index > 0 {
                write_bytes(output, b" AND ")?;
            }
            let column = context.selected_columns[column_index];
            let value = &row[*source_index];
            let source_name = column.source_name.as_deref().unwrap_or(&column.display_name);
            // Reuse the UPDATE predicate builder so NULL -> IS NULL, MySQL BINARY,
            // and MySQL JSON CAST(...) stay consistent with copy-as-UPDATE.
            let predicate = build_column_predicate(
                context.request.database_type,
                source_name,
                value,
                context.selected_column_info[column_index],
                true,
                None,
            );
            write_bytes(output, predicate.as_bytes())?;
        }
        if context.request.rows.len() > 1 {
            write_bytes(output, b")")?;
        }
    }
    Ok(())
}

fn sql_metadata(omitted_columns: Vec<String>) -> WriteMetadata {
    let warnings = if omitted_columns.is_empty() {
        Vec::new()
    } else {
        vec![DataGridExtractWarning {
            code: DataGridExtractWarningCode::OmittedColumns,
            message: format!("Omitted columns: {}", omitted_columns.join(", ")),
        }]
    };
    WriteMetadata { mime_type: "application/sql", file_extension: "sql", omitted_columns, warnings }
}

fn normalize_name(name: &str) -> String {
    name.trim_matches(|character| matches!(character, '`' | '"' | '[' | ']')).to_ascii_uppercase()
}
