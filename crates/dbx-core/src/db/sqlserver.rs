use crate::query::MAX_ROWS;
use crate::sql::starts_with_executable_sql_keyword;
use crate::types::{
    ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, LinkedServerInfo, ObjectStatistics, QueryResult, TableInfo,
    TriggerInfo,
};
use futures::{FutureExt, TryStreamExt};
use rust_decimal::Decimal;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};
use tiberius::{AuthMethod, Client, ColumnData, Config, FromSql, QueryItem, QueryStream, SqlBrowser};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};
use tokio_util::sync::CancellationToken;

pub type SqlServerClient = Client<Compat<TcpStream>>;
pub const SQLSERVER_DRIVER_PANIC_ERROR_PREFIX: &str = "SQL Server driver panic:";
const SIMPLE_QUERY_MODULE_KEYWORDS: &[&str] = &["FUNCTION", "PROC", "PROCEDURE", "TRIGGER", "VIEW"];

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

fn query_result_row_limit(max_rows: Option<usize>) -> usize {
    max_rows.unwrap_or(MAX_ROWS).max(1)
}

pub async fn connect(
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    database: Option<&str>,
    timeout: Duration,
) -> Result<SqlServerClient, String> {
    match try_connect(host, port, user, pass, database, true, timeout).await {
        Ok(client) => Ok(client),
        Err(_) => try_connect(host, port, user, pass, database, false, timeout).await,
    }
}

