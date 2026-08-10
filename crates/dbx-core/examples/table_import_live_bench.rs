use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;
use dbx_core::table_import::{
    import_table_file_core, TableImportColumnMapping, TableImportMode, TableImportParseOptions, TableImportPhase,
    TableImportRequest, TableImportSourceFormat,
};
use dbx_core::xlsx_export::{build_xlsx_workbook, XlsxWorksheetData};
use serde_json::json;
use sysinfo::{get_current_pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

#[derive(Debug, Clone, Copy)]
enum BenchDatabase {
    Mysql,
    Postgres,
    SqlServer,
}

impl BenchDatabase {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "mysql" => Ok(Self::Mysql),
            "postgres" => Ok(Self::Postgres),
            "sqlserver" => Ok(Self::SqlServer),
            _ => Err(format!("Unsupported database: {value}")),
        }
    }

    fn db_type(self) -> DatabaseType {
        match self {
            Self::Mysql => DatabaseType::Mysql,
            Self::Postgres => DatabaseType::Postgres,
            Self::SqlServer => DatabaseType::SqlServer,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Mysql => "mysql",
            Self::Postgres => "postgres",
            Self::SqlServer => "sqlserver",
        }
    }

    fn default_port(self) -> u16 {
        match self {
            Self::Mysql => 3306,
            Self::Postgres => 5432,
            Self::SqlServer => 1433,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum BenchFormat {
    Csv,
    Xlsx,
}

impl BenchFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "csv" => Ok(Self::Csv),
            "xlsx" => Ok(Self::Xlsx),
            _ => Err(format!("Unsupported format: {value}")),
        }
    }

    fn source_format(self) -> TableImportSourceFormat {
        match self {
            Self::Csv => TableImportSourceFormat::Csv,
            Self::Xlsx => TableImportSourceFormat::Excel,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Xlsx => "xlsx",
        }
    }
}

struct Options {
    database: BenchDatabase,
    format: BenchFormat,
    rows: usize,
    columns: usize,
    batch_size: usize,
    text_bytes: usize,
}

fn print_help() {
    println!(
        "Live table import benchmark\n\n\
Usage:\n  cargo run -p dbx-core --example table_import_live_bench --release -- [options]\n\n\
Options:\n\
  --database=postgres   mysql, postgres, or sqlserver\n\
  --format=csv          csv or xlsx\n\
  --rows=200000         Number of data rows\n\
  --columns=12          Number of columns\n\
  --batch-size=500      Import batch size\n\
  --text-bytes=0        Exact text value bytes; 0 keeps the default values\n\n\
Connection environment:\n\
  DBX_BENCH_HOST, DBX_BENCH_PORT, DBX_BENCH_USER, DBX_BENCH_PASSWORD,\n\
  DBX_BENCH_DATABASE, DBX_BENCH_SCHEMA, DBX_BENCH_SSL"
    );
}

fn parse_options() -> Result<Options, String> {
    let mut database = BenchDatabase::Postgres;
    let mut format = BenchFormat::Csv;
    let mut rows = 200_000;
    let mut columns = 12;
    let mut batch_size = 500;
    let mut text_bytes = 0;
    for argument in std::env::args().skip(1) {
        if matches!(argument.as_str(), "--help" | "-h") {
            print_help();
            std::process::exit(0);
        }
        let (key, value) = argument.split_once('=').ok_or_else(|| format!("Invalid option: {argument}"))?;
        match key {
            "--database" => database = BenchDatabase::parse(value)?,
            "--format" => format = BenchFormat::parse(value)?,
            "--rows" => rows = value.parse().map_err(|_| format!("Invalid row count: {value}"))?,
            "--columns" => columns = value.parse().map_err(|_| format!("Invalid column count: {value}"))?,
            "--batch-size" => batch_size = value.parse().map_err(|_| format!("Invalid batch size: {value}"))?,
            "--text-bytes" => text_bytes = value.parse().map_err(|_| format!("Invalid text byte count: {value}"))?,
            _ => return Err(format!("Unknown option: {key}")),
        }
    }
    if rows == 0 || columns < 2 || batch_size == 0 {
        return Err("rows and batch-size must be positive; columns must be at least 2".to_string());
    }
    Ok(Options { database, format, rows, columns, batch_size, text_bytes })
}

