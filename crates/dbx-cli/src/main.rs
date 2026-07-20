use std::{env, path::PathBuf, process::ExitCode, sync::Arc};

use dbx_core::{
    models::connection::{ConnectionConfig, DatabaseType},
    production_safety::{is_production_database, targets_production_database},
    sql_risk::{classify_sql_risk_for_database, SqlRisk},
    types::{ColumnInfo, QueryResult, TableInfo},
};
use dbx_mcp::{
    mongo::{self, MongoSafetyError},
    DbxBackend, LocalBackend, WebBackend,
};
use serde::Serialize;
use serde_json::{json, Map, Value};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DIRECT_QUERY_TYPES: &[&str] =
    &["postgres", "redshift", "mysql", "doris", "starrocks", "manticoresearch", "sqlite", "rqlite", "kwdb", "questdb"];
const BRIDGE_REQUIRED_TYPES: &[&str] = &[
    "cloudflare-d1",
    "redis",
    "mongodb",
    "duckdb",
    "clickhouse",
    "sqlserver",
    "oracle",
    "elasticsearch",
    "qdrant",
    "milvus",
    "weaviate",
    "chromadb",
    "etcd",
    "dameng",
    "kingbase",
    "highgo",
    "vastbase",
    "goldendb",
    "databend",
    "gaussdb",
    "yashandb",
    "databricks",
    "saphana",
    "teradata",
    "vertica",
    "firebird",
    "exasol",
    "opengauss",
    "oceanbase-oracle",
    "gbase",
    "tdengine",
    "iotdb",
    "h2",
    "snowflake",
    "trino",
    "prestosql",
    "hive",
    "spark",
    "db2",
    "informix",
    "iris",
    "neo4j",
    "cassandra",
    "bigquery",
    "kylin",
    "sundb",
    "oscar",
    "xugu",
    "jdbc",
    "access",
    "influxdb",
    "zookeeper",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutputFormat {
    Table,
    Json,
    Csv,
}

#[derive(Debug)]
struct Flags {
    args: Vec<String>,
    format: OutputFormat,
    schema: Option<String>,
    database: Option<String>,
    tables: Vec<String>,
    max_tables: Option<usize>,
    max_rows: Option<usize>,
    timeout_ms: Option<u64>,
    file: Option<PathBuf>,
    allow_writes: bool,
    allow_dangerous: bool,
    help: bool,
    version: bool,
}

#[derive(Debug)]
struct CliError {
    code: &'static str,
    message: String,
}

impl CliError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    app_data_dir: String,
    db_path: String,
    db_path_exists: bool,
    connections_table_exists: bool,
    connection_row_count: usize,
    load_connections_ok: bool,
    loaded_connection_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_connections_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_connections_hint: Option<String>,
    bridge_port_file: String,
    bridge_port_file_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    bridge_url: Option<String>,
    direct_query_types: Vec<&'static str>,
    bridge_required_types: Vec<&'static str>,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(env::args().skip(1).collect()).await {
        Ok(output) => {
            print!("{output}");
            ExitCode::SUCCESS
        }
        Err((error, json_output)) => {
            if json_output {
                eprintln!(
                    "{}",
                    serde_json::to_string_pretty(&json!({ "error": { "code": error.code, "message": error.message } }))
                        .unwrap()
                );
            } else {
                eprintln!("Error [{}]: {}", error.code, error.message);
            }
            ExitCode::FAILURE
        }
    }
}

async fn run(argv: Vec<String>) -> Result<String, (CliError, bool)> {
    let wants_json = argv.iter().any(|arg| arg == "--json");
    let flags = parse_flags(&argv).map_err(|error| (error, wants_json))?;
    let json_output = flags.format == OutputFormat::Json;
    if flags.version {
        return Ok(format!("{VERSION}\n"));
    }
    if flags.args.is_empty() || flags.help || flags.args.first().is_some_and(|arg| arg == "help") {
        return Ok(format!("{}\n", usage()));
    }
    if flags.args[0] == "doctor" {
        ensure_arg_count(&flags.args, 1, "dbx doctor").map_err(|error| (error, json_output))?;
        let diagnostics = diagnostics().await;
        return format_diagnostics(&diagnostics, flags.format).map_err(|error| (error, json_output));
    }
    if flags.args[0] == "capabilities" {
        ensure_arg_count(&flags.args, 1, "dbx capabilities").map_err(|error| (error, json_output))?;
        return format_capabilities(flags.format).map_err(|error| (error, json_output));
    }

    let backend: Arc<dyn DbxBackend> = if let Ok(base_url) = env::var("DBX_WEB_URL") {
        Arc::new(
            WebBackend::new(base_url, env::var("DBX_WEB_PASSWORD").unwrap_or_default())
                .map_err(|message| (CliError::new("CONNECTION_STORE_ERROR", message), json_output))?,
        )
    } else {
        let db_path = dbx_mcp::paths::storage_db_path()
            .map_err(|message| (CliError::new("CONNECTION_STORE_ERROR", message), json_output))?;
        Arc::new(
            LocalBackend::open(&db_path)
                .await
                .map_err(|message| (CliError::new("CONNECTION_STORE_ERROR", message), json_output))?,
        )
    };

    let result = run_with_backend(backend.as_ref(), flags).await;
    result.map_err(|error| (error, json_output))
}