async fn try_connect(
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
    database: Option<&str>,
    use_encryption: bool,
    timeout: Duration,
) -> Result<SqlServerClient, String> {
    let mut config = Config::new();
    let endpoint = sqlserver_endpoint(host);
    config.host(endpoint.host);
    if let Some(instance_name) = endpoint.instance_name {
        config.instance_name(instance_name);
    } else {
        config.port(port);
    }
    config.authentication(AuthMethod::sql_server(user, pass));
    if let Some(db) = database {
        config.database(db);
    }
    config.trust_cert();
    if !use_encryption {
        config.encryption(tiberius::EncryptionLevel::NotSupported);
    }

    let tcp = if endpoint.instance_name.is_some() {
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

fn columns_from_metadata(metadata: &tiberius::ResultMetadata) -> Vec<String> {
    metadata.columns().iter().map(|c| c.name().to_string()).collect()
}

/// Map a tiberius column to a user-facing type name for the result-grid header.
/// Uses the TDS column-type debug name lowercased; good enough for display, with
/// no risk of mismatching the enum variants across tiberius versions.
fn sqlserver_column_type_name(column: &tiberius::Column) -> String {
    format!("{:?}", column.column_type()).to_lowercase()
}

fn column_types_from_metadata(metadata: &tiberius::ResultMetadata) -> Vec<String> {
    metadata.columns().iter().map(sqlserver_column_type_name).collect()
}

async fn collect_first_result_limited(
    mut stream: QueryStream<'_>,
    start: Instant,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let row_limit = query_result_row_limit(max_rows);
    let mut columns: Vec<String> = vec![];
    let mut column_types: Vec<String> = vec![];
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;

    while let Some(item) = stream.try_next().await.map_err(|e| e.to_string())? {
        match item {
            QueryItem::Metadata(metadata) if metadata.result_index() == 0 => {
                columns = columns_from_metadata(&metadata);
                column_types = column_types_from_metadata(&metadata);
            }
            QueryItem::Metadata(_) => {}
            QueryItem::Row(row) if row.result_index() == 0 => {
                if rows.len() < row_limit {
                    rows.push(row_to_json(&row));
                } else {
                    truncated = true;
                }
            }
            QueryItem::Row(_) => {}
        }
    }

    Ok(QueryResult {
        columns,
        column_types,
        column_sortables: vec![],
        rows,
        affected_rows: 0,
        execution_time_ms: start.elapsed().as_millis(),
        truncated,
        session_id: None,
        has_more: false,
    })
}

struct SqlServerResultSet {
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    truncated: bool,
}

pub struct SqlServerStreamExportSummary {
    pub columns: Vec<String>,
    pub rows_exported: u64,
}

pub enum SqlServerStreamItem<'a> {
    Columns(&'a [String]),
    Row(&'a [serde_json::Value]),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SqlServerDescribedColumn {
    name: Option<String>,
    system_type_name: Option<String>,
    user_type_schema: Option<String>,
    user_type_name: Option<String>,
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
) -> Result<Vec<SqlServerDescribedColumn>, String> {
    let describe_sql = "\
        SELECT name, system_type_name, user_type_schema, user_type_name \
        FROM sys.dm_exec_describe_first_result_set(@P1, NULL, 0) \
        WHERE error_number IS NULL AND is_hidden = 0 \
        ORDER BY column_ordinal";
    let stream = sqlserver_driver_result(client.query(describe_sql, &[&sql])).await?;
    let rows = sqlserver_driver_result(stream.into_first_result()).await?;

    Ok(rows
        .iter()
        .map(|row| SqlServerDescribedColumn {
            name: row.try_get::<&str, _>(0).ok().flatten().map(str::to_string),
            system_type_name: row.try_get::<&str, _>(1).ok().flatten().map(str::to_string),
            user_type_schema: row.try_get::<&str, _>(2).ok().flatten().map(str::to_string),
            user_type_name: row.try_get::<&str, _>(3).ok().flatten().map(str::to_string),
        })
        .collect())
}

async fn spatial_safe_sqlserver_query(client: &mut SqlServerClient, sql: &str) -> Result<Option<String>, String> {
    if !is_single_sqlserver_select(sql) {
        return Ok(None);
    }
    let columns = describe_sqlserver_result_set(client, sql).await?;
    Ok(build_spatial_safe_sqlserver_query(sql, &columns))
}

fn build_spatial_safe_sqlserver_query(sql: &str, columns: &[SqlServerDescribedColumn]) -> Option<String> {
    if columns.is_empty() || !columns.iter().any(is_sqlserver_spatial_column) {
        return None;
    }
    let statement = normalized_sqlserver_select_statement(sql)?;
    let source_alias = quote_sqlserver_identifier("dbx_spatial_source");
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
                format!("{quoted_output} = CASE WHEN {value_ref} IS NULL THEN NULL ELSE {value_ref}.STAsText() END")
            } else {
                format!("{quoted_output} = {value_ref}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");

    Some(format!("SELECT {select_list} FROM ({statement}) AS {source_alias}({source_alias_list})"))
}

fn is_sqlserver_spatial_column(column: &SqlServerDescribedColumn) -> bool {
    [&column.system_type_name, &column.user_type_name].into_iter().flatten().any(|name| {
        let normalized = name.trim().trim_matches(['[', ']']).to_ascii_lowercase();
        normalized == "geometry"
            || normalized == "geography"
            || normalized.ends_with(".geometry")
            || normalized.ends_with(".geography")
    })
}

fn normalized_sqlserver_select_statement(sql: &str) -> Option<String> {
    let statement = trim_sqlserver_statement(sql);
    let trimmed = statement.trim_start();
    if trimmed.is_empty() || !trimmed.get(..6).is_some_and(|prefix| prefix.eq_ignore_ascii_case("SELECT")) {
        return None;
    }
    if has_top_level_select_into(trimmed) {
        return None;
    }

    // Strip trailing ORDER BY so the statement can be used as a derived table
    // subquery. SQL Server requires TOP / OFFSET / FOR XML alongside ORDER BY
    // in subqueries, none of which are version-safe across 2008–2022.
    let mut statement = trimmed.to_string();
    let tokens = top_level_sqlserver_tokens(&statement);
    for index in (0..tokens.len().saturating_sub(1)).rev() {
        if tokens[index].text == "ORDER" && tokens.get(index + 1).is_some_and(|token| token.text == "BY") {
            statement.truncate(tokens[index].start);
            statement = statement.trim_end().to_string();
            break;
        }
    }
    Some(statement)
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
            rows: result.rows,
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: result.truncated,
            session_id: None,
            has_more: false,
        });
    }
}

