use std::collections::HashSet;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::transfer::{execute_on_pool, generate_insert, qualified_table};
use crate::connection::AppState;

pub const DEFAULT_PREVIEW_LIMIT: usize = 50;
pub const DEFAULT_BATCH_SIZE: usize = 500;

#[derive(Debug, Clone)]
pub struct ParsedImportFile {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportSqlBatch {
    pub sql: String,
    pub row_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportColumnMapping {
    pub source_column: String,
    pub target_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportMode {
    Append,
    Truncate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportRequest {
    pub import_id: String,
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    pub file_path: String,
    pub mappings: Vec<TableImportColumnMapping>,
    pub mode: TableImportMode,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportPreview {
    pub file_name: String,
    pub file_path: String,
    pub file_type: String,
    pub size_bytes: u64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total_rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportSummary {
    pub import_id: String,
    pub rows_imported: usize,
    pub total_rows: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableImportProgress {
    pub import_id: String,
    pub status: TableImportStatus,
    pub rows_imported: usize,
    pub total_rows: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TableImportStatus {
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFileKind {
    Csv,
    Tsv,
    Json,
    Xlsx,
}

impl ImportFileKind {
    pub fn label(self) -> &'static str {
        match self {
            ImportFileKind::Csv => "csv",
            ImportFileKind::Tsv => "tsv",
            ImportFileKind::Json => "json",
            ImportFileKind::Xlsx => "xlsx",
        }
    }
}

pub fn import_file_kind(path: &str) -> Result<ImportFileKind, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".csv") {
        Ok(ImportFileKind::Csv)
    } else if lower.ends_with(".tsv") {
        Ok(ImportFileKind::Tsv)
    } else if lower.ends_with(".json") {
        Ok(ImportFileKind::Json)
    } else if lower.ends_with(".xlsx") || lower.ends_with(".xlsm") || lower.ends_with(".xls") {
        Ok(ImportFileKind::Xlsx)
    } else {
        Err("Unsupported import file type".to_string())
    }
}

pub fn normalize_header(value: &str, index: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        format!("column_{}", index + 1)
    } else {
        trimmed.to_string()
    }
}

pub fn csv_value(value: &str) -> serde_json::Value {
    if value.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(value.to_string())
    }
}

pub fn parse_delimited_bytes(
    bytes: &[u8],
    delimiter: u8,
    preview_limit: usize,
) -> Result<ParsedImportFile, String> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .flexible(true)
        .from_reader(bytes);
    let columns = reader
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .enumerate()
        .map(|(index, header)| normalize_header(header, index))
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("Import file has no columns".to_string());
    }

    let mut rows = Vec::new();
    let mut total_rows = 0;
    for record in reader.records() {
        let record = record.map_err(|e| e.to_string())?;
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        let mut row = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            row.push(
                record
                    .get(index)
                    .map(csv_value)
                    .unwrap_or(serde_json::Value::Null),
            );
        }
        rows.push(row);
    }

    Ok(ParsedImportFile {
        columns,
        rows,
        total_rows,
    })
}

pub fn parse_csv_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    parse_delimited_bytes(bytes, b',', preview_limit)
}

