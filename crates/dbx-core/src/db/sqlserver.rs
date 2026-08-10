use crate::query::MAX_ROWS;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, LinkedServerInfo, ObjectStatistics, QueryMessage, QueryResult,
    SpatialColumnBuilder, TableInfo, TriggerInfo,
};
use futures::{FutureExt, TryStreamExt};
use sqlparser::ast::{Expr, Ident, ObjectNamePart, OrderByKind, SelectItem, SetExpr, Statement, TableFactor, Value};
use sqlparser::dialect::MsSqlDialect;
use sqlparser::parser::Parser;
use std::borrow::Cow;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc as StdArc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tiberius::{
    AuthMethod, Client, ColumnData, ColumnType, Config, FromSql, QueryItem, QueryStream, Row, SqlBrowser, TokenRow,
};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use tokio_util::sync::CancellationToken;
use tracing::instrument::WithSubscriber;
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::{Context as LayerContext, SubscriberExt};
use tracing_subscriber::Layer;

pub type SqlServerClient = Client<Compat<TcpStream>>;
pub const SQLSERVER_DRIVER_PANIC_ERROR_PREFIX: &str = "SQL Server driver panic:";
pub const SQLSERVER_LEGACY_DRIVER_PROFILE: &str = "sqlserver-legacy";
pub const SQLSERVER_LEGACY_DRIVER_LABEL: &str = "SQL Server legacy compatibility component";
const SQLSERVER_DEFAULT_PORT: u16 = 1433;
const SQLSERVER_UNSAFE_PROBE_BLOCK_ERROR_PREFIX: &str = "SQL Server unsafe result type:";
const SQLSERVER_RESULT_TYPE_PROBE_SQL: &str = "\
    DECLARE @dbx_use_describe_dmv bit = CASE \
        WHEN @P2 = 0 AND OBJECT_ID(N'sys.dm_exec_describe_first_result_set') IS NOT NULL THEN 1 ELSE 0 END; \
    SELECT @dbx_use_describe_dmv AS dbx_use_describe_dmv; \
    IF @dbx_use_describe_dmv = 1 \
    BEGIN \
        EXEC sys.sp_executesql \
            N'SELECT name, system_type_name, user_type_schema, user_type_name \
              FROM sys.dm_exec_describe_first_result_set(@sql, NULL, 0) \
              WHERE error_number IS NULL AND is_hidden = 0 \
              ORDER BY column_ordinal', \
            N'@sql nvarchar(max)', @sql = @P1 \
    END \
    ELSE \
    BEGIN \
        DECLARE @dbx_probe_table sysname = N'##dbx_result_type_probe_' + CONVERT(nvarchar(12), @@SPID); \
        DECLARE @dbx_probe_object nvarchar(258) = N'tempdb..' + QUOTENAME(@dbx_probe_table); \
        DECLARE @dbx_probe_sql nvarchar(max); \
        BEGIN TRY \
            SET @dbx_probe_sql = N'SELECT TOP (0) * INTO ' + QUOTENAME(@dbx_probe_table) + \
                N' FROM ' + @P3; \
            EXEC sys.sp_executesql @dbx_probe_sql; \
            SELECT c.name, TYPE_NAME(c.system_type_id) AS system_type_name, \
                   SCHEMA_NAME(t.schema_id) AS user_type_schema, t.name AS user_type_name \
            FROM tempdb.sys.columns c \
            JOIN tempdb.sys.types t ON c.user_type_id = t.user_type_id \
            WHERE c.object_id = OBJECT_ID(@dbx_probe_object) \
            ORDER BY c.column_id; \
            SET @dbx_probe_sql = N'DROP TABLE ' + QUOTENAME(@dbx_probe_table); \
            EXEC sys.sp_executesql @dbx_probe_sql; \
        END TRY \
        BEGIN CATCH \
            IF OBJECT_ID(@dbx_probe_object) IS NOT NULL \
            BEGIN \
                SET @dbx_probe_sql = N'DROP TABLE ' + QUOTENAME(@dbx_probe_table); \
                EXEC sys.sp_executesql @dbx_probe_sql; \
            END \
            DECLARE @dbx_probe_error nvarchar(2048) = ERROR_MESSAGE(); \
            RAISERROR(@dbx_probe_error, 16, 1); \
        END CATCH \
    END";
const SIMPLE_QUERY_MODULE_KEYWORDS: &[&str] = &["FUNCTION", "PROC", "PROCEDURE", "TRIGGER", "VIEW"];
// Match JDBC/tiberius `encrypt=false`: encrypt only login, then drop back to raw TDS.
const SQLSERVER_LEGACY_ENCRYPTION_LEVEL: tiberius::EncryptionLevel = tiberius::EncryptionLevel::Off;
// Some very old SQL Server setups only accepted DBX <= 0.5.48 because the fallback
// advertised no encryption support at all. Keep it as the last-resort compatibility path.
const SQLSERVER_UNSUPPORTED_ENCRYPTION_LEVEL: tiberius::EncryptionLevel = tiberius::EncryptionLevel::NotSupported;
const SQLSERVER_LEGACY_ENCRYPTION_FALLBACKS: [(&str, tiberius::EncryptionLevel); 2] = [
    ("login-only encryption", SQLSERVER_LEGACY_ENCRYPTION_LEVEL),
    ("no-encryption compatibility fallback", SQLSERVER_UNSUPPORTED_ENCRYPTION_LEVEL),
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SqlServerColumnMetadata {
    #[serde(flatten)]
    pub column: ColumnInfo,
    pub is_identity: bool,
    pub is_computed: bool,
    pub is_hidden: bool,
    pub generated_always_type: i32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct SqlServerCompletionContext {
    pub default_schema: String,
    pub supports_session_database_switch: bool,
}

const SQLSERVER_COMPLETION_CONTEXT_SQL: &str = "\
    SELECT COALESCE(\
        (SELECT default_schema.name \
         FROM sys.schemas default_schema \
         WHERE default_schema.name = SCHEMA_NAME()), \
        N'dbo'\
    ) AS default_schema, \
    CONVERT(int, SERVERPROPERTY(N'EngineEdition')) AS engine_edition";

fn sqlserver_supports_session_database_switch(engine_edition: i32) -> bool {
    // Only known boxed SQL Server, Managed Instance, and SQL Edge editions are
    // allowed to switch databases. Cloud single-database endpoints and future
    // editions default to opening a connection directly to the target database.
    matches!(engine_edition, 1 | 2 | 3 | 4 | 8 | 9)
}

fn sqlserver_completion_context(
    default_schema: Option<&str>,
    engine_edition: Option<i32>,
) -> Result<SqlServerCompletionContext, String> {
    let default_schema = default_schema.map(str::trim).filter(|schema| !schema.is_empty()).unwrap_or("dbo");
    let engine_edition = engine_edition.ok_or_else(|| "SQL Server EngineEdition is unavailable".to_string())?;
    Ok(SqlServerCompletionContext {
        default_schema: default_schema.to_string(),
        supports_session_database_switch: sqlserver_supports_session_database_switch(engine_edition),
    })
}

pub fn completion_context_sql() -> &'static str {
    SQLSERVER_COMPLETION_CONTEXT_SQL
}

pub fn completion_context_from_query_result(result: QueryResult) -> Result<SqlServerCompletionContext, String> {
    let row = result.rows.first().ok_or_else(|| "SQL Server completion context query returned no rows".to_string())?;
    let default_schema = row.first().and_then(serde_json::Value::as_str);
    let engine_edition = row.get(1).and_then(|value| {
        value
            .as_i64()
            .and_then(|value| i32::try_from(value).ok())
            .or_else(|| value.as_str()?.trim().parse::<i32>().ok())
    });
    sqlserver_completion_context(default_schema, engine_edition)
}

#[derive(Debug, PartialEq, Eq)]
struct SqlServerEndpoint<'a> {
    host: &'a str,
    instance_name: Option<&'a str>,
}

fn sqlserver_endpoint(host: &str) -> SqlServerEndpoint<'_> {
    if let Some((server, instance)) = host.split_once('\\') {
        if !server.trim().is_empty() && !instance.trim().is_empty() {
            return SqlServerEndpoint { host: server.trim(), instance_name: Some(instance.trim()) };
        }
    }

    SqlServerEndpoint { host: host.trim(), instance_name: None }
}

fn sqlserver_uses_named_instance_resolution(endpoint: &SqlServerEndpoint<'_>, port: u16, port_explicit: bool) -> bool {
    endpoint.instance_name.is_some() && (port == 0 || (port == SQLSERVER_DEFAULT_PORT && !port_explicit))
}

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(MAX_ROWS).max(1)
}

pub async fn connect(
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    database: Option<&str>,
    _url_params: Option<&str>,
    timeout: Duration,
) -> Result<SqlServerClient, String> {
    connect_with_port_explicit(host, port, false, user, pass, database, timeout).await
}

pub async fn connect_with_port_explicit(
    host: &str,
    port: u16,
    port_explicit: bool,
    user: &str,
    pass: &str,
    database: Option<&str>,
    timeout: Duration,
) -> Result<SqlServerClient, String> {
    match try_connect(host, port, port_explicit, user, pass, database, tiberius::EncryptionLevel::Required, timeout)
        .await
    {
        Ok(client) => Ok(client),
        Err(encrypted_error) => {
            try_connect_legacy_sqlserver_encryption(host, port, port_explicit, user, pass, database, timeout)
                .await
                .map_err(|plain_error| {
                    if is_sqlserver_tls_handshake_error(&encrypted_error) {
                        format!(
                        "{encrypted_error}\n\nThis may be caused by an old SQL Server TLS/encryption configuration. \
                         If you are connecting to SQL Server 2008/2008 R2/2012 or another legacy instance, \
                         try SQL Server legacy compatibility mode. It first behaves like encrypt=false and, \
                         when explicitly enabled, DBX can also fall back to the SQL Server legacy compatibility \
                         driver for TLS 1.0 encrypted transport. Only use this mode on trusted networks, VPNs, \
                         or SSH tunnels.\n\n\
                         Automatic native legacy fallback also failed: {plain_error}"
                    )
                    } else {
                        plain_error
                    }
                })
        }
    }
}

async fn try_connect_legacy_sqlserver_encryption(
    host: &str,
    port: u16,
    port_explicit: bool,
    user: &str,
    pass: &str,
    database: Option<&str>,
    timeout: Duration,
) -> Result<SqlServerClient, String> {
    let mut errors = Vec::new();
    for (label, encryption) in SQLSERVER_LEGACY_ENCRYPTION_FALLBACKS {
        match try_connect(host, port, port_explicit, user, pass, database, encryption, timeout).await {
            Ok(client) => return Ok(client),
            Err(error) => errors.push(format!("{label} failed: {error}")),
        }
    }

    Err(errors.join("\n"))
}

pub fn sqlserver_native_encryption_disabled(url_params: Option<&str>) -> bool {
    let Some(params) = url_params.map(str::trim).filter(|params| !params.is_empty()) else {
        return false;
    };

    params.trim_start_matches('?').split(['&', ';']).filter_map(|pair| pair.split_once('=')).any(|(key, value)| {
        let key = key.trim();
        let value = value.trim().to_ascii_lowercase();
        let disabled = matches!(value.as_str(), "disabled" | "disable" | "false" | "0" | "off" | "no");
        (key.eq_ignore_ascii_case("sqlserverEncryption") || key.eq_ignore_ascii_case("encrypt")) && disabled
    })
}

fn is_sqlserver_tls_handshake_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("tls") && (error.contains("handshake") || error.contains("eof") || error.contains("performing i/o"))
}

async fn try_connect(
    host: &str,
    port: u16,
    port_explicit: bool,
    user: &str,
    pass: &str,
    database: Option<&str>,
    encryption: tiberius::EncryptionLevel,
    timeout: Duration,
) -> Result<SqlServerClient, String> {
    let mut config = Config::new();
    let endpoint = sqlserver_endpoint(host);
    let uses_named_instance_resolution = sqlserver_uses_named_instance_resolution(&endpoint, port, port_explicit);
    config.host(endpoint.host);
    if let Some(instance_name) = endpoint.instance_name.filter(|_| uses_named_instance_resolution) {
        config.instance_name(instance_name);
    } else {
        config.port(port);
    }
    config.authentication(AuthMethod::sql_server(user, pass));
    if let Some(db) = database {
        config.database(db);
    }
    config.trust_cert();
    config.encryption(encryption);

    let tcp = if uses_named_instance_resolution {
        tokio::time::timeout(timeout, TcpStream::connect_named(&config))
            .await
            .map_err(|_| format!("SQL Server connection timed out ({}s)", timeout.as_secs()))?
            .map_err(|e| format!("SQL Server connection failed: {e}"))?
    } else {
        tokio::time::timeout(timeout, TcpStream::connect(config.get_addr()))
            .await
            .map_err(|_| format!("SQL Server connection timed out ({}s)", timeout.as_secs()))?
            .map_err(|e| format!("SQL Server connection failed: {e}"))?
    };
    tokio::time::timeout(timeout, Client::connect(config, tcp.compat_write()))
        .await
        .map_err(|_| format!("SQL Server handshake timed out ({}s)", timeout.as_secs()))?
        .map_err(|e| format!("SQL Server connection failed: {e}"))
}

fn row_to_json(row: &tiberius::Row) -> Vec<serde_json::Value> {
    row.cells().map(|(_, cell)| sqlserver_cell_to_json(cell)).collect()
}

fn sqlserver_spatial_marker(value: serde_json::Value) -> (serde_json::Value, Option<u32>) {
    let serde_json::Value::String(text) = value else {
        return (value, None);
    };
    let Some(rest) = text.strip_prefix("SRID=") else {
        return (serde_json::Value::String(text), None);
    };
    let Some((srid, wkt)) = rest.split_once(';') else {
        return (serde_json::Value::String(text), None);
    };
    let Ok(srid) = srid.parse::<i64>() else {
        return (serde_json::Value::String(wkt.to_string()), None);
    };
    let srid = u32::try_from(srid).ok().filter(|value| *value != 0);
    (serde_json::Value::String(wkt.to_string()), srid)
}

fn row_to_json_with_spatial_metadata(
    row: &tiberius::Row,
    spatial_columns: &[SqlServerSpatialColumn],
    on_srid: impl FnMut(usize, Option<u32>),
) -> (Vec<serde_json::Value>, Vec<Option<u32>>) {
    let mut values = row_to_json(row);
    let srids = decode_sqlserver_spatial_values(&mut values, spatial_columns, on_srid);
    (values, srids)
}

/// Decode `SRID=n;WKT` markers into plain WKT, returning the per-cell SRIDs
/// (`None` for non-spatial cells or unknown SRIDs). Every geometry value keeps
/// its own SRID so mixed-SRID columns stay correct.
fn decode_sqlserver_spatial_values(
    values: &mut [serde_json::Value],
    spatial_columns: &[SqlServerSpatialColumn],
    mut on_srid: impl FnMut(usize, Option<u32>),
) -> Vec<Option<u32>> {
    let mut srids = vec![None; values.len()];
    for spatial_column in spatial_columns {
        let Some(value) = values.get_mut(spatial_column.column_index) else {
            continue;
        };
        let (wkt, srid) = sqlserver_spatial_marker(std::mem::take(value));
        *value = wkt;
        srids[spatial_column.column_index] = srid;
        on_srid(spatial_column.column_index, srid);
    }
    srids
}

fn restore_sqlserver_spatial_column_types(column_types: &mut [String], spatial_columns: &[SqlServerSpatialColumn]) {
    for spatial_column in spatial_columns {
        if let Some(column_type) = column_types.get_mut(spatial_column.column_index) {
            column_type.clone_from(&spatial_column.column_type);
        }
    }
}

fn columns_from_metadata(metadata: &tiberius::ResultMetadata) -> Vec<String> {
    metadata.columns().iter().map(|c| c.name().to_string()).collect()
}

fn sqlserver_column_type_name(column: &tiberius::Column) -> String {
    match column.column_type() {
        ColumnType::BigVarChar => "varchar".to_string(),
        ColumnType::BigChar => "char".to_string(),
        ColumnType::BigVarBin => "varbinary".to_string(),
        ColumnType::BigBinary => "binary".to_string(),
        column_type => format!("{column_type:?}").to_lowercase(),
    }
}

fn column_types_from_metadata(metadata: &tiberius::ResultMetadata) -> Vec<String> {
    metadata.columns().iter().map(sqlserver_column_type_name).collect()
}

const SQLSERVER_MESSAGE_COLUMN: &str = "Message";
// Tiberius 0.12.3 emits both user-visible INFO tokens and internal ENVCHANGE
// tokens at the same tracing target/level. DONE tokens are also consumed before
// QueryStream yields its next public item. Keep these callsite guards in sync
// with the pinned driver when Tiberius is upgraded.
const TIBERIUS_INFO_TOKEN_EVENT_LINE: u32 = 194;
const TIBERIUS_DONE_TOKEN_EVENT_LINE: u32 = 153;
const TIBERIUS_DONE_PROC_TOKEN_EVENT_LINE: u32 = 159;
const TIBERIUS_DONE_IN_PROC_TOKEN_EVENT_LINE: u32 = 165;

#[derive(Debug, Clone)]
pub(crate) struct SqlServerBatchResult {
    pub result: QueryResult,
    pub server_message: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SqlServerTdsEvent {
    Message(String),
    Done(Option<u64>),
}

#[derive(Clone, Default)]
struct SqlServerTdsEventLayer {
    events: StdArc<StdMutex<Vec<SqlServerTdsEvent>>>,
}

impl SqlServerTdsEventLayer {
    fn take_events(&self) -> Vec<SqlServerTdsEvent> {
        self.events.lock().map(|mut events| std::mem::take(&mut *events)).unwrap_or_default()
    }
}

impl<S> Layer<S> for SqlServerTdsEventLayer
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: LayerContext<'_, S>) {
        let metadata = event.metadata();
        if metadata.target() != "tiberius::tds::stream::token" {
            return;
        }

        let mut visitor = SqlServerMessageVisitor::default();
        event.record(&mut visitor);
        let Some(message) = visitor.message.filter(|message| !message.trim().is_empty()) else {
            return;
        };
        let captured = match (metadata.level(), metadata.line()) {
            (&Level::INFO, Some(TIBERIUS_INFO_TOKEN_EVENT_LINE)) => Some(SqlServerTdsEvent::Message(message)),
            (&Level::TRACE, Some(line)) => sqlserver_done_trace_event(line, &message),
            _ => None,
        };
        if let (Some(captured), Ok(mut events)) = (captured, self.events.lock()) {
            events.push(captured);
        }
    }
}

#[derive(Default)]
struct SqlServerMessageVisitor {
    message: Option<String>,
}

impl tracing::field::Visit for SqlServerMessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = Some(format!("{value:?}").trim_matches('"').to_string());
        }
    }
}

fn sqlserver_done_trace_event(line: u32, message: &str) -> Option<SqlServerTdsEvent> {
    if !matches!(
        line,
        TIBERIUS_DONE_TOKEN_EVENT_LINE | TIBERIUS_DONE_PROC_TOKEN_EVENT_LINE | TIBERIUS_DONE_IN_PROC_TOKEN_EVENT_LINE
    ) {
        return None;
    }
    if line == TIBERIUS_DONE_PROC_TOKEN_EVENT_LINE && message.contains("BitFlags<DoneStatus>(0b0)") {
        return None;
    }
    let rows = if !message.contains("Count") {
        None
    } else if message.ends_with("(1 row left)") {
        Some(1)
    } else if let Some(prefix) = message.strip_suffix(" rows left)") {
        Some(prefix.rsplit_once('(').and_then(|(_, rows)| rows.parse::<u64>().ok()).unwrap_or(0))
    } else {
        Some(0)
    };
    Some(SqlServerTdsEvent::Done(rows))
}

async fn capture_sqlserver_messages<F, T>(future: F) -> (T, Vec<String>)
where
    F: Future<Output = T>,
{
    let layer = SqlServerTdsEventLayer::default();
    let captured = layer.clone();
    // Tiberius consumes TDS INFO tokens internally and exposes them only as
    // tracing events. Scope collection to this future to isolate connections.
    let output = future.with_subscriber(tracing_subscriber::registry().with(layer)).await;
    let messages = captured
        .take_events()
        .into_iter()
        .filter_map(|event| match event {
            SqlServerTdsEvent::Message(message) => Some(message),
            SqlServerTdsEvent::Done(_) => None,
        })
        .collect();
    (output, messages)
}

/// Map captured tiberius INFO-token texts to generic query messages. Tiberius
/// exposes only the message text in its tracing event, so severity is always
/// `INFO` and no code/detail/hint is available.
fn sqlserver_query_messages(messages: &[String]) -> Vec<QueryMessage> {
    messages
        .iter()
        .map(|message| QueryMessage {
            severity: "INFO".to_string(),
            message: message.clone(),
            code: None,
            detail: None,
            hint: None,
        })
        .collect()
}

fn query_result_with_server_messages(result: QueryResult, messages: Vec<String>) -> QueryResult {
    query_result_with_server_messages_metadata(result, messages).result
}

fn query_result_with_server_messages_metadata(mut result: QueryResult, messages: Vec<String>) -> SqlServerBatchResult {
    if messages.is_empty() {
        return SqlServerBatchResult { result, server_message: false };
    }
    if !result.columns.is_empty() || !result.rows.is_empty() {
        // Tabular results keep their shape and additionally carry the
        // messages; only the empty-result synthesis below leaves
        // `messages` empty so consumers do not render the same text twice.
        result.messages = sqlserver_query_messages(&messages);
        return SqlServerBatchResult { result, server_message: false };
    }

    // Empty results synthesize the legacy single-"Message"-column grid; the
    // text lives only there, so `messages` stays empty to avoid consumers
    // rendering the same text twice.
    result.columns = vec![SQLSERVER_MESSAGE_COLUMN.to_string()];
    result.column_types = vec!["nvarchar".to_string()];
    result.rows = messages.into_iter().map(|message| vec![serde_json::Value::String(message)]).collect();
    SqlServerBatchResult { result, server_message: true }
}

fn server_messages_query_result(messages: Vec<String>, start: Instant) -> Option<SqlServerBatchResult> {
    if messages.is_empty() {
        return None;
    }

    Some(query_result_with_server_messages_metadata(
        QueryResult {
            columns: vec![],
            column_types: vec![],
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        },
        messages,
    ))
}

async fn collect_first_result_limited(
    mut stream: QueryStream<'_>,
    start: Instant,
    max_rows: Option<usize>,
    result_offset: usize,
    spatial_columns: &[SqlServerSpatialColumn],
) -> Result<QueryResult, String> {
    let row_limit = query_result_row_limit(max_rows);
    let mut remaining_offset = result_offset;
    let mut columns: Vec<String> = vec![];
    let mut column_types: Vec<String> = vec![];
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut spatial_values: Vec<Vec<Option<u32>>> = Vec::new();
    let mut spatial_values_builder =
        SpatialColumnBuilder::new(spatial_columns.iter().map(|column| column.column_index));
    let mut truncated = false;

    while let Some(item) = stream.try_next().await.map_err(|e| e.to_string())? {
        match item {
            QueryItem::Metadata(metadata) if metadata.result_index() == 0 => {
                columns = columns_from_metadata(&metadata);
                column_types = column_types_from_metadata(&metadata);
                restore_sqlserver_spatial_column_types(&mut column_types, spatial_columns);
            }
            QueryItem::Metadata(_) => {}
            QueryItem::Row(row) if row.result_index() == 0 => {
                if remaining_offset > 0 {
                    remaining_offset -= 1;
                    continue;
                }
                if rows.len() < row_limit {
                    let (values, srids) =
                        row_to_json_with_spatial_metadata(&row, spatial_columns, |column_index, srid| {
                            spatial_values_builder.observe(column_index, srid);
                        });
                    rows.push(values);
                    spatial_values.push(srids);
                } else {
                    truncated = true;
                }
            }
            QueryItem::Row(_) => {}
        }
    }

    restore_sqlserver_spatial_column_types(&mut column_types, spatial_columns);

    Ok(QueryResult {
        columns,
        column_types,
        column_sortables: vec![],
        spatial_columns: spatial_values_builder.finish(),
        spatial_values,
        rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
        elasticsearch_raw_body: None,
        messages: Vec::new(),
    })
}

struct SqlServerResultSet {
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    truncated: bool,
    remaining_offset: usize,
}

pub struct SqlServerStreamExportSummary {
    pub columns: Vec<String>,
    pub rows_exported: u64,
}

