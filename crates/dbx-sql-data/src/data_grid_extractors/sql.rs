use super::{
    estimated_value_bytes, normalized_name_eq, write_bytes, DataGridExtractError, DataGridExtractErrorCode,
    DataGridExtractWarning, DataGridExtractWarningCode, DataGridTemporalFormat, ExtractContext, WriteMetadata,
    DATA_GRID_EXTRACTOR_MAX_OUTPUT_BYTES,
};
use crate::data_grid_sql::{
    build_column_predicate, build_data_grid_copy_insert_statement_with_formatters,
    build_data_grid_copy_update_statements, data_grid_generated_table_name, format_grid_copy_insert_sql_literal,
    format_grid_sql_literal_with_identifier_quote, is_auto_generated_column, is_grid_insert_omitted_column,
    is_non_identity_generated_column, supports_relational_copy_predicates, DataGridColumnInfo,
    DataGridCopyInsertStatementOptions, DataGridCopyUpdateStatementOptions, DataGridTableMeta,
};
use crate::models::connection::DatabaseType;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime};
use dbx_types::types::is_opaque_aggregate_state_type;
use serde_json::Value;
use std::collections::{hash_map::Entry, HashMap, HashSet};
use std::io::Write;

#[path = "sql_identifiers.rs"]
mod identifiers;