async fn run_with_backend(backend: &dyn DbxBackend, flags: Flags) -> Result<String, CliError> {
    let args = &flags.args;
    if args.first().is_some_and(|arg| arg == "connections") && args.get(1).is_some_and(|arg| arg == "list") {
        ensure_arg_count(args, 2, "dbx connections list")?;
        return format_connections(&backend.load_connections().await.map_err(store_error)?, flags.format);
    }
    if args.first().is_some_and(|arg| arg == "schema") && args.get(1).is_some_and(|arg| arg == "list") {
        ensure_arg_count(args, 3, "dbx schema list")?;
        let connection_name = required(args.get(2), "Connection name is required.")?;
        let connection = find_connection(backend, connection_name).await?;
        let database = selected_database(&connection, flags.database.as_deref());
        let schema = flags.schema.as_deref().unwrap_or("");
        let tables = backend.list_tables(&connection, &database, schema).await.map_err(command_error)?;
        return format_tables(connection_name, flags.schema.as_deref(), &tables, flags.format);
    }
    if args.first().is_some_and(|arg| arg == "schema") && args.get(1).is_some_and(|arg| arg == "describe") {
        ensure_arg_count(args, 4, "dbx schema describe")?;
        let connection_name = required(args.get(2), "Connection name is required.")?;
        let table = required(args.get(3), "Table name is required.")?;
        let connection = find_connection(backend, connection_name).await?;
        let database = selected_database(&connection, flags.database.as_deref());
        let schema = flags.schema.as_deref().unwrap_or("");
        let columns = backend.get_columns(&connection, &database, schema, table).await.map_err(command_error)?;
        return format_columns(connection_name, flags.schema.as_deref(), table, &columns, flags.format);
    }
    if args.first().is_some_and(|arg| arg == "query") {
        return run_query(backend, &flags).await;
    }
    if args.first().is_some_and(|arg| arg == "context") {
        return run_context(backend, &flags).await;
    }
    if args.first().is_some_and(|arg| arg == "open") {
        ensure_arg_count(args, 3, "dbx open")?;
        let connection = required(args.get(1), "Connection name is required.")?;
        let table = required(args.get(2), "Table name is required.")?;
        if flags.format == OutputFormat::Csv {
            return Err(CliError::new("INVALID_OPTION", "CSV format is not supported for dbx open."));
        }
        backend
            .bridge_request(
                "/open-table",
                optional_object([
                    ("connection_name", Some(json!(connection))),
                    ("table", Some(json!(table))),
                    ("schema", flags.schema.clone().map(|value| json!(value))),
                    ("database", flags.database.clone().map(|value| json!(value))),
                ]),
            )
            .await
            .map_err(|message| CliError::new("DBX_NOT_RUNNING", message))?;
        if flags.format == OutputFormat::Json {
            return json_string(&optional_object([
                ("opened", Some(json!(true))),
                ("connection", Some(json!(connection))),
                ("table", Some(json!(table))),
                ("schema", flags.schema.clone().map(|value| json!(value))),
                ("database", flags.database.clone().map(|value| json!(value))),
            ]));
        }
        return Ok(format!("Opened {table} in DBX\n"));
    }
    Err(CliError::new("USAGE", usage()))
}