pub enum SqlServerStreamItem<'a> {
    Columns { columns: &'a [String], column_types: &'a [String] },
    Row(&'a [serde_json::Value]),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerDescribedColumn {
    name: Option<String>,
    system_type_name: Option<String>,
    user_type_schema: Option<String>,
    user_type_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerSpatialColumn {
    column_index: usize,
    column_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerUnsafeTypeQuery {
    sql: String,
    spatial_columns: Vec<SqlServerSpatialColumn>,
}

impl SqlServerUnsafeTypeQuery {
    fn plain(sql: &str) -> Self {
        Self { sql: sql.to_string(), spatial_columns: Vec::new() }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SqlServerLegacyProbe {
    source_sql: String,
    output_names: Option<Vec<Option<String>>>,
    output_name_overrides: Vec<SqlServerProbeOutputNameOverride>,
}

#[derive(Debug, PartialEq, Eq)]
struct SqlServerWildcardProjectionProbe {
    statement: String,
    output_name_overrides: Vec<SqlServerProbeOutputNameOverride>,
}

#[derive(Debug, PartialEq, Eq)]
struct SqlServerProbeOutputNameOverride {
    projection_ordinal: usize,
    probe_name: String,
    output_name: Option<String>,
}

async fn sqlserver_driver_result<T, E, F>(future: F) -> Result<T, String>
where
    F: Future<Output = Result<T, E>>,
    E: ToString,
{
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(_) => Err(format!(
            "{SQLSERVER_DRIVER_PANIC_ERROR_PREFIX} the current client will be rebuilt. \
                 Unsupported columns may need to be cast to text."
        )),
    }
}

pub fn is_driver_panic_error(error: &str) -> bool {
    error.starts_with(SQLSERVER_DRIVER_PANIC_ERROR_PREFIX)
}

async fn describe_sqlserver_result_set(
    client: &mut SqlServerClient,
    sql: &str,
    legacy_probe: &SqlServerLegacyProbe,
) -> Result<Vec<SqlServerDescribedColumn>, String> {
    describe_sqlserver_result_set_with_mode(client, sql, legacy_probe, false).await
}

async fn describe_sqlserver_result_set_with_mode(
    client: &mut SqlServerClient,
    sql: &str,
    legacy_probe: &SqlServerLegacyProbe,
    force_legacy: bool,
) -> Result<Vec<SqlServerDescribedColumn>, String> {
    // SQL Server 2008 has no first-result-set DMV. Keep one probe round trip by
    // selecting the modern DMV path server-side and using metadata-only execution otherwise.
    let force_legacy = i32::from(force_legacy);
    let mut stream = sqlserver_driver_result(
        client.query(SQLSERVER_RESULT_TYPE_PROBE_SQL, &[&sql, &force_legacy, &legacy_probe.source_sql]),
    )
    .await?;
    let mut active_result_index = None;
    let mut uses_describe_dmv = None;
    let mut rows = Vec::new();

    loop {
        let item = match sqlserver_driver_result(stream.try_next()).await {
            Ok(item) => item,
            Err(error) if uses_describe_dmv == Some(false) => {
                let error = format!("{SQLSERVER_UNSAFE_PROBE_BLOCK_ERROR_PREFIX} {error}");
                if is_sqlserver_legacy_duplicate_probe_error(&error) {
                    let Some(metadata_sql) = sqlserver_legacy_wildcard_metadata_query(sql) else {
                        return Err(error);
                    };
                    drop(stream);
                    return describe_sqlserver_legacy_wildcard_result_set(client, &metadata_sql).await;
                }
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let Some(item) = item else {
            break;
        };
        match item {
            QueryItem::Metadata(result_metadata) => {
                active_result_index = Some(result_metadata.result_index());
            }
            QueryItem::Row(row) if active_result_index == Some(0) => {
                uses_describe_dmv = row.try_get::<bool, _>(0).ok().flatten();
            }
            QueryItem::Row(row) => rows.push(row),
        }
    }

    if uses_describe_dmv.is_none() {
        return Err("SQL Server result type probe did not report its compatibility mode".to_string());
    }
    let mut columns = rows.iter().map(sqlserver_described_column_from_row).collect::<Vec<_>>();
    if uses_describe_dmv == Some(false) {
        restore_sqlserver_legacy_probe_output_names(&mut columns, legacy_probe);
    }
    Ok(columns)
}

fn is_sqlserver_legacy_duplicate_probe_error(error: &str) -> bool {
    error.starts_with(SQLSERVER_UNSAFE_PROBE_BLOCK_ERROR_PREFIX)
        && error.to_ascii_lowercase().contains("dbx_probe_source")
}

async fn describe_sqlserver_legacy_wildcard_result_set(
    client: &mut SqlServerClient,
    metadata_sql: &str,
) -> Result<Vec<SqlServerDescribedColumn>, String> {
    let rows = sqlserver_driver_result(client.query(metadata_sql, &[]))
        .await
        .map_err(|error| format!("{SQLSERVER_UNSAFE_PROBE_BLOCK_ERROR_PREFIX} {error}"))?
        .into_first_result()
        .await
        .map_err(|error| format!("{SQLSERVER_UNSAFE_PROBE_BLOCK_ERROR_PREFIX} {error}"))?;
    if rows.is_empty() {
        return Err(format!(
            "{SQLSERVER_UNSAFE_PROBE_BLOCK_ERROR_PREFIX} legacy wildcard metadata capture returned no columns"
        ));
    }
    Ok(rows.iter().map(sqlserver_described_column_from_row).collect())
}

fn sqlserver_legacy_wildcard_metadata_query(sql: &str) -> Option<String> {
    let statement = normalized_sqlserver_select_statement(sql)?;
    let statements = Parser::parse_sql(&MsSqlDialect {}, &statement.inner).ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return None;
    };
    if !matches!(select.projection.as_slice(), [SelectItem::Wildcard(_)]) {
        return None;
    }

    let mut relations = Vec::new();
    for source in &select.from {
        relations.push(sqlserver_legacy_wildcard_relation(&source.relation)?);
        for join in &source.joins {
            relations.push(sqlserver_legacy_wildcard_relation(&join.relation)?);
        }
    }
    if relations.is_empty() {
        return None;
    }

    let checks = relations
        .iter()
        .map(|relation| {
            format!(
                "IF OBJECT_ID({}) IS NULL RAISERROR(N'Unable to inspect wildcard source metadata', 16, 1);",
                sqlserver_nstring_literal(&relation.object_name)
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let selects = relations
        .iter()
        .enumerate()
        .map(|(index, relation)| {
            let catalog = relation.catalog_prefix;
            format!(
                "SELECT {} AS dbx_source_ordinal, c.column_id AS dbx_column_ordinal, c.name, \
                 TYPE_NAME(c.system_type_id) AS system_type_name, s.name AS user_type_schema, t.name AS user_type_name \
                 FROM {catalog}sys.columns c \
                 JOIN {catalog}sys.types t ON c.user_type_id = t.user_type_id \
                 JOIN {catalog}sys.schemas s ON t.schema_id = s.schema_id \
                 WHERE c.object_id = OBJECT_ID({})",
                index + 1,
                sqlserver_nstring_literal(&relation.object_name)
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    Some(format!(
        "{checks} SELECT name, system_type_name, user_type_schema, user_type_name \
         FROM ({selects}) AS dbx_wildcard_metadata \
         ORDER BY dbx_source_ordinal, dbx_column_ordinal"
    ))
}

struct SqlServerLegacyWildcardRelation {
    catalog_prefix: &'static str,
    object_name: String,
}

fn sqlserver_legacy_wildcard_relation(relation: &TableFactor) -> Option<SqlServerLegacyWildcardRelation> {
    let TableFactor::Table { name, args, .. } = relation else {
        return None;
    };
    if args.is_some() {
        return None;
    }
    let identifiers = name.0.iter().map(ObjectNamePart::as_ident).collect::<Option<Vec<_>>>()?;
    match identifiers.as_slice() {
        [table] if table.value.starts_with('#') => Some(SqlServerLegacyWildcardRelation {
            catalog_prefix: "tempdb.",
            object_name: format!("tempdb..{}", table.value),
        }),
        [_table] => Some(SqlServerLegacyWildcardRelation { catalog_prefix: "", object_name: name.to_string() }),
        [_schema, _table] => {
            Some(SqlServerLegacyWildcardRelation { catalog_prefix: "", object_name: name.to_string() })
        }
        _ => None,
    }
}

fn restore_sqlserver_legacy_probe_output_names(
    columns: &mut [SqlServerDescribedColumn],
    legacy_probe: &SqlServerLegacyProbe,
) {
    if let Some(output_names) = &legacy_probe.output_names {
        for (column, output_name) in columns.iter_mut().zip(output_names) {
            column.name.clone_from(output_name);
        }
    } else if !legacy_probe.output_name_overrides.is_empty() {
        for column in columns {
            let output_name = column.name.as_deref().and_then(|probe_name| {
                legacy_probe
                    .output_name_overrides
                    .iter()
                    .find(|output_name_override| output_name_override.probe_name.eq_ignore_ascii_case(probe_name))
                    .map(|output_name_override| output_name_override.output_name.clone())
            });
            if let Some(output_name) = output_name {
                column.name = output_name;
            }
        }
    }
}

fn sqlserver_described_column_from_row(row: &Row) -> SqlServerDescribedColumn {
    SqlServerDescribedColumn {
        name: row.try_get::<&str, _>(0).ok().flatten().map(str::to_string),
        system_type_name: row.try_get::<&str, _>(1).ok().flatten().map(str::to_string),
        user_type_schema: row.try_get::<&str, _>(2).ok().flatten().map(str::to_string),
        user_type_name: row.try_get::<&str, _>(3).ok().flatten().map(str::to_string),
    }
}

fn is_blocking_sqlserver_unsafe_probe_error(error: &str) -> bool {
    error.starts_with(SQLSERVER_UNSAFE_PROBE_BLOCK_ERROR_PREFIX)
}

async fn sqlserver_unsafe_type_query(
    client: &mut SqlServerClient,
    sql: &str,
) -> Result<Option<SqlServerUnsafeTypeQuery>, String> {
    if !is_single_sqlserver_select(sql) {
        return Ok(None);
    }
    let Some(legacy_probe) = sqlserver_legacy_probe(sql) else {
        return Ok(None);
    };
    let columns = describe_sqlserver_result_set(client, sql, &legacy_probe).await?;
    Ok(build_sqlserver_unsafe_type_query(sql, &columns))
}

fn sqlserver_legacy_probe(sql: &str) -> Option<SqlServerLegacyProbe> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    sqlserver_legacy_probe_with_nonce(sql, &nonce)
}

fn sqlserver_legacy_probe_with_nonce(sql: &str, nonce: &str) -> Option<SqlServerLegacyProbe> {
    let statement = normalized_sqlserver_select_statement(sql)?;
    let output_names = sqlserver_projection_output_names(&statement.inner);
    let source_alias = quote_sqlserver_identifier("dbx_probe_source");
    let (source_sql, output_name_overrides) = if let Some(names) = &output_names {
        let aliases = (0..names.len())
            .map(sqlserver_source_column_name)
            .map(|name| quote_sqlserver_identifier(&name))
            .collect::<Vec<_>>()
            .join(", ");
        (format!("({}) AS {source_alias}({aliases})", statement.inner), Vec::new())
    } else if let Some(wildcard_probe) = sqlserver_wildcard_projection_probe(&statement.inner, nonce) {
        (format!("({}) AS {source_alias}", wildcard_probe.statement), wildcard_probe.output_name_overrides)
    } else {
        (format!("({}) AS {source_alias}", statement.inner), Vec::new())
    };
    Some(SqlServerLegacyProbe { source_sql, output_names, output_name_overrides })
}

fn sqlserver_projection_output_names(statement: &str) -> Option<Vec<Option<String>>> {
    let statements = Parser::parse_sql(&MsSqlDialect {}, statement).ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    let SetExpr::Select(select) = query.body.as_ref() else {
        return None;
    };
    select.projection.iter().map(sqlserver_projection_item_output_name).collect()
}

fn sqlserver_projection_item_output_name(item: &SelectItem) -> Option<Option<String>> {
    match item {
        SelectItem::ExprWithAlias { alias, .. } => Some(Some(alias.value.clone())),
        SelectItem::UnnamedExpr(Expr::Identifier(identifier)) => {
            Some((!identifier.value.starts_with('@')).then(|| identifier.value.clone()))
        }
        SelectItem::UnnamedExpr(Expr::CompoundIdentifier(identifiers)) => {
            Some(identifiers.last().map(|identifier| identifier.value.clone()))
        }
        SelectItem::UnnamedExpr(_) => Some(None),
        SelectItem::ExprWithAliases { .. } | SelectItem::QualifiedWildcard(_, _) | SelectItem::Wildcard(_) => None,
    }
}

fn sqlserver_probe_explicit_alias(nonce: &str, projection_ordinal: usize) -> String {
    format!("__dbx_probe_{nonce}_explicit_{projection_ordinal}__")
}

fn sqlserver_wildcard_projection_probe(statement: &str, nonce: &str) -> Option<SqlServerWildcardProjectionProbe> {
    let mut statements = Parser::parse_sql(&MsSqlDialect {}, statement).ok()?;
    let [Statement::Query(query)] = statements.as_mut_slice() else {
        return None;
    };
    let SetExpr::Select(select) = query.body.as_mut() else {
        return None;
    };
    if !select
        .projection
        .iter()
        .any(|item| matches!(item, SelectItem::QualifiedWildcard(_, _) | SelectItem::Wildcard(_)))
    {
        return None;
    }

    let mut output_name_overrides = Vec::new();
    for (index, item) in select.projection.iter_mut().enumerate() {
        let (expr, output_name) = match item {
            SelectItem::UnnamedExpr(expr) => (expr.clone(), sqlserver_projection_item_output_name(item)?),
            SelectItem::ExprWithAlias { expr, alias } => (expr.clone(), Some(alias.value.clone())),
            SelectItem::QualifiedWildcard(_, _) | SelectItem::Wildcard(_) => continue,
            SelectItem::ExprWithAliases { .. } => return None,
        };
        let projection_ordinal = index + 1;
        let probe_name = sqlserver_probe_explicit_alias(nonce, projection_ordinal);
        *item = SelectItem::ExprWithAlias { expr, alias: Ident::with_quote('[', probe_name.clone()) };
        output_name_overrides.push(SqlServerProbeOutputNameOverride { projection_ordinal, probe_name, output_name });
    }

    Some(SqlServerWildcardProjectionProbe { statement: query.to_string(), output_name_overrides })
}

fn build_sqlserver_unsafe_type_query(
    sql: &str,
    columns: &[SqlServerDescribedColumn],
) -> Option<SqlServerUnsafeTypeQuery> {
    if columns.is_empty() || !columns.iter().any(is_sqlserver_unsafe_column) {
        return None;
    }
    let statement = normalized_sqlserver_select_statement(sql)?;
    let source_alias = quote_sqlserver_identifier("dbx_unsafe_source");
    let source_columns = (0..columns.len()).map(sqlserver_source_column_name).collect::<Vec<_>>();
    let source_alias_list =
        source_columns.iter().map(|name| quote_sqlserver_identifier(name)).collect::<Vec<_>>().join(", ");
    let select_list = columns
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let output_name = sqlserver_output_column_name(column, index);
            let quoted_output = quote_sqlserver_identifier(&output_name);
            let source_column = quote_sqlserver_identifier(&source_columns[index]);
            let value_ref = format!("{source_alias}.{source_column}");
            if is_sqlserver_spatial_column(column) {
                format!(
                    "{quoted_output} = CASE WHEN {value_ref} IS NULL THEN NULL ELSE N'SRID=' + CONVERT(nvarchar(20), {value_ref}.STSrid) + N';' + {value_ref}.AsTextZM() END"
                )
            } else if is_sqlserver_variant_column(column) {
                format!("{quoted_output} = CAST({value_ref} AS NVARCHAR(MAX))")
            } else {
                format!("{quoted_output} = {value_ref}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");

    let spatial_columns = columns
        .iter()
        .enumerate()
        .filter_map(|(column_index, column)| {
            sqlserver_spatial_column_type(column)
                .map(|column_type| SqlServerSpatialColumn { column_index, column_type: column_type.to_string() })
        })
        .collect();

    // Re-apply the original ORDER BY / OFFSET / FETCH on the outer query so
    // ordering and pagination survive the derived-table rewrite. When the sort
    // keys cannot be safely migrated, refuse the rewrite rather than silently
    // dropping order semantics (callers fall back to the plain statement).
    let order_by = match &statement.order_by {
        Some(order_by) => {
            let outer_order_by = sqlserver_outer_order_by(order_by, columns)?;
            format!(" {outer_order_by}")
        }
        None => String::new(),
    };

    Some(SqlServerUnsafeTypeQuery {
        sql: format!(
            "SELECT {select_list} FROM ({}) AS {source_alias}({source_alias_list}){order_by}",
            statement.inner
        ),
        spatial_columns,
    })
}

fn is_sqlserver_unsafe_column(column: &SqlServerDescribedColumn) -> bool {
    is_sqlserver_spatial_column(column) || is_sqlserver_variant_column(column)
}

fn is_sqlserver_spatial_column(column: &SqlServerDescribedColumn) -> bool {
    sqlserver_spatial_column_type(column).is_some()
}

fn sqlserver_spatial_column_type(column: &SqlServerDescribedColumn) -> Option<&'static str> {
    [&column.system_type_name, &column.user_type_name].into_iter().flatten().find_map(|name| {
        let normalized = name.trim().trim_matches(['[', ']']).to_ascii_lowercase();
        if normalized == "geometry" || normalized.ends_with(".geometry") {
            Some("geometry")
        } else if normalized == "geography" || normalized.ends_with(".geography") {
            Some("geography")
        } else {
            None
        }
    })
}

fn is_sqlserver_variant_column(column: &SqlServerDescribedColumn) -> bool {
    [&column.system_type_name, &column.user_type_name].into_iter().flatten().any(|name| {
        let normalized = name.trim().trim_matches(['[', ']']).to_ascii_lowercase();
        normalized == "sql_variant" || normalized.ends_with(".sql_variant")
    })
}

struct SqlServerNormalizedStatement {
    /// Statement with the trailing ORDER BY (and any OFFSET/FETCH) removed so it
    /// can be used as a derived table subquery.
    inner: String,
    /// The removed trailing ORDER BY clause verbatim, including any
    /// `OFFSET ... ROWS [FETCH NEXT ... ROWS ONLY]` tail, if the query had one.
    order_by: Option<String>,
}

fn normalized_sqlserver_select_statement(sql: &str) -> Option<SqlServerNormalizedStatement> {
    let statement = trim_sqlserver_statement(sql);
    let trimmed = statement.trim_start();
    if trimmed.is_empty() || !trimmed.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("SELECT")) {
        return None;
    }
    if has_top_level_select_into(trimmed) {
        return None;
    }

    // SQL Server rejects ORDER BY inside a derived table subquery (it requires
    // TOP / OFFSET / FOR XML alongside it, none of which are version-safe across
    // 2008–2022). Move the trailing ORDER BY out of the inner statement so the
    // outer rewrite can re-apply it (see `sqlserver_outer_order_by`). When a
    // top-level TOP is present the ORDER BY also drives row selection, so it must
    // stay inside the derived table too (TOP makes ORDER BY legal in subqueries
    // on every SQL Server version) while the outer rewrite re-applies it for the
    // final result order.
    let tokens = top_level_sqlserver_tokens(trimmed);
    let order_index = (0..tokens.len().saturating_sub(1))
        .rev()
        .find(|index| tokens[*index].text == "ORDER" && tokens.get(index + 1).is_some_and(|token| token.text == "BY"));
    let Some(order_index) = order_index else {
        return Some(SqlServerNormalizedStatement { inner: trimmed.to_string(), order_by: None });
    };
    let order_by = trimmed[tokens[order_index].start..].trim().to_string();
    if has_top_level_top(trimmed) {
        return Some(SqlServerNormalizedStatement { inner: trimmed.to_string(), order_by: Some(order_by) });
    }
    let inner = trimmed[..tokens[order_index].start].trim_end().to_string();
    Some(SqlServerNormalizedStatement { inner, order_by: Some(order_by) })
}

/// Translate the original trailing ORDER BY clause (with optional OFFSET/FETCH)
/// into an equivalent clause for the outer rewrite, or return `None` when the
/// ordering cannot be guaranteed on the outer query. `None` covers ORDER BY keys
/// that reference columns absent from the projection, non-trivial expressions,
/// and keys targeting columns the rewrite transforms (spatial/variant); callers
/// must then fall back to executing the plain statement rather than silently
/// dropping order and pagination semantics.
fn sqlserver_outer_order_by(order_by: &str, columns: &[SqlServerDescribedColumn]) -> Option<String> {
    // OFFSET/FETCH carry no column references, so keep that tail verbatim and
    // rebuild only the sort-key list against the outer projection.
    let tokens = top_level_sqlserver_tokens(order_by);
    let offset_start = tokens.iter().find(|token| token.text == "OFFSET").map(|token| token.start);
    let (order_exprs_text, offset_tail) = match offset_start {
        Some(start) => (&order_by[..start], order_by[start..].trim()),
        None => (order_by, ""),
    };

    let wrapped = format!("SELECT 1 {order_exprs_text}");
    let statements = Parser::parse_sql(&MsSqlDialect {}, &wrapped).ok()?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    let order_by = query.order_by.as_ref()?;
    let OrderByKind::Expressions(order_exprs) = &order_by.kind else {
        return None;
    };
    if order_exprs.is_empty() {
        return None;
    }

    let mut parts = Vec::with_capacity(order_exprs.len());
    for order_expr in order_exprs {
        let output_name = sqlserver_order_by_output_name(columns, &order_expr.expr)?;
        let mut part = quote_sqlserver_identifier(&output_name);
        if order_expr.options.asc == Some(false) {
            part.push_str(" DESC");
        }
        if let Some(nulls_first) = order_expr.options.nulls_first {
            part.push_str(if nulls_first { " NULLS FIRST" } else { " NULLS LAST" });
        }
        parts.push(part);
    }

    let mut outer = format!("ORDER BY {}", parts.join(", "));
    if !offset_tail.is_empty() {
        outer.push(' ');
        outer.push_str(offset_tail);
    }
    Some(outer)
}

/// Map an ORDER BY sort key to the outer rewrite's output column name. Returns
/// `None` for keys that do not resolve to a projection column, keys targeting a
/// column the rewrite transforms (spatial/variant), and any non-trivial
/// expression, none of which can be safely re-applied on the outer query.
fn sqlserver_order_by_output_name(columns: &[SqlServerDescribedColumn], expr: &Expr) -> Option<String> {
    let index = match expr {
        Expr::Identifier(identifier) => sqlserver_projection_column_index(columns, &identifier.value)?,
        Expr::CompoundIdentifier(identifiers) => {
            sqlserver_projection_column_index(columns, identifiers.last()?.value.as_str())?
        }
        Expr::Value(value_with_span) => {
            if let Value::Number(ordinal, _) = &value_with_span.value {
                ordinal.parse::<usize>().ok()?.checked_sub(1)?
            } else {
                return None;
            }
        }
        _ => return None,
    };
    let column = columns.get(index)?;
    if is_sqlserver_unsafe_column(column) {
        return None;
    }
    Some(sqlserver_output_column_name(column, index))
}

fn sqlserver_projection_column_index(columns: &[SqlServerDescribedColumn], name: &str) -> Option<usize> {
    columns.iter().position(|column| {
        column.name.as_deref().map(str::trim).is_some_and(|output_name| output_name.eq_ignore_ascii_case(name))
    })
}

fn trim_sqlserver_statement(sql: &str) -> String {
    let mut statement = sql.trim();
    while let Some(stripped) = statement.strip_suffix(';') {
        statement = stripped.trim_end();
    }
    statement.to_string()
}

fn is_single_sqlserver_select(sql: &str) -> bool {
    let statements = crate::sql::split_sql_statements(sql);
    if statements.len() != 1 {
        return false;
    }
    let statement = statements[0].trim_start();
    statement.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("SELECT"))
}

fn sqlserver_source_column_name(index: usize) -> String {
    format!("dbx_col_{}", index + 1)
}

fn sqlserver_output_column_name(column: &SqlServerDescribedColumn, index: usize) -> String {
    column
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("column_{}", index + 1))
}

fn quote_sqlserver_identifier(identifier: &str) -> String {
    format!("[{}]", identifier.replace(']', "]]"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerToken {
    text: String,
    start: usize,
}

fn top_level_sqlserver_tokens(sql: &str) -> Vec<SqlServerToken> {
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut depth = 0usize;

    while i < sql.len() {
        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());

        if ch == '-' && next == Some('-') {
            i += 2;
            while i < sql.len() && next_char(sql, i) != '\n' {
                i += next_char(sql, i).len_utf8();
            }
            continue;
        }
        if ch == '/' && next == Some('*') {
            i += 2;
            while i < sql.len() {
                let current = next_char(sql, i);
                let following = next_char_at(sql, i + current.len_utf8());
                if current == '*' && following == Some('/') {
                    i += 2;
                    break;
                }
                i += current.len_utf8();
            }
            continue;
        }
        if matches!(ch, '\'' | '"') {
            i = skip_sqlserver_quoted(sql, i, ch);
            continue;
        }
        if ch == '[' {
            i = skip_sqlserver_bracket_identifier(sql, i);
            continue;
        }
        if ch == '(' {
            depth += 1;
            i += ch.len_utf8();
            continue;
        }
        if ch == ')' {
            depth = depth.saturating_sub(1);
            i += ch.len_utf8();
            continue;
        }
        if depth == 0 && is_sqlserver_token_start(ch) {
            let start = i;
            i += ch.len_utf8();
            while i < sql.len() && is_sqlserver_token_part(next_char(sql, i)) {
                i += next_char(sql, i).len_utf8();
            }
            tokens.push(SqlServerToken { text: sql[start..i].to_ascii_uppercase(), start });
            continue;
        }
        i += ch.len_utf8();
    }

    tokens
}

fn has_top_level_select_into(sql: &str) -> bool {
    let tokens = top_level_sqlserver_tokens(sql);
    let Some(select_index) = tokens.iter().position(|token| token.text == "SELECT") else {
        return false;
    };
    let from_index = tokens
        .iter()
        .enumerate()
        .find(|(index, token)| *index > select_index && token.text == "FROM")
        .map(|(index, _)| index)
        .unwrap_or(tokens.len());
    tokens[select_index + 1..from_index].iter().any(|token| token.text == "INTO")
}

fn has_top_level_top(sql: &str) -> bool {
    let tokens = top_level_sqlserver_tokens(sql);
    let Some(select_index) = tokens.iter().position(|token| token.text == "SELECT") else {
        return false;
    };
    let from_index = tokens
        .iter()
        .enumerate()
        .find(|(index, token)| *index > select_index && token.text == "FROM")
        .map(|(index, _)| index)
        .unwrap_or(tokens.len());
    tokens[select_index + 1..from_index].iter().any(|token| token.text == "TOP")
}

fn skip_sqlserver_quoted(sql: &str, pos: usize, quote: char) -> usize {
    let mut i = pos + quote.len_utf8();
    while i < sql.len() {
        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());
        if ch == quote {
            if next == Some(quote) {
                i += ch.len_utf8() + quote.len_utf8();
                continue;
            }
            return i + ch.len_utf8();
        }
        i += ch.len_utf8();
    }
    sql.len()
}

fn skip_sqlserver_bracket_identifier(sql: &str, pos: usize) -> usize {
    let mut i = pos + 1;
    while i < sql.len() {
        let ch = next_char(sql, i);
        let next = next_char_at(sql, i + ch.len_utf8());
        if ch == ']' {
            if next == Some(']') {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += ch.len_utf8();
    }
    sql.len()
}

fn is_sqlserver_token_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_'
}

fn is_sqlserver_token_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$' | '#')
}

fn next_char(sql: &str, index: usize) -> char {
    sql[index..].chars().next().unwrap_or('\0')
}

fn next_char_at(sql: &str, index: usize) -> Option<char> {
    if index >= sql.len() {
        None
    } else {
        sql[index..].chars().next()
    }
}

fn push_sqlserver_result_set(results: &mut Vec<QueryResult>, result: Option<SqlServerResultSet>, start: Instant) {
    if let Some(result) = result {
        if result.rows.is_empty() && result.columns.is_empty() {
            return;
        }
        results.push(QueryResult {
            columns: result.columns,
            column_types: result.column_types,
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: result.rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: result.truncated,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        });
    }
}

fn push_sqlserver_ordered_result_set(
    results: &mut Vec<SqlServerBatchResult>,
    result: Option<SqlServerResultSet>,
    start: Instant,
) {
    let mut query_results = Vec::with_capacity(1);
    push_sqlserver_result_set(&mut query_results, result, start);
    results.extend(query_results.into_iter().map(|result| SqlServerBatchResult { result, server_message: false }));
}

fn push_sqlserver_ordered_events(
    results: &mut Vec<SqlServerBatchResult>,
    current: &mut Option<SqlServerResultSet>,
    events: Vec<SqlServerTdsEvent>,
    start: Instant,
) {
    if events.is_empty() {
        return;
    }
    // The first DONE after an active result set closes that SELECT. Its row
    // count is not a standalone DML result.
    let mut result_set_done_pending = current.is_some();
    push_sqlserver_ordered_result_set(results, current.take(), start);

    let mut messages = Vec::new();
    for event in events {
        match event {
            SqlServerTdsEvent::Message(message) => messages.push(message),
            SqlServerTdsEvent::Done(affected_rows) => {
                if result_set_done_pending {
                    result_set_done_pending = false;
                    continue;
                }
                let Some(affected_rows) = affected_rows else {
                    continue;
                };
                if let Some(message_result) = server_messages_query_result(std::mem::take(&mut messages), start) {
                    results.push(message_result);
                }
                results.push(SqlServerBatchResult {
                    result: QueryResult {
                        columns: vec![],
                        column_types: vec![],
                        column_sortables: vec![],
                        spatial_columns: vec![],
                        spatial_values: vec![],
                        rows: vec![],
                        affected_rows,
                        execution_time_ms: start.elapsed().as_millis(),
                        truncated: false,
                        session_id: None,
                        has_more: false,
                        elasticsearch_raw_body: None,
                        messages: Vec::new(),
                    },
                    server_message: false,
                });
            }
        }
    }
    if let Some(message_result) = server_messages_query_result(messages, start) {
        results.push(message_result);
    }
}

async fn collect_ordered_result_sets_limited(
    mut stream: QueryStream<'_>,
    start: Instant,
    max_rows: Option<usize>,
    result_offset: usize,
    event_layer: SqlServerTdsEventLayer,
) -> Result<Vec<SqlServerBatchResult>, String> {
    let row_limit = query_result_row_limit(max_rows);
    let mut results = Vec::new();
    let mut current: Option<SqlServerResultSet> = None;
    let mut saw_result_set = false;

    loop {
        let item = stream.try_next().await.map_err(|e| e.to_string())?;
        push_sqlserver_ordered_events(&mut results, &mut current, event_layer.take_events(), start);
        let Some(item) = item else {
            break;
        };
        match item {
            QueryItem::Metadata(metadata) => {
                push_sqlserver_ordered_result_set(&mut results, current.take(), start);
                let remaining_offset = if saw_result_set { 0 } else { result_offset };
                saw_result_set = true;
                current = Some(SqlServerResultSet {
                    columns: columns_from_metadata(&metadata),
                    column_types: column_types_from_metadata(&metadata),
                    rows: Vec::new(),
                    truncated: false,
                    remaining_offset,
                });
            }
            QueryItem::Row(row) => {
                let result = current.get_or_insert_with(|| SqlServerResultSet {
                    columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                    column_types: row.columns().iter().map(sqlserver_column_type_name).collect(),
                    rows: Vec::new(),
                    truncated: false,
                    remaining_offset: if saw_result_set { 0 } else { result_offset },
                });
                saw_result_set = true;
                if result.remaining_offset > 0 {
                    result.remaining_offset -= 1;
                    continue;
                }
                if result.rows.len() < row_limit {
                    result.rows.push(row_to_json(&row));
                } else {
                    result.truncated = true;
                }
            }
        }
    }

    push_sqlserver_ordered_result_set(&mut results, current, start);
    Ok(results)
}

pub async fn stream_first_result_set(
    client: &mut SqlServerClient,
    sql: &str,
    row_limit: Option<usize>,
    cancel_token: Option<CancellationToken>,
    mut on_item: impl for<'a> FnMut(SqlServerStreamItem<'a>) -> Result<(), String>,
) -> Result<SqlServerStreamExportSummary, String> {
    let query = match sqlserver_unsafe_type_query(client, sql).await {
        Ok(Some(query)) => query,
        Ok(None) => SqlServerUnsafeTypeQuery::plain(sql),
        Err(error) if is_blocking_sqlserver_unsafe_probe_error(&error) => return Err(error),
        Err(_) => SqlServerUnsafeTypeQuery::plain(sql),
    };
    let mut stream = sqlserver_driver_result(client.query(query.sql.as_str(), &[])).await?;
    let mut active_result_index: Option<usize> = None;
    let mut columns: Vec<String> = Vec::new();
    let mut column_types: Vec<String> = Vec::new();
    let mut columns_emitted = false;
    let mut rows_exported = 0_u64;

    loop {
        if cancel_token.as_ref().is_some_and(|token| token.is_cancelled()) {
            return Err(crate::query::canceled_error());
        }
        let item = match cancel_token.as_ref() {
            Some(token) => {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(crate::query::canceled_error()),
                    item = stream.try_next() => item.map_err(|e| e.to_string())?,
                }
            }
            None => stream.try_next().await.map_err(|e| e.to_string())?,
        };
        let Some(item) = item else {
            break;
        };
        match item {
            QueryItem::Metadata(metadata) => {
                if active_result_index.is_none() {
                    active_result_index = Some(metadata.result_index());
                    columns = columns_from_metadata(&metadata);
                    column_types = column_types_from_metadata(&metadata);
                    restore_sqlserver_spatial_column_types(&mut column_types, &query.spatial_columns);
                    on_item(SqlServerStreamItem::Columns { columns: &columns, column_types: &column_types })?;
                    columns_emitted = true;
                }
            }
            QueryItem::Row(row) => {
                if active_result_index.is_none() {
                    active_result_index = Some(row.result_index());
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                    column_types = row.columns().iter().map(sqlserver_column_type_name).collect();
                    restore_sqlserver_spatial_column_types(&mut column_types, &query.spatial_columns);
                    on_item(SqlServerStreamItem::Columns { columns: &columns, column_types: &column_types })?;
                    columns_emitted = true;
                }
                if Some(row.result_index()) != active_result_index {
                    continue;
                }
                if row_limit.is_some_and(|limit| rows_exported as usize >= limit) {
                    break;
                }
                let (values, _) = row_to_json_with_spatial_metadata(&row, &query.spatial_columns, |_, _| {});
                on_item(SqlServerStreamItem::Row(&values))?;
                rows_exported += 1;
            }
        }
    }

    if !columns_emitted {
        on_item(SqlServerStreamItem::Columns { columns: &columns, column_types: &column_types })?;
    }
    Ok(SqlServerStreamExportSummary { columns, rows_exported })
}

// rust_decimal (behind tiberius's `Decimal: FromSql`) only supports scale <= 28 and a
// 96-bit mantissa, while SQL Server NUMERIC allows precision/scale up to 38; converting
// such values panics and aborts the app (issue #3648). Format the raw i128 value and
// scale manually instead.
fn format_sqlserver_numeric(value: i128, scale: u8) -> String {
    if scale == 0 {
        return value.to_string();
    }
    let digits = value.unsigned_abs().to_string();
    let scale = scale as usize;
    let sign = if value < 0 { "-" } else { "" };
    if digits.len() > scale {
        let (int_part, frac_part) = digits.split_at(digits.len() - scale);
        format!("{}{}.{}", sign, int_part, frac_part)
    } else {
        format!("{}0.{:0>width$}", sign, digits, width = scale)
    }
}

fn sqlserver_cell_to_json(cell: &ColumnData<'static>) -> serde_json::Value {
    if let ColumnData::Numeric(numeric) = cell {
        return match numeric {
            Some(n) => serde_json::Value::String(format_sqlserver_numeric(n.value(), n.scale())),
            None => serde_json::Value::Null,
        };
    }
    if let Ok(Some(v)) = <&tiberius::xml::XmlData as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.as_ref().to_string());
    }
    if let Ok(Some(v)) = <&str as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::NaiveDateTime as FromSql>::from_sql(cell) {
        let value = match cell {
            ColumnData::DateTime(_) => crate::sqlserver_temporal::format_sqlserver_datetime_display(&v),
            _ => v.to_string(),
        };
        return serde_json::Value::String(value);
    }
    if let Ok(Some(v)) = <chrono::NaiveDate as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::NaiveTime as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::DateTime<chrono::FixedOffset> as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_rfc3339());
    }
    if let Ok(Some(v)) = <u8 as FromSql>::from_sql(cell) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(Some(v)) = <i16 as FromSql>::from_sql(cell) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(Some(v)) = <i32 as FromSql>::from_sql(cell) {
        return serde_json::Value::Number(v.into());
    }
    if let Ok(Some(v)) = <i64 as FromSql>::from_sql(cell) {
        return super::safe_i64_to_json(v);
    }
    if let Ok(Some(v)) = <f32 as FromSql>::from_sql(cell) {
        return serde_json::Number::from_f64(v as f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null);
    }
    if let Ok(Some(v)) = <f64 as FromSql>::from_sql(cell) {
        return serde_json::Number::from_f64(v).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null);
    }
    if let Ok(Some(v)) = <bool as FromSql>::from_sql(cell) {
        return serde_json::Value::Bool(v);
    }
    if let Ok(Some(v)) = <uuid::Uuid as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <Vec<u8> as tiberius::FromSqlOwned>::from_sql_owned(cell.clone()) {
        return super::binary_value_to_json(&v);
    }
    serde_json::Value::Null
}