fn env_required(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("Missing environment variable: {name}"))
}

fn connection_config(id: &str, database: BenchDatabase) -> Result<ConnectionConfig, String> {
    let database_name = env_required("DBX_BENCH_DATABASE")?;
    Ok(ConnectionConfig {
        docs_notes_path: None,
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
        db_type: database.db_type(),
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: env_required("DBX_BENCH_HOST")?,
        port: std::env::var("DBX_BENCH_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or_else(|| database.default_port()),
        username: env_required("DBX_BENCH_USER")?,
        password: env_required("DBX_BENCH_PASSWORD")?,
        database: Some(database_name),
        default_schema: None,
        visible_databases: None,
        visible_schemas: None,
        show_system_schemas: false,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 15,
        query_timeout_secs: 120,
        idle_timeout_secs: 60,
        keepalive_interval_secs: 0,
        ssl: std::env::var("DBX_BENCH_SSL").is_ok_and(|value| value.eq_ignore_ascii_case("true")),
        ca_cert_path: String::new(),
        client_cert_path: String::new(),
        client_key_path: String::new(),
        sysdba: false,
        oracle_connection_type: None,
        connection_string: None,
        redis_connection_mode: None,
        redis_sentinel_master: String::new(),
        redis_sentinel_nodes: String::new(),
        redis_sentinel_username: String::new(),
        redis_sentinel_password: String::new(),
        redis_sentinel_tls: false,
        redis_cluster_nodes: String::new(),
        redis_key_separator: dbx_core::models::connection::default_redis_key_separator(),
        redis_scan_page_size: None,
        redis_database_aliases: Default::default(),
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        read_only: false,
        is_production: false,
        production_databases: Vec::new(),
        database_info: None,
    })
}

fn columns(count: usize) -> Vec<String> {
    (0..count).map(|index| format!("column_{}", index + 1)).collect()
}

fn row(row_index: usize, column_count: usize, text_bytes: usize) -> Vec<serde_json::Value> {
    (0..column_count)
        .map(|column_index| {
            if column_index == 0 {
                json!(row_index + 1)
            } else {
                let value = format!("value-{row_index:08}-{column_index:02}");
                if text_bytes == 0 {
                    json!(value)
                } else if value.len() >= text_bytes {
                    json!(&value[..text_bytes])
                } else {
                    json!(format!("{value}{}", "x".repeat(text_bytes - value.len())))
                }
            }
        })
        .collect()
}

fn write_csv(path: &Path, row_count: usize, column_count: usize, text_bytes: usize) -> Result<(), String> {
    let mut writer = BufWriter::new(File::create(path).map_err(|error| error.to_string())?);
    writeln!(writer, "{}", columns(column_count).join(",")).map_err(|error| error.to_string())?;
    for row_index in 0..row_count {
        writeln!(
            writer,
            "{}",
            row(row_index, column_count, text_bytes)
                .into_iter()
                .map(|value| value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))
                .collect::<Vec<_>>()
                .join(",")
        )
        .map_err(|error| error.to_string())?;
    }
    writer.flush().map_err(|error| error.to_string())
}

fn write_xlsx(path: &Path, row_count: usize, column_count: usize, text_bytes: usize) -> Result<(), String> {
    let workbook = build_xlsx_workbook(&XlsxWorksheetData {
        sheet_name: Some("Benchmark".to_string()),
        columns: columns(column_count),
        column_types: Vec::new(),
        column_comments: Vec::new(),
        rows: (0..row_count).map(|row_index| row(row_index, column_count, text_bytes)).collect(),
        numeric_column_right_align: false,
    })?;
    fs::write(path, workbook).map_err(|error| error.to_string())
}