async fn run_query(backend: &dyn DbxBackend, flags: &Flags) -> Result<String, CliError> {
    let args = &flags.args;
    let default_connection = env::var("DBX_CONNECTION").ok().filter(|value| !value.is_empty());
    let uses_default = default_connection.is_some() && args.len() == if flags.file.is_some() { 1 } else { 2 };
    ensure_arg_count(
        args,
        if uses_default {
            if flags.file.is_some() {
                1
            } else {
                2
            }
        } else if flags.file.is_some() {
            2
        } else {
            3
        },
        "dbx query",
    )?;
    let connection_name = if uses_default {
        default_connection.as_deref().unwrap()
    } else {
        required(args.get(1), "Connection name is required.")?
    };
    if flags.file.is_some() && args.get(2).is_some() {
        return Err(CliError::new("INVALID_ARGUMENT", "Provide SQL either inline or with --file, not both."));
    }
    let sql = if let Some(file) = &flags.file {
        tokio::fs::read_to_string(file).await.map_err(|error| CliError::new("ERROR", error.to_string()))?
    } else {
        required(args.get(if uses_default { 1 } else { 2 }), "SQL string or --file is required.")?.to_string()
    };
    let connection = find_connection(backend, connection_name).await?;
    let env_allow_writes = env_flag("DBX_MCP_ALLOW_WRITES");
    let env_allow_dangerous = env_flag("DBX_MCP_ALLOW_DANGEROUS_SQL");
    if flags.allow_dangerous && !flags.allow_writes && !env_allow_writes {
        return Err(CliError::new("INVALID_OPTION", "--allow-dangerous-sql requires --allow-writes."));
    }
    let allow_writes = flags.allow_writes || env_allow_writes;
    let allow_dangerous = flags.allow_dangerous || env_allow_dangerous;
    let database = selected_database(&connection, flags.database.as_deref());
    if connection.db_type == DatabaseType::Redis {
        return Err(CliError::new(
            "REDIS_COMMAND_REQUIRED",
            "Redis connections do not accept SQL through dbx query. Use an MCP Redis command tool or DBX directly.",
        ));
    }
    if connection.db_type == DatabaseType::MongoDb {
        let command = mongo::parse(&sql).map_err(|message| CliError::new("QUERY_ERROR", message))?;
        if let Err(error) = mongo::validate_safety(
            &command,
            allow_writes,
            allow_dangerous,
            is_production_database(&connection, &database),
        ) {
            return Err(match error {
                MongoSafetyError::WritesDisabled => {
                    CliError::new("SQL_BLOCKED", "MongoDB write command is blocked. Pass --allow-writes to allow it.")
                }
                MongoSafetyError::EmptyFilter => CliError::new(
                    "SQL_BLOCKED",
                    "MongoDB update/delete commands require a non-empty filter unless --allow-dangerous-sql is set.",
                ),
                MongoSafetyError::Dangerous => CliError::new(
                    "SQL_BLOCKED",
                    "Dangerous MongoDB command is blocked. Pass --allow-dangerous-sql to allow it.",
                ),
                MongoSafetyError::ProductionWrite => {
                    CliError::new("SQL_BLOCKED", "Writes and DDL are blocked for production databases.")
                }
            });
        }
        let mut result =
            backend.execute_mongo_command(&connection, &database, &command).await.map_err(command_error)?;
        truncate_query_result(&mut result, flags.max_rows);
        return format_query(connection_name, &result, flags.format);
    }
    let risk = classify_sql_risk_for_database(&sql, connection.db_type)
        .map_err(|message| CliError::new("SQL_BLOCKED", message))?;
    if risk == SqlRisk::Transaction
        || risk == SqlRisk::Write && !allow_writes
        || risk == SqlRisk::Ddl && !allow_dangerous
    {
        return Err(CliError::new("SQL_BLOCKED", format!("{risk} statement is blocked.")));
    }
    if risk != SqlRisk::ReadOnly && targets_production_database(&connection, &database, &sql) {
        return Err(CliError::new("SQL_BLOCKED", "Writes and DDL are blocked for production databases."));
    }
    let timeout_secs = flags.timeout_ms.map(|value| value.div_ceil(1000));
    let result = backend
        .execute_query(&connection, &database, &sql, flags.max_rows, timeout_secs)
        .await
        .map_err(command_error)?;
    format_query(connection_name, &result, flags.format)
}

fn truncate_query_result(result: &mut QueryResult, max_rows: Option<usize>) {
    let Some(max_rows) = max_rows else { return };
    if result.rows.len() > max_rows {
        result.rows.truncate(max_rows);
        result.truncated = true;
    }
}

async fn run_context(backend: &dyn DbxBackend, flags: &Flags) -> Result<String, CliError> {
    let args = &flags.args;
    let default_connection = env::var("DBX_CONNECTION").ok().filter(|value| !value.is_empty());
    let uses_default = default_connection.is_some() && args.len() == 1;
    ensure_arg_count(args, if uses_default { 1 } else { 2 }, "dbx context")?;
    if flags.format == OutputFormat::Csv {
        return Err(CliError::new("INVALID_OPTION", "CSV format is not supported for dbx context."));
    }
    let connection_name = if uses_default {
        default_connection.as_deref().unwrap()
    } else {
        required(args.get(1), "Connection name is required.")?
    };
    let connection = find_connection(backend, connection_name).await?;
    let database = selected_database(&connection, flags.database.as_deref());
    let schema = flags.schema.as_deref().unwrap_or("");
    let all_tables = backend.list_tables(&connection, &database, schema).await.map_err(command_error)?;
    let max_tables = flags.max_tables.unwrap_or(8).clamp(1, 20);
    let requested = !flags.tables.is_empty();
    let selected: Vec<TableInfo> = if !requested {
        all_tables.iter().take(max_tables).cloned().collect()
    } else {
        all_tables
            .iter()
            .filter(|table| flags.tables.iter().any(|name| name.eq_ignore_ascii_case(&table.name)))
            .cloned()
            .collect()
    };
    let truncated = selected.len() > max_tables || (!requested && all_tables.len() > max_tables);
    let selected = selected.into_iter().take(max_tables).collect::<Vec<_>>();
    let mut context_tables = Vec::new();
    for table in selected {
        let columns = backend.get_columns(&connection, &database, schema, &table.name).await.map_err(command_error)?;
        context_tables.push(json!({ "name": table.name, "type": table.table_type, "columns": columns }));
    }
    let payload = json!({
        "connection": connection_name,
        "database": database,
        "schema": schema,
        "truncated": truncated,
        "tables": context_tables,
    });
    if flags.format == OutputFormat::Json {
        return json_string(&payload);
    }
    let mut header = vec![format!("Connection: {connection_name}")];
    if !database.is_empty() {
        header.push(format!("Database: {database}"));
    }
    if !schema.is_empty() {
        header.push(format!("Schema: {schema}"));
    }
    let mut output = format!("{}\n", header.join("\n"));
    for table in payload["tables"].as_array().unwrap() {
        output.push_str(&format!(
            "\n## {}\nType: {}\n",
            table["name"].as_str().unwrap_or_default(),
            table["type"].as_str().unwrap_or_default()
        ));
        for column in table["columns"].as_array().unwrap_or(&Vec::new()) {
            output.push_str(&format!(
                "- {} {} {}{}{}\n",
                column["name"].as_str().unwrap_or_default(),
                column["data_type"].as_str().unwrap_or_default(),
                if column["is_nullable"].as_bool().unwrap_or(false) { "NULL" } else { "NOT NULL" },
                if column["is_primary_key"].as_bool().unwrap_or(false) { " PK" } else { "" },
                column["comment"].as_str().map(|comment| format!(" -- {comment}")).unwrap_or_default()
            ));
        }
    }
    if truncated {
        output.push_str("\nNote: table list was truncated; request specific table names for more context.\n");
    }
    Ok(output)
}