pub fn parse_json_bytes(bytes: &[u8], preview_limit: usize) -> Result<ParsedImportFile, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let items = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(_) => vec![value],
        _ => return Err("JSON import must be an object or an array".to_string()),
    };
    if items.is_empty() {
        return Err("Import file has no rows".to_string());
    }

    if items.iter().all(|item| item.is_object()) {
        let mut columns = Vec::new();
        for item in &items {
            if let Some(obj) = item.as_object() {
                for key in obj.keys() {
                    if !columns.contains(key) {
                        columns.push(key.clone());
                    }
                }
            }
        }
        if columns.is_empty() {
            return Err("Import file has no columns".to_string());
        }
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let obj = item.as_object().expect("checked object JSON row");
                columns
                    .iter()
                    .map(|column| obj.get(column).cloned().unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile {
            columns,
            rows,
            total_rows: items.len(),
        });
    }

    if items.iter().all(|item| item.is_array()) {
        let max_cols = items
            .iter()
            .filter_map(|item| item.as_array().map(|row| row.len()))
            .max()
            .unwrap_or(0);
        if max_cols == 0 {
            return Err("Import file has no columns".to_string());
        }
        let columns = (0..max_cols)
            .map(|index| format!("column_{}", index + 1))
            .collect::<Vec<_>>();
        let rows = items
            .iter()
            .take(preview_limit)
            .map(|item| {
                let arr = item.as_array().expect("checked array JSON row");
                (0..max_cols)
                    .map(|index| arr.get(index).cloned().unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        return Ok(ParsedImportFile {
            columns,
            rows,
            total_rows: items.len(),
        });
    }

    Err("JSON rows must all be objects or all be arrays".to_string())
}

pub fn xlsx_cell_value(cell: &Data) -> serde_json::Value {
    match cell {
        Data::Empty => serde_json::Value::Null,
        Data::String(s) => csv_value(s),
        Data::Float(n) => serde_json::Number::from_f64(*n)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Data::Int(n) => serde_json::Value::Number((*n).into()),
        Data::Bool(v) => serde_json::Value::Bool(*v),
        Data::DateTime(v) => serde_json::Value::String(v.to_string()),
        Data::DateTimeIso(v) => serde_json::Value::String(v.clone()),
        Data::DurationIso(v) => serde_json::Value::String(v.clone()),
        Data::Error(v) => serde_json::Value::String(v.to_string()),
    }
}

pub fn xlsx_cell_label(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(n) => n.to_string(),
        Data::Int(n) => n.to_string(),
        Data::Bool(v) => v.to_string(),
        Data::DateTime(v) => v.to_string(),
        Data::DateTimeIso(v) => v.clone(),
        Data::DurationIso(v) => v.clone(),
        Data::Error(v) => v.to_string(),
    }
}

pub fn parse_xlsx_file(path: &str, preview_limit: usize) -> Result<ParsedImportFile, String> {
    let mut workbook = open_workbook_auto(path).map_err(|e| e.to_string())?;
    let sheet_name = workbook
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| "Workbook has no sheets".to_string())?;
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|e| e.to_string())?;
    let mut rows_iter = range.rows();
    let header = rows_iter
        .next()
        .ok_or_else(|| "Import file has no rows".to_string())?;
    let columns = header
        .iter()
        .enumerate()
        .map(|(index, cell)| normalize_header(&xlsx_cell_label(cell), index))
        .collect::<Vec<_>>();
    if columns.is_empty() {
        return Err("Import file has no columns".to_string());
    }

    let mut rows = Vec::new();
    let mut total_rows = 0;
    for source_row in rows_iter {
        total_rows += 1;
        if rows.len() >= preview_limit {
            continue;
        }
        let mut row = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            row.push(
                source_row
                    .get(index)
                    .map(xlsx_cell_value)
                    .unwrap_or(serde_json::Value::Null),
            );
        }
        rows.push(row);
    }

    Ok(ParsedImportFile {
        columns,
        rows,
        total_rows,
    })
}

pub fn parse_import_file(path: &str, preview_limit: usize) -> Result<ParsedImportFile, String> {
    match import_file_kind(path)? {
        ImportFileKind::Csv => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            parse_csv_bytes(&bytes, preview_limit)
        }
        ImportFileKind::Tsv => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            parse_delimited_bytes(&bytes, b'\t', preview_limit)
        }
        ImportFileKind::Json => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            parse_json_bytes(&bytes, preview_limit)
        }
        ImportFileKind::Xlsx => parse_xlsx_file(path, preview_limit),
    }
}

pub fn mapping_indexes(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
) -> Result<Vec<(usize, String)>, String> {
    if mappings.is_empty() {
        return Err("No columns mapped for import".to_string());
    }
    let mut mapped = Vec::new();
    let mut target_seen = HashSet::new();
    for mapping in mappings {
        let source_index = data
            .columns
            .iter()
            .position(|column| column == &mapping.source_column)
            .ok_or_else(|| format!("Source column not found: {}", mapping.source_column))?;
        if mapping.target_column.trim().is_empty() {
            return Err("Target column cannot be empty".to_string());
        }
        if !target_seen.insert(mapping.target_column.clone()) {
            return Err(format!(
                "Target column mapped more than once: {}",
                mapping.target_column
            ));
        }
        mapped.push((source_index, mapping.target_column.clone()));
    }
    Ok(mapped)
}