pub(super) fn write_sql_in_list(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<(), DataGridExtractError> {
    write_bytes(output, b"(")?;
    let mut seen_rows = HashMap::<Vec<u8>, ()>::new();
    let mut has_output = false;
    for row in &context.request.rows {
        let mut tuple = Vec::new();
        if context.selected_columns.len() > 1 {
            tuple.push(b'(');
        }
        for (column_index, source_index) in context.selected_source_indexes.iter().enumerate() {
            if column_index > 0 {
                tuple.extend_from_slice(b", ");
            }
            let value = &row[*source_index];
            let info = context.selected_column_info[column_index];
            tuple.extend_from_slice(
                format_grid_sql_literal_with_identifier_quote(
                    value,
                    context.request.database_type,
                    info,
                    context.request.identifier_quote.as_deref(),
                )
                .as_bytes(),
            );
        }
        if context.selected_columns.len() > 1 {
            tuple.push(b')');
        }
        if let Entry::Vacant(entry) = seen_rows.entry(tuple) {
            if has_output {
                write_bytes(output, b", ")?;
            }
            write_bytes(output, entry.key())?;
            entry.insert(());
            has_output = true;
        }
    }
    write_bytes(output, b")")
}

pub(super) fn write_sql_inserts(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<WriteMetadata, DataGridExtractError> {
    ensure_sql_builder_budget(context)?;
    reject_selected_opaque_aggregate_states(context)?;
    let data = sql_selected_data(context, false)?;
    let statement = build_data_grid_copy_insert_statement_with_formatters(
        DataGridCopyInsertStatementOptions {
            database_type: context.request.database_type,
            identifier_quote: context.request.identifier_quote.clone(),
            table_meta: context.request.table_meta.clone(),
            columns: data.columns,
            column_types: Some(data.column_types),
            source_columns: Some(data.source_columns),
            rows: data.rows,
            exclude_primary_keys: context.request.options.sql.exclude_primary_keys_from_insert,
            include_computed_columns: !context.request.options.sql.skip_computed_columns,
            include_database_name: context.request.options.sql.include_database_name,
            insert_mode: context.request.options.sql.insert_mode,
        },
        |reference| {
            if context.request.options.sql.quote_identifiers {
                reference
            } else {
                identifiers::unquote_optional_identifiers(
                    reference,
                    context.request.database_type,
                    context.request.identifier_quote.as_deref(),
                )
            }
        },
        |value, database_type, info, identifier_quote| {
            if context.request.options.sql.temporal_format == DataGridTemporalFormat::String {
                if let Some(literal) = portable_temporal_literal(value, database_type, info) {
                    return literal;
                }
            }
            format_grid_copy_insert_sql_literal(value, database_type, info, identifier_quote)
        },
    )
    .ok_or_else(|| {
        DataGridExtractError::new(
            DataGridExtractErrorCode::NoWritableColumns,
            "No insertable columns remain after applying extractor column rules.",
        )
    })?;
    write_bytes(output, statement.as_bytes())?;
    Ok(sql_metadata(data.omitted_columns))
}

fn portable_temporal_literal(
    value: &Value,
    database_type: Option<DatabaseType>,
    info: Option<&DataGridColumnInfo>,
) -> Option<String> {
    let data_type = info?.data_type.trim().to_ascii_lowercase();
    let kind = data_type.split(['(', ':', ' ']).next()?;
    if database_type == Some(DatabaseType::SqlServer) && kind == "timestamp" {
        return None;
    }
    if !matches!(
        kind,
        "date"
            | "time"
            | "timetz"
            | "timestamp"
            | "timestamptz"
            | "datetime"
            | "datetime2"
            | "datetimeoffset"
            | "smalldatetime"
    ) {
        return None;
    }
    let text = value.as_str()?;
    if database_type == Some(DatabaseType::Iotdb) && kind == "timestamp" && text.parse::<i64>().is_ok() {
        return None;
    }
    let normalized = DateTime::parse_from_rfc3339(text)
        .map(|datetime| datetime.naive_local())
        .ok()
        .or_else(|| NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f").ok())
        .or_else(|| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").ok())
        .or_else(|| NaiveDate::parse_from_str(text, "%Y-%m-%d").ok().and_then(|date| date.and_hms_opt(0, 0, 0)))
        .map(|datetime| {
            datetime
                .format(if matches!(kind, "time" | "timetz") { "%H:%M:%S" } else { "%Y-%m-%d %H:%M:%S" })
                .to_string()
        })
        .or_else(|| NaiveTime::parse_from_str(text, "%H:%M:%S%.f").ok().map(|time| time.format("%H:%M:%S").to_string()))
        .unwrap_or_else(|| text.to_string());
    Some(format!("'{}'", normalized.replace('\'', "''")))
}

pub(super) fn write_sql_updates(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<WriteMetadata, DataGridExtractError> {
    ensure_sql_builder_budget(context)?;
    reject_selected_opaque_aggregate_states(context)?;
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
        identifier_quote: context.request.identifier_quote.clone(),
        table_meta: table_meta.clone(),
        columns: data.columns,
        source_columns: Some(data.source_columns),
        rows: data.rows,
        include_database_name: context.request.options.sql.include_database_name,
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

fn reject_selected_opaque_aggregate_states(context: &ExtractContext<'_>) -> Result<(), DataGridExtractError> {
    if context.selected_column_info.iter().flatten().any(|info| is_opaque_aggregate_state_type(&info.data_type)) {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::NoWritableColumns,
            "Doris aggregate-state columns are opaque and cannot be copied as automatic SQL; use an explicit Doris state function instead.",
        ));
    }
    Ok(())
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
    // WHERE-clause output (and SELECT built from a cell selection, which reuses
    // the same predicate builder) repeats every selected column's identifier
    // once per row via OR'd row groups, just like SqlUpdates/row-by-row insert.
    let repeats_identifiers_per_row = context.request.extractor == super::DataGridExtractorId::SqlUpdates
        || context.request.options.sql.insert_mode == crate::data_grid_sql::DataGridCopyInsertMode::RowByRow
        || context.request.extractor == super::DataGridExtractorId::WhereClause
        || (context.request.extractor == super::DataGridExtractorId::SqlSelect
            && context.request.selection_kind == super::DataGridSelectionKind::Cells);
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
            || (context.request.options.sql.skip_generated_columns
                && info.is_some_and(is_auto_generated_column)
                && !is_primary_key)
            || (for_update && is_primary_key)
            // Exclude only auto-generated primary keys; manually-assigned key
            // columns must survive "without primary keys" INSERT copies
            // (composite keys would otherwise lose NOT NULL data).
            || (!for_update
                && context.request.options.sql.exclude_primary_keys_from_insert
                && is_primary_key
                && info.is_some_and(is_auto_generated_column));
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
                context.request.identifier_quote.as_deref(),
            );
            write_bytes(output, predicate.as_bytes())?;
        }
        if context.request.rows.len() > 1 {
            write_bytes(output, b")")?;
        }
    }
    Ok(())
}

pub(super) fn write_sql_select(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
) -> Result<(), DataGridExtractError> {
    ensure_sql_builder_budget(context)?;
    if !supports_relational_copy_predicates(context.request.database_type) {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::UnsupportedDatabase,
            "SELECT extraction is not supported for this database type.",
        ));
    }
    let table_meta =
        context.request.table_meta.as_ref().filter(|meta| !meta.table_name.trim().is_empty()).ok_or_else(|| {
            DataGridExtractError::new(
                DataGridExtractErrorCode::MissingTableMetadata,
                "SELECT extraction requires one resolved table target.",
            )
        })?;
    if context.request.rows.is_empty()
        || matches!(context.request.selection_kind, super::DataGridSelectionKind::Columns)
        || (context.request.selection_kind == super::DataGridSelectionKind::Rows && context.request.rows.len() != 1)
    {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidSelectSelection,
            "SELECT extraction supports cell selections or exactly one selected row.",
        ));
    }

    let table = data_grid_generated_table_name(
        context.request.database_type,
        table_meta.catalog.as_deref(),
        table_meta.schema.as_deref(),
        table_meta.database.as_deref(),
        &table_meta.table_name,
        context.request.identifier_quote.as_deref(),
        context.request.options.sql.include_database_name,
    );

    if context.request.selection_kind == super::DataGridSelectionKind::Cells {
        // A cell-selection SELECT reuses the WHERE-clause predicate builder so a
        // multi-cell selection (same-row columns AND'd, multi-row selections
        // OR'd) produces the same predicate as "Copy as WHERE clause" for the
        // identical selection — including its fallback to display_name when a
        // column has no resolved source_name. build_context() already rejects
        // an empty column selection before this function runs.
        write_bytes(output, format!("SELECT * FROM {table} WHERE ").as_bytes())?;
        write_where_clause(context, output)?;
        return write_bytes(output, b";");
    }

    // Only the single-row identity path (row-checkbox selection) reaches here;
    // cell selections returned above via the write_where_clause path.
    let row = &context.request.rows[0];
    let identity = table_meta
        .primary_keys
        .iter()
        .map(|primary_key| {
            context
                .request
                .columns
                .iter()
                .find(|column| {
                    normalized_name_eq(column.source_name.as_deref().unwrap_or(&column.display_name), primary_key)
                })
                .filter(|column| row.get(column.source_index).is_some_and(|value| !value.is_null()))
        })
        .collect::<Option<Vec<_>>>();
    let predicate_columns =
        identity.filter(|columns| !columns.is_empty()).unwrap_or_else(|| context.request.columns.iter().collect());
    if predicate_columns.is_empty() {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidColumnMapping,
            "SELECT extraction has no source columns for its predicate.",
        ));
    }

    let mut predicates = Vec::with_capacity(predicate_columns.len());
    for column in predicate_columns {
        let value = row.get(column.source_index).ok_or_else(|| {
            DataGridExtractError::new(
                DataGridExtractErrorCode::InvalidColumnMapping,
                format!("Column '{}' maps to missing row index {}.", column.display_name, column.source_index),
            )
        })?;
        let source_name = column.source_name.as_deref().filter(|name| !name.trim().is_empty()).ok_or_else(|| {
            DataGridExtractError::new(
                DataGridExtractErrorCode::InvalidColumnMapping,
                format!("Column '{}' has no resolved source-column mapping.", column.display_name),
            )
        })?;
        let column_info = table_meta
            .columns
            .as_deref()
            .unwrap_or_default()
            .iter()
            .find(|info| normalized_name_eq(&info.name, source_name));
        predicates.push(build_column_predicate(
            context.request.database_type,
            source_name,
            value,
            column_info,
            true,
            context.request.identifier_quote.as_deref(),
        ));
    }
    write_bytes(output, format!("SELECT * FROM {table} WHERE {};", predicates.join(" AND ")).as_bytes())
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