async fn find_connection(backend: &dyn DbxBackend, name: &str) -> Result<ConnectionConfig, CliError> {
    backend
        .load_connections()
        .await
        .map_err(store_error)?
        .into_iter()
        .find(|connection| connection.name.eq_ignore_ascii_case(name))
        .ok_or_else(|| CliError::new("CONNECTION_NOT_FOUND", format!("Connection \"{name}\" not found.")))
}

fn selected_database(connection: &ConnectionConfig, override_database: Option<&str>) -> String {
    override_database.map(ToOwned::to_owned).or_else(|| connection.database.clone()).unwrap_or_default()
}

fn parse_flags(argv: &[String]) -> Result<Flags, CliError> {
    let mut flags = Flags {
        args: Vec::new(),
        format: OutputFormat::Table,
        schema: None,
        database: None,
        tables: Vec::new(),
        max_tables: None,
        max_rows: None,
        timeout_ms: None,
        file: None,
        allow_writes: false,
        allow_dangerous: false,
        help: false,
        version: false,
    };
    let mut index = 0;
    while index < argv.len() {
        let arg = &argv[index];
        if arg == "--" {
            flags.args.extend(argv[index + 1..].iter().cloned());
            break;
        }
        match arg.as_str() {
            "--json" => flags.format = OutputFormat::Json,
            "--format" => {
                let value = option_value(argv, &mut index, "--format")?;
                flags.format = match value.as_str() {
                    "table" => OutputFormat::Table,
                    "json" => OutputFormat::Json,
                    "csv" => OutputFormat::Csv,
                    _ => return Err(CliError::new("INVALID_OPTION", "--format must be one of: table, json, csv.")),
                };
            }
            "--help" | "-h" => flags.help = true,
            "--version" | "-V" => flags.version = true,
            "--schema" => flags.schema = Some(option_value(argv, &mut index, "--schema")?),
            "--database" => flags.database = Some(option_value(argv, &mut index, "--database")?),
            "--tables" => {
                flags.tables = option_value(argv, &mut index, "--tables")?
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .collect()
            }
            "--max-tables" => {
                flags.max_tables =
                    Some(positive_usize(&option_value(argv, &mut index, "--max-tables")?, "--max-tables")?)
            }
            "--limit" => flags.max_rows = Some(positive_usize(&option_value(argv, &mut index, "--limit")?, "--limit")?),
            "--timeout" => {
                flags.timeout_ms = Some(duration_ms(&option_value(argv, &mut index, "--timeout")?, "--timeout")?)
            }
            "--file" => flags.file = Some(PathBuf::from(option_value(argv, &mut index, "--file")?)),
            "--allow-writes" => flags.allow_writes = true,
            "--allow-dangerous-sql" => flags.allow_dangerous = true,
            value if value.starts_with('-') => {
                return Err(CliError::new("UNKNOWN_OPTION", format!("Unknown option: {value}")))
            }
            _ => flags.args.push(arg.clone()),
        }
        index += 1;
    }
    Ok(flags)
}

fn option_value(argv: &[String], index: &mut usize, option: &'static str) -> Result<String, CliError> {
    *index += 1;
    argv.get(*index)
        .filter(|value| !value.starts_with('-'))
        .cloned()
        .ok_or_else(|| CliError::new("INVALID_OPTION", format!("{option} requires a value.")))
}

