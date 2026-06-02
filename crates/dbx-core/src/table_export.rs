use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;

use crate::connection::AppState;
use crate::csv_export::{escape_csv, format_csv, value_to_csv_text};
use crate::database_export::is_export_cancelled;
pub use crate::database_export::ExportStatus;
use crate::transfer::{count_sql, execute_on_pool, pagination_sql};
use crate::xlsx_export::{build_xlsx_workbook, XlsxWorksheetData};

const DEFAULT_BATCH_SIZE: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExportRequest {
    pub export_id: String,
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table_name: String,
    pub file_path: String,
    /// "csv" or "xlsx"
    pub format: String,
    #[serde(default)]
    pub columns: Option<Vec<String>>,
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

    // 3. Get columns
    let columns = crate::schema::get_columns_core(
        state,
        &request.connection_id,
        &request.database,
        request.schema.as_deref().unwrap_or(""),
        &request.table_name,
    )
    .await?;

    let col_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();

    // 4. Optionally filter to requested columns
    let col_names = if let Some(requested_cols) = &request.columns {
        if requested_cols.is_empty() {
            col_names
        } else {
            let filtered: Vec<String> = requested_cols.iter().filter(|c| col_names.contains(c)).cloned().collect();
            if filtered.is_empty() {
                return Err("None of the requested columns exist in the table".to_string());
            }
            filtered
        }
    } else {
        col_names
    };

    if col_names.is_empty() {
        return Err("No columns found for table".to_string());
    }

    // 5. Get total row count for progress estimation
    let count_query = count_sql(&request.table_name, request.schema.as_deref().unwrap_or(""), &db_type);
    let total_rows = match execute_on_pool(state, &pool_key, &count_query).await {
        Ok(result) => result.rows.first().and_then(|r| r.first()).and_then(|v| match v {
            Value::Number(n) => n.as_u64(),
            Value::String(s) => s.parse::<u64>().ok(),
            _ => None,
        }),
        Err(_) => None,
    };

    // 6. Emit initial Running progress
    on_progress(TableExportProgress {
        export_id: request.export_id.clone(),
        table_name: request.table_name.clone(),
        rows_exported: 0,
        total_rows,
        status: ExportStatus::Running,
        error_message: None,
    });

    // 7. Create output file
    let mut file = std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to create file: {e}"))?;

    let mut rows_exported: u64 = 0;
    let mut offset: u64 = 0;
    let batch_size = DEFAULT_BATCH_SIZE;

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

                let sql = pagination_sql(
                    &col_names,
                    &request.table_name,
                    request.schema.as_deref().unwrap_or(""),
                    &db_type,
                    offset,
                    batch_size,
                );

                let result = execute_on_pool(state, &pool_key, &sql).await?;
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
                offset += row_count as u64;

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

                let sql = pagination_sql(
                    &col_names,
                    &request.table_name,
                    request.schema.as_deref().unwrap_or(""),
                    &db_type,
                    offset,
                    batch_size,
                );

                let result = execute_on_pool(state, &pool_key, &sql).await?;
                let row_count = result.rows.len();
                if row_count == 0 {
                    break;
                }

                all_rows.extend(result.rows);
                rows_exported += row_count as u64;
                offset += row_count as u64;

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
        other => {
            return Err(format!("Unsupported export format: {other}"));
        }
    }

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
        let rows = vec![vec![json!(true), json!(3.14)], vec![json!(false), json!(-42)]];
        let out = format_csv_rows(&rows);
        assert!(csv_lines_equal(&out, "\"true\",\"3.14\"\n\"false\",\"-42\""));
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
    fn formats_csv_rows_escapes_embedded_commas_and_newlines() {
        let rows = vec![vec![json!("hello,world"), json!("line1\nline2")]];
        let out = format_csv_rows(&rows);
        assert!(out.contains("\"hello,world\""));
        assert!(out.contains("\"line1\nline2\""));
        // CSV escaping wraps in quotes, so commas inside are safe
        let fields: Vec<&str> = out.split(',').collect();
        assert_eq!(fields.len(), 2);
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