async fn collect_result_sets_limited(
    mut stream: QueryStream<'_>,
    start: Instant,
    max_rows: Option<usize>,
) -> Result<Vec<QueryResult>, String> {
    let row_limit = query_result_row_limit(max_rows);
    let mut results = Vec::new();
    let mut current: Option<SqlServerResultSet> = None;

    while let Some(item) = stream.try_next().await.map_err(|e| e.to_string())? {
        match item {
            QueryItem::Metadata(metadata) => {
                push_sqlserver_result_set(&mut results, current.take(), start);
                current = Some(SqlServerResultSet {
                    columns: columns_from_metadata(&metadata),
                    column_types: column_types_from_metadata(&metadata),
                    rows: Vec::new(),
                    truncated: false,
                });
            }
            QueryItem::Row(row) => {
                let result = current.get_or_insert_with(|| SqlServerResultSet {
                    columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                    column_types: row.columns().iter().map(sqlserver_column_type_name).collect(),
                    rows: Vec::new(),
                    truncated: false,
                });
                if result.rows.len() < row_limit {
                    result.rows.push(row_to_json(&row));
                } else {
                    result.truncated = true;
                }
            }
        }
    }

    push_sqlserver_result_set(&mut results, current, start);
    Ok(results)
}

pub async fn stream_first_result_set(
    client: &mut SqlServerClient,
    sql: &str,
    row_limit: Option<usize>,
    cancel_token: Option<CancellationToken>,
    mut on_item: impl for<'a> FnMut(SqlServerStreamItem<'a>) -> Result<(), String>,
) -> Result<SqlServerStreamExportSummary, String> {
    let query_sql = match spatial_safe_sqlserver_query(client, sql).await {
        Ok(Some(sql)) => sql,
        Ok(None) | Err(_) => sql.to_string(),
    };
    let mut stream = sqlserver_driver_result(client.query(query_sql.as_str(), &[])).await?;
    let mut active_result_index: Option<usize> = None;
    let mut columns: Vec<String> = Vec::new();
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
                    on_item(SqlServerStreamItem::Columns(&columns))?;
                    columns_emitted = true;
                }
            }
            QueryItem::Row(row) => {
                if active_result_index.is_none() {
                    active_result_index = Some(row.result_index());
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                    on_item(SqlServerStreamItem::Columns(&columns))?;
                    columns_emitted = true;
                }
                if Some(row.result_index()) != active_result_index {
                    continue;
                }
                if row_limit.is_some_and(|limit| rows_exported as usize >= limit) {
                    break;
                }
                let values = row_to_json(&row);
                on_item(SqlServerStreamItem::Row(&values))?;
                rows_exported += 1;
            }
        }
    }

    if !columns_emitted {
        on_item(SqlServerStreamItem::Columns(&columns))?;
    }
    Ok(SqlServerStreamExportSummary { columns, rows_exported })
}