fn positive_usize(value: &str, option: &'static str) -> Result<usize, CliError> {
    value
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| CliError::new("INVALID_OPTION", format!("{option} must be a positive integer.")))
}

fn duration_ms(value: &str, option: &'static str) -> Result<u64, CliError> {
    let (number, multiplier) = if let Some(value) = value.strip_suffix("ms") {
        (value, 1)
    } else if let Some(value) = value.strip_suffix('s') {
        (value, 1000)
    } else if let Some(value) = value.strip_suffix('m') {
        (value, 60_000)
    } else {
        (value, 1)
    };
    number
        .parse::<u64>()
        .ok()
        .filter(|amount| *amount > 0)
        .and_then(|amount| amount.checked_mul(multiplier))
        .ok_or_else(|| {
            CliError::new("INVALID_OPTION", format!("{option} must be a positive duration such as 500ms, 10s, or 1m."))
        })
}

fn ensure_arg_count(args: &[String], count: usize, command: &'static str) -> Result<(), CliError> {
    if args.len() == count {
        Ok(())
    } else {
        Err(CliError::new(
            "INVALID_ARGUMENT",
            format!("{command} expects {} argument(s); received {}.", count - 1, args.len().saturating_sub(1)),
        ))
    }
}

fn required<'a>(value: Option<&'a String>, message: &'static str) -> Result<&'a str, CliError> {
    value.map(String::as_str).filter(|value| !value.is_empty()).ok_or_else(|| CliError::new("ERROR", message))
}

fn env_flag(name: &str) -> bool {
    env::var(name).ok().is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
}

fn store_error(message: String) -> CliError {
    CliError::new("CONNECTION_STORE_ERROR", message)
}
fn command_error(message: String) -> CliError {
    CliError::new("ERROR", message)
}

fn db_type_name(db_type: DatabaseType) -> String {
    serde_json::to_value(db_type)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| format!("{db_type:?}").to_ascii_lowercase())
}

fn format_connections(connections: &[ConnectionConfig], format: OutputFormat) -> Result<String, CliError> {
    let rows: Vec<Value> = connections
        .iter()
        .map(|connection| {
            optional_object([
                ("name", Some(json!(connection.name))),
                ("type", Some(json!(db_type_name(connection.db_type)))),
                ("host", Some(json!(connection.host))),
                ("port", Some(json!(connection.port))),
                ("database", connection.database.clone().filter(|value| !value.is_empty()).map(|value| json!(value))),
            ])
        })
        .collect();
    match format {
        OutputFormat::Json => json_string(&json!({ "connections": rows })),
        OutputFormat::Csv => Ok(csv_table(&["name", "type", "host", "port", "database"], &rows)),
        OutputFormat::Table => Ok(format!(
            "{}\n",
            markdown_table(
                &["Name", "Type", "Host", "Port", "Database"],
                &rows,
                &["name", "type", "host", "port", "database"]
            )
        )),
    }
}

fn format_tables(
    connection: &str,
    schema: Option<&str>,
    tables: &[TableInfo],
    format: OutputFormat,
) -> Result<String, CliError> {
    let rows: Vec<Value> = tables
        .iter()
        .map(|table| optional_object([("name", Some(json!(table.name))), ("type", Some(json!(table.table_type)))]))
        .collect();
    match format {
        OutputFormat::Json => json_string(&optional_object([
            ("connection", Some(json!(connection))),
            ("schema", schema.map(|value| json!(value))),
            ("tables", Some(json!(rows))),
        ])),
        OutputFormat::Csv => Ok(csv_table(&["name", "type"], &rows)),
        OutputFormat::Table => Ok(format!("{}\n", markdown_table(&["Table", "Type"], &rows, &["name", "type"]))),
    }
}

fn format_columns(
    connection: &str,
    schema: Option<&str>,
    table: &str,
    columns: &[ColumnInfo],
    format: OutputFormat,
) -> Result<String, CliError> {
    if format == OutputFormat::Json {
        return json_string(&optional_object([
            ("connection", Some(json!(connection))),
            ("schema", schema.map(|value| json!(value))),
            ("table", Some(json!(table))),
            ("columns", Some(json!(columns))),
        ]));
    }
    let rows: Vec<Value> = columns.iter().map(|column| json!({ "name": column.name, "data_type": column.data_type, "is_nullable": column.is_nullable, "is_primary_key": column.is_primary_key, "column_default": column.column_default, "comment": column.comment, "display_name": if column.is_primary_key { format!("{} (PK)", column.name) } else { column.name.clone() }, "nullable": if column.is_nullable { "YES" } else { "NO" } })).collect();
    if format == OutputFormat::Csv {
        return Ok(csv_table(
            &["name", "data_type", "is_nullable", "is_primary_key", "column_default", "comment"],
            &rows,
        ));
    }
    Ok(format!(
        "{}\n",
        markdown_table(
            &["Column", "Type", "Nullable", "Default", "Comment"],
            &rows,
            &["display_name", "data_type", "nullable", "column_default", "comment"]
        )
    ))
}