pub async fn list_databases(client: &mut SqlServerClient) -> Result<Vec<DatabaseInfo>, String> {
    let stream = client
        .query(
            "SELECT name \
             FROM sys.databases \
             WHERE state = 0 \
             ORDER BY name",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| DatabaseInfo { name: row.get::<&str, _>(0).unwrap_or("").to_string() }).collect())
}

pub async fn get_completion_context(client: &mut SqlServerClient) -> Result<SqlServerCompletionContext, String> {
    let stream = client.query(SQLSERVER_COMPLETION_CONTEXT_SQL, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    let row = rows.first().ok_or_else(|| "SQL Server completion context query returned no rows".to_string())?;
    let default_schema = row.try_get::<&str, _>(0).map_err(|e| e.to_string())?;
    let engine_edition = row.try_get::<i32, _>(1).map_err(|e| e.to_string())?;
    sqlserver_completion_context(default_schema, engine_edition)
}

pub async fn test_connection(client: &mut SqlServerClient) -> Result<(), String> {
    crate::db::with_connection_timeout("SQL Server", crate::db::connection_timeout(), async {
        let stream = client.simple_query("SELECT 1").await.map_err(|e| e.to_string())?;
        let _ = stream.into_first_result().await.map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

pub async fn list_linked_servers(client: &mut SqlServerClient) -> Result<Vec<LinkedServerInfo>, String> {
    let stream = client
        .query(
            "SELECT name, product, provider, data_source \
             FROM sys.servers \
             WHERE is_linked = 1 \
             ORDER BY name",
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| LinkedServerInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            product: row.get::<&str, _>(1).filter(|value| !value.trim().is_empty()).map(str::to_string),
            provider: row.get::<&str, _>(2).filter(|value| !value.trim().is_empty()).map(str::to_string),
            data_source: row.get::<&str, _>(3).filter(|value| !value.trim().is_empty()).map(str::to_string),
        })
        .filter(|server| !server.name.trim().is_empty())
        .collect())
}

pub async fn list_linked_server_catalogs(
    client: &mut SqlServerClient,
    server: &str,
) -> Result<Vec<DatabaseInfo>, String> {
    let stream = client.query("EXEC sp_catalogs @server_name = @P1", &[&server]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get::<&str, _>(0).map(str::trim).filter(|name| !name.is_empty()))
        .map(|name| DatabaseInfo { name: name.to_string() })
        .collect())
}

pub async fn list_linked_server_schemas(
    client: &mut SqlServerClient,
    server: &str,
    catalog: &str,
) -> Result<Vec<String>, String> {
    let tables = linked_server_table_rows(client, server, catalog, None, None).await?;
    let mut schemas = Vec::new();
    for table in tables {
        if let Some(schema) = table.schema.filter(|value| !value.trim().is_empty()) {
            if !schemas.iter().any(|existing: &String| existing.eq_ignore_ascii_case(&schema)) {
                schemas.push(schema);
            }
        }
    }
    schemas.sort_by_key(|schema| (if schema.eq_ignore_ascii_case("dbo") { 0 } else { 1 }, schema.to_lowercase()));
    Ok(schemas)
}

pub async fn list_linked_server_tables(
    client: &mut SqlServerClient,
    server: &str,
    catalog: &str,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<TableInfo>, String> {
    let filter = filter.map(str::trim).filter(|value| !value.is_empty()).map(str::to_lowercase);
    let limit = limit.unwrap_or(usize::MAX);
    let offset = offset.unwrap_or(0);
    let rows = linked_server_table_rows(client, server, catalog, Some(schema), None).await?;
    Ok(rows
        .into_iter()
        .filter(|row| filter.as_ref().is_none_or(|value| row.name.to_lowercase().contains(value)))
        .skip(offset)
        .take(limit)
        .map(|row| TableInfo {
            name: row.name,
            table_type: normalize_linked_server_table_type(row.table_type.as_deref()),
            comment: row.comment,
            parent_schema: None,
            parent_name: None,
        })
        .collect())
}

pub async fn get_linked_server_columns(
    client: &mut SqlServerClient,
    server: &str,
    catalog: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let stream = client
        .query(
            "EXEC sp_columns_ex \
             @table_server = @P1, \
             @table_name = @P2, \
             @table_schema = @P3, \
             @table_catalog = @P4",
            &[&server, &table, &schema, &catalog],
        )
        .await
        .map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = row.get::<&str, _>(3)?.trim();
            if name.is_empty() {
                return None;
            }
            let base_type = row.get::<&str, _>(5).unwrap_or("").trim();
            let column_size = linked_i32(row, 6);
            let numeric_scale = linked_i32(row, 8);
            let nullable = linked_i32(row, 10).unwrap_or(1) != 0;
            let data_type = linked_server_column_type(base_type, column_size, numeric_scale);
            Some(ColumnInfo {
                name: name.to_string(),
                data_type,
                is_nullable: nullable,
                column_default: row.get::<&str, _>(12).filter(|value| !value.trim().is_empty()).map(str::to_string),
                is_primary_key: false,
                extra: None,
                comment: row.get::<&str, _>(11).filter(|value| !value.trim().is_empty()).map(str::to_string),
                numeric_precision: column_size,
                numeric_scale,
                character_maximum_length: linked_i32(row, 15),
                enum_values: None,
                ..Default::default()
            })
        })
        .collect())
}

struct LinkedServerTableRow {
    schema: Option<String>,
    name: String,
    table_type: Option<String>,
    comment: Option<String>,
}

async fn linked_server_table_rows(
    client: &mut SqlServerClient,
    server: &str,
    catalog: &str,
    schema: Option<&str>,
    table_name: Option<&str>,
) -> Result<Vec<LinkedServerTableRow>, String> {
    let sql = format!(
        "EXEC sp_tables_ex \
         @table_server = {}, \
         @table_name = {}, \
         @table_schema = {}, \
         @table_catalog = {}, \
         @table_type = '''TABLE'',''VIEW''', \
         @fUsePattern = 0",
        sqlserver_nstring_literal(server),
        sqlserver_optional_nstring_literal(table_name),
        sqlserver_optional_nstring_literal(schema),
        sqlserver_nstring_literal(catalog),
    );
    let stream = client.query(sql.as_str(), &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = row.get::<&str, _>(2)?.trim();
            if name.is_empty() {
                return None;
            }
            Some(LinkedServerTableRow {
                schema: row.get::<&str, _>(1).filter(|value| !value.trim().is_empty()).map(str::to_string),
                name: name.to_string(),
                table_type: row.get::<&str, _>(3).filter(|value| !value.trim().is_empty()).map(str::to_string),
                comment: row.get::<&str, _>(4).filter(|value| !value.trim().is_empty()).map(str::to_string),
            })
        })
        .collect())
}

fn sqlserver_optional_nstring_literal(value: Option<&str>) -> String {
    value.filter(|value| !value.trim().is_empty()).map(sqlserver_nstring_literal).unwrap_or_else(|| "NULL".to_string())
}

fn sqlserver_nstring_literal(value: &str) -> String {
    format!("N'{}'", value.replace('\'', "''"))
}

fn normalize_linked_server_table_type(value: Option<&str>) -> String {
    let upper = value.unwrap_or("TABLE").to_ascii_uppercase();
    if upper.contains("VIEW") {
        "VIEW".to_string()
    } else {
        "BASE TABLE".to_string()
    }
}

fn linked_server_column_type(base_type: &str, size: Option<i32>, scale: Option<i32>) -> String {
    let lower = base_type.to_ascii_lowercase();
    if matches!(lower.as_str(), "varchar" | "nvarchar" | "char" | "nchar" | "binary" | "varbinary") {
        if let Some(size) = size {
            if size > 0 {
                return format!("{base_type}({size})");
            }
        }
    }
    if matches!(lower.as_str(), "decimal" | "numeric") {
        if let (Some(size), Some(scale)) = (size, scale) {
            return format!("{base_type}({size},{scale})");
        }
    }
    base_type.to_string()
}

fn linked_i32(row: &tiberius::Row, index: usize) -> Option<i32> {
    row.try_get::<i32, _>(index).ok().flatten().or_else(|| row.try_get::<i16, _>(index).ok().flatten().map(i32::from))
}

pub async fn list_schemas(client: &mut SqlServerClient) -> Result<Vec<String>, String> {
    let sql = sqlserver_list_schemas_sql();
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|row| row.get::<&str, _>(0).unwrap_or("").to_string()).collect())
}

fn sqlserver_list_schemas_sql() -> String {
    let excluded_schemas =
        sqlserver_hidden_schema_names().iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(",");
    format!(
        "SELECT s.name \
         FROM sys.schemas s \
         WHERE s.name NOT IN ({excluded_schemas}) \
         ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name"
    )
}

pub async fn list_tables(
    client: &mut SqlServerClient,
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<TableInfo>, String> {
    let sql = sqlserver_list_tables_sql(schema, filter, limit, offset);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            table_type: row.get::<&str, _>(1).unwrap_or("BASE TABLE").to_string(),
            comment: row.get::<&str, _>(2).filter(|s: &&str| !s.is_empty()).map(|s: &str| s.to_string()),
            parent_schema: None,
            parent_name: None,
        })
        .collect())
}

pub async fn completion_assistant_search(
    client: &mut SqlServerClient,
    request: &crate::types::CompletionAssistantRequest,
) -> Result<crate::types::CompletionAssistantResponse, String> {
    let limit = request.max_results.unwrap_or(100).clamp(1, 1000);
    let sql = sqlserver_completion_assistant_sql(request, limit);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    let candidates = rows
        .iter()
        .map(|row| {
            let object_type = row.get::<&str, _>(2).unwrap_or("OBJECT");
            crate::types::CompletionAssistantCandidate {
                name: row.get::<&str, _>(0).unwrap_or("").to_string(),
                kind: sqlserver_completion_candidate_kind(object_type),
                database: Some(request.database.clone()),
                schema: row.get::<&str, _>(1).map(str::to_string),
                parent_schema: row.get::<&str, _>(3).map(str::to_string),
                parent_name: row.get::<&str, _>(4).map(str::to_string),
                comment: row.get::<&str, _>(5).filter(|s: &&str| !s.is_empty()).map(|s| (*s).to_string()),
                data_type: row.get::<&str, _>(6).map(str::to_string),
                signature: None,
            }
        })
        .collect::<Vec<_>>();
    Ok(crate::types::CompletionAssistantResponse {
        incomplete: candidates.len() >= limit,
        candidates,
        fallback_used: false,
    })
}

fn sqlserver_completion_candidate_kind(object_type: &str) -> crate::types::CompletionAssistantCandidateKind {
    match object_type.to_ascii_uppercase().as_str() {
        "SCHEMA" => crate::types::CompletionAssistantCandidateKind::Schema,
        "TABLE" | "BASE TABLE" => crate::types::CompletionAssistantCandidateKind::Table,
        "VIEW" => crate::types::CompletionAssistantCandidateKind::View,
        "PROCEDURE" => crate::types::CompletionAssistantCandidateKind::Procedure,
        "FUNCTION" => crate::types::CompletionAssistantCandidateKind::Function,
        "COLUMN" => crate::types::CompletionAssistantCandidateKind::Column,
        _ => crate::types::CompletionAssistantCandidateKind::Object,
    }
}

fn sqlserver_completion_assistant_sql(request: &crate::types::CompletionAssistantRequest, limit: usize) -> String {
    let object_kinds = if request.object_kinds.is_empty() {
        vec![crate::types::CompletionAssistantObjectKind::Table, crate::types::CompletionAssistantObjectKind::View]
    } else {
        request.object_kinds.clone()
    };
    let mask = request.mask.trim();
    let like_pattern = completion_like_pattern(mask, request.match_mode.as_ref());
    let like_clause = if like_pattern == "%" {
        String::new()
    } else {
        format!(" AND LOWER({}) LIKE LOWER('{like_pattern}') ESCAPE '\\' ", "name_expr")
    };
    let schema_filter = request
        .schema
        .as_deref()
        .or(request.parent_schema.as_deref())
        .filter(|schema| !schema.trim().is_empty())
        .map(|schema| format!(" AND s.name = '{}' ", schema.replace('\'', "''")))
        .unwrap_or_default();
    let columns_only = object_kinds.len() == 1
        && matches!(object_kinds.first(), Some(crate::types::CompletionAssistantObjectKind::Column));

    let mut queries = Vec::new();
    if (mask.starts_with('#') || mask.starts_with("%#"))
        && object_kinds.iter().any(crate::types::CompletionAssistantObjectKind::is_table_like)
    {
        let object_like = sqlserver_completion_object_search_clause(request, &like_pattern);
        queries.push(format!(
            "SELECT TOP ({limit}) o.name, s.name AS schema_name, 'TABLE' AS object_type, CAST(NULL AS NVARCHAR(128)) AS parent_schema, CAST(NULL AS NVARCHAR(128)) AS parent_name, CAST(NULL AS NVARCHAR(MAX)) AS object_comment, CAST(NULL AS NVARCHAR(128)) AS data_type \
             FROM tempdb.sys.all_objects o \
             JOIN tempdb.sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type = 'U' {object_like}"
        ));
        return format!("SELECT * FROM ({}) AS dbx_completion ORDER BY name", queries.remove(0));
    }
    if object_kinds.iter().any(|kind| matches!(kind, crate::types::CompletionAssistantObjectKind::Schema)) {
        let schema_like = like_clause.replace("name_expr", "s.name");
        queries.push(format!(
            "SELECT TOP ({limit}) s.name, s.name AS schema_name, 'SCHEMA' AS object_type, CAST(NULL AS NVARCHAR(128)) AS parent_schema, CAST(NULL AS NVARCHAR(128)) AS parent_name, CAST(NULL AS NVARCHAR(MAX)) AS object_comment, CAST(NULL AS NVARCHAR(128)) AS data_type \
             FROM sys.schemas s \
             WHERE s.name NOT IN ('guest','INFORMATION_SCHEMA','sys') {schema_like}"
        ));
    }
    if object_kinds.iter().any(crate::types::CompletionAssistantObjectKind::is_table_like)
        || object_kinds.iter().any(crate::types::CompletionAssistantObjectKind::is_routine_like)
    {
        let mut type_ids = Vec::new();
        if object_kinds.iter().any(|kind| matches!(kind, crate::types::CompletionAssistantObjectKind::Table)) {
            type_ids.push("'U'");
        }
        if object_kinds.iter().any(|kind| matches!(kind, crate::types::CompletionAssistantObjectKind::View)) {
            type_ids.push("'V'");
        }
        if object_kinds.iter().any(|kind| {
            matches!(
                kind,
                crate::types::CompletionAssistantObjectKind::Procedure
                    | crate::types::CompletionAssistantObjectKind::Routine
            )
        }) {
            type_ids.push("'P'");
        }
        if object_kinds.iter().any(|kind| {
            matches!(
                kind,
                crate::types::CompletionAssistantObjectKind::Function
                    | crate::types::CompletionAssistantObjectKind::Routine
            )
        }) {
            type_ids.extend(["'FN'", "'IF'", "'TF'", "'FS'", "'FT'"]);
        }
        let object_like = sqlserver_completion_object_search_clause(request, &like_pattern);
        let object_visibility = sqlserver_visible_object_predicate();
        let data_type = if object_kinds.iter().any(crate::types::CompletionAssistantObjectKind::is_routine_like) {
            "CASE WHEN o.type IN ('IF','TF','FT') THEN 'table' ELSE (SELECT TOP (1) TYPE_NAME(p.user_type_id) FROM sys.parameters p WHERE p.object_id = o.object_id AND p.parameter_id = 0) END"
        } else {
            "CAST(NULL AS NVARCHAR(128))"
        };
        queries.push(format!(
            "SELECT TOP ({limit}) o.name, s.name AS schema_name, \
             CASE o.type WHEN 'U' THEN 'TABLE' WHEN 'V' THEN 'VIEW' WHEN 'P' THEN 'PROCEDURE' WHEN 'FN' THEN 'FUNCTION' WHEN 'IF' THEN 'FUNCTION' WHEN 'TF' THEN 'FUNCTION' WHEN 'FS' THEN 'FUNCTION' WHEN 'FT' THEN 'FUNCTION' ELSE o.type_desc END AS object_type, \
             CAST(NULL AS NVARCHAR(128)) AS parent_schema, CAST(NULL AS NVARCHAR(128)) AS parent_name, ep.value AS object_comment, {data_type} AS data_type \
             FROM sys.objects o \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             OUTER APPLY (SELECT CAST(ep.value AS NVARCHAR(MAX)) AS value FROM sys.extended_properties ep WHERE ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description') ep \
             WHERE o.type IN ({}) AND {object_visibility} {schema_filter} {object_like}",
            type_ids.join(",")
        ));
    }
    if object_kinds.iter().any(|kind| matches!(kind, crate::types::CompletionAssistantObjectKind::Column)) {
        let column_like = like_clause.replace("name_expr", "c.name");
        let parent_table_filter = request
            .parent_name
            .as_deref()
            .filter(|table| !table.trim().is_empty())
            .map(|table| format!(" AND o.name = '{}' ", table.replace('\'', "''")))
            .unwrap_or_default();
        let object_visibility = sqlserver_visible_object_predicate();
        queries.push(format!(
            "SELECT TOP ({limit}) c.name, s.name AS schema_name, 'COLUMN' AS object_type, s.name AS parent_schema, o.name AS parent_name, CAST(NULL AS NVARCHAR(MAX)) AS object_comment, TYPE_NAME(c.user_type_id) AS data_type \
             FROM sys.columns c \
             JOIN sys.objects o ON o.object_id = c.object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type IN ('U','V') AND {object_visibility} {schema_filter} {parent_table_filter} {column_like} ORDER BY c.column_id"
        ));
    }

    if queries.is_empty() {
        "SELECT TOP (0) CAST('' AS NVARCHAR(128)) AS name, CAST('' AS NVARCHAR(128)) AS schema_name, CAST('' AS NVARCHAR(60)) AS object_type, CAST(NULL AS NVARCHAR(128)) AS parent_schema, CAST(NULL AS NVARCHAR(128)) AS parent_name, CAST(NULL AS NVARCHAR(MAX)) AS object_comment, CAST(NULL AS NVARCHAR(128)) AS data_type".to_string()
    } else if columns_only && queries.len() == 1 {
        // Preserve sys.columns.column_id order for SELECT * expansion.
        queries.remove(0)
    } else if queries.len() == 1 {
        format!("SELECT * FROM ({}) AS dbx_completion ORDER BY name", queries.remove(0))
    } else {
        format!("SELECT TOP ({limit}) * FROM ({}) AS dbx_completion ORDER BY name", queries.join(" UNION ALL "))
    }
}

fn sqlserver_completion_object_search_clause(
    request: &crate::types::CompletionAssistantRequest,
    like_pattern: &str,
) -> String {
    if like_pattern == "%" {
        return String::new();
    }
    let mut predicates = vec![format!("LOWER(o.name) LIKE LOWER('{like_pattern}') ESCAPE '\\'")];
    if request.search_in_comments {
        predicates.push(format!("LOWER(COALESCE(ep.value, '')) LIKE LOWER('{like_pattern}') ESCAPE '\\'"));
    }
    if request.search_in_definitions {
        predicates.push(format!(
            "LOWER(COALESCE(OBJECT_DEFINITION(o.object_id), '')) LIKE LOWER('{like_pattern}') ESCAPE '\\'"
        ));
    }
    format!(" AND ({}) ", predicates.join(" OR "))
}

