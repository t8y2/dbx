use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use dbx_core::models::connection::DatabaseType;
use dbx_core::table_import::{
    build_import_insert_batches, parse_delimited_file_with_options, parse_xlsx_file_with_options,
    preview_table_import_file_with_request, ParsedImportFile, TableImportColumnMapping, TableImportParseOptions,
    TableImportPreviewRequest, TableImportSourceFormat,
};
use dbx_core::xlsx_export::{build_xlsx_workbook, XlsxWorksheetData};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BenchFormat {
    Csv,
    Xlsx,
    All,
}

struct Options {
    rows: usize,
    columns: usize,
    batch_size: usize,
    format: BenchFormat,
}

fn print_help() {
    println!(
        "Table import benchmark\n\n\
Usage:\n  cargo run -p dbx-core --example table_import_bench --release -- [options]\n\n\
Options:\n  --rows=10000       Number of data rows\n  --columns=10       Number of columns\n  --batch-size=500   SQL rows per batch\n  --format=all       csv, xlsx, or all\n  --help             Show this help\n"
    );
}

fn parse_options() -> Result<Options, String> {
    let mut options = Options { rows: 10_000, columns: 10, batch_size: 500, format: BenchFormat::All };
    for argument in std::env::args().skip(1) {
        if argument == "--help" || argument == "-h" {
            print_help();
            std::process::exit(0);
        }
        let (key, value) = argument.split_once('=').ok_or_else(|| format!("Invalid option: {argument}"))?;
        match key {
            "--rows" => options.rows = value.parse().map_err(|_| format!("Invalid row count: {value}"))?,
            "--columns" => options.columns = value.parse().map_err(|_| format!("Invalid column count: {value}"))?,
            "--batch-size" => options.batch_size = value.parse().map_err(|_| format!("Invalid batch size: {value}"))?,
            "--format" => {
                options.format = match value {
                    "csv" => BenchFormat::Csv,
                    "xlsx" => BenchFormat::Xlsx,
                    "all" => BenchFormat::All,
                    _ => return Err(format!("Invalid format: {value}")),
                }
            }
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

fn row(row_index: usize, column_count: usize) -> Vec<serde_json::Value> {
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
}

fn write_csv(path: &Path, row_count: usize, column_count: usize) -> Result<(), String> {
    let file = File::create(path).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);
    writeln!(writer, "{}", columns(column_count).join(",")).map_err(|error| error.to_string())?;
    for row_index in 0..row_count {
        let values = row(row_index, column_count)
            .into_iter()
            .map(|value| value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))
            .collect::<Vec<_>>();
        writeln!(writer, "{}", values.join(",")).map_err(|error| error.to_string())?;
    }
    writer.flush().map_err(|error| error.to_string())
}

fn write_xlsx(path: &Path, row_count: usize, column_count: usize) -> Result<(), String> {
    let workbook = build_xlsx_workbook(&XlsxWorksheetData {
        sheet_name: Some("Benchmark".to_string()),
        columns: columns(column_count),
        column_types: vec![],
        rows: (0..row_count).map(|row_index| row(row_index, column_count)).collect(),
    })?;
    fs::write(path, workbook).map_err(|error| error.to_string())
}

fn mappings(data: &ParsedImportFile) -> Vec<TableImportColumnMapping> {
    data.columns
        .iter()
        .map(|column| TableImportColumnMapping {
            source_column: column.clone(),
            target_column: column.clone(),
            target_data_type: None,
        })
        .collect()
}

async fn benchmark_file(
    path: &Path,
    format: TableImportSourceFormat,
    options: &Options,
) -> Result<serde_json::Value, String> {
    let path_text = path.to_string_lossy();
    let parse_options = TableImportParseOptions::default();
    let preview_started = Instant::now();
    let preview = preview_table_import_file_with_request(TableImportPreviewRequest {
        file_path: path_text.to_string(),
        source_ref: None,
        source_format: Some(format),
        parse_options: parse_options.clone(),
        preview_limit: Some(50),
    })
    .await?;
    let preview_ms = preview_started.elapsed().as_secs_f64() * 1000.0;

    let full_parse_started = Instant::now();
    let parsed = match format {
        TableImportSourceFormat::Csv => {
            parse_delimited_file_with_options(&path_text, format, &parse_options, usize::MAX)?
        }
        TableImportSourceFormat::Excel => parse_xlsx_file_with_options(&path_text, &parse_options, usize::MAX)?,
        _ => unreachable!(),
    };
    let full_parse_ms = full_parse_started.elapsed().as_secs_f64() * 1000.0;

    let batch_started = Instant::now();
    let batches = build_import_insert_batches(
        &parsed,
        &mappings(&parsed),
        &[],
        "benchmark_import",
        "main",
        &DatabaseType::Sqlite,
        options.batch_size,
    )?;
    let batch_build_ms = batch_started.elapsed().as_secs_f64() * 1000.0;
    let sql_bytes = batches.iter().map(|batch| batch.sql.len()).sum::<usize>();

    Ok(serde_json::json!({
        "format": format.label(),
        "fileBytes": fs::metadata(path).map_err(|error| error.to_string())?.len(),
        "rows": parsed.total_rows,
        "columns": preview.columns.len(),
        "previewRows": preview.rows.len(),
        "previewTotalRowsExact": preview.total_rows_exact,
        "previewMs": preview_ms,
        "fullParseMs": full_parse_ms,
        "batchBuildMs": batch_build_ms,
        "batchCount": batches.len(),
        "sqlBytes": sql_bytes,
    }))
}

async fn run() -> Result<(), String> {
    let options = parse_options()?;
    let temp_dir = std::env::temp_dir().join(format!("dbx-table-import-bench-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;
    let mut results = Vec::new();

    if matches!(options.format, BenchFormat::Csv | BenchFormat::All) {
        let path = temp_dir.join("benchmark.csv");
        write_csv(&path, options.rows, options.columns)?;
        results.push(benchmark_file(&path, TableImportSourceFormat::Csv, &options).await?);
    }
    if matches!(options.format, BenchFormat::Xlsx | BenchFormat::All) {
        let path = temp_dir.join("benchmark.xlsx");
        write_xlsx(&path, options.rows, options.columns)?;
        results.push(benchmark_file(&path, TableImportSourceFormat::Excel, &options).await?);
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "rows": options.rows,
            "columns": options.columns,
            "batchSize": options.batch_size,
            "results": results,
        }))
        .map_err(|error| error.to_string())?
    );
    let _ = fs::remove_dir_all(temp_dir);
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