fn format_query(connection: &str, result: &QueryResult, format: OutputFormat) -> Result<String, CliError> {
    let rows: Vec<Value> = result
        .rows
        .iter()
        .map(|values| {
            Value::Object(result.columns.iter().cloned().zip(values.iter().cloned()).collect::<Map<String, Value>>())
        })
        .collect();
    let row_count = if result.columns.is_empty() { result.affected_rows } else { result.rows.len() as u64 };
    match format {
        OutputFormat::Json => json_string(
            &json!({ "connection": connection, "columns": result.columns, "rows": rows, "row_count": row_count }),
        ),
        OutputFormat::Csv => Ok(csv_table(&result.columns.iter().map(String::as_str).collect::<Vec<_>>(), &rows)),
        OutputFormat::Table if result.columns.is_empty() => {
            Ok(format!("Query executed. {row_count} row(s) affected.\n"))
        }
        OutputFormat::Table => Ok(format!(
            "{}\n\n{row_count} row(s)\n",
            markdown_table(
                &result.columns.iter().map(String::as_str).collect::<Vec<_>>(),
                &rows,
                &result.columns.iter().map(String::as_str).collect::<Vec<_>>()
            )
        )),
    }
}

fn format_capabilities(format: OutputFormat) -> Result<String, CliError> {
    match format {
        OutputFormat::Json => json_string(
            &json!({ "directQueryTypes": DIRECT_QUERY_TYPES, "bridgeRequiredTypes": BRIDGE_REQUIRED_TYPES }),
        ),
        OutputFormat::Csv => {
            let rows: Vec<Value> = DIRECT_QUERY_TYPES
                .iter()
                .map(|kind| json!({ "mode": "direct", "type": kind }))
                .chain(BRIDGE_REQUIRED_TYPES.iter().map(|kind| json!({ "mode": "bridge", "type": kind })))
                .collect();
            Ok(csv_table(&["mode", "type"], &rows))
        }
        OutputFormat::Table => {
            let rows = vec![
                json!({ "mode": "Direct", "types": DIRECT_QUERY_TYPES.join(", ") }),
                json!({ "mode": "Requires DBX Desktop", "types": BRIDGE_REQUIRED_TYPES.join(", ") }),
            ];
            Ok(format!("{}\n", markdown_table(&["Mode", "Types"], &rows, &["mode", "types"])))
        }
    }
}

async fn diagnostics() -> Diagnostics {
    let app_data_dir = dbx_mcp::paths::app_data_dir().unwrap_or_default();
    let db_path = app_data_dir.join(dbx_mcp::paths::STORAGE_DB_FILE_NAME);
    let bridge_port_file = app_data_dir.join("mcp-bridge-port");
    let db_path_exists = db_path.exists();
    let bridge_port_file_exists = bridge_port_file.exists();
    let bridge_url = if bridge_port_file_exists {
        tokio::fs::read_to_string(&bridge_port_file).await.ok().map(|port| format!("http://127.0.0.1:{}", port.trim()))
    } else {
        None
    };
    let loaded = if db_path_exists {
        match LocalBackend::open(&db_path).await {
            Ok(backend) => backend.load_connections().await,
            Err(error) => Err(error),
        }
    } else {
        Err("DBX database does not exist.".to_string())
    };
    let (load_connections_ok, connections, error) = match loaded {
        Ok(connections) => (true, connections, None),
        Err(error) => (false, Vec::new(), Some(error)),
    };
    Diagnostics {
        app_data_dir: app_data_dir.display().to_string(),
        db_path: db_path.display().to_string(),
        db_path_exists,
        connections_table_exists: load_connections_ok,
        connection_row_count: connections.len(),
        load_connections_ok,
        loaded_connection_count: connections.len(),
        load_connections_error: error,
        load_connections_hint: None,
        bridge_port_file: bridge_port_file.display().to_string(),
        bridge_port_file_exists,
        bridge_url,
        direct_query_types: DIRECT_QUERY_TYPES.to_vec(),
        bridge_required_types: BRIDGE_REQUIRED_TYPES.to_vec(),
    }
}

fn format_diagnostics(value: &Diagnostics, format: OutputFormat) -> Result<String, CliError> {
    if format == OutputFormat::Json {
        return json_string(value);
    }
    let rows = vec![
        json!({ "check": "App data directory", "value": value.app_data_dir }),
        json!({ "check": "DBX database", "value": if value.db_path_exists { format!("found ({})", value.db_path) } else { format!("missing ({})", value.db_path) } }),
        json!({ "check": "Connections table", "value": if value.connections_table_exists { format!("{} row(s)", value.connection_row_count) } else { "missing".to_string() } }),
        json!({ "check": "Connection loading", "value": if value.load_connections_ok { format!("ok ({} loaded)", value.loaded_connection_count) } else { format!("failed ({})", value.load_connections_error.as_deref().unwrap_or("unknown error")) } }),
        json!({ "check": "Desktop bridge", "value": if value.bridge_port_file_exists { format!("available ({})", value.bridge_url.as_deref().unwrap_or(&value.bridge_port_file)) } else { "not running".to_string() } }),
        json!({ "check": "Direct query types", "value": value.direct_query_types.join(", ") }),
        json!({ "check": "Bridge-required types", "value": value.bridge_required_types.join(", ") }),
    ];
    if format == OutputFormat::Csv {
        return Ok(csv_table(&["check", "value"], &rows));
    }
    Ok(format!("{}\n", markdown_table(&["Check", "Value"], &rows, &["check", "value"])))
}

