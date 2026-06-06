use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufWriter, Write};

use crate::connection::AppState;
use crate::csv_export::{escape_csv, format_csv, value_to_csv_text};
pub use crate::database_export::ExportStatus;
use crate::database_export::{build_export_insert_statements, is_export_cancelled, BuildExportInsertStatementsOptions};
use crate::transfer::{
    count_sql_with_where, execute_on_pool, execute_on_pool_with_max_rows, keyset_pagination_sql,
    pagination_sql_with_filter_order,
};
use crate::xlsx_export::{build_xlsx_workbook, XlsxWorksheetData};

const DEFAULT_BATCH_SIZE: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExportRequest {
    pub export_id: String,
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table_name: String,
    pub file_path: String,
    /// "csv", "xlsx", "json", "markdown", or "sql"
    pub format: String,
    #[serde(default)]
    pub columns: Option<Vec<String>>,
    #[serde(default)]
    pub column_types: Option<Vec<Option<String>>>,
    #[serde(default)]
    pub primary_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub where_input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_by: Option<String>,
    #[serde(default)]
    pub skip_count: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExportProgress {
    pub export_id: String,
    pub table_name: String,
    pub rows_exported: u64,
    pub total_rows: Option<u64>,
    pub status: ExportStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// Format rows as CSV text without a header row.
/// Used for streaming subsequent pagination batches.
fn format_csv_rows(rows: &[Vec<Value>]) -> String {
    rows.iter()
        .map(|row| row.iter().map(|cell| escape_csv(&value_to_csv_text(cell))).collect::<Vec<_>>().join(","))
        .collect::<Vec<_>>()
        .join("\n")
}

fn write_json_row_object<W: Write>(writer: &mut W, columns: &[String], row: &[Value]) -> Result<(), String> {
    writer.write_all(b"{\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
    let mut first = true;
    for (index, column) in columns.iter().enumerate() {
        let Some(value) = row.get(index) else {
            continue;
        };
        if !first {
            writer.write_all(b",\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
        }
        writer.write_all(b"  ").map_err(|e| format!("Failed to write JSON: {e}"))?;
        serde_json::to_writer(&mut *writer, column).map_err(|e| format!("Failed to write JSON: {e}"))?;
        writer.write_all(b": ").map_err(|e| format!("Failed to write JSON: {e}"))?;
        serde_json::to_writer(&mut *writer, value).map_err(|e| format!("Failed to write JSON: {e}"))?;
        first = false;
    }
    writer.write_all(b"\n}").map_err(|e| format!("Failed to write JSON: {e}"))
}

fn display_cell(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn markdown_cell(value: &str) -> String {
    value.replace('|', "\\|").replace("\r\n", "<br>").replace('\n', "<br>")
}

fn format_markdown_header(columns: &[String]) -> String {
    let header = columns.iter().map(|column| markdown_cell(column)).collect::<Vec<_>>().join(" | ");
    let separator = columns.iter().map(|_| "---").collect::<Vec<_>>().join(" | ");
    format!("| {header} |\n| {separator} |\n")
}

fn format_markdown_rows(rows: &[Vec<Value>]) -> String {
    rows.iter()
        .map(|row| {
            let cells = row.iter().map(|cell| markdown_cell(&display_cell(cell))).collect::<Vec<_>>().join(" | ");
            format!("| {cells} |")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[allow(clippy::too_many_arguments)]
fn table_page_sql(
    request: &TableExportRequest,
    db_type: &crate::models::connection::DatabaseType,
    col_names: &[String],
    primary_keys: &[String],
    use_keyset: bool,
    last_pk_values: &[Value],
    offset: u64,
    batch_size: usize,
) -> String {
    if use_keyset {
        keyset_pagination_sql(
            col_names,
            &request.table_name,
            request.schema.as_deref().unwrap_or(""),
            db_type,
            primary_keys,
            last_pk_values,
            batch_size,
        )
    } else {
        pagination_sql_with_filter_order(
            col_names,
            &request.table_name,
            request.schema.as_deref().unwrap_or(""),
            db_type,
            offset,
            batch_size,
            request.where_input.as_deref(),
            request.order_by.as_deref(),
            primary_keys,
        )
    }
}

pub async fn export_table_data_core(
    state: &AppState,
    request: &TableExportRequest,
    on_progress: impl Fn(TableExportProgress),
) -> Result<(), String> {
    // 1. Get database type
    let db_type = state
        .configs
        .read()
        .await
        .get(&request.connection_id)
        .map(|c| c.db_type)
        .ok_or_else(|| format!("Connection config not found: {}", request.connection_id))?;

    // 2. Get pool
    let pool_key = state.get_or_create_pool(&request.connection_id, Some(&request.database)).await?;

    // 3. Resolve columns. Data grid exports can provide columns/primary keys
    // directly, which avoids expensive metadata round-trips on JDBC drivers.
    let requested_columns = request.columns.as_ref().filter(|columns| !columns.is_empty());
    let (col_names, column_types, primary_keys) = if let Some(requested_columns) = requested_columns {
        let primary_keys = request.primary_keys.clone().unwrap_or_default();
        let column_types = request.column_types.clone().unwrap_or_default();
        (requested_columns.clone(), column_types, primary_keys)
    } else {
        let columns = crate::schema::get_columns_core(
            state,
            &request.connection_id,
            &request.database,
            request.schema.as_deref().unwrap_or(""),
            &request.table_name,
        )
        .await?;
        let col_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
        let column_types: Vec<Option<String>> = columns.iter().map(|c| Some(c.data_type.clone())).collect();
        let primary_keys: Vec<String> = columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.clone()).collect();
        (col_names, column_types, primary_keys)
    };

    if col_names.is_empty() {
        return Err("No columns found for table".to_string());
    }

    // Use keyset pagination when all PKs are in the selected (filtered) columns.
    // This avoids the OFFSET performance penalty for large tables.
    // When no PK is available, falls back to offset-based pagination.
    let has_custom_filter_or_order = request.where_input.as_ref().is_some_and(|value| !value.trim().is_empty())
        || request.order_by.as_ref().is_some_and(|value| !value.trim().is_empty());
    let use_keyset =
        !has_custom_filter_or_order && !primary_keys.is_empty() && primary_keys.iter().all(|pk| col_names.contains(pk));

    // PK column indices within result rows (for extracting last-row values)
    let pk_indices: Vec<usize> = if use_keyset {
        primary_keys.iter().map(|pk| col_names.iter().position(|c| c == pk).unwrap()).collect()
    } else {
        Vec::new()
    };

    // 6. Get total row count for progress estimation when requested. Data
    // grid exports skip this by default because COUNT can be the slowest query
    // on large HANA/JDBC tables, especially with filters.
    let total_rows = if request.skip_count {
        None
    } else {
        let count_query = count_sql_with_where(
            &request.table_name,
            request.schema.as_deref().unwrap_or(""),
            &db_type,
            request.where_input.as_deref(),
        );
        match execute_on_pool(state, &pool_key, &count_query).await {
            Ok(result) => result.rows.first().and_then(|r| r.first()).and_then(|v| match v {
                Value::Number(n) => n.as_u64(),
                Value::String(s) => s.parse::<u64>().ok(),
                _ => None,
            }),
            Err(_) => None,
        }
    };

    // 7. Emit initial Running progress
    on_progress(TableExportProgress {
        export_id: request.export_id.clone(),
        table_name: request.table_name.clone(),
        rows_exported: 0,
        total_rows,
        status: ExportStatus::Running,
        error_message: None,
    });

    // 8. Create output file
    let file = std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?;
    let mut file = BufWriter::new(file);

    let mut rows_exported: u64 = 0;
    let batch_size = request.batch_size.unwrap_or(DEFAULT_BATCH_SIZE).max(1);
    let mut offset: u64 = 0;

    // Track last primary key values for keyset pagination
    let mut last_pk_values: Vec<Value> = Vec::new();

    match request.format.to_lowercase().as_str() {
        "csv" => {
            // Write UTF-8 BOM
            file.write_all(b"\xEF\xBB\xBF").map_err(|e| format!("Failed to write BOM: {e}"))?;

            let mut is_first_batch = true;

            loop {
                // Check cancellation between batches
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    return Ok(());
                }

                let sql = table_page_sql(
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    batch_size,
                );

                let result = execute_on_pool_with_max_rows(state, &pool_key, &sql, Some(batch_size)).await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                if is_first_batch {
                    // First batch: write header + rows via format_csv
                    let csv_content = format_csv(&col_names, &result.rows);
                    file.write_all(csv_content.as_bytes()).map_err(|e| format!("Failed to write CSV: {e}"))?;
                    is_first_batch = false;
                } else {
                    // Subsequent batches: write rows only (prepend newline for separation)
                    let rows_csv = format_csv_rows(&result.rows);
                    if !rows_csv.is_empty() {
                        write!(file, "\n{rows_csv}").map_err(|e| format!("Failed to write CSV rows: {e}"))?;
                    }
                }

                rows_exported += row_count as u64;

                if use_keyset {
                    // Keyset pagination: track last PK values for next batch
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < batch_size {
                    break;
                }
            }
        }
        "xlsx" => {
            let mut all_rows: Vec<Vec<Value>> = Vec::new();

            loop {
                // Check cancellation between batches
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    return Ok(());
                }

                let sql = table_page_sql(
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    batch_size,
                );

                let result = execute_on_pool_with_max_rows(state, &pool_key, &sql, Some(batch_size)).await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                all_rows.extend(result.rows);
                rows_exported += row_count as u64;

                if use_keyset {
                    // Keyset pagination: track last PK values for next batch
                    if let Some(last_row) = all_rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < batch_size {
                    break;
                }
            }

            // Emit Writing progress before building XLSX
            on_progress(TableExportProgress {
                export_id: request.export_id.clone(),
                table_name: request.table_name.clone(),
                rows_exported,
                total_rows,
                status: ExportStatus::Writing,
                error_message: None,
            });

            // Build XLSX workbook from accumulated rows
            let workbook_data =
                XlsxWorksheetData { sheet_name: Some(request.table_name.clone()), columns: col_names, rows: all_rows };
            let xlsx_bytes = build_xlsx_workbook(&workbook_data)?;
            file.write_all(&xlsx_bytes).map_err(|e| format!("Failed to write XLSX file: {e}"))?;
        }
        "json" => {
            file.write_all(b"[\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
            let mut is_first_row = true;

            loop {
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    return Ok(());
                }

                let sql = table_page_sql(
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    batch_size,
                );
                let result = execute_on_pool_with_max_rows(state, &pool_key, &sql, Some(batch_size)).await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                for row in &result.rows {
                    if !is_first_row {
                        file.write_all(b",\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
                    }
                    write_json_row_object(&mut file, &col_names, row)?;
                    is_first_row = false;
                }

                rows_exported += row_count as u64;
                if use_keyset {
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < batch_size {
                    break;
                }
            }

            file.write_all(b"\n]\n").map_err(|e| format!("Failed to write JSON: {e}"))?;
        }
        "markdown" | "md" => {
            file.write_all(format_markdown_header(&col_names).as_bytes())
                .map_err(|e| format!("Failed to write Markdown: {e}"))?;
            let mut wrote_rows = false;

            loop {
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    return Ok(());
                }

                let sql = table_page_sql(
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    batch_size,
                );
                let result = execute_on_pool_with_max_rows(state, &pool_key, &sql, Some(batch_size)).await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                let rows_markdown = format_markdown_rows(&result.rows);
                if !rows_markdown.is_empty() {
                    if wrote_rows {
                        file.write_all(b"\n").map_err(|e| format!("Failed to write Markdown: {e}"))?;
                    }
                    file.write_all(rows_markdown.as_bytes()).map_err(|e| format!("Failed to write Markdown: {e}"))?;
                    wrote_rows = true;
                }

                rows_exported += row_count as u64;
                if use_keyset {
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < batch_size {
                    break;
                }
            }

            file.write_all(b"\n").map_err(|e| format!("Failed to write Markdown: {e}"))?;
        }
        "sql" => {
            let mut wrote_statements = false;

            loop {
                if is_export_cancelled(&request.export_id).await {
                    on_progress(TableExportProgress {
                        export_id: request.export_id.clone(),
                        table_name: request.table_name.clone(),
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Cancelled,
                        error_message: Some("Export cancelled".to_string()),
                    });
                    return Ok(());
                }

                let sql = table_page_sql(
                    request,
                    &db_type,
                    &col_names,
                    &primary_keys,
                    use_keyset,
                    &last_pk_values,
                    offset,
                    batch_size,
                );
                let result = execute_on_pool_with_max_rows(state, &pool_key, &sql, Some(batch_size)).await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
                    database_type: Some(db_type),
                    schema: request.schema.clone(),
                    table_name: Some(request.table_name.clone()),
                    qualified_table_name: None,
                    columns: col_names.clone(),
                    column_types: column_types.clone(),
                    rows: result.rows.clone(),
                    batch_size: Some(100),
                })?;
                if !statements.is_empty() {
                    if wrote_statements {
                        file.write_all(b"\n").map_err(|e| format!("Failed to write SQL: {e}"))?;
                    }
                    file.write_all(statements.join("\n").as_bytes())
                        .map_err(|e| format!("Failed to write SQL: {e}"))?;
                    wrote_statements = true;
                }

                rows_exported += row_count as u64;
                if use_keyset {
                    if let Some(last_row) = result.rows.last() {
                        last_pk_values = pk_indices.iter().map(|&i| last_row[i].clone()).collect();
                    }
                } else {
                    offset += row_count as u64;
                }

                on_progress(TableExportProgress {
                    export_id: request.export_id.clone(),
                    table_name: request.table_name.clone(),
                    rows_exported,
                    total_rows,
                    status: ExportStatus::Running,
                    error_message: None,
                });

                if row_count < batch_size {
                    break;
                }
            }

            if wrote_statements {
                file.write_all(b"\n").map_err(|e| format!("Failed to write SQL: {e}"))?;
            }
        }
        other => {
            return Err(format!("Unsupported export format: {other}"));
        }
    }

    file.flush().map_err(|e| format!("Failed to flush export file: {e}"))?;

    // 8. Emit Done progress
    on_progress(TableExportProgress {
        export_id: request.export_id.clone(),
        table_name: request.table_name.clone(),
        rows_exported,
        total_rows,
        status: ExportStatus::Done,
        error_message: None,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database_export::{clear_export_cancelled, set_export_cancelled};
    use serde_json::json;

    // -----------------------------------------------------------------------
    // Helper: check that two CSV strings are equivalent by splitting lines
    // -----------------------------------------------------------------------
    fn csv_lines_equal(actual: &str, expected: &str) -> bool {
        let actual_lines: Vec<&str> = actual.lines().collect();
        let expected_lines: Vec<&str> = expected.lines().collect();
        actual_lines == expected_lines
    }

    // -----------------------------------------------------------------------
    // format_csv_rows
    // -----------------------------------------------------------------------

    #[test]
    fn formats_csv_rows_with_multiple_columns() {
        let rows = vec![vec![json!(1), json!("Alice")], vec![json!(2), json!("Bob \"Builder\"")]];
        let out = format_csv_rows(&rows);
        assert!(csv_lines_equal(&out, "\"1\",\"Alice\"\n\"2\",\"Bob \"\"Builder\"\"\""));
    }

    #[test]
    fn formats_csv_rows_with_null_values() {
        let rows = vec![vec![json!(1), Value::Null, json!("active")], vec![json!(2), json!("some notes"), Value::Null]];
        let out = format_csv_rows(&rows);
        assert!(csv_lines_equal(&out, "\"1\",\"\",\"active\"\n\"2\",\"some notes\",\"\""));
    }

    #[test]
    fn formats_csv_rows_with_boolean_and_number_values() {
        let rows = vec![vec![json!(true), json!(2.75)], vec![json!(false), json!(-42)]];
        let out = format_csv_rows(&rows);
        assert!(csv_lines_equal(&out, "\"true\",\"2.75\"\n\"false\",\"-42\""));
    }

    #[test]
    fn formats_csv_rows_returns_empty_string_for_empty_rows() {
        let rows: Vec<Vec<Value>> = vec![];
        let out = format_csv_rows(&rows);
        assert_eq!(out, "");
    }

    #[test]
    fn formats_csv_rows_single_row() {
        let rows = vec![vec![json!("just"), json!("one")]];
        let out = format_csv_rows(&rows);
        assert_eq!(out, "\"just\",\"one\"");
    }

    #[test]
    fn writes_json_row_without_allocating_object_map() {
        let mut out = Vec::new();
        write_json_row_object(
            &mut out,
            &["id".to_string(), "name".to_string(), "missing".to_string()],
            &[json!(1), json!("Ada")],
        )
        .unwrap();

        assert_eq!(String::from_utf8(out).unwrap(), "{\n  \"id\": 1,\n  \"name\": \"Ada\"\n}");
    }

    #[test]
    fn formats_csv_rows_escapes_embedded_commas_and_newlines() {
        let rows = vec![vec![json!("hello,world"), json!("line1\nline2")]];
        let out = format_csv_rows(&rows);
        assert!(out.contains("\"hello,world\""));
        assert!(out.contains("\"line1\nline2\""));
        let records: Vec<Vec<String>> = csv::ReaderBuilder::new()
            .has_headers(false)
            .from_reader(out.as_bytes())
            .records()
            .map(|record| record.unwrap().iter().map(str::to_string).collect())
            .collect();
        assert_eq!(records, vec![vec!["hello,world".to_string(), "line1\nline2".to_string()]]);
    }

    // -----------------------------------------------------------------------
    // Cancellation flow
    // -----------------------------------------------------------------------

    #[test]
    fn cancellation_set_and_cleared_correctly() {
        let export_id = "test-cancel-1";

        assert!(!poll_is_cancelled(export_id));
        block_on(set_export_cancelled(export_id));
        assert!(poll_is_cancelled(export_id));
        block_on(clear_export_cancelled(export_id));
        assert!(!poll_is_cancelled(export_id));
    }

    #[test]
    fn cancellation_is_id_scoped() {
        let id_a = "cancel-scope-a";
        let id_b = "cancel-scope-b";

        block_on(set_export_cancelled(id_a));
        assert!(poll_is_cancelled(id_a));
        assert!(!poll_is_cancelled(id_b));
        block_on(clear_export_cancelled(id_a));
    }

    // -----------------------------------------------------------------------
    // XLSX workbook integration
    // -----------------------------------------------------------------------

    #[test]
    fn builds_xlsx_workbook_with_table_export_data() {
        let data = XlsxWorksheetData {
            sheet_name: Some("employees".to_string()),
            columns: vec!["id".to_string(), "name".to_string(), "salary".to_string()],
            rows: vec![
                vec![json!(1), json!("Alice"), json!(75000.50)],
                vec![json!(2), json!("Bob"), json!(82000)],
                vec![json!(3), Value::Null, json!(0)],
            ],
        };
        let workbook = build_xlsx_workbook(&data).expect("XLSX build should succeed");
        let text = String::from_utf8_lossy(&workbook);

        assert_eq!(workbook[0], 0x50, "Should be a ZIP (PK) archive");
        assert_eq!(workbook[1], 0x4b);
        assert!(text.contains("[Content_Types].xml"));
        assert!(text.contains("xl/worksheets/sheet1.xml"));
        assert!(text.contains("name=\"employees\""));
        assert!(text.contains("<v>75000.5</v>"));
        assert!(text.contains("Alice"));
    }

    // -----------------------------------------------------------------------
    // CSV header + rows (format_csv) — basic integration check
    // -----------------------------------------------------------------------

    #[test]
    fn format_csv_produces_header_and_rows() {
        let out = format_csv(
            &["col1".to_string(), "col2".to_string()],
            &[vec![json!("a"), json!("b")], vec![json!("c"), json!("d")]],
        );
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3, "header + 2 data rows = 3 lines");
        assert_eq!(lines[0], "\"col1\",\"col2\"");
        assert_eq!(lines[1], "\"a\",\"b\"");
        assert_eq!(lines[2], "\"c\",\"d\"");
    }

    // -----------------------------------------------------------------------
    // Helpers for async cancellation in tests
    // -----------------------------------------------------------------------

    fn poll_is_cancelled(export_id: &str) -> bool {
        block_on(is_export_cancelled(export_id))
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Runtime::new().expect("create tokio runtime").block_on(future)
    }
}