fn completion_like_pattern(mask: &str, mode: Option<&crate::types::CompletionAssistantMatchMode>) -> String {
    if mask.is_empty() || mask == "%" {
        return "%".to_string();
    }
    let has_wildcard = mask.contains('%');
    if has_wildcard {
        return mask.split('%').map(escape_like_literal).collect::<Vec<_>>().join("%");
    }
    let escaped = escape_like_literal(mask);
    match mode.unwrap_or(&crate::types::CompletionAssistantMatchMode::Prefix) {
        crate::types::CompletionAssistantMatchMode::Prefix => format!("{escaped}%"),
        crate::types::CompletionAssistantMatchMode::Contains => format!("%{escaped}%"),
    }
}

fn sqlserver_list_tables_sql(
    schema: &str,
    filter: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> String {
    let filter_clause = filter
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            let contains_pattern = format!("%{}%", escape_like_literal(value.trim()));
            if crate::sql::fuzzy_filter_enabled(value) {
                let fuzzy_pattern =
                    crate::sql::fuzzy_like_pattern_with_escape(value.trim(), escape_like_literal);
                format!(
                    " AND (LOWER(o.name) LIKE LOWER('{contains_pattern}') ESCAPE '\\' OR LOWER(o.name) LIKE LOWER('{fuzzy_pattern}') ESCAPE '\\') "
                )
            } else {
                format!(" AND LOWER(o.name) LIKE LOWER('{contains_pattern}') ESCAPE '\\' ")
            }
        })
        .unwrap_or_default();
    let base_columns = "o.name, CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'BASE TABLE' END, ep.value AS TABLE_COMMENT";
    let base_from = "FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         OUTER APPLY (SELECT CAST(ep.value AS NVARCHAR(MAX)) AS value FROM sys.extended_properties ep \
           WHERE ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description') ep";
    let object_visibility = sqlserver_visible_object_predicate();
    let schema_filter = sqlserver_schema_name_predicate(schema, "s.name");
    let base_where = format!("WHERE {schema_filter} AND o.type IN ('U','V') AND {object_visibility} {filter_clause}");
    let order_by = "ORDER BY o.name";

    // Use SELECT TOP for broad SQL Server version compatibility.
    // OFFSET / FETCH NEXT is only available in SQL Server 2012+.
    match (limit, offset) {
        (Some(limit), Some(offset)) if offset > 0 => {
            let end = offset + limit.min(1000);
            format!(
                "SELECT * FROM (\
                 SELECT {base_columns}, ROW_NUMBER() OVER ({order_by}) AS __dbx_rn \
                 {base_from} {base_where}\
                 ) AS __dbx_page WHERE __dbx_rn > {offset} AND __dbx_rn <= {end} ORDER BY __dbx_rn"
            )
        }
        (Some(limit), _) => {
            format!("SELECT TOP ({}) {base_columns} {base_from} {base_where} {order_by}", limit.min(1000))
        }
        _ => {
            format!("SELECT {base_columns} {base_from} {base_where} {order_by}")
        }
    }
}

fn sqlserver_schema_name_predicate(schema: &str, schema_name_expression: &str) -> String {
    if schema.trim().is_empty() {
        // SQL Server resolves unqualified objects through the user's default schema.
        // A configured default can be missing, so match DBeaver and fall back to dbo.
        return format!(
            "{schema_name_expression} = COALESCE((SELECT default_schema.name FROM sys.schemas default_schema WHERE default_schema.name = SCHEMA_NAME()), N'dbo')"
        );
    }

    format!("{schema_name_expression} = N'{}'", schema.replace('\'', "''"))
}

fn sqlserver_object_id_expression(schema: &str, table: &str) -> String {
    let table = table.replace('\'', "''");
    if schema.trim().is_empty() {
        return format!("OBJECT_ID(QUOTENAME(N'{table}'))");
    }

    let schema = schema.replace('\'', "''");
    format!("OBJECT_ID(QUOTENAME(N'{schema}') + N'.' + QUOTENAME(N'{table}'))")
}

fn sqlserver_object_schema_name_predicate(schema: &str, table: &str, schema_name_expression: &str) -> String {
    if schema.trim().is_empty() {
        return format!(
            "{schema_name_expression} = OBJECT_SCHEMA_NAME({})",
            sqlserver_object_id_expression(schema, table)
        );
    }

    sqlserver_schema_name_predicate(schema, schema_name_expression)
}

fn escape_like_literal(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "''").replace('%', "\\%").replace('_', "\\_").replace('[', "\\[")
}

fn sqlserver_visible_object_predicate() -> &'static str {
    "(o.is_ms_shipped = 0 OR s.name = 'cdc')"
}

fn sqlserver_hidden_schema_names() -> &'static [&'static str] {
    &[
        "guest",
        "INFORMATION_SCHEMA",
        "sys",
        "db_owner",
        "db_accessadmin",
        "db_securityadmin",
        "db_ddladmin",
        "db_backupoperator",
        "db_datareader",
        "db_datawriter",
        "db_denydatareader",
        "db_denydatawriter",
    ]
}

pub async fn list_objects(client: &mut SqlServerClient, schema: &str) -> Result<Vec<crate::types::ObjectInfo>, String> {
    let sql = sqlserver_list_objects_sql(schema);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| crate::types::ObjectInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            object_type: row.get::<&str, _>(1).unwrap_or("TABLE").to_string(),
            schema: Some(schema.to_string()),
            valid: None,
            signature: None,
            comment: row.get::<&str, _>(4).filter(|s: &&str| !s.is_empty()).map(|s: &str| s.to_string()),
            created_at: row.get::<chrono::NaiveDateTime, _>(2).map(|value| value.to_string()),
            updated_at: row.get::<chrono::NaiveDateTime, _>(3).map(|value| value.to_string()),
            parent_schema: None,
            parent_name: None,
            xugu_type_members_expandable: None,
        })
        .collect())
}

fn sqlserver_list_objects_sql(schema: &str) -> String {
    let s = schema.replace('\'', "''");
    let object_visibility = sqlserver_visible_object_predicate();
    format!(
        "SELECT o.name, \
         CASE o.type \
           WHEN 'U' THEN 'TABLE' \
           WHEN 'V' THEN 'VIEW' \
           WHEN 'P' THEN 'PROCEDURE' \
           WHEN 'FN' THEN 'FUNCTION' \
           WHEN 'IF' THEN 'FUNCTION' \
           WHEN 'TF' THEN 'FUNCTION' \
           WHEN 'FS' THEN 'FUNCTION' \
           WHEN 'FT' THEN 'FUNCTION' \
           ELSE o.type_desc \
         END AS object_type, \
         o.create_date, \
         o.modify_date, \
         ep.value AS object_comment \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         OUTER APPLY (SELECT CAST(ep.value AS NVARCHAR(MAX)) AS value FROM sys.extended_properties ep WHERE ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description') ep \
         WHERE s.name = '{s}' \
           AND o.type IN ('U','V','P','FN','IF','TF','FS','FT') \
           AND {object_visibility} \
         ORDER BY CASE o.type \
           WHEN 'U' THEN 0 \
           WHEN 'V' THEN 1 \
           WHEN 'P' THEN 2 \
           ELSE 3 \
         END, o.name"
    )
}

pub async fn list_object_statistics(
    client: &mut SqlServerClient,
    schema: &str,
) -> Result<Vec<ObjectStatistics>, String> {
    let s = schema.replace('\'', "''");
    let object_visibility = sqlserver_visible_object_predicate();
    let sql = format!(
        "SELECT o.name, \
                SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS estimated_rows, \
                SUM(ps.reserved_page_count) * 8192 AS total_bytes \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         JOIN sys.dm_db_partition_stats ps ON ps.object_id = o.object_id \
         WHERE s.name = '{s}' AND o.type = 'U' AND {object_visibility} \
         GROUP BY o.object_id, o.name \
         ORDER BY o.name"
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ObjectStatistics {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            schema: Some(schema.to_string()),
            estimated_rows: row
                .try_get::<i64, _>(1)
                .ok()
                .flatten()
                .or_else(|| row.try_get::<i32, _>(1).ok().flatten().map(i64::from)),
            total_bytes: row
                .try_get::<i64, _>(2)
                .ok()
                .flatten()
                .or_else(|| row.try_get::<i32, _>(2).ok().flatten().map(i64::from)),
        })
        .filter(|stat| !stat.name.is_empty())
        .collect())
}

pub async fn get_columns(client: &mut SqlServerClient, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    Ok(get_column_metadata(client, schema, table).await?.into_iter().map(|metadata| metadata.column).collect())
}

pub async fn get_column_metadata(
    client: &mut SqlServerClient,
    schema: &str,
    table: &str,
) -> Result<Vec<SqlServerColumnMetadata>, String> {
    let sql = sqlserver_columns_sql(schema, table);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(sqlserver_column_metadata_from_row).collect())
}

fn sqlserver_column_metadata_from_row(row: &Row) -> SqlServerColumnMetadata {
    let base = row.get::<&str, _>(1).unwrap_or("").to_string();
    let max_len = row
        .try_get::<i32, _>(7)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<i16, _>(7).ok().flatten().map(|v| v as i32))
        .or_else(|| row.try_get::<u8, _>(7).ok().flatten().map(|v| v as i32));
    let dt_prec = row
        .try_get::<i32, _>(8)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<i16, _>(8).ok().flatten().map(|v| v as i32))
        .or_else(|| row.try_get::<u8, _>(8).ok().flatten().map(|v| v as i32));
    let num_prec = row
        .try_get::<i32, _>(5)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<i16, _>(5).ok().flatten().map(|v| v as i32))
        .or_else(|| row.try_get::<u8, _>(5).ok().flatten().map(|v| v as i32));
    let num_scale = row
        .try_get::<i32, _>(6)
        .ok()
        .flatten()
        .or_else(|| row.try_get::<i16, _>(6).ok().flatten().map(|v| v as i32))
        .or_else(|| row.try_get::<u8, _>(6).ok().flatten().map(|v| v as i32));
    let data_type = match base.to_lowercase().as_str() {
        "varchar" => match max_len {
            Some(-1) => "varchar(max)".to_string(),
            Some(n) => format!("varchar({n})"),
            None => "varchar".to_string(),
        },
        "nvarchar" => match max_len {
            Some(-1) => "nvarchar(max)".to_string(),
            Some(n) => format!("nvarchar({n})"),
            None => "nvarchar".to_string(),
        },
        "varbinary" => match max_len {
            Some(-1) => "varbinary(max)".to_string(),
            Some(n) if n > 0 => format!("varbinary({n})"),
            _ => "varbinary".to_string(),
        },
        "char" | "nchar" | "binary" => match max_len {
            Some(n) if n > 0 => format!("{base}({n})"),
            _ => base,
        },
        "decimal" | "numeric" => match (num_prec, num_scale) {
            (Some(p), Some(s)) => format!("{base}({p},{s})"),
            _ => base,
        },
        "datetime2" | "datetimeoffset" | "time" => match dt_prec {
            Some(p) => format!("{base}({p})"),
            _ => base,
        },
        _ => base,
    };
    let column = ColumnInfo {
        name: row.get::<&str, _>(0).unwrap_or("").to_string(),
        data_type,
        is_nullable: row.get::<&str, _>(2).unwrap_or("NO") == "YES",
        column_default: row.get::<&str, _>(3).map(|s| s.to_string()),
        is_primary_key: row.get::<i32, _>(4).unwrap_or(0) == 1,
        extra: row.get::<&str, _>(9).filter(|s: &&str| !s.is_empty()).map(|s: &str| s.to_string()),
        comment: row.get::<&str, _>(10).filter(|s: &&str| !s.is_empty()).map(|s: &str| s.to_string()),
        numeric_precision: num_prec,
        numeric_scale: num_scale,
        character_maximum_length: max_len,
        enum_values: None,
        ..Default::default()
    };
    SqlServerColumnMetadata {
        column,
        is_identity: row.get::<i32, _>(11).unwrap_or(0) == 1,
        is_computed: row.get::<i32, _>(12).unwrap_or(0) == 1,
        is_hidden: row.get::<i32, _>(13).unwrap_or(0) == 1,
        generated_always_type: row.get::<i32, _>(14).unwrap_or(0),
    }
}

fn sqlserver_columns_sql(schema: &str, table: &str) -> String {
    let t = table.replace('\'', "''");
    let schema_filter = sqlserver_object_schema_name_predicate(schema, table, "s.name");
    // COLUMNPROPERTY keeps hidden/generated flags separate and returns NULL on
    // SQL Server versions that do not expose a newer property.
    format!(
        "SELECT c.name AS COLUMN_NAME, \
         ty.name AS DATA_TYPE, \
         CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS IS_NULLABLE, \
         dc.definition AS COLUMN_DEFAULT, \
         CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS IS_PK, \
         CONVERT(INT, c.precision) AS NUMERIC_PRECISION, \
         CONVERT(INT, c.scale) AS NUMERIC_SCALE, \
         CASE \
           WHEN ty.name IN ('nchar','nvarchar') AND c.max_length > 0 THEN CONVERT(INT, c.max_length / 2) \
           WHEN c.max_length = -1 THEN -1 \
           ELSE CONVERT(INT, c.max_length) \
         END AS CHARACTER_MAXIMUM_LENGTH, \
         CONVERT(INT, c.scale) AS DATETIME_PRECISION, \
         CASE \
           WHEN c.is_computed = 1 THEN 'computed' \
           WHEN ic.column_id IS NOT NULL THEN 'identity(' + CONVERT(VARCHAR(38), ic.seed_value) + ',' + CONVERT(VARCHAR(38), ic.increment_value) + ')' \
           ELSE NULL \
         END AS COLUMN_EXTRA, \
         ep.value AS COLUMN_COMMENT, \
         CONVERT(INT, COLUMNPROPERTY(c.object_id, c.name, 'IsIdentity')) AS IS_IDENTITY, \
         CONVERT(INT, COLUMNPROPERTY(c.object_id, c.name, 'IsComputed')) AS IS_COMPUTED, \
         CONVERT(INT, COLUMNPROPERTY(c.object_id, c.name, 'IsHidden')) AS IS_HIDDEN, \
         CONVERT(INT, COLUMNPROPERTY(c.object_id, c.name, 'GeneratedAlwaysType')) AS GENERATED_ALWAYS_TYPE \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         JOIN sys.columns c ON c.object_id = o.object_id \
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
         LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id \
         LEFT JOIN ( \
           SELECT ic.object_id, ic.column_id \
           FROM sys.indexes i \
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
           WHERE i.is_primary_key = 1 \
         ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id \
         OUTER APPLY (SELECT CAST(ep.value AS NVARCHAR(MAX)) AS value FROM sys.extended_properties ep WHERE ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description') ep \
         WHERE {schema_filter} AND o.name = '{t}' AND o.type IN ('U','V') \
         ORDER BY c.column_id"
    )
}

pub async fn list_indexes(client: &mut SqlServerClient, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let sql = sqlserver_indexes_sql(schema, table);
    let rows = match sqlserver_index_rows(client, &sql).await {
        Ok(rows) => rows,
        Err(error) if sqlserver_filter_definition_missing(&error) => {
            let legacy_sql = sqlserver_legacy_indexes_sql(schema, table);
            sqlserver_index_rows(client, &legacy_sql).await.map_err(|error| error.to_string())?
        }
        Err(error) => return Err(error.to_string()),
    };
    Ok(rows
        .iter()
        .map(|row| {
            let cols_str = row.get::<&str, _>(1).unwrap_or("");
            let inc_str = row.get::<&str, _>(5).unwrap_or("");
            IndexInfo {
                name: row.get::<&str, _>(0).unwrap_or("").to_string(),
                columns: cols_str.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
                is_unique: row.get::<bool, _>(2).unwrap_or(false),
                is_primary: row.get::<bool, _>(3).unwrap_or(false),
                filter: row.get::<&str, _>(6).map(|s| s.to_string()),
                index_type: row.get::<&str, _>(4).map(|s| s.to_string()),
                included_columns: if inc_str.is_empty() {
                    None
                } else {
                    Some(inc_str.split(',').map(|s| s.to_string()).collect())
                },
                comment: row.get::<&str, _>(7).filter(|s: &&str| !s.is_empty()).map(|s: &str| s.to_string()),
            }
        })
        .collect())
}

async fn sqlserver_index_rows(client: &mut SqlServerClient, sql: &str) -> Result<Vec<Row>, tiberius::error::Error> {
    client.query(sql, &[]).await?.into_first_result().await
}

fn sqlserver_filter_definition_missing(error: &tiberius::error::Error) -> bool {
    sqlserver_filter_definition_error(error.code(), &error.to_string())
}

fn sqlserver_filter_definition_error(code: Option<u32>, message: &str) -> bool {
    code == Some(207) && message.to_ascii_lowercase().contains("filter_definition")
}

fn sqlserver_indexes_sql(schema: &str, table: &str) -> String {
    sqlserver_indexes_sql_with_filter_definition(schema, table, true)
}

fn sqlserver_legacy_indexes_sql(schema: &str, table: &str) -> String {
    sqlserver_indexes_sql_with_filter_definition(schema, table, false)
}

fn sqlserver_indexes_sql_with_filter_definition(schema: &str, table: &str, include_filter_definition: bool) -> String {
    let filter_definition = if include_filter_definition {
        "i.filter_definition"
    } else {
        "CAST(NULL AS NVARCHAR(MAX)) AS filter_definition"
    };
    let object_id = sqlserver_object_id_expression(schema, table);
    format!(
        "SELECT i.name, \
         STUFF((SELECT ',' + c2.name \
                FROM sys.index_columns ic2 \
                JOIN sys.columns c2 ON ic2.object_id = c2.object_id AND ic2.column_id = c2.column_id \
                WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0 \
                ORDER BY ic2.key_ordinal \
                FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '') AS columns, \
         i.is_unique, i.is_primary_key, i.type_desc, \
         STUFF((SELECT ',' + c3.name \
                FROM sys.index_columns ic3 \
                JOIN sys.columns c3 ON ic3.object_id = c3.object_id AND ic3.column_id = c3.column_id \
                WHERE ic3.object_id = i.object_id AND ic3.index_id = i.index_id AND ic3.is_included_column = 1 \
                ORDER BY ic3.index_column_id \
                FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '') AS included_cols, \
         {filter_definition}, \
         ep.value AS index_comment \
         FROM sys.indexes i \
         OUTER APPLY (SELECT CAST(ep.value AS NVARCHAR(MAX)) AS value FROM sys.extended_properties ep WHERE ep.major_id = i.object_id AND ep.minor_id = i.index_id AND ep.name = N'MS_Description' AND ep.class = 7) ep \
         WHERE i.object_id = {object_id} AND i.name IS NOT NULL \
         ORDER BY i.name",
    )
}

pub async fn list_foreign_keys(
    client: &mut SqlServerClient,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = format!(
        "SELECT fk.name, c.name, SCHEMA_NAME(rt.schema_id), rt.name, rc.name \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id \
         JOIN sys.columns c ON fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id \
         JOIN sys.tables rt ON fkc.referenced_object_id = rt.object_id \
         JOIN sys.columns rc ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id \
         WHERE fk.parent_object_id = OBJECT_ID('{s}.{t}') \
         ORDER BY fk.name, fkc.constraint_column_id",
        s = schema.replace('\'', "''"),
        t = table.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            column: row.get::<&str, _>(1).unwrap_or("").to_string(),
            ref_schema: Some(row.get::<&str, _>(2).unwrap_or("").to_string()),
            ref_table: row.get::<&str, _>(3).unwrap_or("").to_string(),
            ref_column: row.get::<&str, _>(4).unwrap_or("").to_string(),
            on_update: None,
            on_delete: None,
        })
        .collect())
}

pub async fn get_table_comment(
    client: &mut SqlServerClient,
    schema: &str,
    table: &str,
) -> Result<Option<String>, String> {
    let sql = sqlserver_table_comment_sql(schema, table);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows.first().and_then(|row| row.get::<&str, _>(0)).filter(|s| !s.is_empty()).map(|s| s.to_string()))
}

fn sqlserver_table_comment_sql(schema: &str, table: &str) -> String {
    let s = schema.replace('\'', "''");
    let t = table.replace('\'', "''");
    format!(
        "SELECT CAST(ep.value AS NVARCHAR(MAX)) \
         FROM sys.extended_properties ep \
         WHERE ep.major_id = OBJECT_ID(QUOTENAME('{s}') + '.' + QUOTENAME('{t}')) \
           AND ep.minor_id = 0 \
           AND ep.name = N'MS_Description'"
    )
}

pub async fn list_triggers(
    client: &mut SqlServerClient,
    schema: &str,
    table: &str,
) -> Result<Vec<TriggerInfo>, String> {
    let sql = sqlserver_triggers_sql(schema, table);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| TriggerInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            event: row.get::<&str, _>(1).unwrap_or("").to_string(),
            timing: row.get::<&str, _>(2).unwrap_or("AFTER").to_string(),
            statement: row.get::<&str, _>(3).map(str::to_string),
        })
        .collect())
}

fn sqlserver_triggers_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT t.name, te.type_desc, CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END, \
         OBJECT_DEFINITION(t.object_id) \
         FROM sys.triggers t \
         JOIN sys.trigger_events te ON t.object_id = te.object_id \
         WHERE t.parent_id = OBJECT_ID('{s}.{t}') \
         ORDER BY t.name",
        s = schema.replace('\'', "''"),
        t = table.replace('\'', "''")
    )
}

pub async fn execute_query(client: &mut SqlServerClient, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(client, sql, None).await
}

fn sqlserver_bulk_token_row(values: Vec<Option<String>>) -> TokenRow<'static> {
    let mut row = TokenRow::with_capacity(values.len());
    for value in values {
        row.push(ColumnData::String(value.map(Cow::Owned)));
    }
    row
}

pub async fn bulk_insert_text_rows<T, F>(
    client: &mut SqlServerClient,
    staging_table: &str,
    rows: &[T],
    column_count: usize,
    mut convert_row: F,
) -> Result<u64, String>
where
    F: FnMut(usize, &T) -> Result<Vec<Option<String>>, String>,
{
    if rows.is_empty() {
        return Ok(0);
    }
    if column_count == 0 {
        return Err("SQL Server bulk load requires at least one mapped column".to_string());
    }

    let mut request = client
        .bulk_insert(staging_table)
        .await
        .map_err(|error| format!("SQL Server bulk load initialization failed: {error}"))?;
    for (row_index, source_row) in rows.iter().enumerate() {
        let row = convert_row(row_index, source_row)?;
        if row.len() != column_count {
            return Err(format!(
                "SQL Server bulk row {} has {} columns; expected {}",
                row_index + 1,
                row.len(),
                column_count
            ));
        }
        request
            .send(sqlserver_bulk_token_row(row))
            .await
            .map_err(|error| format!("SQL Server bulk load send failed: {error}"))?;
    }
    request
        .finalize()
        .await
        .map(|result| result.total())
        .map_err(|error| format!("SQL Server bulk load finalize failed: {error}"))
}

pub async fn execute_query_with_max_rows(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let result_offset = crate::query_result_sql::sqlserver_result_offset(sql);

    if starts_with_executable_sql_keyword(sql, &["SELECT", "EXEC", "WITH", "TABLE"])
        || sqlserver_dml_output_returns_rows(sql)
    {
        let query = match sqlserver_unsafe_type_query(client, sql).await {
            Ok(Some(query)) => query,
            Ok(None) => SqlServerUnsafeTypeQuery::plain(sql),
            Err(error) if is_blocking_sqlserver_unsafe_probe_error(&error) => return Err(error),
            Err(_) => SqlServerUnsafeTypeQuery::plain(sql),
        };
        let (result, messages) = capture_sqlserver_messages(async {
            let stream = sqlserver_driver_result(client.query(query.sql.as_str(), &[])).await?;
            sqlserver_driver_result(collect_first_result_limited(
                stream,
                start,
                max_rows,
                result_offset,
                &query.spatial_columns,
            ))
            .await
        })
        .await;
        let mut result = query_result_with_server_messages(result?, messages);
        strip_dbx_sqlserver_row_number_column(&mut result, sql);
        Ok(result)
    } else if !sqlserver_batch_can_use_execute(sql) {
        execute_simple_batch_first_result_with_max_rows(client, sql, max_rows).await
    } else {
        let (result, messages) = capture_sqlserver_messages(sqlserver_driver_result(client.execute(sql, &[]))).await;
        let result = result?;
        Ok(query_result_with_server_messages(
            QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![],
                affected_rows: result.rows_affected().iter().sum::<u64>(),
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages: Vec::new(),
            },
            messages,
        ))
    }
}

pub async fn execute_batch(client: &mut SqlServerClient, sql: &str) -> Result<Vec<QueryResult>, String> {
    execute_batch_with_max_rows(client, sql, None).await
}