fn json_string(value: &impl Serialize) -> Result<String, CliError> {
    serde_json::to_string_pretty(value)
        .map(|value| format!("{value}\n"))
        .map_err(|error| CliError::new("ERROR", error.to_string()))
}

fn optional_object<const N: usize>(fields: [(&str, Option<Value>); N]) -> Value {
    let mut object = Map::new();
    for (key, value) in fields {
        if let Some(value) = value {
            object.insert(key.to_string(), value);
        }
    }
    Value::Object(object)
}

fn markdown_table(headers: &[&str], rows: &[Value], keys: &[&str]) -> String {
    let mut output = format!("| {} |\n| {} |", headers.join(" | "), vec!["---"; headers.len()].join(" | "));
    for row in rows {
        output.push_str(&format!(
            "\n| {} |",
            keys.iter().map(|key| format_cell(&row[*key])).collect::<Vec<_>>().join(" | ")
        ));
    }
    output
}

fn csv_table(headers: &[&str], rows: &[Value]) -> String {
    let mut output = format!("{}\n", headers.join(","));
    for row in rows {
        output.push_str(&format!(
            "{}\n",
            headers.iter().map(|key| csv_cell(&format_cell(&row[*key]))).collect::<Vec<_>>().join(",")
        ));
    }
    output
}

