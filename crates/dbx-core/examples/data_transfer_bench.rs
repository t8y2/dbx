use std::time::Instant;

use dbx_core::csv_export::format_query_result_csv_rows;
use dbx_core::database_export::{build_export_insert_statements, BuildExportInsertStatementsOptions};
use dbx_core::models::connection::DatabaseType;
use dbx_core::table_import::{build_import_insert_batches, ParsedImportFile, TableImportColumnMapping};
use dbx_core::xlsx_export::{build_xlsx_workbook, XlsxWorksheetData};

struct Options {
    rows: usize,
    columns: usize,
    batch_size: usize,
}

fn parse_options() -> Result<Options, String> {
    let mut options = Options { rows: 20_000, columns: 10, batch_size: 500 };
    for argument in std::env::args().skip(1) {
        let (key, value) = argument.split_once('=').ok_or_else(|| format!("Invalid option: {argument}"))?;
        match key {
            "--rows" => options.rows = value.parse().map_err(|_| format!("Invalid row count: {value}"))?,
            "--columns" => options.columns = value.parse().map_err(|_| format!("Invalid column count: {value}"))?,
            "--batch-size" => options.batch_size = value.parse().map_err(|_| format!("Invalid batch size: {value}"))?,
            _ => return Err(format!("Unknown option: {key}")),
        }
    }
    if options.rows == 0 || options.columns == 0 || options.batch_size == 0 {
        return Err("rows, columns, and batch-size must be greater than zero".to_string());
    }
    Ok(options)
}

fn columns(count: usize) -> Vec<String> {
    (0..count).map(|index| format!("column_{}", index + 1)).collect()
}

fn rows(row_count: usize, column_count: usize) -> Vec<Vec<serde_json::Value>> {
    (0..row_count)
        .map(|row_index| {
            (0..column_count)
                .map(|column_index| {
                    if column_index == 0 {
                        serde_json::json!(row_index + 1)
                    } else if column_index % 3 == 0 {
                        serde_json::json!(format!("2026-07-{:02} 12:34:56", row_index % 28 + 1))
                    } else {
                        serde_json::json!(format!("value-{row_index}-{column_index}"))
                    }
                })
                .collect()
        })
        .collect()
}

fn elapsed_ms(started_at: Instant) -> f64 {
    started_at.elapsed().as_secs_f64() * 1000.0
}

fn run() -> Result<(), String> {
    let options = parse_options()?;
    let columns = columns(options.columns);
    let rows = rows(options.rows, options.columns);
    let mappings = columns
        .iter()
        .map(|column| TableImportColumnMapping {
            source_column: column.clone(),
            target_column: column.clone(),
            target_data_type: None,
        })
        .collect::<Vec<_>>();
    let parsed = ParsedImportFile {
        columns: columns.clone(),
        rows: rows.clone(),
        total_rows: rows.len(),
        effective_encoding: None,
    };

    let import_started = Instant::now();
    let import_batches = build_import_insert_batches(
        &parsed,
        &mappings,
        &[],
        "benchmark_import",
        "main",
        &DatabaseType::Sqlite,
        options.batch_size,
    )?;
    let import_ms = elapsed_ms(import_started);

    let csv_started = Instant::now();
    let csv = format_query_result_csv_rows(&rows);
    let csv_ms = elapsed_ms(csv_started);

    let sql_started = Instant::now();
    let sql = build_export_insert_statements(BuildExportInsertStatementsOptions {
        database_type: Some(DatabaseType::Sqlite),
        identifier_quote: None,
        schema: Some("main".to_string()),
        table_name: Some("benchmark_export".to_string()),
        qualified_table_name: None,
        columns: columns.clone(),
        column_types: vec![None; columns.len()],
        column_extras: Vec::new(),
        spatial_columns: Vec::new(),
        spatial_values: Vec::new(),
        rows: rows.clone(),
        batch_size: Some(options.batch_size),
    })?;
    let sql_ms = elapsed_ms(sql_started);

    let xlsx_started = Instant::now();
    let xlsx = build_xlsx_workbook(&XlsxWorksheetData {
        sheet_name: Some("Benchmark".to_string()),
        columns,
        column_types: Vec::new(),
        column_comments: Vec::new(),
        rows,
        numeric_column_right_align: false,
    })?;
    let xlsx_ms = elapsed_ms(xlsx_started);

    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "rows": options.rows,
            "columns": options.columns,
            "batchSize": options.batch_size,
            "importSql": {
                "milliseconds": import_ms,
                "batches": import_batches.len(),
                "bytes": import_batches.iter().map(|batch| batch.sql.len()).sum::<usize>(),
            },
            "csv": {
                "milliseconds": csv_ms,
                "bytes": csv.len(),
            },
            "sqlExport": {
                "milliseconds": sql_ms,
                "statements": sql.len(),
                "bytes": sql.iter().map(String::len).sum::<usize>(),
            },
            "xlsx": {
                "milliseconds": xlsx_ms,
                "bytes": xlsx.len(),
            },
        }))
        .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