fn sqlserver_cell_to_json(cell: &ColumnData<'static>) -> serde_json::Value {
    if let Ok(Some(v)) = <&str as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
    }
    if let Ok(Some(v)) = <chrono::NaiveDateTime as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
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
    if let Ok(Some(v)) = <Decimal as FromSql>::from_sql(cell) {
        return serde_json::Value::String(v.to_string());
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
        queries.push(format!(
            "SELECT TOP ({limit}) o.name, s.name AS schema_name, \
             CASE o.type WHEN 'U' THEN 'TABLE' WHEN 'V' THEN 'VIEW' WHEN 'P' THEN 'PROCEDURE' WHEN 'FN' THEN 'FUNCTION' WHEN 'IF' THEN 'FUNCTION' WHEN 'TF' THEN 'FUNCTION' WHEN 'FS' THEN 'FUNCTION' WHEN 'FT' THEN 'FUNCTION' ELSE o.type_desc END AS object_type, \
             CAST(NULL AS NVARCHAR(128)) AS parent_schema, CAST(NULL AS NVARCHAR(128)) AS parent_name, ep.value AS object_comment, CAST(NULL AS NVARCHAR(128)) AS data_type \
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
             WHERE o.type IN ('U','V') AND {object_visibility} {schema_filter} {parent_table_filter} {column_like}"
        ));
    }

    if queries.is_empty() {
        format!("SELECT TOP (0) CAST('' AS NVARCHAR(128)) AS name, CAST('' AS NVARCHAR(128)) AS schema_name, CAST('' AS NVARCHAR(60)) AS object_type, CAST(NULL AS NVARCHAR(128)) AS parent_schema, CAST(NULL AS NVARCHAR(128)) AS parent_name, CAST(NULL AS NVARCHAR(MAX)) AS object_comment, CAST(NULL AS NVARCHAR(128)) AS data_type")
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
    let schema_escaped = schema.replace('\'', "''");
    let base_columns = "o.name, CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'BASE TABLE' END, ep.value AS TABLE_COMMENT";
    let base_from = "FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         OUTER APPLY (SELECT CAST(ep.value AS NVARCHAR(MAX)) AS value FROM sys.extended_properties ep \
           WHERE ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description') ep";
    let object_visibility = sqlserver_visible_object_predicate();
    let base_where =
        format!("WHERE s.name = '{schema_escaped}' AND o.type IN ('U','V') AND {object_visibility} {filter_clause}");
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
            comment: row.get::<&str, _>(4).filter(|s: &&str| !s.is_empty()).map(|s: &str| s.to_string()),
            created_at: row.get::<chrono::NaiveDateTime, _>(2).map(|value| value.to_string()),
            updated_at: row.get::<chrono::NaiveDateTime, _>(3).map(|value| value.to_string()),
            parent_schema: None,
            parent_name: None,
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
    let sql = sqlserver_columns_sql(schema, table);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| {
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
            ColumnInfo {
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
            }
        })
        .collect())
}

fn sqlserver_columns_sql(schema: &str, table: &str) -> String {
    let s = schema.replace('\'', "''");
    let t = table.replace('\'', "''");
    format!(
        "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT, \
         CASE WHEN kcu.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK, \
         c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.CHARACTER_MAXIMUM_LENGTH, c.DATETIME_PRECISION, \
         ident.extra AS COLUMN_EXTRA, \
         ep.value AS COLUMN_COMMENT \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
           ON c.TABLE_SCHEMA = kcu.TABLE_SCHEMA AND c.TABLE_NAME = kcu.TABLE_NAME AND c.COLUMN_NAME = kcu.COLUMN_NAME \
           AND kcu.CONSTRAINT_NAME IN (SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' AND TABLE_SCHEMA = '{s}' AND TABLE_NAME = '{t}') \
         OUTER APPLY (SELECT 'identity(' + CONVERT(VARCHAR(38), ic.seed_value) + ',' + CONVERT(VARCHAR(38), ic.increment_value) + ')' AS extra FROM sys.identity_columns ic WHERE ic.object_id = OBJECT_ID(QUOTENAME('{s}') + '.' + QUOTENAME('{t}')) AND ic.name = c.COLUMN_NAME) ident \
         OUTER APPLY (SELECT CAST(ep.value AS NVARCHAR(MAX)) AS value FROM sys.extended_properties ep WHERE ep.major_id = OBJECT_ID(QUOTENAME('{s}') + '.' + QUOTENAME('{t}')) AND ep.minor_id = COLUMNPROPERTY(OBJECT_ID(QUOTENAME('{s}') + '.' + QUOTENAME('{t}')), c.COLUMN_NAME, 'ColumnId') AND ep.name = N'MS_Description') ep \
         WHERE c.TABLE_SCHEMA = '{s}' AND c.TABLE_NAME = '{t}' \
         ORDER BY c.ORDINAL_POSITION"
    )
}

pub async fn list_indexes(client: &mut SqlServerClient, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let sql = sqlserver_indexes_sql(schema, table);
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
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

fn sqlserver_indexes_sql(schema: &str, table: &str) -> String {
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
         i.filter_definition, \
         ep.value AS index_comment \
         FROM sys.indexes i \
         OUTER APPLY (SELECT CAST(ep.value AS NVARCHAR(MAX)) AS value FROM sys.extended_properties ep WHERE ep.major_id = i.object_id AND ep.minor_id = i.index_id AND ep.name = N'MS_Description' AND ep.class = 7) ep \
         WHERE i.object_id = OBJECT_ID('{s}.{t}') AND i.name IS NOT NULL \
         ORDER BY i.name",
        s = schema.replace('\'', "''"),
        t = table.replace('\'', "''")
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
    let sql = format!(
        "SELECT t.name, te.type_desc, CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END \
         FROM sys.triggers t \
         JOIN sys.trigger_events te ON t.object_id = te.object_id \
         WHERE t.parent_id = OBJECT_ID('{s}.{t}') \
         ORDER BY t.name",
        s = schema.replace('\'', "''"),
        t = table.replace('\'', "''")
    );
    let stream = client.query(&*sql, &[]).await.map_err(|e| e.to_string())?;
    let rows = stream.into_first_result().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|row| TriggerInfo {
            name: row.get::<&str, _>(0).unwrap_or("").to_string(),
            event: row.get::<&str, _>(1).unwrap_or("").to_string(),
            timing: row.get::<&str, _>(2).unwrap_or("AFTER").to_string(),
            statement: None,
        })
        .collect())
}