fn format_cell(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.replace('|', "\\|").replace('\n', " "),
        Value::Bool(value) => value.to_string(),
        other => other.to_string(),
    }
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn usage() -> &'static str {
    "Usage:\n  dbx doctor [--json]\n  dbx capabilities [--json]\n  dbx connections list [--json]\n  dbx schema list <connection> [--schema name] [--json]\n  dbx schema describe <connection> <table> [--schema name] [--json]\n  dbx query <connection> <sql> [--file path] [--limit n] [--timeout 10s] [--allow-writes] [--allow-dangerous-sql] [--json]\n  dbx context <connection> [--schema name] [--tables a,b] [--max-tables n] [--json]\n  dbx open <connection> <table> [--schema name] [--database name] [--json]"
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use dbx_core::{
        agent_events::ToolResult,
        agent_tools::AgentSqlPermissions,
        storage::{McpGlobalPolicy, Storage},
    };
    use dbx_mcp::{backend::new_connection_config, mongo::MongoCommand};

    struct MongoBackend {
        connection: ConnectionConfig,
    }

    impl MongoBackend {
        fn new() -> Self {
            Self {
                connection: new_connection_config(
                    "mongo-test".to_string(),
                    "local-mongo".to_string(),
                    DatabaseType::MongoDb,
                    "127.0.0.1".to_string(),
                    27017,
                    String::new(),
                    String::new(),
                    Some("test".to_string()),
                    false,
                    None,
                )
                .unwrap(),
            }
        }
    }

    #[async_trait]
    impl DbxBackend for MongoBackend {
        async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
            Ok(McpGlobalPolicy::default())
        }

        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            Ok(vec![self.connection.clone()])
        }

        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            _tool_name: &str,
            _arguments: Value,
            _permissions: AgentSqlPermissions,
        ) -> ToolResult {
            panic!("Mongo CLI queries must not fall through to agent SQL execution")
        }

        async fn execute_mongo_command(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            command: &MongoCommand,
        ) -> Result<QueryResult, String> {
            assert!(matches!(command, MongoCommand::Insert { collection, .. } if collection == "products"));
            Ok(QueryResult {
                columns: Vec::new(),
                column_types: Vec::new(),
                column_sortables: Vec::new(),
                rows: Vec::new(),
                affected_rows: 2,
                execution_time_ms: 0,
                truncated: false,
                session_id: None,
                has_more: false,
            })
        }

        async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
            Ok(config)
        }

        async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
            Ok(true)
        }
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parses_existing_json_and_query_flags() {
        let flags =
            parse_flags(&args(&["query", "local", "select 1", "--limit", "50", "--timeout", "10s", "--json"])).unwrap();
        assert_eq!(flags.args, args(&["query", "local", "select 1"]));
        assert_eq!(flags.max_rows, Some(50));
        assert_eq!(flags.timeout_ms, Some(10_000));
        assert!(flags.format == OutputFormat::Json);
    }

    #[test]
    fn preserves_double_dash_sql() {
        let flags = parse_flags(&args(&["query", "local", "--json", "--", "-- comment\nselect 1"])).unwrap();
        assert_eq!(flags.args, args(&["query", "local", "-- comment\nselect 1"]));
    }

    #[test]
    fn rejects_unknown_options_with_stable_code() {
        let error = parse_flags(&args(&["connections", "list", "--wat"])).unwrap_err();
        assert_eq!(error.code, "UNKNOWN_OPTION");
    }

    #[test]
    fn formats_csv_using_existing_escaping_rules() {
        let rows = vec![json!({ "name": "alpha,beta", "value": "a\"b" })];
        assert_eq!(csv_table(&["name", "value"], &rows), "name,value\n\"alpha,beta\",\"a\"\"b\"\n");
    }

    #[test]
    fn dangerous_sql_requires_explicit_permission() {
        let risk = classify_sql_risk_for_database("drop table users", DatabaseType::Postgres).unwrap();
        assert_eq!(risk, SqlRisk::Ddl);
    }

    #[tokio::test]
    async fn routes_legacy_mongo_insert_through_shared_mongo_backend() {
        let flags = parse_flags(&args(&[
            "query",
            "local-mongo",
            "db.products.insert([{name: 'first'}, {name: 'second'}])",
            "--allow-writes",
            "--json",
        ]))
        .unwrap();
        let output = run_with_backend(&MongoBackend::new(), flags).await.unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["connection"], "local-mongo");
        assert_eq!(value["row_count"], 2);
        assert_eq!(value["columns"], json!([]));
    }

    #[tokio::test]
    async fn blocks_mongo_writes_without_explicit_permission() {
        let flags =
            parse_flags(&args(&["query", "local-mongo", "db.products.insertOne({name: 'demo'})", "--json"])).unwrap();
        let error = run_with_backend(&MongoBackend::new(), flags).await.unwrap_err();
        assert_eq!(error.code, "SQL_BLOCKED");
    }

    #[tokio::test]
    #[ignore = "requires DBX_MCP_TEST_MONGO_HOST and DBX_MCP_TEST_MONGO_PASSWORD"]
    async fn executes_legacy_mongo_insert_without_desktop_process() {
        let host = env::var("DBX_MCP_TEST_MONGO_HOST").expect("MongoDB host");
        let port = env::var("DBX_MCP_TEST_MONGO_PORT")
            .unwrap_or_else(|_| "27017".to_string())
            .parse::<u16>()
            .expect("MongoDB port");
        let password = env::var("DBX_MCP_TEST_MONGO_PASSWORD").expect("MongoDB password");
        let directory = tempfile::tempdir().expect("temporary data directory");
        let db_path = directory.path().join("dbx.db");
        let storage = Storage::open(&db_path).await.expect("open storage");
        let mut connection = new_connection_config(
            "mongo-cli-e2e".to_string(),
            "mongo-cli-e2e".to_string(),
            DatabaseType::MongoDb,
            host,
            port,
            "root".to_string(),
            password,
            Some("dbx_mcp_test".to_string()),
            false,
            None,
        )
        .unwrap();
        connection.url_params = Some("authSource=admin".to_string());
        storage.save_connections(&[connection]).await.expect("save connection");
        let backend = LocalBackend::open(&db_path).await.expect("open local backend");

        let cleanup = parse_flags(&args(&[
            "query",
            "mongo-cli-e2e",
            "db.items.deleteMany({_id: {$in: ['rust-cli-e2e-1', 'rust-cli-e2e-2']}})",
            "--allow-writes",
        ]))
        .unwrap();
        run_with_backend(&backend, cleanup).await.expect("initial cleanup");

        let insert = parse_flags(&args(&[
            "query",
            "mongo-cli-e2e",
            "db.items.insert([{_id: 'rust-cli-e2e-1', name: 'Ada'}, {_id: 'rust-cli-e2e-2', name: 'Grace'}])",
            "--allow-writes",
            "--json",
        ]))
        .unwrap();
        let inserted: Value = serde_json::from_str(&run_with_backend(&backend, insert).await.unwrap()).unwrap();
        assert_eq!(inserted["row_count"], 2);

        let find = parse_flags(&args(&[
            "query",
            "mongo-cli-e2e",
            "db.items.find({_id: {$in: ['rust-cli-e2e-1', 'rust-cli-e2e-2']}}).sort({_id: 1})",
            "--json",
        ]))
        .unwrap();
        let found: Value = serde_json::from_str(&run_with_backend(&backend, find).await.unwrap()).unwrap();
        assert_eq!(found["row_count"], 2);
        assert_eq!(found["rows"][0]["name"], "Ada");
        assert_eq!(found["rows"][1]["name"], "Grace");

        let cleanup = parse_flags(&args(&[
            "query",
            "mongo-cli-e2e",
            "db.items.deleteMany({_id: {$in: ['rust-cli-e2e-1', 'rust-cli-e2e-2']}})",
            "--allow-writes",
        ]))
        .unwrap();
        run_with_backend(&backend, cleanup).await.expect("final cleanup");
    }
}