pub fn build_import_insert_batches(
    data: &ParsedImportFile,
    mappings: &[TableImportColumnMapping],
    table: &str,
    schema: &str,
    db_type: &DatabaseType,
    batch_size: usize,
) -> Result<Vec<ImportSqlBatch>, String> {
    let mapped = mapping_indexes(data, mappings)?;
    let columns = mapped
        .iter()
        .map(|(_, target)| target.clone())
        .collect::<Vec<_>>();
    let batch_size = batch_size.max(1);
    let mut batches = Vec::new();

    for chunk in data.rows.chunks(batch_size) {
        let rows = chunk
            .iter()
            .map(|row| {
                mapped
                    .iter()
                    .map(|(source_index, _)| {
                        row.get(*source_index)
                            .cloned()
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let sql = generate_insert(&columns, &rows, table, schema, db_type);
        if !sql.trim().is_empty() {
            batches.push(ImportSqlBatch {
                sql,
                row_count: chunk.len(),
            });
        }
    }

    Ok(batches)
}

pub fn truncate_sql(table: &str, schema: &str, db_type: &DatabaseType) -> String {
    let full_table = qualified_table(table, schema, db_type);
    match db_type {
        DatabaseType::Sqlite => format!("DELETE FROM {full_table}"),
        _ => format!("TRUNCATE TABLE {full_table}"),
    }
}

pub fn preview_table_import_file_core(file_path: &str) -> Result<TableImportPreview, String> {
    let kind = import_file_kind(file_path)?;
    let parsed = parse_import_file(file_path, DEFAULT_PREVIEW_LIMIT)?;
    let metadata = std::fs::metadata(file_path).map_err(|e| e.to_string())?;
    let file_name = Path::new(file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file_path)
        .to_string();

    Ok(TableImportPreview {
        file_name,
        file_path: file_path.to_string(),
        file_type: kind.label().to_string(),
        size_bytes: metadata.len(),
        columns: parsed.columns,
        rows: parsed.rows,
        total_rows: parsed.total_rows,
    })
}

/// Core import logic. Returns (rows_imported, total_rows).
/// `progress_callback` is invoked for progress updates.
pub async fn import_table_file_core<F>(
    state: &AppState,
    request: &TableImportRequest,
    db_type: &DatabaseType,
    pool_key: &str,
    is_cancelled: impl Fn(&str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>>,
    mut progress_callback: F,
) -> Result<TableImportSummary, String>
where
    F: FnMut(TableImportProgress),
{
    let batch_size = if request.batch_size == 0 {
        DEFAULT_BATCH_SIZE
    } else {
        request.batch_size
    };

    let parsed = match parse_import_file(&request.file_path, usize::MAX) {
        Ok(parsed) => parsed,
        Err(error) => {
            progress_callback(TableImportProgress {
                import_id: request.import_id.clone(),
                status: TableImportStatus::Error,
                rows_imported: 0,
                total_rows: 0,
                error: Some(error.clone()),
            });
            return Err(error);
        }
    };

    let total_rows = parsed.total_rows;
    progress_callback(TableImportProgress {
        import_id: request.import_id.clone(),
        status: TableImportStatus::Running,
        rows_imported: 0,
        total_rows,
        error: None,
    });

    let batches = match build_import_insert_batches(
        &parsed,
        &request.mappings,
        &request.table,
        &request.schema,
        db_type,
        batch_size,
    ) {
        Ok(batches) => batches,
        Err(error) => {
            progress_callback(TableImportProgress {
                import_id: request.import_id.clone(),
                status: TableImportStatus::Error,
                rows_imported: 0,
                total_rows,
                error: Some(error.clone()),
            });
            return Err(error);
        }
    };

    if matches!(request.mode, TableImportMode::Truncate) {
        let sql = truncate_sql(&request.table, &request.schema, db_type);
        if let Err(error) = execute_on_pool(state, pool_key, &sql).await {
            progress_callback(TableImportProgress {
                import_id: request.import_id.clone(),
                status: TableImportStatus::Error,
                rows_imported: 0,
                total_rows,
                error: Some(error.clone()),
            });
            return Err(error);
        }
    }

    let mut rows_imported = 0;
    for batch in batches {
        if is_cancelled(&request.import_id).await {
            progress_callback(TableImportProgress {
                import_id: request.import_id.clone(),
                status: TableImportStatus::Cancelled,
                rows_imported,
                total_rows,
                error: None,
            });
            return Err("Import cancelled".to_string());
        }

        if let Err(error) = execute_on_pool(state, pool_key, &batch.sql).await {
            progress_callback(TableImportProgress {
                import_id: request.import_id.clone(),
                status: TableImportStatus::Error,
                rows_imported,
                total_rows,
                error: Some(error.clone()),
            });
            return Err(error);
        }
        rows_imported = (rows_imported + batch.row_count).min(total_rows);
        progress_callback(TableImportProgress {
            import_id: request.import_id.clone(),
            status: TableImportStatus::Running,
            rows_imported,
            total_rows,
            error: None,
        });
    }

    progress_callback(TableImportProgress {
        import_id: request.import_id.clone(),
        status: TableImportStatus::Done,
        rows_imported,
        total_rows,
        error: None,
    });

    Ok(TableImportSummary {
        import_id: request.import_id.clone(),
        rows_imported,
        total_rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::DatabaseType;

    #[test]
    fn parses_csv_headers_and_preview_rows() {
        let parsed = parse_csv_bytes(b"id,name,active\n1,Ada,true\n2,,false\n", 10).unwrap();

        assert_eq!(parsed.columns, vec!["id", "name", "active"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(
            parsed.rows[0],
            vec![
                serde_json::Value::String("1".to_string()),
                serde_json::Value::String("Ada".to_string()),
                serde_json::Value::String("true".to_string()),
            ]
        );
        assert_eq!(
            parsed.rows[1],
            vec![
                serde_json::Value::String("2".to_string()),
                serde_json::Value::Null,
                serde_json::Value::String("false".to_string()),
            ]
        );
    }

    #[test]
    fn parses_tsv_with_tab_delimiter() {
        let parsed = parse_delimited_bytes(b"id\tname\n1\tAda\n", b'\t', 10).unwrap();

        assert_eq!(parsed.columns, vec!["id", "name"]);
        assert_eq!(parsed.total_rows, 1);
        assert_eq!(
            parsed.rows[0],
            vec![
                serde_json::Value::String("1".to_string()),
                serde_json::Value::String("Ada".to_string()),
            ]
        );
    }

    #[test]
    fn parses_json_array_objects_with_union_columns() {
        let parsed =
            parse_json_bytes(br#"[{"id":1,"name":"Ada"},{"id":2,"active":true}]"#, 10).unwrap();

        assert_eq!(parsed.columns, vec!["id", "name", "active"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(
            parsed.rows[0],
            vec![
                serde_json::json!(1),
                serde_json::json!("Ada"),
                serde_json::Value::Null,
            ]
        );
        assert_eq!(
            parsed.rows[1],
            vec![
                serde_json::json!(2),
                serde_json::Value::Null,
                serde_json::json!(true),
            ]
        );
    }

    #[test]
    fn builds_import_insert_batches_from_mapped_columns() {
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "id".to_string(),
                target_column: "user_id".to_string(),
            },
            TableImportColumnMapping {
                source_column: "name".to_string(),
                target_column: "display_name".to_string(),
            },
        ];
        let data = ParsedImportFile {
            columns: vec!["id".to_string(), "name".to_string(), "ignored".to_string()],
            rows: vec![
                vec![
                    serde_json::json!(1),
                    serde_json::json!("Ada"),
                    serde_json::json!("x"),
                ],
                vec![
                    serde_json::json!(2),
                    serde_json::json!("O'Hara"),
                    serde_json::json!("y"),
                ],
                vec![
                    serde_json::json!(3),
                    serde_json::Value::Null,
                    serde_json::json!("z"),
                ],
            ],
            total_rows: 3,
        };

        let batches = build_import_insert_batches(
            &data,
            &mappings,
            "users",
            "public",
            &DatabaseType::Postgres,
            2,
        )
        .unwrap();

        assert_eq!(batches, vec![
            ImportSqlBatch {
                sql: "INSERT INTO \"public\".\"users\" (\"user_id\", \"display_name\") VALUES\n(1, 'Ada'),\n(2, 'O''Hara')".to_string(),
                row_count: 2,
            },
            ImportSqlBatch {
                sql: "INSERT INTO \"public\".\"users\" (\"user_id\", \"display_name\") VALUES\n(3, NULL)".to_string(),
                row_count: 1,
            },
        ]);
    }
}