struct PeakRssSampler {
    baseline_bytes: u64,
    peak_bytes: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl PeakRssSampler {
    fn start() -> Result<Self, String> {
        let pid = get_current_pid().map_err(|error| error.to_string())?;
        let mut system =
            System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new().with_memory()));
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::new().with_memory(),
        );
        let baseline_bytes = system.process(pid).map(|process| process.memory()).unwrap_or(0);
        let peak_bytes = Arc::new(AtomicU64::new(baseline_bytes));
        let stop = Arc::new(AtomicBool::new(false));
        let peak_for_thread = peak_bytes.clone();
        let stop_for_thread = stop.clone();
        let handle = thread::spawn(move || {
            let mut system =
                System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new().with_memory()));
            while !stop_for_thread.load(Ordering::Relaxed) {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&[pid]),
                    true,
                    ProcessRefreshKind::new().with_memory(),
                );
                if let Some(process) = system.process(pid) {
                    peak_for_thread.fetch_max(process.memory(), Ordering::Relaxed);
                }
                thread::sleep(Duration::from_millis(10));
            }
        });
        Ok(Self { baseline_bytes, peak_bytes, stop, thread: Some(handle) })
    }

    fn stop(mut self) -> (u64, u64) {
        self.shutdown();
        (self.baseline_bytes, self.peak_bytes.load(Ordering::Relaxed))
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for PeakRssSampler {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn qualified_table(database: BenchDatabase, schema: &str, table: &str) -> String {
    match database {
        BenchDatabase::Mysql => format!("`{schema}`.`{table}`"),
        BenchDatabase::Postgres => format!("\"{schema}\".\"{table}\""),
        BenchDatabase::SqlServer => format!("[{schema}].[{table}]"),
    }
}

async fn execute_sql(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    sql: &str,
) -> Result<(), String> {
    dbx_core::query::execute_sql_statement(state, connection_id, database, sql, Some(schema), None).await.map(|_| ())
}

fn create_table_sql(database: BenchDatabase, schema: &str, table: &str, column_count: usize) -> Vec<String> {
    let qualified = qualified_table(database, schema, table);
    let definitions = columns(column_count)
        .into_iter()
        .enumerate()
        .map(|(index, column)| match database {
            BenchDatabase::Mysql if index == 0 => format!("`{column}` BIGINT NOT NULL"),
            BenchDatabase::Mysql => format!("`{column}` TEXT NULL"),
            BenchDatabase::Postgres if index == 0 => format!("\"{column}\" BIGINT NOT NULL"),
            BenchDatabase::Postgres => format!("\"{column}\" TEXT NULL"),
            BenchDatabase::SqlServer if index == 0 => format!("[{column}] BIGINT NOT NULL"),
            BenchDatabase::SqlServer => format!("[{column}] NVARCHAR(200) NULL"),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut statements = Vec::new();
    if matches!(database, BenchDatabase::Postgres) {
        statements.push(format!("CREATE SCHEMA IF NOT EXISTS \"{schema}\""));
    }
    statements.push(format!("DROP TABLE IF EXISTS {qualified}"));
    statements.push(format!("CREATE TABLE {qualified} ({definitions})"));
    statements
}

fn import_request(
    connection_id: &str,
    database: &str,
    schema: &str,
    table: &str,
    path: &Path,
    options: &Options,
    import_id: &str,
) -> TableImportRequest {
    TableImportRequest {
        import_id: import_id.to_string(),
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        schema: schema.to_string(),
        table: table.to_string(),
        file_path: path.to_string_lossy().to_string(),
        source_ref: None,
        source_format: Some(options.format.source_format()),
        parse_options: TableImportParseOptions::default(),
        mappings: columns(options.columns)
            .into_iter()
            .map(|column| TableImportColumnMapping {
                source_column: column.clone(),
                target_column: column,
                target_data_type: None,
            })
            .collect(),
        mode: TableImportMode::Append,
        create_table: false,
        batch_size: options.batch_size,
        date_time_format: None,
        prepared_source: None,
        retain_source: false,
    }
}

async fn run() -> Result<(), String> {
    let options = parse_options()?;
    let database_name = env_required("DBX_BENCH_DATABASE")?;
    let schema = env_required("DBX_BENCH_SCHEMA")?;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("table-import-live-bench-{suffix}");
    let table = format!("dbx_import_bench_{}", &suffix[..12]);
    let temp_dir = tempfile::Builder::new()
        .prefix(&format!("dbx-table-import-live-bench-{suffix}-"))
        .tempdir()
        .map_err(|error| error.to_string())?;
    let source_path = temp_dir.path().join(format!("benchmark.{}", options.format.extension()));
    match options.format {
        BenchFormat::Csv => write_csv(&source_path, options.rows, options.columns, options.text_bytes)?,
        BenchFormat::Xlsx => write_xlsx(&source_path, options.rows, options.columns, options.text_bytes)?,
    }
    let file_bytes = fs::metadata(&source_path).map_err(|error| error.to_string())?.len();

    let storage = Storage::open(&temp_dir.path().join("storage.db")).await?;
    let state = AppState::new(storage);
    let config = connection_config(&connection_id, options.database)?;
    state.configs.write().await.insert(connection_id.clone(), config);
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database_name)).await?;
    let benchmark_result: Result<serde_json::Value, String> = async {
        for sql in create_table_sql(options.database, &schema, &table, options.columns) {
            execute_sql(&state, &connection_id, &database_name, &schema, &sql).await?;
        }
        let throughput_request = import_request(
            &connection_id,
            &database_name,
            &schema,
            &table,
            &source_path,
            &options,
            &format!("throughput-{suffix}"),
        );
        let rss = PeakRssSampler::start()?;
        let throughput_started = Instant::now();
        let throughput_summary = import_table_file_core(
            &state,
            &throughput_request,
            &options.database.db_type(),
            &pool_key,
            |_| Box::pin(async { false }),
            |_| {},
        )
        .await?;
        let throughput_elapsed = throughput_started.elapsed();
        let (baseline_rss_bytes, peak_rss_bytes) = rss.stop();
        if throughput_summary.rows_imported != options.rows {
            return Err(format!(
                "Import row count mismatch: expected {}, imported {}",
                options.rows, throughput_summary.rows_imported
            ));
        }

        execute_sql(
            &state,
            &connection_id,
            &database_name,
            &schema,
            &format!("TRUNCATE TABLE {}", qualified_table(options.database, &schema, &table)),
        )
        .await?;
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let cancel_requested_at = Arc::new(Mutex::new(None::<Instant>));
        let cancel_for_check = cancel_requested.clone();
        let cancel_for_progress = cancel_requested.clone();
        let cancel_time_for_progress = cancel_requested_at.clone();
        let cancel_request = import_request(
            &connection_id,
            &database_name,
            &schema,
            &table,
            &source_path,
            &options,
            &format!("cancel-{suffix}"),
        );
        let cancel_result = import_table_file_core(
            &state,
            &cancel_request,
            &options.database.db_type(),
            &pool_key,
            move |_| {
                let cancel = cancel_for_check.clone();
                Box::pin(async move { cancel.load(Ordering::Acquire) })
            },
            move |progress| {
                if progress.phase == TableImportPhase::Writing
                    && progress.rows_imported > 0
                    && cancel_for_progress.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
                {
                    *cancel_time_for_progress.lock().expect("cancel time lock") = Some(Instant::now());
                }
            },
        )
        .await;
        let cancel_latency = cancel_requested_at
            .lock()
            .map_err(|_| "cancel time lock poisoned".to_string())?
            .as_ref()
            .map(Instant::elapsed)
            .ok_or_else(|| "import completed before cancellation was requested".to_string())?;
        if !cancel_result.as_ref().is_err_and(|error| error.contains("cancelled")) {
            return Err(format!("Expected cancelled import, got: {cancel_result:?}"));
        }

        let rows_imported = throughput_summary.rows_imported;
        let elapsed_seconds = throughput_elapsed.as_secs_f64();
        Ok(json!({
            "database": options.database.label(),
            "format": options.format.extension(),
            "fileBytes": file_bytes,
            "rows": options.rows,
            "columns": options.columns,
            "batchSize": options.batch_size,
            "textBytes": options.text_bytes,
            "rowsImported": rows_imported,
            "elapsedMs": throughput_elapsed.as_secs_f64() * 1000.0,
            "rowsPerSecond": rows_imported as f64 / elapsed_seconds,
            "baselineRssBytes": baseline_rss_bytes,
            "peakRssBytes": peak_rss_bytes,
            "peakRssDeltaBytes": peak_rss_bytes.saturating_sub(baseline_rss_bytes),
            "cancellationLatencyMs": cancel_latency.as_secs_f64() * 1000.0,
        }))
    }
    .await;

    let cleanup_result = execute_sql(
        &state,
        &connection_id,
        &database_name,
        &schema,
        &format!("DROP TABLE IF EXISTS {}", qualified_table(options.database, &schema, &table)),
    )
    .await;
    state.remove_connection_pools_detached(&connection_id).await;
    let output = benchmark_result?;
    cleanup_result?;
    println!("{}", serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?);
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