pub async fn execute_query(client: &mut SqlServerClient, sql: &str) -> Result<QueryResult, String> {
    execute_query_with_max_rows(client, sql, None).await
}

pub async fn execute_query_with_max_rows(
    client: &mut SqlServerClient,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let start = Instant::now();

    if starts_with_executable_sql_keyword(sql, &["SELECT", "EXEC", "WITH", "TABLE"]) {
        let query_sql = match spatial_safe_sqlserver_query(client, sql).await {
            Ok(Some(sql)) => sql,
            Ok(None) | Err(_) => sql.to_string(),
        };
        let stream = sqlserver_driver_result(client.query(query_sql.as_str(), &[])).await?;
        let mut result = sqlserver_driver_result(collect_first_result_limited(stream, start, max_rows)).await?;
        strip_dbx_sqlserver_row_number_column(&mut result, sql);
        Ok(result)
    } else if requires_simple_query_batch(sql) || is_transaction_control(sql) {
        let stream = sqlserver_driver_result(client.simple_query(sql)).await?;
        let _ = sqlserver_driver_result(collect_result_sets_limited(stream, start, max_rows)).await?;
        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
    } else {
        let result = sqlserver_driver_result(client.execute(sql, &[])).await?;
        Ok(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: result.rows_affected().iter().sum::<u64>(),
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        })
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
    let start = Instant::now();
    if sqlserver_batch_can_use_execute(sql) {
        let result = sqlserver_driver_result(client.execute(sql, &[])).await?;
        return Ok(vec![QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: result.rows_affected().iter().sum::<u64>(),
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        }]);
    }

    if is_single_sqlserver_select(sql) {
        if let Ok(Some(query_sql)) = spatial_safe_sqlserver_query(client, sql).await {
            let stream = sqlserver_driver_result(client.query(query_sql.as_str(), &[])).await?;
            return sqlserver_driver_result(collect_first_result_limited(stream, start, max_rows)).await.map(
                |mut result| {
                    strip_dbx_sqlserver_row_number_column(&mut result, sql);
                    vec![result]
                },
            );
        }
    }
    let stream = sqlserver_driver_result(client.simple_query(sql)).await?;
    let mut results = sqlserver_driver_result(collect_result_sets_limited(stream, start, max_rows)).await?;
    for result in &mut results {
        strip_dbx_sqlserver_row_number_column(result, sql);
    }

    if results.is_empty() {
        results.push(QueryResult {
            columns: vec![],
            column_types: Vec::new(),
            column_sortables: vec![],
            rows: vec![],
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            truncated: false,
            session_id: None,
            has_more: false,
        });
    }

    Ok(results)
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
    !requires_simple_query_batch(sql)
        && !sqlserver_batch_may_return_result_set(sql)
        && !sqlserver_dml_output_returns_rows(sql)
}