pub async fn execute_batch_with_max_rows(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<Vec<QueryResult>, String> {
    execute_batch_with_max_rows_metadata(client, sql, max_rows)
        .await
        .map(|results| results.into_iter().map(|result| result.result).collect())
}

pub(crate) async fn execute_batch_with_max_rows_metadata(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<Vec<SqlServerBatchResult>, String> {
    let start = Instant::now();
    let result_offset = crate::query_result_sql::sqlserver_result_offset(sql);
    if sqlserver_batch_can_use_execute(sql) {
        let (result, messages) = capture_sqlserver_messages(sqlserver_driver_result(client.execute(sql, &[]))).await;
        let result = result?;
        return Ok(vec![query_result_with_server_messages_metadata(
            QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![],
                affected_rows: result.rows_affected().iter().sum::<u64>(),
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages: Vec::new(),
            },
            messages,
        )]);
    }

    if is_single_sqlserver_select(sql) {
        match sqlserver_unsafe_type_query(client, sql).await {
            Ok(Some(query)) => {
                let (result, messages) = capture_sqlserver_messages(async {
                    let stream = sqlserver_driver_result(client.query(query.sql.as_str(), &[])).await?;
                    sqlserver_driver_result(collect_first_result_limited(
                        stream,
                        start,
                        max_rows,
                        result_offset,
                        &query.spatial_columns,
                    ))
                    .await
                })
                .await;
                return result.map(|result| {
                    let mut result = query_result_with_server_messages_metadata(result, messages);
                    strip_dbx_sqlserver_row_number_column(&mut result.result, sql);
                    vec![result]
                });
            }
            Err(error) if is_blocking_sqlserver_unsafe_probe_error(&error) => return Err(error),
            Ok(None) | Err(_) => {}
        }
    }
    execute_simple_batch_with_max_rows_metadata(client, sql, max_rows).await
}

/// Execute a SQL Server batch directly through TDS simple-query mode.
///
/// This intentionally bypasses result-set type probing and SQL rewriting. It is
/// required while `SHOWPLAN_XML` or `STATISTICS XML` is enabled because any probe
/// issued on the same session is itself affected by the plan-capture state.
pub async fn execute_simple_batch_with_max_rows(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<Vec<QueryResult>, String> {
    execute_simple_batch_with_max_rows_metadata(client, sql, max_rows)
        .await
        .map(|results| results.into_iter().map(|result| result.result).collect())
}

pub(crate) async fn execute_simple_batch_with_max_rows_metadata(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<Vec<SqlServerBatchResult>, String> {
    let start = Instant::now();
    let result_offset = crate::query_result_sql::sqlserver_result_offset(sql);
    let layer = SqlServerTdsEventLayer::default();
    let captured = layer.clone();
    let results = async {
        let stream = sqlserver_driver_result(client.simple_query(sql)).await?;
        sqlserver_driver_result(collect_ordered_result_sets_limited(stream, start, max_rows, result_offset, captured))
            .await
    }
    .with_subscriber(tracing_subscriber::registry().with(layer))
    .await;
    let mut results = results?;
    for result in &mut results {
        strip_dbx_sqlserver_row_number_column(&mut result.result, sql);
    }

    if results.is_empty() {
        results.push(SqlServerBatchResult {
            result: QueryResult {
                columns: vec![],
                column_types: Vec::new(),
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: start.elapsed().as_millis(),
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages: Vec::new(),
            },
            server_message: false,
        });
    }

    Ok(results)
}

async fn execute_simple_batch_first_result_with_max_rows(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let result_offset = crate::query_result_sql::sqlserver_result_offset(sql);
    let (result, messages) = capture_sqlserver_messages(async {
        let stream = sqlserver_driver_result(client.simple_query(sql)).await?;
        sqlserver_driver_result(collect_first_result_limited(stream, start, max_rows, result_offset, &[])).await
    })
    .await;
    let mut result = query_result_with_server_messages(result?, messages);
    strip_dbx_sqlserver_row_number_column(&mut result, sql);
    Ok(result)
}

fn strip_dbx_sqlserver_row_number_column(result: &mut QueryResult, sql: &str) {
    if !is_dbx_sqlserver_row_number_page_sql(sql) {
        return;
    }
    if !result.columns.last().is_some_and(|column| column.eq_ignore_ascii_case("__dbx_row_num")) {
        return;
    }

    result.columns.pop();
    if result.column_types.len() > result.columns.len() {
        result.column_types.pop();
    }
    if result.column_sortables.len() > result.columns.len() {
        result.column_sortables.pop();
    }
    for row in &mut result.rows {
        if row.len() > result.columns.len() {
            row.pop();
        }
    }
}

fn is_dbx_sqlserver_row_number_page_sql(sql: &str) -> bool {
    let normalized = sql.to_ascii_uppercase();
    normalized.contains("ROW_NUMBER() OVER")
        && normalized.contains("[__DBX_ROW_NUM]")
        && normalized.contains("DBX_PAGE_SOURCE.*")
}

fn sqlserver_batch_can_use_execute(sql: &str) -> bool {
    let contains_transaction_control = contains_transaction_control(sql);
    !requires_simple_query_batch(sql)
        && !sqlserver_batch_may_emit_info_messages(sql)
        // Tiberius executes this path through an RPC. SQL Server rejects an RPC
        // that changes @@TRANCOUNT with error 266, while a regular batch is allowed
        // to leave an explicit transaction open for a later COMMIT or ROLLBACK.
        && (!contains_transaction_control || sqlserver_balanced_transaction_batch_can_use_execute(sql))
        && !sqlserver_batch_may_return_result_set(sql)
        && !sqlserver_dml_output_returns_rows(sql)
}

fn sqlserver_batch_may_emit_info_messages(sql: &str) -> bool {
    top_level_sqlserver_tokens(sql).iter().any(|token| matches!(token.text.as_str(), "PRINT" | "RAISERROR" | "DBCC"))
}

fn sqlserver_balanced_transaction_batch_can_use_execute(sql: &str) -> bool {
    let tokens = top_level_sqlserver_tokens(sql);
    if tokens.iter().any(|token| {
        matches!(token.text.as_str(), "IF" | "ELSE" | "WHILE" | "TRY" | "CATCH" | "GOTO" | "RETURN" | "ROLLBACK")
    }) {
        return false;
    }

    let mut transaction_depth = 0usize;
    let mut saw_begin = false;
    let mut saw_commit = false;

    for (index, token) in tokens.iter().enumerate() {
        if token.text == "SET" && tokens.get(index + 1).is_some_and(|next| next.text == "IMPLICIT_TRANSACTIONS") {
            return false;
        }

        if token.text == "BEGIN" {
            if tokens.get(index + 1).is_some_and(|next| next.text == "DISTRIBUTED") {
                return false;
            }
            if tokens.get(index + 1).is_some_and(|next| matches!(next.text.as_str(), "TRANSACTION" | "TRAN")) {
                transaction_depth += 1;
                saw_begin = true;
            }
        } else if token.text == "COMMIT" {
            if transaction_depth == 0 {
                return false;
            }
            transaction_depth -= 1;
            saw_commit = true;
        }
    }

    saw_begin && saw_commit && transaction_depth == 0
}

fn sqlserver_batch_may_return_result_set(sql: &str) -> bool {
    crate::sql::split_sql_statements(sql).iter().any(|statement| {
        let tokens = top_level_sqlserver_tokens(statement);
        let starts_with_dml = starts_with_executable_sql_keyword(statement, &["INSERT", "UPDATE", "DELETE", "MERGE"]);
        if starts_with_dml {
            return false;
        }
        let starts_with_cte_dml = tokens.first().is_some_and(|token| token.text == "WITH")
            && tokens.iter().any(|token| matches!(token.text.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE"));
        tokens.first().is_some_and(|token| token.text == "TABLE")
            || tokens.iter().any(|token| {
                matches!(token.text.as_str(), "SELECT" | "EXEC" | "EXECUTE")
                    || (token.text == "WITH" && !starts_with_cte_dml)
            })
    })
}

fn sqlserver_dml_output_returns_rows(sql: &str) -> bool {
    crate::sql::split_sql_statements(sql).iter().any(|statement| {
        let tokens = top_level_sqlserver_tokens(statement);
        let contains_dml = starts_with_executable_sql_keyword(statement, &["INSERT", "UPDATE", "DELETE", "MERGE"])
            || (tokens.first().is_some_and(|token| token.text == "WITH")
                && tokens.iter().any(|token| matches!(token.text.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE")));
        if !contains_dml {
            return false;
        }

        tokens.iter().enumerate().any(|(output_index, token)| {
            if token.text != "OUTPUT" || (token.start > 0 && statement.as_bytes()[token.start - 1] == b'@') {
                return false;
            }

            // SQL Server may combine OUTPUT ... INTO with a second OUTPUT clause.
            // Only an OUTPUT whose rows are not routed before the next clause reaches the client.
            !tokens[output_index + 1..].iter().take_while(|next| next.text != "OUTPUT").any(|next| next.text == "INTO")
        })
    })
}

fn contains_transaction_control(sql: &str) -> bool {
    let tokens = top_level_sqlserver_tokens(sql);
    tokens.iter().enumerate().any(|(index, token)| {
        if matches!(token.text.as_str(), "COMMIT" | "ROLLBACK") {
            return true;
        }
        if token.text == "BEGIN" {
            if tokens.get(index + 1).is_some_and(|next| matches!(next.text.as_str(), "TRANSACTION" | "TRAN")) {
                return true;
            }
            if tokens.get(index + 1).is_some_and(|next| next.text == "DISTRIBUTED")
                && tokens.get(index + 2).is_some_and(|next| matches!(next.text.as_str(), "TRANSACTION" | "TRAN"))
            {
                return true;
            }
        }
        token.text == "SET"
            && tokens.get(index + 1).is_some_and(|next| next.text == "IMPLICIT_TRANSACTIONS")
            && tokens.get(index + 2).is_some_and(|next| next.text == "ON")
    })
}

fn requires_simple_query_batch(sql: &str) -> bool {
    if creates_local_temp_table(sql) {
        return true;
    }

    let tokens = first_sql_tokens(sql, 4);
    if tokens.len() >= 2 && tokens[0].eq_ignore_ascii_case("SET") && tokens[1].eq_ignore_ascii_case("SHOWPLAN_XML") {
        return true;
    }
    if tokens.len() >= 3
        && tokens[0].eq_ignore_ascii_case("SET")
        && tokens[1].eq_ignore_ascii_case("STATISTICS")
        && tokens[2].eq_ignore_ascii_case("XML")
    {
        return true;
    }
    if tokens.len() >= 2 && tokens[0].eq_ignore_ascii_case("CREATE") && tokens[1].eq_ignore_ascii_case("SCHEMA") {
        return true;
    }

    if tokens.len() >= 4
        && tokens[0].eq_ignore_ascii_case("CREATE")
        && tokens[1].eq_ignore_ascii_case("OR")
        && tokens[2].eq_ignore_ascii_case("ALTER")
    {
        return SIMPLE_QUERY_MODULE_KEYWORDS.iter().any(|keyword| tokens[3].eq_ignore_ascii_case(keyword));
    }

    if tokens.len() >= 2 && (tokens[0].eq_ignore_ascii_case("CREATE") || tokens[0].eq_ignore_ascii_case("ALTER")) {
        return SIMPLE_QUERY_MODULE_KEYWORDS.iter().any(|keyword| tokens[1].eq_ignore_ascii_case(keyword));
    }

    false
}

fn creates_local_temp_table(sql: &str) -> bool {
    if !sql.as_bytes().contains(&b'#') {
        return false;
    }

    let Ok(statements) = Parser::parse_sql(&MsSqlDialect {}, sql) else {
        return false;
    };
    statements.iter().any(|statement| {
        let Statement::CreateTable(table) = statement else {
            return false;
        };
        table.name.0.last().and_then(|part| part.as_ident()).is_some_and(|identifier| identifier.value.starts_with('#'))
    })
}

fn first_sql_tokens(sql: &str, limit: usize) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;

    while i < bytes.len() && tokens.len() < limit {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }

        if i + 1 < bytes.len() && bytes[i] == b'-' && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }

        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
            i += 1;
        }

        if i > start {
            tokens.push(sql[start..i].to_string());
        } else {
            i += 1;
        }
    }

    tokens
}

#[cfg(test)]
mod tests {
    use super::{
        build_sqlserver_unsafe_type_query, capture_sqlserver_messages, completion_context_from_query_result,
        decode_sqlserver_spatial_values, format_sqlserver_numeric, is_blocking_sqlserver_unsafe_probe_error,
        is_sqlserver_legacy_duplicate_probe_error, is_sqlserver_spatial_column, is_sqlserver_variant_column,
        push_sqlserver_ordered_events, query_result_with_server_messages, query_result_with_server_messages_metadata,
        requires_simple_query_batch, restore_sqlserver_legacy_probe_output_names,
        restore_sqlserver_spatial_column_types, server_messages_query_result, sqlserver_batch_can_use_execute,
        sqlserver_bulk_token_row, sqlserver_cell_to_json, sqlserver_columns_sql, sqlserver_completion_assistant_sql,
        sqlserver_dml_output_returns_rows, sqlserver_done_trace_event, sqlserver_filter_definition_error,
        sqlserver_hidden_schema_names, sqlserver_indexes_sql, sqlserver_legacy_indexes_sql, sqlserver_legacy_probe,
        sqlserver_legacy_probe_with_nonce, sqlserver_legacy_wildcard_metadata_query, sqlserver_list_objects_sql,
        sqlserver_list_schemas_sql, sqlserver_list_tables_sql, sqlserver_probe_explicit_alias,
        sqlserver_query_messages, sqlserver_schema_name_predicate, sqlserver_spatial_marker,
        sqlserver_supports_session_database_switch, sqlserver_table_comment_sql, sqlserver_triggers_sql,
        sqlserver_visible_object_predicate, strip_dbx_sqlserver_row_number_column, SqlServerDescribedColumn,
        SqlServerProbeOutputNameOverride, SqlServerResultSet, SqlServerSpatialColumn, SqlServerTdsEvent,
        SQLSERVER_COMPLETION_CONTEXT_SQL, SQLSERVER_RESULT_TYPE_PROBE_SQL,
    };
    use crate::types::{
        CompletionAssistantMatchMode, CompletionAssistantObjectKind, CompletionAssistantRequest, QueryResult,
        SpatialColumn,
    };
    use chrono::NaiveDate;
    use std::{borrow::Cow, time::Instant};
    use tiberius::{Column, ColumnData, ColumnType, IntoSql};

    #[test]
    fn sqlserver_bulk_token_row_owns_text_and_preserves_nulls() {
        let row = sqlserver_bulk_token_row(vec![Some("Tieng Viet".to_string()), None]);
        let values = row.iter().collect::<Vec<_>>();

        assert!(matches!(&values[0], ColumnData::String(Some(value)) if value.as_ref() == "Tieng Viet"));
        assert!(matches!(&values[1], ColumnData::String(None)));
    }

    #[tokio::test]
    async fn sqlserver_ignores_non_info_tiberius_events() {
        let (_, messages) = capture_sqlserver_messages(async {
            tracing::event!(target: "tiberius::tds::stream::token", tracing::Level::ERROR, "permission denied");
            tracing::event!(target: "dbx_core::db::sqlserver", tracing::Level::INFO, "not a TDS token");
        })
        .await;

        assert!(messages.is_empty());
    }

    #[test]
    fn sqlserver_server_messages_fill_only_empty_results() {
        let empty = QueryResult {
            columns: vec![],
            column_types: vec![],
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: 1,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };
        let result = query_result_with_server_messages(empty, vec!["DBCC execution completed".to_string()]);
        assert_eq!(result.columns, vec!["Message"]);
        assert_eq!(result.column_types, vec!["nvarchar"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!("DBCC execution completed")]]);
        // The synthesized grid already carries the text; `messages` stays
        // empty so consumers do not render the same text twice.
        assert!(result.messages.is_empty());

        let message = query_result_with_server_messages_metadata(
            QueryResult {
                columns: vec![],
                column_types: vec![],
                column_sortables: vec![],
                spatial_columns: vec![],
                spatial_values: vec![],
                rows: vec![],
                affected_rows: 0,
                execution_time_ms: 1,
                truncated: false,
                session_id: None,
                has_more: false,
                elasticsearch_raw_body: None,
                messages: Vec::new(),
            },
            vec!["PRINT output".to_string()],
        );
        assert!(message.server_message);

        let select = QueryResult {
            columns: vec!["id".to_string()],
            column_types: vec!["int".to_string()],
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![serde_json::json!(1)]],
            affected_rows: 0,
            execution_time_ms: 1,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };
        let result = query_result_with_server_messages_metadata(select, vec!["informational".to_string()]);
        assert!(!result.server_message);
        assert_eq!(result.result.columns, vec!["id"]);
        assert_eq!(result.result.rows, vec![vec![serde_json::json!(1)]]);
        // Non-empty results keep their shape but still carry the server messages.
        assert_eq!(result.result.messages.len(), 1);
        assert_eq!(result.result.messages[0].severity, "INFO");
        assert_eq!(result.result.messages[0].message, "informational");
    }

    #[test]
    fn sqlserver_done_trace_events_keep_statement_boundaries_and_counts() {
        assert_eq!(
            sqlserver_done_trace_event(
                super::TIBERIUS_DONE_TOKEN_EVENT_LINE,
                "Done with status BitFlags<DoneStatus>(0b10001, More | Count) (2 rows left)",
            ),
            Some(SqlServerTdsEvent::Done(Some(2)))
        );
        assert_eq!(
            sqlserver_done_trace_event(
                super::TIBERIUS_DONE_IN_PROC_TOKEN_EVENT_LINE,
                "Done with status BitFlags<DoneStatus>(0b10000, Count)",
            ),
            Some(SqlServerTdsEvent::Done(Some(0)))
        );
        assert_eq!(
            sqlserver_done_trace_event(
                super::TIBERIUS_DONE_PROC_TOKEN_EVENT_LINE,
                "Done with status BitFlags<DoneStatus>(0b0)",
            ),
            None
        );
        assert_eq!(
            sqlserver_done_trace_event(
                super::TIBERIUS_DONE_TOKEN_EVENT_LINE,
                "Done with status BitFlags<DoneStatus>(0b1, More)",
            ),
            Some(SqlServerTdsEvent::Done(None))
        );
    }

    #[test]
    fn sqlserver_ordered_events_preserve_message_result_and_count_order() {
        let start = Instant::now();
        let mut results = Vec::new();
        let mut current = None;

        push_sqlserver_ordered_events(
            &mut results,
            &mut current,
            vec![SqlServerTdsEvent::Message("before".to_string())],
            start,
        );
        current = Some(SqlServerResultSet {
            columns: vec!["first".to_string()],
            column_types: vec!["int".to_string()],
            rows: vec![vec![serde_json::json!(1)]],
            truncated: false,
            remaining_offset: 0,
        });
        push_sqlserver_ordered_events(
            &mut results,
            &mut current,
            vec![SqlServerTdsEvent::Done(Some(1)), SqlServerTdsEvent::Message("between".to_string())],
            start,
        );
        current = Some(SqlServerResultSet {
            columns: vec!["second".to_string()],
            column_types: vec!["int".to_string()],
            rows: vec![vec![serde_json::json!(2)]],
            truncated: false,
            remaining_offset: 0,
        });
        push_sqlserver_ordered_events(
            &mut results,
            &mut current,
            vec![
                SqlServerTdsEvent::Done(Some(1)),
                SqlServerTdsEvent::Message("after one".to_string()),
                SqlServerTdsEvent::Message("after two".to_string()),
                SqlServerTdsEvent::Done(Some(3)),
            ],
            start,
        );

        assert_eq!(results.len(), 6);
        assert!(results[0].server_message);
        assert_eq!(results[0].result.rows, vec![vec![serde_json::json!("before")]]);
        assert_eq!(results[1].result.columns, vec!["first"]);
        assert!(results[2].server_message);
        assert_eq!(results[2].result.rows, vec![vec![serde_json::json!("between")]]);
        assert_eq!(results[3].result.columns, vec!["second"]);
        assert!(results[4].server_message);
        assert_eq!(
            results[4].result.rows,
            vec![vec![serde_json::json!("after one")], vec![serde_json::json!("after two")]]
        );
        assert_eq!(results[5].result.affected_rows, 3);
        assert!(!results[5].server_message);
    }

    #[test]
    fn sqlserver_ordered_events_drop_select_counts_and_keep_following_dml_counts() {
        let start = Instant::now();
        let mut results = Vec::new();
        let mut current = Some(SqlServerResultSet {
            columns: vec!["selected".to_string()],
            column_types: vec!["int".to_string()],
            rows: vec![vec![serde_json::json!(1)]],
            truncated: false,
            remaining_offset: 0,
        });

        push_sqlserver_ordered_events(
            &mut results,
            &mut current,
            vec![SqlServerTdsEvent::Done(Some(1)), SqlServerTdsEvent::Done(Some(2))],
            start,
        );

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].result.columns, vec!["selected"]);
        assert_eq!(results[1].result.affected_rows, 2);
    }

    #[test]
    fn sqlserver_ordered_events_use_no_count_done_to_close_select_result() {
        let start = Instant::now();
        let mut results = Vec::new();
        let mut current = Some(SqlServerResultSet {
            columns: vec!["selected".to_string()],
            column_types: vec!["int".to_string()],
            rows: vec![vec![serde_json::json!(1)]],
            truncated: false,
            remaining_offset: 0,
        });

        push_sqlserver_ordered_events(
            &mut results,
            &mut current,
            vec![SqlServerTdsEvent::Done(None), SqlServerTdsEvent::Done(Some(2))],
            start,
        );

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].result.columns, vec!["selected"]);
        assert_eq!(results[1].result.affected_rows, 2);
    }

    #[test]
    fn sqlserver_query_messages_map_info_severity() {
        let messages = sqlserver_query_messages(&["first".to_string(), "second".to_string()]);
        assert_eq!(messages.len(), 2);
        for (message, expected) in messages.iter().zip(["first", "second"]) {
            assert_eq!(message.severity, "INFO");
            assert_eq!(message.message, expected);
            assert!(message.code.is_none());
            assert!(message.detail.is_none());
            assert!(message.hint.is_none());
        }

        assert!(sqlserver_query_messages(&[]).is_empty());
    }

    #[test]
    fn sqlserver_server_messages_query_result_synthesizes_grid() {
        assert!(server_messages_query_result(vec![], Instant::now()).is_none());

        let result = server_messages_query_result(vec!["print output".to_string()], Instant::now())
            .expect("non-empty messages yield a result");
        assert!(result.server_message);
        assert_eq!(result.result.columns, vec!["Message"]);
        assert_eq!(result.result.column_types, vec!["nvarchar"]);
        assert_eq!(result.result.rows, vec![vec![serde_json::json!("print output")]]);
        // The synthesized grid already carries the text; `messages` stays
        // empty so consumers do not render the same text twice.
        assert!(result.result.messages.is_empty());
    }

    #[test]
    fn sqlserver_endpoint_splits_named_instance_hosts() {
        assert_eq!(
            super::sqlserver_endpoint(r"192.168.1.10\SQL2022"),
            super::SqlServerEndpoint { host: "192.168.1.10", instance_name: Some("SQL2022") }
        );
        assert_eq!(
            super::sqlserver_endpoint(r" db.example.com\SQLEXPRESS "),
            super::SqlServerEndpoint { host: "db.example.com", instance_name: Some("SQLEXPRESS") }
        );
    }

    #[test]
    fn sqlserver_xml_cells_are_returned_as_strings() {
        let cell = ColumnData::Xml(Some(Cow::Owned(tiberius::xml::XmlData::new(
            "<ShowPlanXML><RelOp NodeId=\"0\" /></ShowPlanXML>",
        ))));

        assert_eq!(
            sqlserver_cell_to_json(&cell),
            serde_json::Value::String("<ShowPlanXML><RelOp NodeId=\"0\" /></ShowPlanXML>".to_string())
        );
    }

    #[test]
    fn sqlserver_uses_sql_type_names_for_tds_big_types() {
        for (column_type, expected) in [
            (ColumnType::BigVarChar, "varchar"),
            (ColumnType::BigChar, "char"),
            (ColumnType::BigVarBin, "varbinary"),
            (ColumnType::BigBinary, "binary"),
        ] {
            let column = Column::new("value".to_string(), column_type);
            assert_eq!(super::sqlserver_column_type_name(&column), expected);
        }
    }

    #[test]
    fn sqlserver_endpoint_keeps_regular_hosts() {
        assert_eq!(
            super::sqlserver_endpoint("db.example.com"),
            super::SqlServerEndpoint { host: "db.example.com", instance_name: None }
        );
        assert_eq!(
            super::sqlserver_endpoint(r"db.example.com\"),
            super::SqlServerEndpoint { host: r"db.example.com\", instance_name: None }
        );
    }

    #[test]
    fn sqlserver_named_instance_resolution_yields_to_explicit_port() {
        let endpoint = super::sqlserver_endpoint(r"db.example.com\SQLEXPRESS");
        assert!(super::sqlserver_uses_named_instance_resolution(&endpoint, 0, false));
        assert!(super::sqlserver_uses_named_instance_resolution(&endpoint, 1433, false));
        assert!(!super::sqlserver_uses_named_instance_resolution(&endpoint, 1433, true));
        assert!(!super::sqlserver_uses_named_instance_resolution(&endpoint, 40030, false));
    }

    #[test]
    fn sqlserver_connect_uses_named_instance_resolution() {
        let source = include_str!("sqlserver.rs");
        let try_connect = source.split("\nasync fn try_connect(").nth(1).unwrap();
        let try_connect = try_connect.split("fn row_to_json").next().unwrap();
        assert!(try_connect.contains("connect_named(&config)"));
    }

    #[test]
    fn sqlserver_native_encryption_flag_accepts_dbx_and_jdbc_params() {
        assert!(!super::sqlserver_native_encryption_disabled(None));
        assert!(!super::sqlserver_native_encryption_disabled(Some("encrypt=true")));
        assert!(super::sqlserver_native_encryption_disabled(Some("sqlserverEncryption=disabled")));
        assert!(super::sqlserver_native_encryption_disabled(Some("applicationName=dbx;sqlserverEncryption=off")));
        assert!(super::sqlserver_native_encryption_disabled(Some("?sqlserverEncryption=false&applicationName=dbx")));
        assert!(super::sqlserver_native_encryption_disabled(Some("applicationName=dbx;encrypt=false")));
        assert!(super::sqlserver_native_encryption_disabled(Some("?Encrypt=0&applicationName=dbx")));
    }

    #[test]
    fn sqlserver_legacy_encryption_modes_cover_jdbc_and_no_encryption_fallback() {
        assert_eq!(super::SQLSERVER_LEGACY_ENCRYPTION_LEVEL, tiberius::EncryptionLevel::Off);
        assert_eq!(super::SQLSERVER_UNSUPPORTED_ENCRYPTION_LEVEL, tiberius::EncryptionLevel::NotSupported);
    }

    #[test]
    fn sqlserver_automatic_fallback_preserves_v48_no_encryption_compatibility() {
        let levels = super::SQLSERVER_LEGACY_ENCRYPTION_FALLBACKS.map(|(_, encryption)| encryption);
        assert_eq!(levels, [tiberius::EncryptionLevel::Off, tiberius::EncryptionLevel::NotSupported]);
    }

    #[test]
    fn sqlserver_tls_handshake_error_detection_matches_legacy_hint_cases() {
        assert!(super::is_sqlserver_tls_handshake_error(
            "SQL Server connection failed: An error occured during the attempt of performing I/O: tls handshake eof"
        ));
        assert!(super::is_sqlserver_tls_handshake_error("TLS handshake failed: unexpected EOF"));
        assert!(!super::is_sqlserver_tls_handshake_error("SQL Server connection failed: Login failed for user"));
    }

    #[test]
    fn sqlserver_module_definitions_require_simple_query_batch() {
        assert!(requires_simple_query_batch("SET SHOWPLAN_XML ON;"));
        assert!(requires_simple_query_batch("SET SHOWPLAN_XML OFF;"));
        assert!(requires_simple_query_batch("SET STATISTICS XML ON;"));
        assert!(requires_simple_query_batch("SET STATISTICS XML OFF;"));
        assert!(!requires_simple_query_batch("SET STATISTICS IO ON;"));
        assert!(requires_simple_query_batch("CREATE SCHEMA [analytics];"));
        assert!(requires_simple_query_batch("CREATE FUNCTION dbo.fn_demo() RETURNS INT AS BEGIN RETURN 1; END;"));
        assert!(requires_simple_query_batch("ALTER PROCEDURE dbo.usp_demo AS SELECT 1;"));
        assert!(requires_simple_query_batch("CREATE OR ALTER VIEW dbo.vw_demo AS SELECT 1 AS id;"));
        assert!(requires_simple_query_batch(
            "-- comment\nALTER TRIGGER dbo.tr_demo ON dbo.t AFTER INSERT AS SELECT 1;"
        ));
    }

    #[test]
    fn sqlserver_regular_ddl_can_use_execute() {
        assert!(!sqlserver_batch_can_use_execute("CREATE SCHEMA [analytics];"));
        assert!(!requires_simple_query_batch("ALTER TABLE dbo.t ADD name NVARCHAR(20);"));
        assert!(!requires_simple_query_batch("CREATE TABLE dbo.t(id INT);"));
        assert!(!requires_simple_query_batch("UPDATE dbo.t SET id = 1;"));
    }

    #[test]
    fn sqlserver_local_temp_table_creation_keeps_session_scoped_query_path() {
        assert!(requires_simple_query_batch("CREATE TABLE #stage (id INT);"));
        assert!(requires_simple_query_batch("CREATE TABLE [#stage] ([id] INT);"));
        assert!(requires_simple_query_batch(
            "DECLARE @id INT = 1; CREATE TABLE #stage (id INT); INSERT INTO #stage VALUES (@id);"
        ));
        assert!(!requires_simple_query_batch("CREATE TABLE dbo.stage (id INT);"));
    }

    #[test]
    fn sqlserver_cud_batches_use_execute_for_affected_rows() {
        assert!(sqlserver_batch_can_use_execute("UPDATE dbo.users SET active = 0 WHERE id = 1;"));
        assert!(sqlserver_batch_can_use_execute("INSERT INTO dbo.users(id) VALUES (1);"));
        assert!(sqlserver_batch_can_use_execute(
            "INSERT INTO dbo.user_archive(id, name) SELECT id, name FROM dbo.users WHERE active = 0;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "DECLARE @target TABLE (id INT); INSERT INTO @target(id) SELECT id FROM (VALUES (1), (2), (3)) AS source(id);"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "INSERT INTO dbo.user_archive(id) SELECT id FROM dbo.users; SELECT COUNT(*) FROM dbo.user_archive;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "DECLARE @target TABLE (id INT); INSERT INTO @target(id) VALUES (1); SELECT id FROM @target;"
        ));
        assert!(sqlserver_batch_can_use_execute("DELETE FROM dbo.users WHERE id = 1;"));
        assert!(sqlserver_batch_can_use_execute(
            "MERGE dbo.t AS t USING dbo.s AS s ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "PRINT N'before'; UPDATE dbo.users SET active = 0 WHERE id = 1; PRINT N'after';"
        ));
        assert!(!sqlserver_batch_can_use_execute("DBCC CHECKIDENT ('dbo.users', NORESEED);"));
        assert!(!sqlserver_batch_can_use_execute("RAISERROR(N'progress', 0, 1) WITH NOWAIT;"));
    }

    #[test]
    fn sqlserver_balanced_transaction_dml_batches_use_execute_for_affected_rows() {
        assert!(sqlserver_batch_can_use_execute(
            "BEGIN TRANSACTION; UPDATE dbo.users SET active = 0 WHERE id = 1; COMMIT TRANSACTION;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "BEGIN TRAN; UPDATE dbo.users SET active = 0 WHERE id = 1; DELETE dbo.audit WHERE user_id = 1; COMMIT;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "BEGIN TRAN outer_tx; BEGIN TRAN inner_tx; UPDATE dbo.users SET active = 0; COMMIT TRAN inner_tx; COMMIT TRAN outer_tx;"
        ));

        assert!(!sqlserver_batch_can_use_execute("BEGIN TRAN; UPDATE dbo.users SET active = 0;"));
        assert!(!sqlserver_batch_can_use_execute("UPDATE dbo.users SET active = 0; COMMIT TRAN;"));
        assert!(!sqlserver_batch_can_use_execute("BEGIN TRAN; UPDATE dbo.users SET active = 0; ROLLBACK TRAN;"));
        assert!(!sqlserver_batch_can_use_execute("BEGIN TRAN; IF @should_commit = 1 COMMIT TRAN;"));
        assert!(!sqlserver_batch_can_use_execute(
            "BEGIN TRY; BEGIN TRAN; UPDATE dbo.users SET active = 0; COMMIT TRAN; END TRY; BEGIN CATCH; ROLLBACK TRAN; END CATCH;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "BEGIN DISTRIBUTED TRAN; UPDATE dbo.users SET active = 0; COMMIT TRAN;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "SET IMPLICIT_TRANSACTIONS ON; UPDATE dbo.users SET active = 0; COMMIT TRAN;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "BEGIN TRAN; UPDATE dbo.users SET active = 0; COMMIT TRAN; SELECT 1;"
        ));
    }

    #[test]
    fn sqlserver_cte_dml_batches_use_execute_for_affected_rows() {
        assert!(sqlserver_batch_can_use_execute(
            ";WITH cte AS (SELECT 1 AS id) UPDATE dbo.users SET active = 0 FROM dbo.users JOIN cte ON cte.id = users.id;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "WITH a AS (SELECT 1 AS id), b AS (SELECT id FROM a) DELETE dbo.users FROM dbo.users JOIN b ON b.id = users.id;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "WITH source AS (SELECT 1 AS id) MERGE dbo.users AS target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET active = 0;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) UPDATE dbo.users WITH (ROWLOCK) SET note = 'SELECT OUTPUT' /* WITH SELECT OUTPUT */;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) UPDATE dbo.users SET active = @output WHERE id = 1;"
        ));

        assert!(!sqlserver_batch_can_use_execute("WITH cte AS (SELECT 1 AS id) SELECT * FROM cte;"));
        assert!(!sqlserver_batch_can_use_execute("WITH cte AS (SELECT 1 AS id) (SELECT id FROM cte);"));
        assert!(!sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) (SELECT id FROM cte) UNION (SELECT 2);"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) (SELECT id FROM cte); UPDATE dbo.users SET active = 0;"
        ));
        assert!(!sqlserver_batch_can_use_execute("WITH XMLNAMESPACES ('urn:demo' AS ns) SELECT 1 AS id;"));
        assert!(!sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) UPDATE dbo.users SET active = 0 OUTPUT inserted.id;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) DELETE dbo.users OUTPUT deleted.id FROM dbo.users JOIN cte ON cte.id = users.id;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "WITH source AS (SELECT 1 AS id) MERGE dbo.users AS target USING source ON target.id = source.id WHEN MATCHED THEN DELETE OUTPUT deleted.id;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) UPDATE dbo.users SET active = 0 OUTPUT inserted.id INTO dbo.audit_ids;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) DELETE dbo.users OUTPUT deleted.id INTO dbo.audit_ids FROM dbo.users JOIN cte ON cte.id = users.id;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "WITH source AS (SELECT 1 AS id) MERGE dbo.users AS target USING source ON target.id = source.id WHEN MATCHED THEN DELETE OUTPUT deleted.id INTO dbo.audit_ids;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "WITH source AS (SELECT 1 AS id) MERGE dbo.users AS target USING source ON target.id = source.id WHEN MATCHED THEN UPDATE SET active = 0 OUTPUT inserted.id INTO dbo.audit_ids OUTPUT inserted.id;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) UPDATE dbo.users SET active = 0; SELECT 1;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) UPDATE dbo.users SET active = 0 OUTPUT inserted.id INTO dbo.audit_ids; SELECT 1;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "WITH cte AS (SELECT 1 AS id) INSERT INTO dbo.users(id) SELECT id FROM cte;"
        ));
        assert!(!sqlserver_batch_can_use_execute("RESTORE HEADERONLY FROM DISK = 'backup.bak' WITH FILE = 1;"));
        assert!(sqlserver_batch_can_use_execute(
            "DECLARE @output INT = 1; UPDATE dbo.users SET active = @output WHERE id = 1;"
        ));
    }

    #[test]
    fn sqlserver_transaction_batches_keep_simple_query_path() {
        assert!(!sqlserver_batch_can_use_execute("BEGIN TRANSACTION\nUPDATE dbo.users SET active = 0 WHERE id = 1;"));
        assert!(!sqlserver_batch_can_use_execute("UPDATE dbo.users SET active = 0 WHERE id = 1;\nCOMMIT;"));
        assert!(!sqlserver_batch_can_use_execute("ROLLBACK TRANSACTION;"));
        assert!(!sqlserver_batch_can_use_execute(
            "BEGIN DISTRIBUTED TRANSACTION\nUPDATE dbo.users SET active = 0 WHERE id = 1;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "SET IMPLICIT_TRANSACTIONS ON\nUPDATE dbo.users SET active = 0 WHERE id = 1;"
        ));
        assert!(sqlserver_batch_can_use_execute("BEGIN TRY\nUPDATE dbo.users SET active = 0 WHERE id = 1;\nEND TRY"));
        assert!(sqlserver_batch_can_use_execute(
            "UPDATE dbo.users SET note = 'BEGIN TRANSACTION; ROLLBACK' WHERE id = 1;"
        ));
        assert!(sqlserver_batch_can_use_execute("UPDATE dbo.users SET [rollback] = 1 WHERE id = 1;"));
    }

    #[test]
    fn sqlserver_result_returning_batches_keep_simple_query_path() {
        assert!(!sqlserver_batch_can_use_execute("SELECT * FROM dbo.users;"));
        assert!(!sqlserver_batch_can_use_execute("EXEC dbo.list_users;"));
        assert!(!sqlserver_batch_can_use_execute("DECLARE @id INT = 1; EXEC dbo.list_users @id;"));
        assert!(!sqlserver_batch_can_use_execute(
            "SET NOCOUNT OFF; DECLARE @rows TABLE (id INT); INSERT INTO @rows VALUES (1), (2); SELECT id FROM @rows;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "DECLARE @id INT = 1; CREATE TABLE #t(id INT); INSERT INTO #t VALUES (@id); SELECT id FROM #t;"
        ));
        assert!(!sqlserver_batch_can_use_execute("WITH cte AS (SELECT 1 AS id) SELECT * FROM cte;"));
        assert!(!sqlserver_batch_can_use_execute("UPDATE dbo.users SET active = 0 OUTPUT inserted.id WHERE id = 1;"));
        assert!(sqlserver_batch_can_use_execute(
            "UPDATE dbo.users SET active = 0 OUTPUT inserted.id INTO dbo.audit_ids WHERE id = 1;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "DELETE FROM dbo.users OUTPUT deleted.id INTO @audit_ids WHERE id = 1;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "MERGE dbo.users AS target USING dbo.source AS source ON target.id = source.id WHEN MATCHED THEN DELETE OUTPUT deleted.id INTO dbo.audit_ids;"
        ));
        assert!(!sqlserver_batch_can_use_execute(
            "UPDATE dbo.users SET active = 0 OUTPUT inserted.id INTO dbo.audit_ids OUTPUT inserted.id WHERE id = 1;"
        ));
        assert!(sqlserver_batch_can_use_execute(
            "DECLARE @id INT = 1; UPDATE dbo.users SET active = 0 WHERE id = @id;"
        ));
        assert!(sqlserver_dml_output_returns_rows("DELETE FROM dbo.users OUTPUT deleted.id WHERE id = 1;"));
    }

    #[test]
    fn sqlserver_dml_output_detection_distinguishes_client_rows_from_output_into() {
        assert!(sqlserver_dml_output_returns_rows(
            "INSERT INTO dbo.users(name) OUTPUT inserted.id, inserted.name VALUES (N'Ada')"
        ));
        assert!(sqlserver_dml_output_returns_rows("UPDATE dbo.users SET active = 1 OUTPUT inserted.id WHERE id = 1"));
        assert!(sqlserver_dml_output_returns_rows("DELETE FROM dbo.users OUTPUT deleted.id WHERE id = 1"));
        assert!(!sqlserver_dml_output_returns_rows(
            "INSERT INTO dbo.audit OUTPUT inserted.id INTO dbo.audit_ids VALUES (1)"
        ));
        assert!(!sqlserver_dml_output_returns_rows(
            "UPDATE dbo.users SET note = N'OUTPUT inserted.id' WHERE id = 1 -- OUTPUT deleted.id"
        ));
        assert!(!sqlserver_dml_output_returns_rows("SELECT N'OUTPUT inserted.id'"));
    }

    #[test]
    fn sqlserver_dml_output_uses_the_result_set_execution_path() {
        let source = include_str!("sqlserver.rs");
        let execute_query = source.split("pub async fn execute_query_with_max_rows").nth(1).unwrap();
        let execute_query = execute_query.split("pub async fn execute_batch").next().unwrap();

        assert!(execute_query.contains("sqlserver_dml_output_returns_rows(sql)"));
        assert!(execute_query.contains("client.query(query.sql.as_str(), &[])"));
    }

    #[test]
    fn sqlserver_single_result_entrypoint_keeps_result_returning_batches() {
        let source = include_str!("sqlserver.rs");
        let execute_query = source.split("pub async fn execute_query_with_max_rows").nth(1).unwrap();
        let execute_query = execute_query.split("pub async fn execute_batch").next().unwrap();

        assert!(execute_query.contains("!sqlserver_batch_can_use_execute(sql)"));
        assert!(execute_query.contains("execute_simple_batch_first_result_with_max_rows(client, sql, max_rows)"));
        assert!(!execute_query.contains("execute_simple_batch_with_max_rows(client, sql, max_rows)"));

        let first_result = source.split("async fn execute_simple_batch_first_result_with_max_rows").nth(1).unwrap();
        let first_result = first_result.split("fn strip_dbx_sqlserver_row_number_column").next().unwrap();
        assert!(first_result.contains("collect_first_result_limited(stream, start, max_rows, result_offset, &[])"));
        assert!(!first_result.contains("collect_result_sets_limited"));
    }

    #[test]
    fn sqlserver_user_query_paths_do_not_collect_full_results_before_limiting() {
        let source = include_str!("sqlserver.rs");
        let execute_query = source.split("pub async fn execute_query").nth(1).unwrap();
        let execute_query = execute_query.split("pub async fn execute_batch").next().unwrap();
        assert!(!execute_query.contains("into_first_result"));

        let execute_batch = source.split("pub async fn execute_batch").nth(1).unwrap();
        let execute_batch = execute_batch.split("#[cfg(test)]").next().unwrap();
        assert!(!execute_batch.contains("into_results"));
    }

    #[test]
    fn sqlserver_explicit_simple_batch_bypasses_result_type_probing() {
        let source = include_str!("sqlserver.rs");
        let simple_batch = source.split("pub async fn execute_simple_batch_with_max_rows").nth(1).unwrap();
        let simple_batch = simple_batch.split("fn strip_dbx_sqlserver_row_number_column").next().unwrap();

        assert!(simple_batch.contains("client.simple_query(sql)"));
        assert!(!simple_batch.contains("sqlserver_unsafe_type_query"));
        assert!(!simple_batch.contains("describe_sqlserver_result_set"));
    }

    #[test]
    fn sqlserver_index_metadata_sql_avoids_string_agg_for_older_compatibility_levels() {
        let sql = sqlserver_indexes_sql("dbo", "DF_Rule");

        assert!(!sql.contains("STRING_AGG"));
        assert!(sql.contains("FOR XML PATH"));
        assert!(sql.contains("OBJECT_ID(QUOTENAME(N'dbo') + N'.' + QUOTENAME(N'DF_Rule'))"));
    }

    #[test]
    fn sqlserver_indexes_sql_includes_index_comment_via_extended_properties() {
        let sql = sqlserver_indexes_sql("dbo", "orders");

        assert!(sql.contains("sys.extended_properties ep"));
        assert!(sql.contains("ep.minor_id = i.index_id"));
        assert!(sql.contains("MS_Description"));
    }

    #[test]
    fn sqlserver_legacy_indexes_sql_omits_filtered_index_metadata() {
        let sql = sqlserver_legacy_indexes_sql("dbo", "orders");

        assert!(!sql.contains("i.filter_definition"));
        assert!(sql.contains("CAST(NULL AS NVARCHAR(MAX)) AS filter_definition"));
        assert!(sql.contains("ep.value AS index_comment"));
    }

    #[test]
    fn sqlserver_filter_definition_fallback_requires_column_error_207() {
        assert!(sqlserver_filter_definition_error(
            Some(207),
            "Token error: Column name 'filter_definition' is invalid. (code: 207)"
        ));
        assert!(sqlserver_filter_definition_error(
            Some(207),
            "Token error: 列名 'filter_definition' 无效。 (code: 207)"
        ));
        assert!(!sqlserver_filter_definition_error(
            Some(207),
            "Token error: Column name 'other_column' is invalid. (code: 207)"
        ));
        assert!(!sqlserver_filter_definition_error(
            Some(229),
            "Token error: SELECT permission denied for filter_definition. (code: 229)"
        ));
    }

    #[test]
    fn sqlserver_columns_sql_reads_column_comment_by_column_id() {
        let sql = sqlserver_columns_sql("dbo", "orders");

        assert!(sql.contains("FROM sys.objects o"));
        assert!(sql.contains("JOIN sys.columns c ON c.object_id = o.object_id"));
        assert!(sql.contains("sys.extended_properties ep"));
        assert!(sql.contains("ep.major_id = c.object_id"));
        assert!(sql.contains("ep.minor_id = c.column_id"));
        assert!(sql.contains("MS_Description"));
        assert!(sql.contains("c.is_computed = 1 THEN 'computed'"));
    }

    #[test]
    fn sqlserver_columns_sql_exposes_structured_generation_flags() {
        let sql = sqlserver_columns_sql("dbo", "orders");

        assert!(sql.contains("COLUMNPROPERTY(c.object_id, c.name, 'IsIdentity')"));
        assert!(sql.contains("COLUMNPROPERTY(c.object_id, c.name, 'IsComputed')"));
        assert!(sql.contains("COLUMNPROPERTY(c.object_id, c.name, 'IsHidden')"));
        assert!(sql.contains("COLUMNPROPERTY(c.object_id, c.name, 'GeneratedAlwaysType')"));
    }

    #[test]
    fn sqlserver_table_comment_sql_queries_extended_properties() {
        let sql = sqlserver_table_comment_sql("dbo", "users");

        assert!(sql.contains("sys.extended_properties ep"));
        assert!(sql.contains("ep.minor_id = 0"));
        assert!(sql.contains("MS_Description"));
        assert!(sql.contains("QUOTENAME('dbo')"));
        assert!(sql.contains("QUOTENAME('users')"));
    }

    #[test]
    fn sqlserver_triggers_sql_includes_definition_for_legacy_versions() {
        let sql = sqlserver_triggers_sql("d'bo", "t'able");

        assert!(sql.contains("OBJECT_DEFINITION(t.object_id)"));
        assert!(sql.contains("JOIN sys.trigger_events te ON t.object_id = te.object_id"));
        assert!(sql.contains("OBJECT_ID('d''bo.t''able')"));
        assert!(sql.contains("ORDER BY t.name"));
        assert!(!sql.contains("STRING_AGG"));
    }

    #[test]
    fn sqlserver_metadata_sql_escapes_literals() {
        let columns_sql = sqlserver_columns_sql("d'bo", "t'able");
        let indexes_sql = sqlserver_indexes_sql("d'bo", "t'able");

        assert!(columns_sql.contains("s.name = N'd''bo'"));
        assert!(columns_sql.contains("o.name = 't''able'"));
        assert!(columns_sql.contains("sys.identity_columns"));
        assert!(indexes_sql.contains("OBJECT_ID(QUOTENAME(N'd''bo') + N'.' + QUOTENAME(N't''able'))"));
    }

    #[test]
    fn sqlserver_metadata_resolves_blank_schema_to_default_with_dbo_fallback() {
        let predicate = sqlserver_schema_name_predicate("  ", "s.name");

        assert_eq!(
            predicate,
            "s.name = COALESCE((SELECT default_schema.name FROM sys.schemas default_schema WHERE default_schema.name = SCHEMA_NAME()), N'dbo')"
        );
        assert!(sqlserver_list_tables_sql("", None, None, None).contains(&predicate));
        assert!(sqlserver_columns_sql("\t", "orders")
            .contains("s.name = OBJECT_SCHEMA_NAME(OBJECT_ID(QUOTENAME(N'orders')))"),);
        assert!(sqlserver_indexes_sql("", "orders").contains("OBJECT_ID(QUOTENAME(N'orders'))"));
    }

    #[test]
    fn sqlserver_completion_context_uses_the_database_user_default_schema() {
        assert!(SQLSERVER_COMPLETION_CONTEXT_SQL.contains("SCHEMA_NAME()"));
        assert!(SQLSERVER_COMPLETION_CONTEXT_SQL.contains("sys.schemas"));
        assert!(SQLSERVER_COMPLETION_CONTEXT_SQL.contains("N'dbo'"));
        assert!(SQLSERVER_COMPLETION_CONTEXT_SQL.contains("EngineEdition"));
    }

    #[test]
    fn sqlserver_completion_context_disables_use_for_azure_database_endpoints() {
        assert!(!sqlserver_supports_session_database_switch(5));
        assert!(!sqlserver_supports_session_database_switch(6));
        assert!(!sqlserver_supports_session_database_switch(11));
        assert!(!sqlserver_supports_session_database_switch(12));
        assert!(!sqlserver_supports_session_database_switch(99));
        assert!(sqlserver_supports_session_database_switch(3));
        assert!(sqlserver_supports_session_database_switch(8));
        assert!(sqlserver_supports_session_database_switch(9));
    }

    #[test]
    fn sqlserver_completion_context_parses_agent_query_results() {
        let context = completion_context_from_query_result(QueryResult {
            columns: vec!["default_schema".to_string(), "engine_edition".to_string()],
            column_types: vec![],
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![serde_json::json!("app_user"), serde_json::json!("8")]],
            affected_rows: 0,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        })
        .unwrap();

        assert_eq!(context.default_schema, "app_user");
        assert!(context.supports_session_database_switch);
    }

    #[test]
    fn sqlserver_metadata_preserves_explicit_schema_matching() {
        let predicate = sqlserver_schema_name_predicate("Sales'Ops", "s.name");

        assert_eq!(predicate, "s.name = N'Sales''Ops'");
        assert!(sqlserver_list_tables_sql("Sales'Ops", None, None, None).contains(&predicate));
        assert!(sqlserver_columns_sql("Sales'Ops", "orders").contains(&predicate));
        assert!(!predicate.contains("SCHEMA_NAME()"));
    }

    #[test]
    fn sqlserver_list_objects_sql_includes_timestamps() {
        let sql = sqlserver_list_objects_sql("dbo");

        assert!(sql.contains("create_date"));
        assert!(sql.contains("modify_date"));
    }

    #[test]
    fn sqlserver_metadata_allows_cdc_system_shipped_objects() {
        let predicate = sqlserver_visible_object_predicate();

        assert_eq!(predicate, "(o.is_ms_shipped = 0 OR s.name = 'cdc')");
        assert!(sqlserver_list_tables_sql("cdc", None, Some(200), None).contains(predicate));
        assert!(sqlserver_list_objects_sql("cdc").contains(predicate));
    }

    #[test]
    fn sqlserver_list_schemas_includes_empty_user_schemas() {
        let sql = sqlserver_list_schemas_sql();

        assert!(!sql.contains("sys.objects"));
        assert!(sql.contains("s.name NOT IN"));
        assert!(sql.contains("'db_owner'"));
        assert!(sql.contains("'db_datareader'"));
        assert!(sqlserver_hidden_schema_names().contains(&"sys"));
    }

    #[test]
    fn sqlserver_list_tables_filter_is_case_insensitive() {
        let sql = sqlserver_list_tables_sql("dbo", Some("temp"), Some(200), None);

        assert!(sql.contains("LOWER(o.name) LIKE LOWER('%temp%') ESCAPE '\\'"));
        assert!(sql.contains("LOWER(o.name) LIKE LOWER('%t%e%m%p%') ESCAPE '\\'"));
        assert!(sql.contains("SELECT TOP (200)"));
    }

    #[test]
    fn sqlserver_list_tables_filter_escapes_like_literals() {
        let sql = sqlserver_list_tables_sql("dbo", Some("Temp_Table[%]"), Some(200), None);

        assert!(sql.contains("LOWER(o.name) LIKE LOWER('%Temp\\_Table\\[\\%]%') ESCAPE '\\'"));
        assert!(sql.contains("LOWER(o.name) LIKE LOWER('%T%e%m%p%\\_%T%a%b%l%e%\\[%\\%%]%') ESCAPE '\\'"));
    }

    #[test]
    fn sqlserver_list_tables_filter_adds_fuzzy_pattern() {
        let sql = sqlserver_list_tables_sql("dbo", Some("sysu"), Some(200), None);

        assert!(sql.contains("LOWER(o.name) LIKE LOWER('%sysu%') ESCAPE '\\'"));
        assert!(sql.contains("LOWER(o.name) LIKE LOWER('%s%y%s%u%') ESCAPE '\\'"));
        assert!(sql.contains("SELECT TOP (200)"));
    }

    #[test]
    fn sqlserver_list_tables_filter_skips_fuzzy_pattern_for_single_character() {
        let sql = sqlserver_list_tables_sql("dbo", Some("u"), Some(200), None);

        assert!(sql.contains("LOWER(o.name) LIKE LOWER('%u%') ESCAPE '\\'"));
        assert!(!sql.contains(" OR LOWER(o.name) LIKE"));
        assert!(sql.contains("SELECT TOP (200)"));
    }

    #[test]
    fn sqlserver_completion_assistant_searches_objects_before_limiting() {
        let request = CompletionAssistantRequest {
            connection_id: "c1".to_string(),
            database: "app".to_string(),
            schema: Some("dbo".to_string()),
            object_kinds: vec![CompletionAssistantObjectKind::Table, CompletionAssistantObjectKind::View],
            mask: "Temp".to_string(),
            case_sensitive: false,
            global_search: false,
            max_results: Some(100),
            search_in_comments: false,
            search_in_definitions: false,
            parent_schema: None,
            parent_name: None,
            match_mode: Some(CompletionAssistantMatchMode::Prefix),
        };

        let sql = sqlserver_completion_assistant_sql(&request, 100);

        assert!(sql.contains("SELECT TOP (100)"));
        assert!(sql.contains("FROM sys.objects o"));
        assert!(sql.contains("o.type IN ('U','V')"));
        assert!(sql.contains("s.name = 'dbo'"));
        assert!(sql.contains("LOWER(o.name) LIKE LOWER('Temp%') ESCAPE '\\'"));
        assert!(sql.contains("CAST(NULL AS NVARCHAR(128)) AS parent_schema"));
        assert!(sql.contains("CAST(NULL AS NVARCHAR(128)) AS parent_name"));
        assert!(sql.contains("CAST(NULL AS NVARCHAR(128)) AS data_type"));
    }

    #[test]
    fn sqlserver_completion_assistant_searches_columns_by_parent_table() {
        let request = CompletionAssistantRequest {
            connection_id: "c1".to_string(),
            database: "app".to_string(),
            schema: Some("dbo".to_string()),
            object_kinds: vec![CompletionAssistantObjectKind::Column],
            mask: "id".to_string(),
            case_sensitive: false,
            global_search: false,
            max_results: Some(50),
            search_in_comments: false,
            search_in_definitions: false,
            parent_schema: Some("dbo".to_string()),
            parent_name: Some("Users".to_string()),
            match_mode: Some(CompletionAssistantMatchMode::Contains),
        };

        let sql = sqlserver_completion_assistant_sql(&request, 50);

        assert!(sql.contains("FROM sys.columns c"));
        assert!(sql.contains("o.name = 'Users'"));
        assert!(sql.contains("LOWER(c.name) LIKE LOWER('%id%') ESCAPE '\\'"));
        assert!(sql.contains("CAST(NULL AS NVARCHAR(MAX)) AS object_comment"));
        assert!(sql.contains("ORDER BY c.column_id"));
        assert!(!sql.contains("AS dbx_completion ORDER BY name"));
    }

    #[test]
    fn sqlserver_completion_assistant_returns_function_result_types() {
        let request = CompletionAssistantRequest {
            connection_id: "c1".to_string(),
            database: "app".to_string(),
            schema: Some("dbo".to_string()),
            object_kinds: vec![CompletionAssistantObjectKind::Routine],
            mask: "fn_".to_string(),
            case_sensitive: false,
            global_search: false,
            max_results: Some(50),
            search_in_comments: false,
            search_in_definitions: false,
            parent_schema: Some("dbo".to_string()),
            parent_name: None,
            match_mode: Some(CompletionAssistantMatchMode::Prefix),
        };

        let sql = sqlserver_completion_assistant_sql(&request, 50);

        assert!(sql.contains("WHEN o.type IN ('IF','TF','FT') THEN 'table'"));
        assert!(sql.contains("p.parameter_id = 0"));
        assert!(sql.contains("TYPE_NAME(p.user_type_id)"));
    }

    #[test]
    fn sqlserver_completion_assistant_searches_tempdb_for_temp_table_masks() {
        let request = CompletionAssistantRequest {
            connection_id: "c1".to_string(),
            database: "app".to_string(),
            schema: Some("dbo".to_string()),
            object_kinds: vec![CompletionAssistantObjectKind::Table],
            mask: "#Temp".to_string(),
            case_sensitive: false,
            global_search: false,
            max_results: Some(100),
            search_in_comments: false,
            search_in_definitions: false,
            parent_schema: None,
            parent_name: None,
            match_mode: Some(CompletionAssistantMatchMode::Prefix),
        };

        let sql = sqlserver_completion_assistant_sql(&request, 100);

        assert!(sql.contains("FROM tempdb.sys.all_objects o"));
        assert!(sql.contains("o.type = 'U'"));
        assert!(sql.contains("LOWER(o.name) LIKE LOWER('#Temp%') ESCAPE '\\'"));
        assert!(sql.contains("CAST(NULL AS NVARCHAR(128)) AS parent_schema"));
        assert!(sql.contains("CAST(NULL AS NVARCHAR(MAX)) AS object_comment"));
    }

    #[test]
    fn sqlserver_completion_assistant_generates_scoped_search_masks() {
        assert_eq!(super::completion_like_pattern("Temp", Some(&CompletionAssistantMatchMode::Prefix)), "Temp%");
        assert_eq!(super::completion_like_pattern("Temp", Some(&CompletionAssistantMatchMode::Contains)), "%Temp%");
        assert_eq!(
            super::completion_like_pattern("dbo.Temp%", Some(&CompletionAssistantMatchMode::Prefix)),
            "dbo.Temp%"
        );
        assert_eq!(
            super::completion_like_pattern("Temp_Table", Some(&CompletionAssistantMatchMode::Prefix)),
            "Temp\\_Table%"
        );
    }

    #[test]
    fn sqlserver_completion_assistant_can_search_comments_and_definitions() {
        let request = CompletionAssistantRequest {
            connection_id: "c1".to_string(),
            database: "app".to_string(),
            schema: Some("dbo".to_string()),
            object_kinds: vec![CompletionAssistantObjectKind::Procedure],
            mask: "audit".to_string(),
            case_sensitive: false,
            global_search: false,
            max_results: Some(100),
            search_in_comments: true,
            search_in_definitions: true,
            parent_schema: None,
            parent_name: None,
            match_mode: Some(CompletionAssistantMatchMode::Contains),
        };

        let sql = sqlserver_completion_assistant_sql(&request, 100);

        assert!(sql.contains("COALESCE(ep.value, '')"));
        assert!(sql.contains("OBJECT_DEFINITION(o.object_id)"));
        assert!(sql.contains("LOWER('%audit%')"));
    }

    #[test]
    fn sqlserver_completion_assistant_casts_schema_and_empty_result_placeholders() {
        let schema_request = CompletionAssistantRequest {
            connection_id: "c1".to_string(),
            database: "app".to_string(),
            schema: None,
            object_kinds: vec![CompletionAssistantObjectKind::Schema],
            mask: "d".to_string(),
            case_sensitive: false,
            global_search: false,
            max_results: Some(100),
            search_in_comments: false,
            search_in_definitions: false,
            parent_schema: None,
            parent_name: None,
            match_mode: Some(CompletionAssistantMatchMode::Prefix),
        };
        let schema_sql = sqlserver_completion_assistant_sql(&schema_request, 100);

        assert!(schema_sql.contains("CAST(NULL AS NVARCHAR(128)) AS parent_schema"));
        assert!(schema_sql.contains("CAST(NULL AS NVARCHAR(128)) AS parent_name"));
        assert!(schema_sql.contains("CAST(NULL AS NVARCHAR(MAX)) AS object_comment"));
        assert!(schema_sql.contains("CAST(NULL AS NVARCHAR(128)) AS data_type"));

        let empty_request = CompletionAssistantRequest {
            object_kinds: vec![CompletionAssistantObjectKind::Database],
            ..schema_request
        };
        let empty_sql = sqlserver_completion_assistant_sql(&empty_request, 100);

        assert!(empty_sql.contains("CAST('' AS NVARCHAR(128)) AS name"));
        assert!(empty_sql.contains("CAST(NULL AS NVARCHAR(128)) AS parent_schema"));
        assert!(empty_sql.contains("CAST(NULL AS NVARCHAR(MAX)) AS object_comment"));
    }

    #[test]
    fn sqlserver_tinyint_cells_are_json_numbers() {
        assert_eq!(sqlserver_cell_to_json(&ColumnData::U8(Some(7))), serde_json::json!(7));
    }

    #[test]
    fn sqlserver_numeric_cells_with_scale_over_28_do_not_panic() {
        // NUMERIC(38, 29) with data used to abort the app: rust_decimal caps scale at 28 (issue #3648).
        let cell = ColumnData::Numeric(Some(tiberius::numeric::Numeric::new_with_scale(5, 29)));
        assert_eq!(sqlserver_cell_to_json(&cell), serde_json::json!("0.00000000000000000000000000005"));
    }

    #[test]
    fn sqlserver_numeric_cells_beyond_96_bit_mantissa_do_not_panic() {
        // Precision-38 values overflow rust_decimal's 96-bit mantissa even at low scale.
        let value: i128 = 12_345_678_901_234_567_890_123_456_789_012_345_678;
        let cell = ColumnData::Numeric(Some(tiberius::numeric::Numeric::new_with_scale(value, 10)));
        assert_eq!(sqlserver_cell_to_json(&cell), serde_json::json!("1234567890123456789012345678.9012345678"));
    }

    #[test]
    fn sqlserver_null_numeric_cells_are_json_null() {
        assert_eq!(sqlserver_cell_to_json(&ColumnData::Numeric(None)), serde_json::Value::Null);
    }

    #[test]
    fn format_sqlserver_numeric_covers_sign_scale_and_padding() {
        assert_eq!(format_sqlserver_numeric(42, 0), "42");
        assert_eq!(format_sqlserver_numeric(-42, 0), "-42");
        assert_eq!(format_sqlserver_numeric(12345, 2), "123.45");
        // Trailing zeros are kept, matching the previous rust_decimal display.
        assert_eq!(format_sqlserver_numeric(1500, 3), "1.500");
        assert_eq!(format_sqlserver_numeric(-15, 1), "-1.5");
        assert_eq!(format_sqlserver_numeric(-5, 2), "-0.05");
        assert_eq!(format_sqlserver_numeric(0, 2), "0.00");
        // digits.len() == scale must keep the leading "0." (guards `>` vs `>=` in the split).
        assert_eq!(format_sqlserver_numeric(123, 3), "0.123");
        // Largest scale tiberius can deliver (its decoder asserts scale < 38).
        assert_eq!(format_sqlserver_numeric(9, 37), format!("0.{}9", "0".repeat(36)));
    }

    #[test]
    fn sqlserver_datetime2_cells_are_json_strings() {
        let datetime = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap().and_hms_milli_opt(9, 8, 7, 123).unwrap();
        let cell: ColumnData<'static> = datetime.into_sql();

        assert_eq!(sqlserver_cell_to_json(&cell), serde_json::json!("2026-05-13 09:08:07.123"));
    }

    #[test]
    fn sqlserver_datetime_cells_display_millisecond_precision() {
        let cell = ColumnData::DateTime(Some(tiberius::time::DateTime::new(46_200, 11_001_869)));

        assert_eq!(sqlserver_cell_to_json(&cell), serde_json::json!("2026-06-29 10:11:12.897"));
    }

    #[test]
    fn sqlserver_binary_cells_are_json_hex_strings() {
        let cell =
            ColumnData::Binary(Some(std::borrow::Cow::Owned(vec![0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xCF, 0x53])));

        assert_eq!(sqlserver_cell_to_json(&cell), serde_json::json!("0x000000000001cf53"));
    }

    #[test]
    fn sqlserver_strips_generated_row_number_pagination_column() {
        let sql = "SELECT * FROM (SELECT dbx_page_source.*, ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS [__dbx_row_num] FROM (SELECT id FROM users) dbx_page_source) dbx_page WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 200 ORDER BY [__dbx_row_num];";
        let mut result = QueryResult {
            columns: vec!["id".to_string(), "__dbx_row_num".to_string()],
            column_types: vec!["int".to_string(), "bigint".to_string()],
            column_sortables: vec![],
            spatial_columns: vec![],
            spatial_values: vec![],
            rows: vec![vec![serde_json::json!(42), serde_json::json!(101)]],
            affected_rows: 0,
            execution_time_ms: 1,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        };

        strip_dbx_sqlserver_row_number_column(&mut result, sql);

        assert_eq!(result.columns, vec!["id"]);
        assert_eq!(result.column_types, vec!["int"]);
        assert_eq!(result.rows, vec![vec![serde_json::json!(42)]]);
    }

    #[test]
    fn sqlserver_detects_geometry_result_columns() {
        assert!(is_sqlserver_spatial_column(&SqlServerDescribedColumn {
            name: Some("polygon".to_string()),
            system_type_name: Some("geometry".to_string()),
            user_type_schema: Some("sys".to_string()),
            user_type_name: Some("geometry".to_string()),
        }));
        assert!(is_sqlserver_spatial_column(&SqlServerDescribedColumn {
            name: Some("shape".to_string()),
            system_type_name: Some("geography".to_string()),
            user_type_schema: Some("sys".to_string()),
            user_type_name: Some("geography".to_string()),
        }));
        assert!(!is_sqlserver_spatial_column(&SqlServerDescribedColumn {
            name: Some("name".to_string()),
            system_type_name: Some("varchar(30)".to_string()),
            user_type_schema: None,
            user_type_name: None,
        }));
    }

    #[test]
    fn sqlserver_wraps_geometry_columns_as_text() {
        let rewritten = build_sqlserver_unsafe_type_query(
            "SELECT * FROM dbo.tLandPolygon;",
            &[
                SqlServerDescribedColumn {
                    name: Some("landId".to_string()),
                    system_type_name: Some("varchar(30)".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
                SqlServerDescribedColumn {
                    name: Some("polygon".to_string()),
                    system_type_name: Some("geometry".to_string()),
                    user_type_schema: Some("sys".to_string()),
                    user_type_name: Some("geometry".to_string()),
                },
            ],
        )
        .unwrap();

        assert_eq!(
            rewritten.sql,
            "SELECT [landId] = [dbx_unsafe_source].[dbx_col_1], [polygon] = CASE WHEN [dbx_unsafe_source].[dbx_col_2] IS NULL THEN NULL ELSE N'SRID=' + CONVERT(nvarchar(20), [dbx_unsafe_source].[dbx_col_2].STSrid) + N';' + [dbx_unsafe_source].[dbx_col_2].AsTextZM() END FROM (SELECT * FROM dbo.tLandPolygon) AS [dbx_unsafe_source]([dbx_col_1], [dbx_col_2])"
        );
        assert_eq!(
            rewritten.spatial_columns,
            vec![SqlServerSpatialColumn { column_index: 1, column_type: "geometry".to_string() }]
        );
    }

    #[test]
    fn sqlserver_spatial_marker_keeps_wkt_and_extracts_srid() {
        let (value, srid) = sqlserver_spatial_marker(serde_json::json!("SRID=3857;POINT(1 2)"));
        assert_eq!(value, serde_json::json!("POINT(1 2)"));
        assert_eq!(srid, Some(3857));
    }

    #[test]
    fn sqlserver_spatial_marker_treats_non_positive_srid_as_unknown_without_leaking_ewkt() {
        for marker in ["SRID=0;POINT(1 2)", "SRID=-1;POINT(1 2)"] {
            let (value, srid) = sqlserver_spatial_marker(serde_json::json!(marker));
            assert_eq!(value, serde_json::json!("POINT(1 2)"));
            assert_eq!(srid, None);
        }
    }

    #[test]
    fn sqlserver_only_decodes_described_spatial_columns() {
        let mut values = vec![serde_json::json!("SRID=4326;POINT(1 2)"), serde_json::json!("SRID=3857;POINT(3 4)")];
        let mut srids = Vec::new();
        let per_cell = decode_sqlserver_spatial_values(
            &mut values,
            &[SqlServerSpatialColumn { column_index: 1, column_type: "geography".to_string() }],
            |column_index, srid| srids.push((column_index, srid)),
        );

        assert_eq!(values[0], serde_json::json!("SRID=4326;POINT(1 2)"));
        assert_eq!(values[1], serde_json::json!("POINT(3 4)"));
        assert_eq!(srids, vec![(1, Some(3857))]);
        assert_eq!(per_cell, vec![None, Some(3857)]);
    }

    #[test]
    fn sqlserver_spatial_values_keep_per_cell_srids_for_multiple_geometry_columns() {
        // Two geometry columns with different SRIDs in the same row must each
        // keep their own SRID instead of collapsing to a single column-level one.
        let mut values = vec![
            serde_json::json!(1),
            serde_json::json!("SRID=4326;POINT(1 2)"),
            serde_json::json!("SRID=3857;POINT(3 4)"),
        ];
        let spatial_columns = [
            SqlServerSpatialColumn { column_index: 1, column_type: "geometry".to_string() },
            SqlServerSpatialColumn { column_index: 2, column_type: "geometry".to_string() },
        ];
        let per_cell = decode_sqlserver_spatial_values(&mut values, &spatial_columns, |_, _| {});

        assert_eq!(values[1], serde_json::json!("POINT(1 2)"));
        assert_eq!(values[2], serde_json::json!("POINT(3 4)"));
        assert_eq!(per_cell, vec![None, Some(4326), Some(3857)]);
    }

    #[test]
    fn sqlserver_marker_preserves_zm_wkt_and_extracts_srid() {
        let (value, srid) = sqlserver_spatial_marker(serde_json::json!("SRID=4326;POINT ZM (1 2 3 4)"));
        assert_eq!(value, serde_json::json!("POINT ZM (1 2 3 4)"));
        assert_eq!(srid, Some(4326));

        let (line_value, line_srid) =
            sqlserver_spatial_marker(serde_json::json!("SRID=4326;LINESTRING ZM (1 2 3 4, 5 6 7 8)"));
        assert_eq!(line_value, serde_json::json!("LINESTRING ZM (1 2 3 4, 5 6 7 8)"));
        assert_eq!(line_srid, Some(4326));
    }

    #[test]
    fn sqlserver_decodes_zm_geometry_for_query_and_export_paths() {
        // `decode_sqlserver_spatial_values` backs both `collect_first_result_limited`
        // (query results) and `stream_first_result_set` (export): Z/M values must
        // survive decoding once the rewrite uses AsTextZM() instead of STAsText().
        let mut values = vec![
            serde_json::json!(1),
            serde_json::json!("SRID=4326;POINT ZM (1 2 3 4)"),
            serde_json::json!("SRID=4326;LINESTRING ZM (1 2 3 4, 5 6 7 8)"),
        ];
        let mut srids = Vec::new();
        decode_sqlserver_spatial_values(
            &mut values,
            &[
                SqlServerSpatialColumn { column_index: 1, column_type: "geometry".to_string() },
                SqlServerSpatialColumn { column_index: 2, column_type: "geometry".to_string() },
            ],
            |column_index, srid| srids.push((column_index, srid)),
        );

        assert_eq!(values[1], serde_json::json!("POINT ZM (1 2 3 4)"));
        assert_eq!(values[2], serde_json::json!("LINESTRING ZM (1 2 3 4, 5 6 7 8)"));
        assert_eq!(srids, vec![(1, Some(4326)), (2, Some(4326))]);
    }

    #[test]
    fn sqlserver_restores_geography_type_even_when_all_values_are_null() {
        let spatial_columns = vec![SqlServerSpatialColumn { column_index: 1, column_type: "geography".to_string() }];
        let mut column_types = vec!["int".to_string(), "nvarchar".to_string()];
        restore_sqlserver_spatial_column_types(&mut column_types, &spatial_columns);

        assert_eq!(column_types, vec!["int", "geography"]);
        let mut values = vec![serde_json::json!(1), serde_json::Value::Null];
        let mut srids = Vec::new();
        decode_sqlserver_spatial_values(&mut values, &spatial_columns, |column_index, srid| {
            srids.push((column_index, srid));
        });
        assert_eq!(srids, vec![(1, None)]);
        assert_eq!(values[1], serde_json::Value::Null);
    }

    #[test]
    fn sqlserver_does_not_wrap_non_spatial_columns() {
        assert_eq!(
            build_sqlserver_unsafe_type_query(
                "SELECT landId FROM dbo.tLandPolygon",
                &[SqlServerDescribedColumn {
                    name: Some("landId".to_string()),
                    system_type_name: Some("varchar(30)".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                }]
            ),
            None
        );
    }

    #[test]
    fn sqlserver_preserves_order_by_when_wrapping_geometry_columns() {
        let rewritten = build_sqlserver_unsafe_type_query(
            "SELECT landId, polygon FROM dbo.tLandPolygon ORDER BY landId DESC",
            &[
                SqlServerDescribedColumn {
                    name: Some("landId".to_string()),
                    system_type_name: Some("varchar(30)".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
                SqlServerDescribedColumn {
                    name: Some("polygon".to_string()),
                    system_type_name: Some("geometry".to_string()),
                    user_type_schema: Some("sys".to_string()),
                    user_type_name: Some("geometry".to_string()),
                },
            ],
        )
        .unwrap();

        // SQL Server rejects ORDER BY inside the derived table subquery, so the
        // inner statement must stay bare while the outer rewrite re-applies the
        // original sort so row order survives the wrap.
        assert!(rewritten.sql.contains("FROM (SELECT landId, polygon FROM dbo.tLandPolygon) AS [dbx_unsafe_source]"));
        assert!(rewritten.sql.ends_with("ORDER BY [landId] DESC"));
        assert!(rewritten.sql.contains(".AsTextZM()"));
    }

    #[test]
    fn sqlserver_migrates_order_by_ordinals_and_offset_fetch_to_outer_query() {
        let rewritten = build_sqlserver_unsafe_type_query(
            "SELECT id, landId, polygon FROM dbo.t ORDER BY 2 DESC, id OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY",
            &[
                SqlServerDescribedColumn {
                    name: Some("id".to_string()),
                    system_type_name: Some("int".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
                SqlServerDescribedColumn {
                    name: Some("landId".to_string()),
                    system_type_name: Some("varchar(30)".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
                SqlServerDescribedColumn {
                    name: Some("polygon".to_string()),
                    system_type_name: Some("geometry".to_string()),
                    user_type_schema: Some("sys".to_string()),
                    user_type_name: Some("geometry".to_string()),
                },
            ],
        )
        .unwrap();

        assert!(rewritten.sql.contains("FROM (SELECT id, landId, polygon FROM dbo.t) AS [dbx_unsafe_source]"));
        assert!(rewritten.sql.ends_with(" ORDER BY [landId] DESC, [id] OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY"));
    }

    #[test]
    fn sqlserver_migrates_qualified_and_bracketed_order_by_columns() {
        let rewritten = build_sqlserver_unsafe_type_query(
            "SELECT [id], polygon FROM dbo.t ORDER BY dbo.t.[id] ASC",
            &[
                SqlServerDescribedColumn {
                    name: Some("id".to_string()),
                    system_type_name: Some("int".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
                SqlServerDescribedColumn {
                    name: Some("polygon".to_string()),
                    system_type_name: Some("geometry".to_string()),
                    user_type_schema: Some("sys".to_string()),
                    user_type_name: Some("geometry".to_string()),
                },
            ],
        )
        .unwrap();

        assert!(rewritten.sql.ends_with(" ORDER BY [id]"));
    }

    #[test]
    fn sqlserver_keeps_order_by_inside_for_top_queries_and_reapplies_outside() {
        // With TOP the ORDER BY also selects which rows TOP returns, so it must
        // stay inside the derived table (legal there once TOP is present) while
        // the outer rewrite re-applies it for the guaranteed final order.
        let rewritten = build_sqlserver_unsafe_type_query(
            "SELECT TOP 10 id, polygon FROM dbo.t ORDER BY id",
            &[
                SqlServerDescribedColumn {
                    name: Some("id".to_string()),
                    system_type_name: Some("int".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
                SqlServerDescribedColumn {
                    name: Some("polygon".to_string()),
                    system_type_name: Some("geometry".to_string()),
                    user_type_schema: Some("sys".to_string()),
                    user_type_name: Some("geometry".to_string()),
                },
            ],
        )
        .unwrap();

        assert!(rewritten
            .sql
            .contains("FROM (SELECT TOP 10 id, polygon FROM dbo.t ORDER BY id) AS [dbx_unsafe_source]"));
        assert!(rewritten.sql.ends_with(" ORDER BY [id]"));
    }

    #[test]
    fn sqlserver_falls_back_when_order_by_cannot_be_migrated() {
        // ORDER BY references a column absent from the projection: cannot be
        // re-applied on the outer query, so the rewrite must be refused rather
        // than silently dropping order semantics.
        assert_eq!(
            build_sqlserver_unsafe_type_query(
                "SELECT polygon FROM dbo.t ORDER BY landId",
                &[SqlServerDescribedColumn {
                    name: Some("polygon".to_string()),
                    system_type_name: Some("geometry".to_string()),
                    user_type_schema: Some("sys".to_string()),
                    user_type_name: Some("geometry".to_string()),
                }],
            ),
            None
        );

        // Non-trivial ORDER BY expression: cannot be re-applied safely.
        assert_eq!(
            build_sqlserver_unsafe_type_query(
                "SELECT id, polygon FROM dbo.t ORDER BY UPPER(id)",
                &[
                    SqlServerDescribedColumn {
                        name: Some("id".to_string()),
                        system_type_name: Some("int".to_string()),
                        user_type_schema: None,
                        user_type_name: None,
                    },
                    SqlServerDescribedColumn {
                        name: Some("polygon".to_string()),
                        system_type_name: Some("geometry".to_string()),
                        user_type_schema: Some("sys".to_string()),
                        user_type_name: Some("geometry".to_string()),
                    },
                ],
            ),
            None
        );

        // ORDER BY targeting a rewritten geometry column would order by the WKT
        // string instead of the geometry value: refuse rather than change semantics.
        assert_eq!(
            build_sqlserver_unsafe_type_query(
                "SELECT id, polygon FROM dbo.t ORDER BY polygon",
                &[
                    SqlServerDescribedColumn {
                        name: Some("id".to_string()),
                        system_type_name: Some("int".to_string()),
                        user_type_schema: None,
                        user_type_name: None,
                    },
                    SqlServerDescribedColumn {
                        name: Some("polygon".to_string()),
                        system_type_name: Some("geometry".to_string()),
                        user_type_schema: Some("sys".to_string()),
                        user_type_name: Some("geometry".to_string()),
                    },
                ],
            ),
            None
        );
    }

    #[test]
    fn sqlserver_keeps_empty_result_sets_when_metadata_exists() {
        let mut results = Vec::new();
        super::push_sqlserver_result_set(
            &mut results,
            Some(SqlServerResultSet {
                columns: vec!["id".to_string(), "name".to_string()],
                column_types: vec![],
                rows: vec![],
                truncated: false,
                remaining_offset: 0,
            }),
            Instant::now(),
        );

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].columns, vec!["id".to_string(), "name".to_string()]);
        assert!(results[0].rows.is_empty());
    }

    #[test]
    fn sqlserver_drops_truly_empty_result_sets_without_metadata() {
        let mut results = Vec::new();
        super::push_sqlserver_result_set(
            &mut results,
            Some(SqlServerResultSet {
                columns: vec![],
                column_types: vec![],
                rows: vec![],
                truncated: false,
                remaining_offset: 0,
            }),
            Instant::now(),
        );

        assert!(results.is_empty());
    }

    #[test]
    fn sqlserver_detects_sql_variant_columns() {
        assert!(is_sqlserver_variant_column(&SqlServerDescribedColumn {
            name: Some("value".to_string()),
            system_type_name: Some("sql_variant".to_string()),
            user_type_schema: None,
            user_type_name: None,
        }));
        assert!(is_sqlserver_variant_column(&SqlServerDescribedColumn {
            name: Some("value".to_string()),
            system_type_name: None,
            user_type_schema: None,
            user_type_name: Some("sql_variant".to_string()),
        }));
        assert!(!is_sqlserver_variant_column(&SqlServerDescribedColumn {
            name: Some("name".to_string()),
            system_type_name: Some("nvarchar(128)".to_string()),
            user_type_schema: None,
            user_type_name: None,
        }));
    }

    #[test]
    fn sqlserver_result_type_probe_keeps_modern_and_legacy_paths_in_one_round_trip() {
        assert!(SQLSERVER_RESULT_TYPE_PROBE_SQL.contains("sys.dm_exec_describe_first_result_set"));
        assert!(SQLSERVER_RESULT_TYPE_PROBE_SQL.contains("##dbx_result_type_probe_"));
        assert!(SQLSERVER_RESULT_TYPE_PROBE_SQL.contains("SELECT TOP (0) * INTO"));
        assert!(SQLSERVER_RESULT_TYPE_PROBE_SQL.contains("N' FROM ' + @P3"));
        assert!(SQLSERVER_RESULT_TYPE_PROBE_SQL.contains("FROM tempdb.sys.columns"));
        assert!(!SQLSERVER_RESULT_TYPE_PROBE_SQL.contains("FMTONLY"));
        assert_eq!(SQLSERVER_RESULT_TYPE_PROBE_SQL.matches("SELECT @dbx_use_describe_dmv").count(), 1);
    }

    #[test]
    fn sqlserver_legacy_duplicate_probe_uses_bounded_metadata_recovery() {
        assert!(is_sqlserver_legacy_duplicate_probe_error(
            "SQL Server unsafe result type: The column 'usergrp' was specified multiple times for 'dbx_probe_source'."
        ));
        assert!(!is_sqlserver_legacy_duplicate_probe_error(
            "SQL Server unsafe result type: Invalid object name 'missing'."
        ));
        let query = sqlserver_legacy_wildcard_metadata_query(
            "SELECT * FROM dbo.purctl a JOIN dbo.deptctl b ON a.id = b.id JOIN whctl c ON b.id = c.id",
        )
        .unwrap();
        assert_eq!(query.matches("OBJECT_ID").count(), 6);
        assert_eq!(query.matches("UNION ALL").count(), 2);
        assert!(query.contains("ORDER BY dbx_source_ordinal, dbx_column_ordinal"));
        assert!(sqlserver_legacy_wildcard_metadata_query("SELECT a.* FROM dbo.purctl a").is_none());
    }

    #[test]
    fn sqlserver_legacy_wildcard_metadata_limits_supported_sources() {
        assert!(sqlserver_legacy_wildcard_metadata_query("SELECT * FROM #left l JOIN #right r ON l.id = r.id")
            .unwrap()
            .contains("tempdb.sys.columns"));
        assert!(sqlserver_legacy_wildcard_metadata_query("SELECT * FROM (SELECT 1 AS id) x").is_none());
        assert!(sqlserver_legacy_wildcard_metadata_query("SELECT * FROM db.dbo.t").is_none());
    }

    #[test]
    fn sqlserver_legacy_probe_uses_unique_internal_names_for_duplicate_outputs() {
        let probe = sqlserver_legacy_probe(
            "SELECT a.HJRQ, b.HJRQ, a.id + b.id AS total, GETDATE() FROM dbo.a a JOIN dbo.b b ON b.id = a.id",
        )
        .unwrap();

        assert_eq!(
            probe.source_sql,
            "(SELECT a.HJRQ, b.HJRQ, a.id + b.id AS total, GETDATE() FROM dbo.a a JOIN dbo.b b ON b.id = a.id) AS [dbx_probe_source]([dbx_col_1], [dbx_col_2], [dbx_col_3], [dbx_col_4])"
        );
        assert_eq!(
            probe.output_names,
            Some(vec![Some("HJRQ".to_string()), Some("HJRQ".to_string()), Some("total".to_string()), None])
        );
    }

    #[test]
    fn sqlserver_legacy_probe_aliases_explicit_columns_next_to_wildcards() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let probe =
            sqlserver_legacy_probe_with_nonce("SELECT a.*, b.HJRQ FROM dbo.a a JOIN dbo.b b ON b.id = a.id", nonce)
                .unwrap();
        let probe_name = sqlserver_probe_explicit_alias(nonce, 2);

        assert!(probe.source_sql.starts_with("(SELECT a.*,"));
        assert!(probe.source_sql.contains(&format!("b.HJRQ AS [{probe_name}]")));
        assert!(probe.source_sql.ends_with(") AS [dbx_probe_source]"));
        assert_eq!(probe.output_names, None);
        assert_eq!(
            probe.output_name_overrides,
            vec![SqlServerProbeOutputNameOverride {
                projection_ordinal: 2,
                probe_name,
                output_name: Some("HJRQ".to_string()),
            }]
        );
    }

    #[test]
    fn sqlserver_legacy_probe_keeps_quoted_columns_around_qualified_wildcard() {
        let nonce = "fedcba9876543210fedcba9876543210";
        let probe =
            sqlserver_legacy_probe_with_nonce("SELECT t.[Order], t.*, t.[After] FROM dbo.t AS t", nonce).unwrap();
        let first_probe_name = sqlserver_probe_explicit_alias(nonce, 1);
        let third_probe_name = sqlserver_probe_explicit_alias(nonce, 3);

        assert!(probe.source_sql.contains(&format!("t.[Order] AS [{first_probe_name}], t.*")));
        assert!(probe.source_sql.contains(&format!("t.*, t.[After] AS [{third_probe_name}]")));
        assert!(probe.source_sql.contains("FROM dbo.t AS t"));
        assert_eq!(
            probe.output_name_overrides,
            vec![
                SqlServerProbeOutputNameOverride {
                    projection_ordinal: 1,
                    probe_name: first_probe_name,
                    output_name: Some("Order".to_string()),
                },
                SqlServerProbeOutputNameOverride {
                    projection_ordinal: 3,
                    probe_name: third_probe_name,
                    output_name: Some("After".to_string()),
                },
            ]
        );
    }

    #[test]
    fn sqlserver_legacy_probe_supports_explicit_columns_followed_by_wildcard() {
        let nonce = "11223344556677889900aabbccddeeff";
        let probe = sqlserver_legacy_probe_with_nonce("SELECT ybbz, cytzrq, jzrq, * FROM dbo.t", nonce).unwrap();
        let first_probe_name = sqlserver_probe_explicit_alias(nonce, 1);
        let second_probe_name = sqlserver_probe_explicit_alias(nonce, 2);
        let third_probe_name = sqlserver_probe_explicit_alias(nonce, 3);

        assert!(probe.source_sql.contains(&format!("ybbz AS [{first_probe_name}]")));
        assert!(probe.source_sql.contains(&format!("cytzrq AS [{second_probe_name}]")));
        assert!(probe.source_sql.contains(&format!("jzrq AS [{third_probe_name}]")));
        assert!(probe.source_sql.contains(", * FROM dbo.t"));
        assert_eq!(
            probe.output_name_overrides,
            vec![
                SqlServerProbeOutputNameOverride {
                    projection_ordinal: 1,
                    probe_name: first_probe_name,
                    output_name: Some("ybbz".to_string()),
                },
                SqlServerProbeOutputNameOverride {
                    projection_ordinal: 2,
                    probe_name: second_probe_name,
                    output_name: Some("cytzrq".to_string()),
                },
                SqlServerProbeOutputNameOverride {
                    projection_ordinal: 3,
                    probe_name: third_probe_name,
                    output_name: Some("jzrq".to_string()),
                },
            ]
        );
    }

    #[test]
    fn sqlserver_legacy_probe_does_not_collide_with_old_probe_alias_column() {
        let nonce = "00112233445566778899aabbccddeeff";
        let old_probe_name = "__dbx_probe_explicit_1__";
        let probe =
            sqlserver_legacy_probe_with_nonce("SELECT t.[__dbx_probe_explicit_1__], t.* FROM dbo.t AS t", nonce)
                .unwrap();
        let generated_probe_name = sqlserver_probe_explicit_alias(nonce, 1);

        assert_ne!(generated_probe_name, old_probe_name);
        assert!(probe.source_sql.contains(&format!("t.[{old_probe_name}] AS [{generated_probe_name}], t.*")));
        assert_eq!(probe.output_name_overrides[0].projection_ordinal, 1);

        let mut columns = vec![
            SqlServerDescribedColumn {
                name: Some(generated_probe_name),
                system_type_name: Some("int".to_string()),
                user_type_schema: None,
                user_type_name: None,
            },
            SqlServerDescribedColumn {
                name: Some(old_probe_name.to_string()),
                system_type_name: Some("int".to_string()),
                user_type_schema: None,
                user_type_name: None,
            },
        ];
        restore_sqlserver_legacy_probe_output_names(&mut columns, &probe);

        assert_eq!(columns[0].name.as_deref(), Some(old_probe_name));
        assert_eq!(columns[1].name.as_deref(), Some(old_probe_name));
    }

    #[test]
    fn sqlserver_legacy_probe_errors_are_blocking_only_when_marked_unsafe() {
        assert!(is_blocking_sqlserver_unsafe_probe_error(
            "SQL Server unsafe result type: legacy schema capture failed"
        ));
        assert!(!is_blocking_sqlserver_unsafe_probe_error("Invalid object name"));
    }

    #[test]
    fn sqlserver_wraps_sql_variant_columns_as_nvarchar() {
        let rewritten = build_sqlserver_unsafe_type_query(
            "SELECT name, value FROM sys.extended_properties;",
            &[
                SqlServerDescribedColumn {
                    name: Some("name".to_string()),
                    system_type_name: Some("sysname".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
                SqlServerDescribedColumn {
                    name: Some("value".to_string()),
                    system_type_name: Some("sql_variant".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
            ],
        )
        .unwrap();

        assert!(rewritten.sql.contains("CAST("));
        assert!(rewritten.sql.contains("AS NVARCHAR(MAX))"));
        assert!(rewritten.sql.contains("FROM sys.extended_properties"));
        // The name column should not be cast
        assert_eq!(rewritten.sql.matches("CAST(").count(), 1);
    }

    #[test]
    fn sqlserver_does_not_wrap_non_variant_columns() {
        assert_eq!(
            build_sqlserver_unsafe_type_query(
                "SELECT name FROM sys.extended_properties",
                &[SqlServerDescribedColumn {
                    name: Some("name".to_string()),
                    system_type_name: Some("sysname".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                }]
            ),
            None
        );
    }

    #[test]
    fn sqlserver_wraps_both_spatial_and_variant_columns() {
        let rewritten = build_sqlserver_unsafe_type_query(
            "SELECT id, shape, metadata FROM dbo.t;",
            &[
                SqlServerDescribedColumn {
                    name: Some("id".to_string()),
                    system_type_name: Some("int".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
                SqlServerDescribedColumn {
                    name: Some("shape".to_string()),
                    system_type_name: Some("geometry".to_string()),
                    user_type_schema: Some("sys".to_string()),
                    user_type_name: Some("geometry".to_string()),
                },
                SqlServerDescribedColumn {
                    name: Some("metadata".to_string()),
                    system_type_name: Some("sql_variant".to_string()),
                    user_type_schema: None,
                    user_type_name: None,
                },
            ],
        )
        .unwrap();

        assert!(rewritten.sql.contains(".AsTextZM()"));
        assert!(rewritten.sql.contains("CAST("));
        assert!(rewritten.sql.contains("AS NVARCHAR(MAX))"));
        assert!(rewritten.sql.contains("FROM dbo.t"));
    }

    #[tokio::test]
    #[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD"]
    async fn live_sqlserver_legacy_probe_casts_variant_and_keeps_connection_usable() {
        let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
        let port = std::env::var("DBX_LIVE_SQLSERVER_PORT")
            .expect("DBX_LIVE_SQLSERVER_PORT")
            .parse::<u16>()
            .expect("valid DBX_LIVE_SQLSERVER_PORT");
        let user = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
        let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
        let mut client =
            super::connect(&host, port, &user, &password, Some("tempdb"), None, std::time::Duration::from_secs(10))
                .await
                .unwrap();

        let setup = "\
            IF OBJECT_ID('tempdb..#dbx_issue_4002') IS NOT NULL DROP TABLE #dbx_issue_4002; \
            IF OBJECT_ID('tempdb..#dbx_issue_5606_extra') IS NOT NULL DROP TABLE #dbx_issue_5606_extra; \
            CREATE TABLE #dbx_issue_4002 (\
                id int NOT NULL, ybbz int NULL, cytzrq date NULL, jzrq datetime NULL, payload sql_variant NULL\
            ); \
            CREATE TABLE #dbx_issue_5606_extra (id int NOT NULL); \
            INSERT INTO #dbx_issue_4002 (id, ybbz, cytzrq, jzrq, payload) \
            VALUES (1, 2, '2026-07-28', '2026-07-28T12:34:56', CAST(N'legacy' AS nvarchar(20))); \
            INSERT INTO #dbx_issue_5606_extra VALUES (2)";
        client.simple_query(setup).await.unwrap().into_results().await.unwrap();

        let sql = "SELECT id, payload FROM #dbx_issue_4002";
        let ordinary_probe = super::sqlserver_legacy_probe("SELECT 42 AS answer").unwrap();
        let ordinary_columns =
            super::describe_sqlserver_result_set_with_mode(&mut client, "SELECT 42 AS answer", &ordinary_probe, true)
                .await
                .unwrap();
        assert_eq!(ordinary_columns[0].system_type_name.as_deref(), Some("int"));

        let legacy_probe = super::sqlserver_legacy_probe(sql).unwrap();
        let legacy_columns =
            super::describe_sqlserver_result_set_with_mode(&mut client, sql, &legacy_probe, true).await.unwrap();
        assert_eq!(legacy_columns.len(), 2);
        assert!(is_sqlserver_variant_column(&legacy_columns[1]));

        let rewritten = build_sqlserver_unsafe_type_query(sql, &legacy_columns).unwrap();
        let legacy_rows = client.query(rewritten.sql.as_str(), &[]).await.unwrap().into_first_result().await.unwrap();
        assert_eq!(legacy_rows[0].get::<i32, _>(0), Some(1));
        assert_eq!(legacy_rows[0].get::<&str, _>(1), Some("legacy"));

        let ordinary = super::execute_query(&mut client, "SELECT CAST(42 AS int) AS answer").await.unwrap();
        assert_eq!(ordinary.rows, vec![vec![serde_json::json!(42)]]);
        let variant = super::execute_query(&mut client, sql).await.unwrap();
        assert_eq!(variant.rows, vec![vec![serde_json::json!(1), serde_json::json!("legacy")]]);

        let duplicate_sql = "SELECT id AS HJRQ, payload AS HJRQ FROM #dbx_issue_4002";
        let duplicate_probe = super::sqlserver_legacy_probe(duplicate_sql).unwrap();
        let duplicate_columns =
            super::describe_sqlserver_result_set_with_mode(&mut client, duplicate_sql, &duplicate_probe, true)
                .await
                .unwrap();
        assert_eq!(duplicate_columns.len(), 2);
        assert_eq!(duplicate_columns[0].name.as_deref(), Some("HJRQ"));
        assert_eq!(duplicate_columns[1].name.as_deref(), Some("HJRQ"));
        assert!(is_sqlserver_variant_column(&duplicate_columns[1]));

        let duplicate_rewritten = build_sqlserver_unsafe_type_query(duplicate_sql, &duplicate_columns).unwrap();
        let duplicate_rows =
            client.query(duplicate_rewritten.sql.as_str(), &[]).await.unwrap().into_first_result().await.unwrap();
        assert_eq!(duplicate_rows[0].columns()[0].name(), "HJRQ");
        assert_eq!(duplicate_rows[0].columns()[1].name(), "HJRQ");
        assert_eq!(duplicate_rows[0].get::<i32, _>(0), Some(1));
        assert_eq!(duplicate_rows[0].get::<&str, _>(1), Some("legacy"));

        let wildcard_sql = "SELECT ybbz, cytzrq, jzrq, * FROM #dbx_issue_4002";
        let previous_wildcard_probe = super::SqlServerLegacyProbe {
            source_sql: format!("({wildcard_sql}) AS [dbx_probe_source]"),
            output_names: None,
            output_name_overrides: Vec::new(),
        };
        let previous_error =
            super::describe_sqlserver_result_set_with_mode(&mut client, wildcard_sql, &previous_wildcard_probe, true)
                .await
                .unwrap_err();
        assert!(previous_error.contains("dbx_probe_source"));

        let wildcard_probe = super::sqlserver_legacy_probe(wildcard_sql).unwrap();
        let wildcard_columns =
            super::describe_sqlserver_result_set_with_mode(&mut client, wildcard_sql, &wildcard_probe, true)
                .await
                .unwrap();
        assert_eq!(wildcard_columns.len(), 8);
        assert_eq!(wildcard_columns[0].name.as_deref(), Some("ybbz"));
        assert_eq!(wildcard_columns[1].name.as_deref(), Some("cytzrq"));
        assert_eq!(wildcard_columns[2].name.as_deref(), Some("jzrq"));
        assert_eq!(wildcard_columns[4].name.as_deref(), Some("ybbz"));
        assert_eq!(wildcard_columns[5].name.as_deref(), Some("cytzrq"));
        assert_eq!(wildcard_columns[6].name.as_deref(), Some("jzrq"));
        assert!(is_sqlserver_variant_column(&wildcard_columns[7]));

        let wildcard_rewritten = build_sqlserver_unsafe_type_query(wildcard_sql, &wildcard_columns).unwrap();
        let wildcard_rows =
            client.query(wildcard_rewritten.sql.as_str(), &[]).await.unwrap().into_first_result().await.unwrap();
        assert_eq!(wildcard_rows.len(), 1);
        assert_eq!(wildcard_rows[0].columns()[0].name(), "ybbz");
        assert_eq!(wildcard_rows[0].columns()[4].name(), "ybbz");
        assert_eq!(wildcard_rows[0].get::<&str, _>(7), Some("legacy"));

        let issue_setup = "\
            CREATE TABLE #purctl (Ref_id nvarchar(32) NOT NULL, Vnd_id nvarchar(32) NULL, usergrp nvarchar(32) NULL); \
            CREATE TABLE #deptctl (tvnd_id nvarchar(32) NULL, usergrp nvarchar(32) NULL); \
            CREATE TABLE #whctl (stru_id nvarchar(32) NULL, usergrp nvarchar(32) NULL); \
            INSERT INTO #purctl VALUES (N'RPM012608060005', N'V1', N'P'); \
            INSERT INTO #deptctl VALUES (N'V1', N'W1'); \
            INSERT INTO #whctl VALUES (N'W1', N'W')";
        client.simple_query(issue_setup).await.unwrap().into_results().await.unwrap();
        let issue_sql = "\
            SELECT * FROM #purctl a \
            JOIN #deptctl b ON COALESCE(a.Vnd_id, N'') = COALESCE(b.tvnd_id, N'') \
            JOIN #whctl c ON b.usergrp = c.stru_id \
            WHERE a.Ref_id = N'RPM012608060005'";
        let issue_probe = super::sqlserver_legacy_probe(issue_sql).unwrap();
        let issue_columns =
            super::describe_sqlserver_result_set_with_mode(&mut client, issue_sql, &issue_probe, true).await.unwrap();
        assert_eq!(issue_columns.len(), 7);
        assert_eq!(issue_columns.iter().filter(|column| column.name.as_deref() == Some("usergrp")).count(), 3);
        assert!(build_sqlserver_unsafe_type_query(issue_sql, &issue_columns).is_none());
        let issue_rows = client.query(issue_sql, &[]).await.unwrap().into_first_result().await.unwrap();
        assert_eq!(issue_rows.len(), 1);

        let pure_wildcard_variant_sql = "SELECT * FROM #dbx_issue_4002 AS a CROSS JOIN #dbx_issue_5606_extra AS b";
        let pure_wildcard_variant_probe = super::sqlserver_legacy_probe(pure_wildcard_variant_sql).unwrap();
        let pure_wildcard_variant_columns = super::describe_sqlserver_result_set_with_mode(
            &mut client,
            pure_wildcard_variant_sql,
            &pure_wildcard_variant_probe,
            true,
        )
        .await
        .unwrap();
        assert_eq!(pure_wildcard_variant_columns.len(), 6);
        assert!(is_sqlserver_variant_column(&pure_wildcard_variant_columns[4]));
        let pure_wildcard_variant_rewritten =
            build_sqlserver_unsafe_type_query(pure_wildcard_variant_sql, &pure_wildcard_variant_columns).unwrap();
        let pure_wildcard_variant_rows = client
            .query(pure_wildcard_variant_rewritten.sql.as_str(), &[])
            .await
            .unwrap()
            .into_first_result()
            .await
            .unwrap();
        assert_eq!(pure_wildcard_variant_rows[0].columns()[0].name(), "id");
        assert_eq!(pure_wildcard_variant_rows[0].columns()[5].name(), "id");
        assert_eq!(pure_wildcard_variant_rows[0].get::<&str, _>(4), Some("legacy"));

        let continued = super::execute_query(&mut client, "SELECT CAST(7 AS int) AS still_connected").await.unwrap();
        assert_eq!(continued.rows, vec![vec![serde_json::json!(7)]]);

        client
            .simple_query(
                "DROP TABLE #purctl; DROP TABLE #deptctl; DROP TABLE #whctl; \
                 DROP TABLE #dbx_issue_5606_extra; DROP TABLE #dbx_issue_4002",
            )
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD"]
    async fn live_sqlserver_point_zm_query_and_export_preserve_z_and_m() {
        let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
        let port = std::env::var("DBX_LIVE_SQLSERVER_PORT")
            .expect("DBX_LIVE_SQLSERVER_PORT")
            .parse::<u16>()
            .expect("valid DBX_LIVE_SQLSERVER_PORT");
        let user = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
        let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");

        let mut client =
            super::connect(&host, port, &user, &password, Some("tempdb"), None, std::time::Duration::from_secs(10))
                .await
                .unwrap();

        let setup = "\
            IF OBJECT_ID('tempdb..#dbx_point_zm') IS NOT NULL DROP TABLE #dbx_point_zm; \
            CREATE TABLE #dbx_point_zm (id int NOT NULL, geom geometry NOT NULL); \
            INSERT INTO #dbx_point_zm (id, geom) VALUES \
            (1, geometry::STGeomFromText('POINT (1 2 3 4)', 4326)), \
            (2, geometry::STGeomFromText('LINESTRING ZM (1 2 3 4, 5 6 7 8)', 4326))";
        client.simple_query(setup).await.unwrap().into_results().await.unwrap();

        // Query path: the rewrite must use AsTextZM() so Z/M survive STAsText's 2D-only output.
        let sql = "SELECT id, geom FROM #dbx_point_zm ORDER BY id";
        let result = super::execute_query(&mut client, sql).await.unwrap();
        assert_eq!(result.rows.len(), 2);
        let mut point_wkt: Option<&str> = None;
        let mut line_wkt: Option<&str> = None;
        for row in &result.rows {
            let wkt = row[1].as_str().expect("geometry cell decodes to WKT string");
            if wkt.starts_with("POINT") {
                point_wkt = Some(wkt);
            } else if wkt.starts_with("LINESTRING") {
                line_wkt = Some(wkt);
            }
        }
        let point_wkt = point_wkt.expect("POINT row present");
        assert!(point_wkt.contains("1 2 3 4"), "POINT must retain Z/M via AsTextZM, got: {point_wkt}");
        let line_wkt = line_wkt.expect("LINESTRING row present");
        assert!(
            line_wkt.contains("1 2 3 4") && line_wkt.contains("5 6 7 8"),
            "LINESTRING must retain Z/M via AsTextZM, got: {line_wkt}"
        );
        assert_eq!(result.spatial_columns, vec![SpatialColumn { column_index: 1, srid: Some(4326) }]);

        // Export path: stream_first_result_set decodes the same AsTextZM() markers.
        let mut exported = Vec::new();
        let summary = super::stream_first_result_set(&mut client, sql, Some(10), None, |item| {
            if let super::SqlServerStreamItem::Row(values) = item {
                exported.push(values.to_vec());
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(summary.rows_exported, 2);
        let exported_point = exported.iter().find_map(|row| row[1].as_str().filter(|wkt| wkt.starts_with("POINT")));
        let exported_point = exported_point.expect("exported POINT row present");
        assert!(
            exported_point.contains("1 2 3 4"),
            "exported POINT must retain Z/M via AsTextZM, got: {exported_point}"
        );

        client.simple_query("DROP TABLE #dbx_point_zm").await.unwrap().into_results().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD"]
    async fn live_sqlserver_geometry_order_and_pagination_are_preserved() {
        let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
        let port = std::env::var("DBX_LIVE_SQLSERVER_PORT")
            .expect("DBX_LIVE_SQLSERVER_PORT")
            .parse::<u16>()
            .expect("valid DBX_LIVE_SQLSERVER_PORT");
        let user = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
        let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");

        let mut client =
            super::connect(&host, port, &user, &password, Some("tempdb"), None, std::time::Duration::from_secs(10))
                .await
                .unwrap();

        let setup = "\
            IF OBJECT_ID('tempdb..#dbx_geometry_order') IS NOT NULL DROP TABLE #dbx_geometry_order; \
            CREATE TABLE #dbx_geometry_order (id int NOT NULL, name varchar(20) NOT NULL, geom geometry NOT NULL); \
            INSERT INTO #dbx_geometry_order (id, name, geom) VALUES \
            (3, 'c', geometry::STGeomFromText('POINT (3 3)', 4326)), \
            (1, 'a', geometry::STGeomFromText('POINT (1 1)', 4326)), \
            (2, 'b', geometry::STGeomFromText('POINT (2 2)', 4326))";
        client.simple_query(setup).await.unwrap().into_results().await.unwrap();

        let ids = |result: &crate::types::QueryResult| -> Vec<i64> {
            result.rows.iter().map(|row| row[0].as_i64().expect("id cell is an integer")).collect()
        };

        // The derived-table rewrite must not lose ORDER BY: rows come back in id
        // order even though the table was inserted out of order.
        let ordered = super::execute_query(&mut client, "SELECT id, name, geom FROM #dbx_geometry_order ORDER BY id")
            .await
            .unwrap();
        assert_eq!(ids(&ordered), vec![1, 2, 3]);

        // OFFSET/FETCH pagination must survive the rewrite: second page = id 2.
        let page = super::execute_query(
            &mut client,
            "SELECT id, name, geom FROM #dbx_geometry_order ORDER BY id OFFSET 1 ROWS FETCH NEXT 1 ROWS ONLY",
        )
        .await
        .unwrap();
        assert_eq!(ids(&page), vec![2]);

        // A page past the end returns no rows, not the whole table.
        let beyond = super::execute_query(
            &mut client,
            "SELECT id, name, geom FROM #dbx_geometry_order ORDER BY id OFFSET 10 ROWS",
        )
        .await
        .unwrap();
        assert!(beyond.rows.is_empty());

        // DESC ordering is preserved too.
        let descending =
            super::execute_query(&mut client, "SELECT id, name, geom FROM #dbx_geometry_order ORDER BY id DESC")
                .await
                .unwrap();
        assert_eq!(ids(&descending), vec![3, 2, 1]);

        // TOP + ORDER BY keeps the sort inside the derived table (it drives row
        // selection) and re-applies it outside for the guaranteed final order.
        let top = super::execute_query(&mut client, "SELECT TOP 2 id, name, geom FROM #dbx_geometry_order ORDER BY id")
            .await
            .unwrap();
        assert_eq!(ids(&top), vec![1, 2]);

        client.simple_query("DROP TABLE #dbx_geometry_order").await.unwrap().into_results().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD"]
    async fn live_sqlserver_mixed_srid_columns_keep_per_cell_srids() {
        let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
        let port = std::env::var("DBX_LIVE_SQLSERVER_PORT")
            .expect("DBX_LIVE_SQLSERVER_PORT")
            .parse::<u16>()
            .expect("valid DBX_LIVE_SQLSERVER_PORT");
        let user = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
        let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");

        let mut client =
            super::connect(&host, port, &user, &password, Some("tempdb"), None, std::time::Duration::from_secs(10))
                .await
                .unwrap();

        let setup = "\
            IF OBJECT_ID('tempdb..#dbx_mixed_srid') IS NOT NULL DROP TABLE #dbx_mixed_srid; \
            CREATE TABLE #dbx_mixed_srid (id int NOT NULL, geom_a geometry NOT NULL, geom_b geometry NOT NULL); \
            INSERT INTO #dbx_mixed_srid (id, geom_a, geom_b) VALUES \
            (1, geometry::STGeomFromText('POINT (1 1)', 4326), geometry::STGeomFromText('POINT (11 11)', 3857)), \
            (2, geometry::STGeomFromText('POINT (2 2)', 3857), geometry::STGeomFromText('POINT (12 12)', 4326))";
        client.simple_query(setup).await.unwrap().into_results().await.unwrap();

        let result = super::execute_query(&mut client, "SELECT id, geom_a, geom_b FROM #dbx_mixed_srid ORDER BY id")
            .await
            .unwrap();
        // Every cell keeps its own SRID: row 1 is (4326, 3857), row 2 is (3857,
        // 4326) — the same column mixes SRIDs across rows without collapsing.
        assert_eq!(
            result.spatial_values,
            vec![vec![None, Some(4326), Some(3857)], vec![None, Some(3857), Some(4326)],]
        );
        // The column-level hint still reports the first non-null SRID per column.
        assert_eq!(
            result.spatial_columns,
            vec![
                SpatialColumn { column_index: 1, srid: Some(4326) },
                SpatialColumn { column_index: 2, srid: Some(3857) },
            ]
        );

        client.simple_query("DROP TABLE #dbx_mixed_srid").await.unwrap().into_results().await.unwrap();
    }
}