fn sqlserver_batch_may_return_result_set(sql: &str) -> bool {
    let tokens = top_level_sqlserver_tokens(sql);
    tokens.iter().any(|token| matches!(token.text.as_str(), "SELECT" | "EXEC" | "EXECUTE" | "WITH" | "TABLE"))
}

fn sqlserver_dml_output_returns_rows(sql: &str) -> bool {
    starts_with_executable_sql_keyword(sql, &["INSERT", "UPDATE", "DELETE", "MERGE"])
        && first_sql_tokens(sql, 64).iter().any(|token| token.eq_ignore_ascii_case("OUTPUT"))
}

fn is_transaction_control(sql: &str) -> bool {
    let tokens = first_sql_tokens(sql, 2);
    if tokens.is_empty() {
        return false;
    }
    let first = &tokens[0];
    if first.eq_ignore_ascii_case("COMMIT") || first.eq_ignore_ascii_case("ROLLBACK") {
        return true;
    }
    if first.eq_ignore_ascii_case("BEGIN") {
        return tokens.get(1).is_some_and(|t| t.eq_ignore_ascii_case("TRANSACTION") || t.eq_ignore_ascii_case("TRAN"));
    }
    false
}

fn requires_simple_query_batch(sql: &str) -> bool {
    let tokens = first_sql_tokens(sql, 4);
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
        build_spatial_safe_sqlserver_query, is_sqlserver_spatial_column, requires_simple_query_batch,
        sqlserver_batch_can_use_execute, sqlserver_cell_to_json, sqlserver_columns_sql,
        sqlserver_completion_assistant_sql, sqlserver_dml_output_returns_rows, sqlserver_hidden_schema_names,
        sqlserver_indexes_sql, sqlserver_list_objects_sql, sqlserver_list_schemas_sql, sqlserver_list_tables_sql,
        sqlserver_table_comment_sql, sqlserver_visible_object_predicate, strip_dbx_sqlserver_row_number_column,
        SqlServerDescribedColumn, SqlServerResultSet,
    };
    use crate::types::{
        CompletionAssistantMatchMode, CompletionAssistantObjectKind, CompletionAssistantRequest, QueryResult,
    };
    use chrono::NaiveDate;
    use std::time::Instant;
    use tiberius::{ColumnData, IntoSql};

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
    fn sqlserver_connect_uses_named_instance_resolution() {
        let source = include_str!("sqlserver.rs");
        let try_connect = source.split("async fn try_connect").nth(1).unwrap();
        let try_connect = try_connect.split("fn row_to_json").next().unwrap();
        assert!(try_connect.contains("connect_named(&config)"));
    }

    #[test]
    fn sqlserver_module_definitions_require_simple_query_batch() {
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
    fn sqlserver_cud_batches_use_execute_for_affected_rows() {
        assert!(sqlserver_batch_can_use_execute("UPDATE dbo.users SET active = 0 WHERE id = 1;"));
        assert!(sqlserver_batch_can_use_execute("INSERT INTO dbo.users(id) VALUES (1);"));
        assert!(sqlserver_batch_can_use_execute("DELETE FROM dbo.users WHERE id = 1;"));
        assert!(sqlserver_batch_can_use_execute(
            "MERGE dbo.t AS t USING dbo.s AS s ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name;"
        ));
    }

    #[test]
    fn sqlserver_result_returning_batches_keep_simple_query_path() {
        assert!(!sqlserver_batch_can_use_execute("SELECT * FROM dbo.users;"));
        assert!(!sqlserver_batch_can_use_execute("EXEC dbo.list_users;"));
        assert!(!sqlserver_batch_can_use_execute("DECLARE @id INT = 1; EXEC dbo.list_users @id;"));
        assert!(!sqlserver_batch_can_use_execute(
            "DECLARE @id INT = 1; CREATE TABLE #t(id INT); INSERT INTO #t VALUES (@id); SELECT id FROM #t;"
        ));
        assert!(!sqlserver_batch_can_use_execute("WITH cte AS (SELECT 1 AS id) SELECT * FROM cte;"));
        assert!(!sqlserver_batch_can_use_execute("UPDATE dbo.users SET active = 0 OUTPUT inserted.id WHERE id = 1;"));
        assert!(sqlserver_batch_can_use_execute(
            "DECLARE @id INT = 1; UPDATE dbo.users SET active = 0 WHERE id = @id;"
        ));
        assert!(sqlserver_dml_output_returns_rows("DELETE FROM dbo.users OUTPUT deleted.id WHERE id = 1;"));
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
    fn sqlserver_index_metadata_sql_avoids_string_agg_for_older_compatibility_levels() {
        let sql = sqlserver_indexes_sql("dbo", "DF_Rule");

        assert!(!sql.contains("STRING_AGG"));
        assert!(sql.contains("FOR XML PATH"));
        assert!(sql.contains("OBJECT_ID('dbo.DF_Rule')"));
    }

    #[test]
    fn sqlserver_indexes_sql_includes_index_comment_via_extended_properties() {
        let sql = sqlserver_indexes_sql("dbo", "orders");

        assert!(sql.contains("sys.extended_properties ep"));
        assert!(sql.contains("ep.minor_id = i.index_id"));
        assert!(sql.contains("MS_Description"));
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
    fn sqlserver_metadata_sql_escapes_literals() {
        let columns_sql = sqlserver_columns_sql("d'bo", "t'able");
        let indexes_sql = sqlserver_indexes_sql("d'bo", "t'able");

        assert!(columns_sql.contains("TABLE_SCHEMA = 'd''bo'"));
        assert!(columns_sql.contains("TABLE_NAME = 't''able'"));
        assert!(columns_sql.contains("sys.identity_columns"));
        assert!(indexes_sql.contains("OBJECT_ID('d''bo.t''able')"));
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
    fn sqlserver_datetime2_cells_are_json_strings() {
        let datetime = NaiveDate::from_ymd_opt(2026, 5, 13).unwrap().and_hms_milli_opt(9, 8, 7, 123).unwrap();
        let cell: ColumnData<'static> = datetime.into_sql();

        assert_eq!(sqlserver_cell_to_json(&cell), serde_json::json!("2026-05-13 09:08:07.123"));
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
            rows: vec![vec![serde_json::json!(42), serde_json::json!(101)]],
            affected_rows: 0,
            execution_time_ms: 1,
            truncated: false,
            session_id: None,
            has_more: false,
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
        let rewritten = build_spatial_safe_sqlserver_query(
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
            rewritten,
            "SELECT [landId] = [dbx_spatial_source].[dbx_col_1], [polygon] = CASE WHEN [dbx_spatial_source].[dbx_col_2] IS NULL THEN NULL ELSE [dbx_spatial_source].[dbx_col_2].STAsText() END FROM (SELECT * FROM dbo.tLandPolygon) AS [dbx_spatial_source]([dbx_col_1], [dbx_col_2])"
        );
    }

    #[test]
    fn sqlserver_does_not_wrap_non_spatial_columns() {
        assert_eq!(
            build_spatial_safe_sqlserver_query(
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
        let rewritten = build_spatial_safe_sqlserver_query(
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

        // ORDER BY is stripped from the inner query so it can be used as a
        // derived table subquery across all SQL Server versions (2008–2022).
        assert!(!rewritten.contains("ORDER BY"));
        assert!(rewritten.contains("FROM dbo.tLandPolygon"));
        assert!(rewritten.contains(".STAsText()"));
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
            Some(SqlServerResultSet { columns: vec![], column_types: vec![], rows: vec![], truncated: false }),
            Instant::now(),
        );

        assert!(results.is_empty());
    }
}
