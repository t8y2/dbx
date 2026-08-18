use std::sync::Arc;

use serde_json::json;

use crate::agent_events::{ToolCall, ToolDefinition, ToolResult};
use crate::connection::AppState;
use crate::db::vector_driver;
use crate::models::connection::DatabaseType;
use crate::query::QueryExecutionOptions;
use crate::query_execution_sql::{build_explain_sql, supports_explain_plan, supports_sql_query, ExplainSqlOptions};
use crate::sql_dialect::{build_table_data_select_sql, TableDataSelectSqlOptions};
use crate::sql_risk::SqlRisk;
use crate::types::{QueryMessage, QueryResult};

/// Maximum number of tables returned by list_tables tool.
const LIST_TABLES_LIMIT: usize = 200;

/// Maximum number of rows returned by execute_query tool.
const EXECUTE_QUERY_LIMIT: usize = 50;

/// Maximum number of rows returned by get_sample_data tool.
const SAMPLE_DATA_LIMIT: usize = 20;

/// Maximum number of rows returned by browse_collection tool.
const BROWSE_COLLECTION_LIMIT: usize = 20;

/// Absolute maximum rows any query tool may request.
const MAX_ALLOWED_ROWS: usize = 100;

/// Default string-cell character budget for AI and local MCP query results.
const DEFAULT_QUERY_CELL_CHAR_LIMIT: usize = 200;

/// Explicit string-cell windows stay bounded so one tool call cannot flood the model context.
const MAX_QUERY_CELL_CHAR_LIMIT: usize = 4_000;

/// Bounds explicit sliding-window scans without changing the underlying database request.
const MAX_QUERY_CELL_CHAR_OFFSET: usize = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueryCellWindow {
    offset: usize,
    limit: usize,
}

impl Default for QueryCellWindow {
    fn default() -> Self {
        Self { offset: 0, limit: DEFAULT_QUERY_CELL_CHAR_LIMIT }
    }
}

impl QueryCellWindow {
    pub fn from_options(offset: Option<u64>, limit: Option<u64>) -> Self {
        Self {
            offset: bounded_query_cell_option(offset, 0, MAX_QUERY_CELL_CHAR_OFFSET),
            limit: bounded_query_cell_option(limit, DEFAULT_QUERY_CELL_CHAR_LIMIT, MAX_QUERY_CELL_CHAR_LIMIT).max(1),
        }
    }

    pub fn from_arguments(arguments: &serde_json::Value) -> Self {
        Self::from_options(
            arguments.get("cell_char_offset").and_then(serde_json::Value::as_u64),
            arguments.get("cell_char_limit").and_then(serde_json::Value::as_u64),
        )
    }

    pub fn explicit_from_arguments(arguments: &serde_json::Value) -> Option<Self> {
        let offset = arguments.get("cell_char_offset").and_then(serde_json::Value::as_u64);
        let limit = arguments.get("cell_char_limit").and_then(serde_json::Value::as_u64);
        (offset.is_some() || limit.is_some()).then(|| Self::from_options(offset, limit))
    }
}

fn bounded_query_cell_option(value: Option<u64>, default: usize, maximum: usize) -> usize {
    value.map(|value| value.min(maximum as u64) as usize).unwrap_or(default)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentSqlPermissions {
    pub allow_writes: bool,
    pub allow_dangerous: bool,
    /// When present, write/DDL execute_query calls must match this SQL
    /// (after trimming only surrounding whitespace). Set by the frontend
    /// when the user confirms a specific write-SQL proposal.
    pub confirmed_write_sql: Option<String>,
}

/// Build the write permissions for one AI-agent run from an explicit user
/// confirmation. Both Desktop and Web use this fail-closed boundary so an
/// empty confirmation or a production target cannot enable writes.
pub fn confirmed_write_sql_permissions(
    production_database: bool,
    allow_write_sql: bool,
    confirmed_write_sql: Option<String>,
) -> AgentSqlPermissions {
    let confirmed_write_sql = confirmed_write_sql.filter(|sql| !sql.trim().is_empty());
    let write_sql_confirmed = !production_database && allow_write_sql && confirmed_write_sql.is_some();

    AgentSqlPermissions {
        allow_writes: write_sql_confirmed,
        allow_dangerous: write_sql_confirmed,
        confirmed_write_sql: write_sql_confirmed.then_some(confirmed_write_sql).flatten(),
    }
}

/// Verify that the confirmed connection/database snapshot matches the actual
/// target. Returns `(allow_write_sql, confirmed_write_sql)` — when the target
/// does not match, the grant is voided (allow=false, confirmed=None).
///
/// This is defense-in-depth: the frontend also verifies synchronously, but
/// this backend check protects CLI-provider and API-driven paths.
pub fn verify_confirmed_target(
    allow_write_sql: Option<bool>,
    confirmed_write_sql: Option<String>,
    confirmed_connection_id: Option<String>,
    confirmed_database: Option<String>,
    confirmed_schema: Option<String>,
    actual_connection_id: &str,
    actual_database: &str,
    actual_schema: Option<&str>,
) -> (Option<bool>, Option<String>) {
    let Some(ref confirmed_sql) = confirmed_write_sql else {
        return (allow_write_sql, confirmed_write_sql);
    };
    // Only verify when a write SQL was actually confirmed.
    let target_mismatch = confirmed_connection_id.as_deref() != Some(actual_connection_id)
        || confirmed_database.as_deref() != Some(actual_database)
        || confirmed_schema.as_deref() != actual_schema;
    if target_mismatch {
        log::warn!(
            "Write-SQL grant voided: confirmed target (conn={:?}, db={:?}, schema={:?}) does not match actual (conn={}, db={}, schema={:?}).",
            confirmed_connection_id,
            confirmed_database,
            confirmed_schema,
            actual_connection_id,
            actual_database,
            actual_schema,
        );
        // SQL can contain literals or credentials. Keep diagnostic visibility
        // behind the shared debug-only redaction boundary.
        crate::sql_diagnostics::debug_sql("write_sql_grant_voided", confirmed_sql);
        return (Some(false), None);
    }
    (allow_write_sql, confirmed_write_sql)
}

fn sql_risk_allowed(risk: SqlRisk, permissions: AgentSqlPermissions) -> bool {
    match risk {
        SqlRisk::ReadOnly => true,
        SqlRisk::Write => permissions.allow_writes,
        SqlRisk::Ddl => permissions.allow_dangerous,
        SqlRisk::Transaction => false,
    }
}

/// Returns true for vector database types (Qdrant, Milvus, Weaviate, ChromaDb).
/// If modifying this, also update VECTOR_DB_TYPES in apps/desktop/src/lib/ai.ts.
pub fn is_vector_db(db_type: DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Qdrant | DatabaseType::Milvus | DatabaseType::Weaviate | DatabaseType::ChromaDb)
}

/// `get_current_time` tool definition — DB-independent utility that returns
/// the current UTC time plus a caller-provided local offset.
fn get_current_time_tool() -> ToolDefinition {
    ToolDefinition {
        name: "get_current_time",
        description: "Get the current date and time with timezone information. \
                      Pass the client UTC offset from the system prompt; when \
                      omitted, local time safely falls back to UTC. Use this to resolve \
                      relative time expressions like \"last 7 days\", \
                      \"yesterday\", \"this month\" into concrete dates \
                      for constructing SQL queries.",
        parameters: json!({
            "type": "object",
            "properties": {
                "utc_offset_minutes": {
                    "type": "integer",
                    "minimum": -1439,
                    "maximum": 1439,
                    "description": "Client UTC offset in minutes from the system prompt"
                },
                "timezone": {
                    "type": "string",
                    "description": "Client IANA timezone name from the system prompt"
                }
            },
            "required": []
        }),
        read_only: true,
        parallel_ok: true,
    }
}

/// Execute `get_current_time` — returns a JSON payload with utc, local,
/// utc_offset_minutes, timezone, and readable fields.
fn execute_get_current_time(tool_call: &ToolCall) -> Result<String, String> {
    let utc = chrono::Utc::now();
    let offset_minutes = tool_call.arguments.get("utc_offset_minutes").and_then(serde_json::Value::as_i64).unwrap_or(0);
    let offset_minutes = i32::try_from(offset_minutes).map_err(|_| "utc_offset_minutes is out of range".to_string())?;
    let offset_seconds =
        offset_minutes.checked_mul(60).ok_or_else(|| "utc_offset_minutes is out of range".to_string())?;
    let offset = chrono::FixedOffset::east_opt(offset_seconds)
        .ok_or_else(|| "utc_offset_minutes must be between -1439 and 1439".to_string())?;
    let local = utc.with_timezone(&offset);
    let timezone = tool_call
        .arguments
        .get("timezone")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| if offset_minutes == 0 { "UTC".to_string() } else { format!("UTC{}", local.format("%:z")) });
    let readable = format!("{} ({timezone}, UTC{})", local.format("%Y-%m-%d %H:%M:%S"), local.format("%:z"));
    Ok(serde_json::json!({
        "utc": utc.to_rfc3339(),
        "local": local.to_rfc3339(),
        "utc_offset_minutes": offset_minutes,
        "timezone": timezone,
        "readable": readable,
    })
    .to_string())
}

/// Get read-only tool definitions for the given database type.
/// Returns vector tools for vector DBs, SQL tools otherwise.
pub fn read_only_tools(db_type: DatabaseType) -> Vec<ToolDefinition> {
    if is_vector_db(db_type) {
        vec![list_collections_tool(), get_current_time_tool()]
    } else {
        vec![list_tables_tool(), get_columns_tool(), get_current_time_tool()]
    }
}

/// Get all available tool definitions for the given database type.
/// Includes read-only tools plus execute_query, get_sample_data, and
/// explain_query for database types that support them.
pub fn all_tools(db_type: DatabaseType, sql_permissions: AgentSqlPermissions) -> Vec<ToolDefinition> {
    if is_vector_db(db_type) {
        return vec![list_collections_tool(), browse_collection_tool(), get_current_time_tool()];
    }
    let mut tools = vec![list_tables_tool(), get_columns_tool(), get_current_time_tool()];
    if db_type == DatabaseType::MongoDb {
        tools.push(mongo_execute_query_tool(sql_permissions));
    } else if supports_sql_query(db_type) {
        tools.push(execute_query_tool(sql_permissions));
        tools.push(get_sample_data_tool());
    }
    if supports_explain_plan(Some(db_type)) {
        tools.push(explain_query_tool());
    }
    tools
}

fn mongo_execute_query_tool(_sql_permissions: AgentSqlPermissions) -> ToolDefinition {
    ToolDefinition {
        name: "execute_query",
        description: "Execute a read-only MongoDB shell command and return results (max 50 rows). Use commands such as db.collection.find({}), db.collection.findOne({}), db.collection.aggregate([]), or db.collection.countDocuments({}). Write commands are not available to the MongoDB Agent.",
        parameters: json!({
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "The MongoDB shell-style command to execute"
                },
                "limit": {
                    "type": "number",
                    "description": "Max rows to return (default 50, max 100)"
                }
            },
            "required": ["sql"]
        }),
        read_only: true,
        parallel_ok: false,
    }
}

/// list_tables tool definition.
fn list_tables_tool() -> ToolDefinition {
    ToolDefinition {
        name: "list_tables",
        description: "List all tables and views in the current database. Returns table names, types, and comments.",
        parameters: json!({
            "type": "object",
            "properties": {
                "schema": {
                    "type": "string",
                    "description": "Schema name to list tables from (optional, defaults to current database)"
                }
            },
            "required": []
        }),
        read_only: true,
        parallel_ok: true,
    }
}

/// get_columns tool definition.
fn get_columns_tool() -> ToolDefinition {
    ToolDefinition {
        name: "get_columns",
        description:
            "Get column definitions for a table: names, types, primary keys, nullable, defaults, and comments. \
             Use this when the user asks about table structure, column details, or field information — \
             even if some schema context was provided, this tool returns the authoritative and complete column list.",
        parameters: json!({
            "type": "object",
            "properties": {
                "table": {
                    "type": "string",
                    "description": "Table name to get columns for"
                },
                "schema": {
                    "type": "string",
                    "description": "Schema name (optional, defaults to current database)"
                }
            },
            "required": ["table"]
        }),
        read_only: true,
        // get_columns runs sequentially: concurrent metadata queries can exhaust
        // single-connection drivers (e.g. DuckDB), causing cascading tool errors.
        parallel_ok: false,
    }
}
/// execute_query tool definition.
fn execute_query_tool(sql_permissions: AgentSqlPermissions) -> ToolDefinition {
    let description = if sql_permissions.allow_dangerous {
        "Execute SQL after the user explicitly confirmed this operation. Read queries, writes, and DDL are allowed for this run."
    } else if sql_permissions.allow_writes {
        "Execute SQL after the user explicitly confirmed this operation. Read queries and non-DDL writes are allowed for this run."
    } else {
        "Execute a read-only SQL query and return results (max 50 rows). Only SELECT, WITH, SHOW, DESCRIBE, EXPLAIN statements are allowed. Write operations (INSERT/UPDATE/DELETE/DDL) are blocked."
    };
    ToolDefinition {
        name: "execute_query",
        description,
        parameters: json!({
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "The SQL query to execute"
                },
                "limit": {
                    "type": "number",
                    "description": "Max rows to return (default 50, max 100)"
                },
                "cell_char_offset": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 1000000,
                    "description": "Start character offset for every string cell (default 0). Use the next offset reported by a truncated result to slide through long values. Narrow the query to the target row and column before expanding."
                },
                "cell_char_limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 4000,
                    "description": "Maximum characters returned per string cell (default 200, max 4000). Increase only for an explicit long-value expansion."
                },
                "client_session_id": {
                    "type": "string",
                    "description": "Opaque DBX session handle that pins this query to the same backend connection as earlier queries in the session (preserves USE/SET/session state). Managed by DBX; agents should not invent values."
                }
            },
            "required": ["sql"]
        }),
        read_only: true,
        parallel_ok: false,
    }
}

/// get_sample_data tool definition.
fn get_sample_data_tool() -> ToolDefinition {
    ToolDefinition {
        name: "get_sample_data",
        description: "Get sample rows from a table to understand its data. Returns up to 20 rows.",
        parameters: json!({
            "type": "object",
            "properties": {
                "table": {
                    "type": "string",
                    "description": "Table name"
                },
                "schema": {
                    "type": "string",
                    "description": "Schema name (optional)"
                },
                "limit": {
                    "type": "number",
                    "description": "Max rows (default 20)"
                }
            },
            "required": ["table"]
        }),
        read_only: true,
        parallel_ok: true,
    }
}

/// explain_query tool definition (Phase 3).
fn explain_query_tool() -> ToolDefinition {
    ToolDefinition {
        name: "explain_query",
        description: "Get the execution plan for a SQL query using EXPLAIN. \
                      Shows how the database will execute the query (scan type, indexes, cost). \
                      Only read-only queries (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN) are allowed. \
                      Use this to analyze query performance and suggest index optimizations.",
        parameters: json!({
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "The SQL query to explain (must be read-only)"
                }
            },
            "required": ["sql"]
        }),
        read_only: true,
        parallel_ok: true,
    }
}

/// list_collections tool definition (vector databases).
fn list_collections_tool() -> ToolDefinition {
    ToolDefinition {
        name: "list_collections",
        description: "List all collections in the current vector database. Returns collection names and dimensions.",
        parameters: json!({
            "type": "object",
            "properties": {},
            "required": []
        }),
        read_only: true,
        parallel_ok: true,
    }
}

/// browse_collection tool definition (vector databases).
fn browse_collection_tool() -> ToolDefinition {
    ToolDefinition {
        name: "browse_collection",
        description: "Browse documents in a collection. Returns up to 20 items with payload/metadata (vectors excluded for compactness). For ChromaDB, use the collection id (UUID from list_collections) instead of the collection name.",
        parameters: json!({
            "type": "object",
            "properties": {
                "collection": {
                    "type": "string",
                    "description": "Collection name"
                },
                "limit": {
                    "type": "number",
                    "description": "Max items to return (default 20, max 100)"
                }
            },
            "required": ["collection"]
        }),
        read_only: true,
        parallel_ok: true,
    }
}

/// Execute a tool call and return the result.
pub async fn execute_tool(
    tool_call: &ToolCall,
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    default_schema: Option<&str>,
    db_type: &DatabaseType,
    sql_permissions: AgentSqlPermissions,
) -> ToolResult {
    let result = match tool_call.name.as_str() {
        "list_tables" => execute_list_tables(tool_call, state, connection_id, database, default_schema, db_type).await,
        "get_columns" => execute_get_columns(tool_call, state, connection_id, database, default_schema, db_type).await,
        "execute_query" => {
            execute_execute_query(tool_call, state, connection_id, database, default_schema, db_type, sql_permissions)
                .await
        }
        "get_sample_data" => {
            execute_get_sample_data(tool_call, state, connection_id, database, default_schema, db_type).await
        }
        "list_collections" => execute_list_collections(tool_call, state, connection_id, database, db_type).await,
        "browse_collection" => execute_browse_collection(tool_call, state, connection_id, database, db_type).await,
        "explain_query" => {
            let (text_result, explain_data) =
                execute_explain_query(tool_call, state, connection_id, database, default_schema, db_type).await;
            match text_result {
                Ok(content) => {
                    return ToolResult {
                        tool_call_id: tool_call.id.clone(),
                        tool_name: tool_call.name.clone(),
                        content,
                        is_error: false,
                        explain_data,
                    };
                }
                Err(err) => {
                    return ToolResult {
                        tool_call_id: tool_call.id.clone(),
                        tool_name: tool_call.name.clone(),
                        content: format!("Error: {err}"),
                        is_error: true,
                        explain_data: None,
                    };
                }
            }
        }
        "get_current_time" => execute_get_current_time(tool_call),
        _ => Err(format!("Unknown tool: {}", tool_call.name)),
    };

    match result {
        Ok(content) => ToolResult {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            content,
            is_error: false,
            explain_data: None,
        },
        Err(err) => ToolResult {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            content: format!("Error: {err}"),
            is_error: true,
            explain_data: None,
        },
    }
}

async fn execute_list_tables(
    tool_call: &ToolCall,
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    default_schema: Option<&str>,
    _db_type: &DatabaseType,
) -> Result<String, String> {
    let schema = effective_schema(tool_call, default_schema).unwrap_or_default();

    // Request one extra to detect whether more tables exist beyond the limit.
    let tables = crate::schema::list_tables_core(
        state,
        connection_id,
        database,
        &schema,
        None,
        Some(LIST_TABLES_LIMIT + 1),
        None,
        None,
        None,
    )
    .await
    .map_err(|e| format!("Failed to list tables: {e}"))?;

    let total = tables.len();
    let truncated = total > LIST_TABLES_LIMIT;

    let mut lines = Vec::new();
    let display_count = if truncated { LIST_TABLES_LIMIT } else { total };
    for table in tables.iter().take(display_count) {
        let mut line = format!("- {} ({})", table.name, table.table_type);
        if let Some(comment) = &table.comment {
            let trimmed = comment.trim();
            if !trimmed.is_empty() {
                line.push_str(&format!(" -- {}", trimmed));
            }
        }
        lines.push(line);
    }

    if truncated {
        lines.push(format!("... (showing {LIST_TABLES_LIMIT} of {total} tables)"));
    }

    if lines.is_empty() {
        return Ok("No tables found in this database/schema.".to_string());
    }

    Ok(lines.join("\n"))
}

async fn execute_get_columns(
    tool_call: &ToolCall,
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    default_schema: Option<&str>,
    _db_type: &DatabaseType,
) -> Result<String, String> {
    let table = tool_call
        .arguments
        .get("table")
        .and_then(|v| v.as_str())
        .ok_or("Missing required parameter: table")?
        .trim()
        .to_string();

    if table.is_empty() {
        return Err("Table name cannot be empty".to_string());
    }
    if table.len() > 256 {
        return Err(format!("Table name too long: {} characters (max 256)", table.len()));
    }
    // Reject names with characters that are unlikely to be valid identifiers
    if table.contains(';') || table.contains('\'') || table.contains('"') || table.contains('\\') {
        return Err(format!("Table name contains invalid characters: '{}'", table));
    }

    let schema = effective_schema(tool_call, default_schema).unwrap_or_default();

    let columns = crate::schema::get_columns_core(state, connection_id, database, &schema, &table)
        .await
        .map_err(|e| format!("Failed to get columns for {table}: {e}"))?;

    if columns.is_empty() {
        return Ok(format!("No columns found for table '{table}'."));
    }

    let mut lines = Vec::new();
    lines.push(format!("Columns of {table}:"));
    for col in &columns {
        let mut flags: Vec<String> = Vec::new();
        if col.is_primary_key {
            flags.push("PK".to_string());
        }
        if col.is_nullable {
            flags.push("nullable".to_string());
        } else {
            flags.push("NOT NULL".to_string());
        }
        if let Some(default) = &col.column_default {
            if !default.is_empty() {
                flags.push(format!("default {default}"));
            }
        }
        if let Some(extra) = &col.extra {
            if !extra.is_empty() {
                flags.push(extra.clone());
            }
        }

        let flags_str = if flags.is_empty() { String::new() } else { format!(" ({})", flags.join(", ")) };

        let comment_str = col
            .comment
            .as_ref()
            .filter(|c| !c.trim().is_empty())
            .map(|c| format!(" -- {}", c.trim()))
            .unwrap_or_default();

        lines.push(format!("  - {}: {}{}{}", col.name, col.data_type, flags_str, comment_str));
    }

    Ok(lines.join("\n"))
}

/// Normalize a SQL string for confirmation comparison.
///
/// Confirmation is intentionally fail-closed: only surrounding whitespace is
/// ignored. SQL case, internal whitespace, comments, literals, and quoted
/// identifiers can all affect execution semantics across supported dialects.
pub fn normalize_sql_for_confirmation(sql: &str) -> String {
    sql.trim().to_string()
}

fn truncate_sql_for_error(sql: &str) -> String {
    let s = sql.trim();
    let char_count = s.chars().count();
    if char_count <= 120 {
        s.to_string()
    } else {
        format!("{}...", s.chars().take(117).collect::<String>())
    }
}

/// Check whether `executed_sql` matches the user-confirmed write SQL. Returns
/// `true` when no confirmation is required (confirmed is `None`) or when the
/// trimmed forms match.
fn sql_matches_confirmed_write(executed_sql: &str, confirmed: &Option<String>) -> bool {
    match confirmed {
        None => true,
        Some(confirmed) => normalize_sql_for_confirmation(executed_sql) == normalize_sql_for_confirmation(confirmed),
    }
}

async fn execute_execute_query(
    tool_call: &ToolCall,
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    default_schema: Option<&str>,
    db_type: &DatabaseType,
    sql_permissions: AgentSqlPermissions,
) -> Result<String, String> {
    let sql = tool_call.arguments.get("sql").and_then(|v| v.as_str()).ok_or("Missing required parameter: sql")?.trim();

    if sql.is_empty() {
        return Err("SQL query cannot be empty".to_string());
    }

    let limit = tool_call
        .arguments
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|l| (l as usize).min(MAX_ALLOWED_ROWS))
        .unwrap_or(EXECUTE_QUERY_LIMIT);
    let cell_window = QueryCellWindow::from_arguments(&tool_call.arguments);

    if *db_type == DatabaseType::MongoDb {
        return execute_mongo_query(state, connection_id, database, sql, limit.max(1), cell_window).await;
    }

    // Classify SQL risk using the concrete database dialect.
    let risk = crate::sql_risk::classify_sql_risk_for_database(sql, *db_type)?;
    let connection_config = state.configs.read().await.get(connection_id).cloned();
    if let Some(config) = connection_config {
        if risk != SqlRisk::ReadOnly && crate::production_safety::targets_production_database(&config, database, sql) {
            return Err("Blocked: AI agents cannot execute writes or DDL on a production database. Return the SQL for the user to review and execute manually in DBX.".to_string());
        }
    }
    if !sql_risk_allowed(risk, sql_permissions.clone()) {
        if risk == SqlRisk::Transaction {
            return Err("Blocked: transaction control statements are not available to the AI agent.".to_string());
        }
        return Err(format!(
            "Blocked: {} statement detected. Ask the user to confirm the proposed database change before executing it.",
            risk
        ));
    }

    // When the user confirmed a specific write SQL, the agent must
    // execute only that SQL — not an arbitrary different statement.
    if risk != SqlRisk::ReadOnly && !sql_matches_confirmed_write(sql, &sql_permissions.confirmed_write_sql) {
        let confirmed = sql_permissions.confirmed_write_sql.as_deref().unwrap_or("");
        return Err(format!(
            "Blocked: the executed SQL does not match the user-confirmed SQL.\n\
             Confirmed: {}\n\
             Attempted: {}",
            truncate_sql_for_error(confirmed),
            truncate_sql_for_error(sql),
        ));
    }

    // Stateful callers (e.g. MCP sessions) pin the query to their dedicated
    // connection pool so USE/SET and other session state is preserved.
    let client_session_id =
        tool_call.arguments.get("client_session_id").and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty());

    // Execute query using existing infrastructure
    let options = QueryExecutionOptions {
        max_rows: Some(limit),
        timeout_secs: Some(30),
        client_session_id: client_session_id.map(str::to_string),
        ..Default::default()
    };
    let result = crate::query::execute_sql_statement_with_options(
        state,
        connection_id,
        database,
        sql,
        default_schema,
        None,
        options,
    )
    .await?;

    format_query_result_as_text(&result, limit, cell_window)
}

async fn execute_mongo_query(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    source: &str,
    limit: usize,
    cell_window: QueryCellWindow,
) -> Result<String, String> {
    let command = crate::mongo_shell::parse(source).map_err(|error| {
        format!(
            "{error} Use MongoDB shell-style commands such as db.collection.find({{}}), db.collection.findOne({{}}), or db.collection.aggregate([])."
        )
    })?;
    if command.is_mutating() {
        return Err(
            "Blocked: MongoDB Agent queries are read-only. Return the command for the user to review and execute manually in DBX."
                .to_string(),
        );
    }

    let result = crate::mongo_ops::execute_mongo_command_core(state, connection_id, database, &command, limit).await?;
    format_query_result_as_text(&result, limit, cell_window)
}

/// Format a QueryResult as a Markdown table for LLM consumption.
pub fn format_query_result_as_text(
    result: &QueryResult,
    limit: usize,
    cell_window: QueryCellWindow,
) -> Result<String, String> {
    // A result without columns is a command result, not an empty result set.
    // This is how drivers represent DML that does not use RETURNING.
    if result.columns.is_empty() {
        return Ok(append_server_messages(
            format!("Query executed. {} row(s) affected.", result.affected_rows),
            &result.messages,
        ));
    }

    let mut lines = Vec::new();

    // Header row
    lines.push(format!("| {} |", result.columns.join(" | ")));
    // Separator row
    lines.push(format!("|{}|", result.columns.iter().map(|_| "---").collect::<Vec<_>>().join("|")));

    // Data rows
    for row in &result.rows {
        let cells: Vec<String> = row
            .iter()
            .map(|v| match v {
                serde_json::Value::Null => "NULL".to_string(),
                serde_json::Value::String(value) => format_query_string_cell(value, cell_window),
                other => other.to_string(),
            })
            .collect();
        lines.push(format!("| {} |", cells.join(" | ")));
    }

    // Truncation notice
    if result.truncated || result.rows.len() >= limit {
        lines.push(format!("... (showing {} rows, result may be truncated)", result.rows.len()));
    }

    // Stats line
    lines.push(format!("({} rows, {}ms)", result.rows.len(), result.execution_time_ms));

    Ok(append_server_messages(lines.join("\n"), &result.messages))
}

fn format_query_string_cell(value: &str, window: QueryCellWindow) -> String {
    let mut characters = value.chars().skip(window.offset);
    let mut returned = 0usize;
    let content = characters.by_ref().take(window.limit).inspect(|_| returned += 1).collect::<String>();
    let has_more = characters.next().is_some();
    if window.offset == 0 && !has_more {
        return content;
    }

    let end = window.offset.saturating_add(returned);
    let prefix = if window.offset > 0 { "..." } else { "" };
    if has_more {
        format!("{prefix}{content}... [chars {}..{end}; next cell_char_offset={end}]", window.offset)
    } else {
        format!("{prefix}{content} [chars {}..{end}; end of value]", window.offset)
    }
}

/// Append server messages in the same style as the MCP `format_query_result`
/// renderer: a `Server messages:` section with `- SEVERITY: message` lines.
fn append_server_messages(mut output: String, messages: &[QueryMessage]) -> String {
    if messages.is_empty() {
        return output;
    }
    output.push_str("\n\nServer messages:");
    for message in messages {
        output.push_str(&format!("\n- {}", message.format_line()));
    }
    output
}

/// Get sample data from a table via the get_sample_data tool.
async fn execute_get_sample_data(
    tool_call: &ToolCall,
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    default_schema: Option<&str>,
    db_type: &DatabaseType,
) -> Result<String, String> {
    let table =
        tool_call.arguments.get("table").and_then(|v| v.as_str()).ok_or("Missing required parameter: table")?.trim();

    if table.is_empty() {
        return Err("Table name cannot be empty".to_string());
    }
    if table.contains(';') || table.contains('\'') || table.contains('"') || table.contains('\\') {
        return Err(format!("Table name contains invalid characters: '{}'", table));
    }

    let schema = effective_schema(tool_call, default_schema);
    let limit = tool_call
        .arguments
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|l| (l as usize).min(MAX_ALLOWED_ROWS))
        .unwrap_or(SAMPLE_DATA_LIMIT);

    // Reuse the table-data builder so identifier quoting and row limiting follow
    // the active database instead of assuming PostgreSQL syntax.
    let sql = build_sample_data_sql(db_type, schema.as_deref(), table, limit);

    // Delegate to execute_execute_query with a synthetic tool call
    let synthetic_call = ToolCall {
        id: tool_call.id.clone(),
        name: "execute_query".to_string(),
        arguments: serde_json::json!({ "sql": sql, "limit": limit }),
        provider_payload: None,
    };
    execute_execute_query(
        &synthetic_call,
        state,
        connection_id,
        database,
        schema.as_deref(),
        db_type,
        AgentSqlPermissions::default(),
    )
    .await
}

fn build_sample_data_sql(db_type: &DatabaseType, schema: Option<&str>, table: &str, limit: usize) -> String {
    build_table_data_select_sql(TableDataSelectSqlOptions {
        database_type: Some(*db_type),
        schema: schema.map(str::to_owned),
        table_name: table.to_string(),
        limit: Some(limit),
        ..Default::default()
    })
}

/// Execute an EXPLAIN query via the explain_query tool.
/// Returns (text_for_llm, optional_explain_data_for_frontend).
async fn execute_explain_query(
    tool_call: &ToolCall,
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    default_schema: Option<&str>,
    db_type: &DatabaseType,
) -> (Result<String, String>, Option<serde_json::Value>) {
    let sql = match tool_call.arguments.get("sql").and_then(|v| v.as_str()) {
        Some(s) => s.trim(),
        None => return (Err("Missing required parameter: sql".to_string()), None),
    };

    if sql.is_empty() {
        return (Err("SQL query cannot be empty".to_string()), None);
    }

    // Classify SQL risk – only ReadOnly queries can be explained
    let risk = match crate::sql_risk::classify_sql_risk_for_database(sql, *db_type) {
        Ok(r) => r,
        Err(e) => return (Err(e), None),
    };
    match risk {
        SqlRisk::ReadOnly => { /* proceed */ }
        _ => {
            return (
                Err(format!(
                    "Blocked: {} statement detected. Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN) can be analyzed.",
                    risk
                )),
                None,
            );
        }
    }

    if *db_type == DatabaseType::Oracle {
        return match crate::agent_explain::get_agent_explain_info_core(
            state,
            connection_id,
            Some(database),
            default_schema,
            sql,
            Some("explain"),
        )
        .await
        {
            Ok(plan) => (Ok(plan.clone()), Some(serde_json::Value::String(plan))),
            Err(error) => (Err(error), None),
        };
    }

    // Build the database-specific EXPLAIN SQL
    let explain_result = build_explain_sql(ExplainSqlOptions {
        database_type: Some(*db_type),
        format: None,
        analyze: None,
        sql: sql.to_string(),
    });

    let explain_sql = match (explain_result.ok, explain_result.sql) {
        (true, Some(sql)) => sql,
        (true, None) => return (Err("EXPLAIN SQL is empty".to_string()), None),
        (false, _) => {
            let reason = explain_result.reason.unwrap_or_else(|| "unknown".to_string());
            return (Err(format!("Cannot explain this query: {}. The database type may not support EXPLAIN, or the query may be unsafe.", reason)), None);
        }
    };

    // Execute the EXPLAIN query
    let options = QueryExecutionOptions { max_rows: Some(100), timeout_secs: Some(30), ..Default::default() };
    let result = match crate::query::execute_sql_statement_with_options(
        state,
        connection_id,
        database,
        &explain_sql,
        default_schema,
        None,
        options,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return (Err(e), None),
    };

    // Serialize the raw QueryResult for the frontend ExplainPlanViewer
    let explain_data = serde_json::to_value(&result).ok();
    let text = match format_query_result_as_text(&result, 100, QueryCellWindow::default()) {
        Ok(t) => t,
        Err(e) => return (Err(e), None),
    };

    (Ok(text), explain_data)
}

/// A selected context schema is authoritative for an Agent run. If none was
/// selected, keep the existing per-tool schema parameter behavior.
fn effective_schema(tool_call: &ToolCall, default_schema: Option<&str>) -> Option<String> {
    default_schema.map(str::trim).filter(|schema| !schema.is_empty()).map(ToOwned::to_owned).or_else(|| {
        tool_call
            .arguments
            .get("schema")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|schema| !schema.is_empty())
            .map(ToOwned::to_owned)
    })
}

/// Execute list_collections tool (vector databases).
async fn execute_list_collections(
    _tool_call: &ToolCall,
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    _db_type: &DatabaseType,
) -> Result<String, String> {
    let collections = crate::schema::list_vector_collections_core(state, connection_id, database)
        .await
        .map_err(|e| format!("Failed to list collections: {e}"))?;

    if collections.is_empty() {
        return Ok("No collections found.".to_string());
    }

    let mut lines: Vec<String> = collections
        .iter()
        .map(|c| {
            let mut line = format!("- {} (COLLECTION)", c.name);
            if let Some(dim) = c.dimension {
                line.push_str(&format!(" -- {}d", dim));
            }
            line.push_str(&format!(" [id: {}]", c.id));
            line
        })
        .collect();

    if lines.len() > LIST_TABLES_LIMIT {
        lines.truncate(LIST_TABLES_LIMIT);
        lines.push(format!("... (showing {LIST_TABLES_LIMIT} of {} collections)", collections.len()));
    }

    Ok(lines.join("\n"))
}

/// Execute browse_collection tool (vector databases).
/// Generates a database-specific REST query and executes it.
async fn execute_browse_collection(
    tool_call: &ToolCall,
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    db_type: &DatabaseType,
) -> Result<String, String> {
    let collection = tool_call
        .arguments
        .get("collection")
        .and_then(|v| v.as_str())
        .ok_or("Missing required parameter: collection")?
        .trim();

    if collection.is_empty() {
        return Err("Collection name cannot be empty".to_string());
    }

    let limit = tool_call
        .arguments
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|l| (l as usize).min(MAX_ALLOWED_ROWS))
        .unwrap_or(BROWSE_COLLECTION_LIMIT);

    // ChromaDB requires UUID in URL path, not collection name.
    // If the collection param is already a UUID (from list_collections output), use it directly.
    let collection_id = if *db_type == DatabaseType::ChromaDb && !is_uuid(collection) {
        resolve_chroma_collection_uuid(state, connection_id, database, collection).await?
    } else {
        collection.to_string()
    };

    let tenant = if *db_type == DatabaseType::ChromaDb {
        state.configs.read().await.get(connection_id).map(|config| config.username.clone()).unwrap_or_default()
    } else {
        String::new()
    };
    let query = build_browse_query(db_type, &collection_id, database, &tenant, limit)?;

    let options = QueryExecutionOptions { max_rows: Some(limit), timeout_secs: Some(30), ..Default::default() };
    let result =
        crate::query::execute_sql_statement_with_options(state, connection_id, database, &query, None, None, options)
            .await?;

    format_query_result_as_text(&result, limit, QueryCellWindow::default())
}

/// Build a browse query for the given vector database type.
/// Intentionally omits offset/pagination — Agent browse only fetches the first N items.
fn build_browse_query(
    db_type: &DatabaseType,
    collection: &str,
    database: &str,
    tenant: &str,
    limit: usize,
) -> Result<String, String> {
    let collection = collection.trim();
    if collection.is_empty() {
        return Err("Collection name cannot be empty".to_string());
    }
    let limit = limit.max(1) as u64;

    match db_type {
        DatabaseType::Qdrant => Ok(format!(
            "POST /collections/{}/points/scroll\n{}",
            vector_driver::path_segment(collection),
            serde_json::json!({ "limit": limit, "with_payload": true, "with_vector": false })
        )),
        // Milvus v2 omitting outputFields defaults to returning only scalar fields (no vectors).
        DatabaseType::Milvus => Ok(format!(
            "POST /v2/vectordb/entities/query\n{}",
            serde_json::json!({
                "dbName": if database.is_empty() { "default" } else { database },
                "collectionName": collection,
                "filter": "", "limit": limit
            })
        )),
        DatabaseType::Weaviate => {
            Ok(format!("GET /v1/objects?class={}&limit={}", vector_driver::query_value(collection), limit))
        }
        DatabaseType::ChromaDb => Ok(format!(
            "POST {}/get\n{}",
            vector_driver::chroma_collection_path(tenant, database, collection, None),
            serde_json::json!({ "limit": limit, "include": ["documents", "metadatas"] })
        )),
        _ => Err(format!("Unsupported database type: {:?}", db_type)),
    }
}

/// Check if a string looks like a UUID (simple check — 36 chars with 4 hyphens).
fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.chars().filter(|&c| c == '-').count() == 4
        && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Resolve a ChromaDB collection name to its UUID by listing all collections.
async fn resolve_chroma_collection_uuid(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    name: &str,
) -> Result<String, String> {
    let collections = crate::schema::list_vector_collections_core(state, connection_id, database).await?;
    collections
        .into_iter()
        .find(|c| c.name == name)
        .map(|c| c.id)
        .ok_or_else(|| format!("Collection '{name}' not found"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::connection::PoolKind;
    #[cfg(unix)]
    use crate::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};
    #[cfg(unix)]
    use crate::models::connection::{default_redis_key_separator, ConnectionConfig};
    #[cfg(unix)]
    use crate::storage::Storage;

    #[cfg(unix)]
    async fn spawn_recording_agent(record_path: &std::path::Path) -> (AgentDriverClient, tempfile::NamedTempFile) {
        use std::io::Write;

        let mut script = tempfile::NamedTempFile::new().unwrap();
        write!(
            script,
            r#"import json
import sys

record_path = sys.argv[1]
print(json.dumps({{"ready": True}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    with open(record_path, "a", encoding="utf-8") as record:
        record.write(json.dumps(request) + "\n")
    result = {{
        "columns": [],
        "column_types": [],
        "column_sortables": [],
        "rows": [],
        "affected_rows": 1,
        "execution_time_ms": 0,
        "truncated": False,
        "session_id": None,
        "has_more": False
    }}
    print(json.dumps({{"jsonrpc": "2.0", "id": request["id"], "result": result}}), flush=True)
"#
        )
        .unwrap();
        script.flush().unwrap();

        let client = AgentDriverClient::spawn(
            AgentLaunchSpec::new("python3")
                .with_args([script.path().to_string_lossy().to_string(), record_path.to_string_lossy().to_string()]),
        )
        .await
        .unwrap();
        (client, script)
    }

    #[cfg(unix)]
    fn agent_test_connection(id: &str, name: &str, db_type: DatabaseType, database: &str) -> ConnectionConfig {
        ConnectionConfig {
            docs_notes_path: None,
            id: id.to_string(),
            name: name.to_string(),
            note: String::new(),
            db_type,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "localhost".to_string(),
            port: 5236,
            username: "APP_USER".to_string(),
            password: String::new(),
            database: Some(database.to_string()),
            default_schema: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 10,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 30,
            ssl: false,
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
            redis_key_separator: default_redis_key_separator(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    #[test]
    fn vector_read_only_tools_do_not_include_collection_browsing() {
        let tools = read_only_tools(DatabaseType::Qdrant);
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();

        assert!(names.contains(&"list_collections"));
        assert!(!names.contains(&"browse_collection"));
        assert!(names.contains(&"get_current_time"));
    }

    #[test]
    fn vector_agent_tools_include_collection_browsing() {
        let tools = all_tools(DatabaseType::Qdrant, AgentSqlPermissions::default());
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();

        assert!(names.contains(&"list_collections"));
        assert!(names.contains(&"browse_collection"));
        assert!(names.contains(&"get_current_time"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongodb_agent_registers_shell_query_tool_and_routes_find_one_as_read_only() {
        let tools = all_tools(DatabaseType::MongoDb, AgentSqlPermissions::default());
        let names = tools.iter().map(|tool| tool.name).collect::<Vec<_>>();
        assert!(names.contains(&"execute_query"));
        assert!(!names.contains(&"get_sample_data"));
        assert!(!names.contains(&"explain_query"));
        let execute_query = tools.iter().find(|tool| tool.name == "execute_query").unwrap();
        assert!(execute_query.description.contains("MongoDB shell command"));
        assert!(!execute_query.description.contains("SQL query"));
        assert!(execute_query.description.contains("read-only"));

        let confirmed_tools = all_tools(
            DatabaseType::MongoDb,
            AgentSqlPermissions {
                allow_writes: true,
                allow_dangerous: true,
                confirmed_write_sql: Some("db.items.insertOne({name: 'test'})".to_string()),
            },
        );
        let confirmed_execute_query = confirmed_tools.iter().find(|tool| tool.name == "execute_query").unwrap();
        assert!(confirmed_execute_query.description.contains("read-only"));
        assert!(!confirmed_execute_query.description.contains("confirmed write"));

        let temp_dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&temp_dir.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new(storage));
        let call = ToolCall {
            id: "mongo-find-one".to_string(),
            name: "execute_query".to_string(),
            arguments: json!({ "sql": "db.BenchmarkIndex_approved.findOne({})" }),
            provider_payload: None,
        };

        let result = execute_tool(
            &call,
            &state,
            "mongo-1",
            "benchmark",
            None,
            &DatabaseType::MongoDb,
            AgentSqlPermissions::default(),
        )
        .await;

        assert!(result.is_error);
        assert!(!result.content.contains("Blocked:"), "{}", result.content);
        assert!(result.content.contains("Connection") || result.content.contains("connection"), "{}", result.content);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mongodb_agent_keeps_all_writes_blocked_after_sql_confirmation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&temp_dir.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new(storage));
        let permissions = AgentSqlPermissions {
            allow_writes: true,
            allow_dangerous: true,
            confirmed_write_sql: Some("SQL confirmation does not grant MongoDB writes".to_string()),
        };

        for (index, source) in [
            "db.items.insertOne({name: 'test'})",
            "db.items.updateMany({tenant: 7}, {$set: {active: false}})",
            "db.items.deleteMany({tenant: 7})",
            "db.items.createIndex({tenant: 1})",
            "db.runCommand({compact: 'items'})",
            r#"db.items.aggregate([{"$out":"items_backup"}])"#,
        ]
        .into_iter()
        .enumerate()
        {
            let call = ToolCall {
                id: format!("mongo-write-{index}"),
                name: "execute_query".to_string(),
                arguments: json!({ "sql": source }),
                provider_payload: None,
            };
            let result =
                execute_tool(&call, &state, "mongo-1", "benchmark", None, &DatabaseType::MongoDb, permissions.clone())
                    .await;

            assert!(result.is_error, "{source}: {}", result.content);
            assert!(result.content.contains("read-only"), "{source}: {}", result.content);
        }
    }

    #[test]
    fn confirmed_sql_permissions_update_execute_query_contract() {
        let tools = all_tools(
            DatabaseType::Mysql,
            AgentSqlPermissions { allow_writes: true, allow_dangerous: true, confirmed_write_sql: None },
        );
        let execute_query = tools.iter().find(|tool| tool.name == "execute_query").unwrap();

        assert!(execute_query.description.contains("explicitly confirmed"));
        assert!(execute_query.description.contains("DDL"));
    }

    #[test]
    fn sql_permissions_keep_writes_blocked_until_confirmation() {
        assert!(!sql_risk_allowed(SqlRisk::Write, AgentSqlPermissions::default()));
        assert!(!sql_risk_allowed(SqlRisk::Ddl, AgentSqlPermissions::default()));
        assert!(sql_risk_allowed(
            SqlRisk::Ddl,
            AgentSqlPermissions { allow_writes: true, allow_dangerous: true, confirmed_write_sql: None }
        ));
        assert!(!sql_risk_allowed(
            SqlRisk::Transaction,
            AgentSqlPermissions { allow_writes: true, allow_dangerous: true, confirmed_write_sql: None }
        ));
    }

    #[test]
    fn oracle_agent_tools_include_explain_query() {
        let tools = all_tools(DatabaseType::Oracle, AgentSqlPermissions::default());
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();

        assert!(names.contains(&"explain_query"));
    }

    fn query_result(columns: Vec<&str>, rows: Vec<Vec<serde_json::Value>>, affected_rows: u64) -> QueryResult {
        QueryResult {
            columns: columns.into_iter().map(str::to_string).collect(),
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows,
            affected_rows,
            execution_time_ms: 1,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        }
    }

    #[test]
    fn query_result_formatter_reports_dml_affected_rows() {
        let result = query_result(vec![], vec![], 2);

        assert_eq!(
            format_query_result_as_text(&result, 50, QueryCellWindow::default()).unwrap(),
            "Query executed. 2 row(s) affected."
        );
    }

    #[test]
    fn query_result_formatter_distinguishes_zero_row_dml_from_an_empty_result_set() {
        let dml = query_result(vec![], vec![], 0);
        let returning = query_result(vec!["id", "name"], vec![], 0);

        assert_eq!(
            format_query_result_as_text(&dml, 50, QueryCellWindow::default()).unwrap(),
            "Query executed. 0 row(s) affected."
        );
        assert_eq!(
            format_query_result_as_text(&returning, 50, QueryCellWindow::default()).unwrap(),
            "| id | name |\n|---|---|\n(0 rows, 1ms)"
        );
    }

    #[test]
    fn query_result_formatter_renders_returning_rows() {
        let result =
            query_result(vec!["id", "name"], vec![vec![serde_json::json!(5), serde_json::json!("returning")]], 0);

        assert_eq!(
            format_query_result_as_text(&result, 50, QueryCellWindow::default()).unwrap(),
            "| id | name |\n|---|---|\n| 5 | returning |\n(1 rows, 1ms)"
        );
    }

    #[test]
    fn query_result_formatter_marks_the_default_character_window() {
        let value = format!("{}DBX_ISSUE_5620_SENTINEL", "A".repeat(200));
        let result = query_result(vec!["message"], vec![vec![serde_json::json!(value)]], 0);

        let output = format_query_result_as_text(&result, 50, QueryCellWindow::from_options(None, None)).unwrap();

        assert!(output.contains(&format!("{}... [chars 0..200; next cell_char_offset=200]", "A".repeat(200))));
        assert!(!output.contains("DBX_ISSUE_5620_SENTINEL"));
    }

    #[test]
    fn query_result_formatter_supports_expanded_and_sliding_character_windows() {
        let value = format!("{}DBX_ISSUE_5620_SENTINEL{}", "A".repeat(200), "Z".repeat(20));
        let result = query_result(vec!["message"], vec![vec![serde_json::json!(value)]], 0);

        let expanded =
            format_query_result_as_text(&result, 50, QueryCellWindow::from_options(None, Some(400))).unwrap();
        assert!(expanded.contains("DBX_ISSUE_5620_SENTINEL"));
        assert!(!expanded.contains("next cell_char_offset"));

        let sliding =
            format_query_result_as_text(&result, 50, QueryCellWindow::from_options(Some(200), Some(23))).unwrap();
        assert!(sliding.contains("...DBX_ISSUE_5620_SENTINEL... [chars 200..223; next cell_char_offset=223]"));
    }

    #[test]
    fn query_result_formatter_counts_unicode_characters_in_windows() {
        let result = query_result(vec!["message"], vec![vec![serde_json::json!("甲乙丙丁戊己庚辛")]], 0);

        let output = format_query_result_as_text(&result, 50, QueryCellWindow::from_options(Some(2), Some(3))).unwrap();

        assert!(output.contains("...丙丁戊... [chars 2..5; next cell_char_offset=5]"));
    }

    #[test]
    fn query_cell_window_clamps_explicit_bounds() {
        assert_eq!(QueryCellWindow::from_options(None, None), QueryCellWindow::default());
        assert_eq!(
            QueryCellWindow::from_options(Some(u64::MAX), Some(0)),
            QueryCellWindow { offset: 1_000_000, limit: 1 }
        );
        assert_eq!(
            QueryCellWindow::from_options(Some(1_000_001), Some(u64::MAX)),
            QueryCellWindow { offset: 1_000_000, limit: 4_000 }
        );
    }

    #[test]
    fn query_result_formatter_appends_server_messages() {
        let mut dml = query_result(vec![], vec![], 2);
        dml.messages = vec![
            QueryMessage {
                severity: "notice".to_string(),
                message: "hello world".to_string(),
                code: Some("00000".to_string()),
                detail: None,
                hint: Some("use a table".to_string()),
            },
            QueryMessage {
                severity: "WARNING".to_string(),
                message: "careful".to_string(),
                code: None,
                detail: None,
                hint: None,
            },
        ];
        assert_eq!(
            format_query_result_as_text(&dml, 50, QueryCellWindow::default()).unwrap(),
            "Query executed. 2 row(s) affected.\n\nServer messages:\n- NOTICE: hello world (code: 00000, hint: use a table)\n- WARNING: careful"
        );

        let mut result = query_result(vec!["id"], vec![vec![serde_json::json!(1)]], 0);
        result.messages = vec![QueryMessage {
            severity: "INFO".to_string(),
            message: "print output".to_string(),
            code: None,
            detail: None,
            hint: None,
        }];
        assert_eq!(
            format_query_result_as_text(&result, 50, QueryCellWindow::default()).unwrap(),
            "| id |\n|---|\n| 1 |\n(1 rows, 1ms)\n\nServer messages:\n- INFO: print output"
        );
    }

    #[test]
    fn sample_data_sql_uses_database_identifier_and_limit_syntax() {
        assert_eq!(
            build_sample_data_sql(&DatabaseType::Mysql, Some("app"), "sys_tenant", 20),
            "SELECT * FROM `app`.`sys_tenant` LIMIT 20;"
        );
        assert_eq!(
            build_sample_data_sql(&DatabaseType::Postgres, Some("public"), "sys_tenant", 20),
            "SELECT * FROM \"public\".\"sys_tenant\" LIMIT 20;"
        );
        assert_eq!(
            build_sample_data_sql(&DatabaseType::SqlServer, Some("dbo"), "sys_tenant", 20),
            "SELECT TOP (20) * FROM [dbo].[sys_tenant]"
        );
        assert_eq!(
            build_sample_data_sql(&DatabaseType::Oracle, Some("APP"), "SYS_TENANT", 20),
            "SELECT * FROM (SELECT * FROM \"APP\".\"SYS_TENANT\") WHERE ROWNUM <= 20"
        );
    }

    #[test]
    fn selected_schema_overrides_the_tool_schema_argument() {
        let call = ToolCall {
            id: "call-1".to_string(),
            name: "list_tables".to_string(),
            arguments: serde_json::json!({ "schema": "OTHER" }),
            provider_payload: None,
        };

        assert_eq!(effective_schema(&call, Some("REPORTING")).as_deref(), Some("REPORTING"));
        assert_eq!(effective_schema(&call, None).as_deref(), Some("OTHER"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dameng_agent_queries_and_confirmed_writes_use_selected_schema() {
        let temp_dir = tempfile::tempdir().unwrap();
        let record_path = temp_dir.path().join("agent-requests.jsonl");
        let (client, _script) = spawn_recording_agent(&record_path).await;
        let storage = Storage::open(&temp_dir.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new(storage));
        let connection = agent_test_connection("dameng-1", "Dameng", DatabaseType::Dameng, "APPDB");
        state.configs.write().await.insert(connection.id.clone(), connection);
        state.connections.write().await.insert("dameng-1:APPDB".to_string(), PoolKind::agent(client));

        let read = ToolCall {
            id: "read".to_string(),
            name: "execute_query".to_string(),
            arguments: json!({ "sql": "SELECT * FROM orders" }),
            provider_payload: None,
        };
        let read_result = execute_tool(
            &read,
            &state,
            "dameng-1",
            "APPDB",
            Some("REPORTING"),
            &DatabaseType::Dameng,
            AgentSqlPermissions::default(),
        )
        .await;
        assert!(!read_result.is_error, "{}", read_result.content);

        let confirmed_sql = "DELETE FROM orders WHERE id = 1";
        let write = ToolCall {
            id: "write".to_string(),
            name: "execute_query".to_string(),
            arguments: json!({ "sql": confirmed_sql }),
            provider_payload: None,
        };
        let write_result = execute_tool(
            &write,
            &state,
            "dameng-1",
            "APPDB",
            Some("REPORTING"),
            &DatabaseType::Dameng,
            confirmed_write_sql_permissions(false, true, Some(confirmed_sql.to_string())),
        )
        .await;
        assert!(!write_result.is_error, "{}", write_result.content);

        let requests = std::fs::read_to_string(&record_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .filter(|request| request["method"] == "execute_query")
            .collect::<Vec<_>>();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["params"]["sql"], "SELECT * FROM orders");
        assert_eq!(requests[1]["params"]["sql"], confirmed_sql);
        for request in requests {
            assert_eq!(request["params"]["database"], "APPDB");
            assert_eq!(request["params"]["schema"], "REPORTING");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mysql_agent_allows_show_triggers_without_write_confirmation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let record_path = temp_dir.path().join("agent-requests.jsonl");
        let (client, _script) = spawn_recording_agent(&record_path).await;
        let storage = Storage::open(&temp_dir.path().join("storage.db")).await.unwrap();
        let state = Arc::new(AppState::new(storage));
        let connection = agent_test_connection("mysql-1", "MySQL", DatabaseType::Mysql, "rs_main");
        state.configs.write().await.insert(connection.id.clone(), connection);
        state.connections.write().await.insert("mysql-1:rs_main".to_string(), PoolKind::agent(client));

        let sql = "SHOW TRIGGERS FROM `rs_main` LIKE 'trg_order_items_after_%';";
        let call = ToolCall {
            id: "show-triggers".to_string(),
            name: "execute_query".to_string(),
            arguments: json!({ "sql": sql }),
            provider_payload: None,
        };
        let result = execute_tool(
            &call,
            &state,
            "mysql-1",
            "rs_main",
            None,
            &DatabaseType::Mysql,
            AgentSqlPermissions::default(),
        )
        .await;

        assert!(!result.is_error, "{}", result.content);
        let request = std::fs::read_to_string(&record_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .find(|request| request["method"] == "execute_query")
            .unwrap();
        assert_eq!(request["params"]["sql"], sql);
    }

    #[test]
    fn build_browse_query_qdrant() {
        let q = build_browse_query(&DatabaseType::Qdrant, "articles", "", "", 10).unwrap();
        assert!(q.starts_with("POST /collections/articles/points/scroll"));
        assert!(q.contains("\"limit\":10"));
        assert!(q.contains("\"with_payload\":true"));
    }

    #[test]
    fn build_browse_query_qdrant_encodes_url_chars() {
        let q = build_browse_query(&DatabaseType::Qdrant, "my collection", "", "", 10).unwrap();
        assert!(q.starts_with("POST /collections/my%20collection/points/scroll"));
    }

    #[test]
    fn build_browse_query_milvus() {
        let q = build_browse_query(&DatabaseType::Milvus, "articles", "custom_db", "", 20).unwrap();
        assert!(q.starts_with("POST /v2/vectordb/entities/query"));
        assert!(q.contains("\"dbName\":\"custom_db\""));
        assert!(q.contains("\"collectionName\":\"articles\""));
        assert!(q.contains("\"limit\":20"));
        assert!(!q.contains("outputFields"));
    }

    #[test]
    fn build_browse_query_milvus_default_db() {
        let q = build_browse_query(&DatabaseType::Milvus, "articles", "", "", 10).unwrap();
        assert!(q.contains("\"dbName\":\"default\""));
    }

    #[test]
    fn build_browse_query_weaviate() {
        let q = build_browse_query(&DatabaseType::Weaviate, "Articles", "", "", 5).unwrap();
        assert_eq!(q, "GET /v1/objects?class=Articles&limit=5");
    }

    #[test]
    fn build_browse_query_weaviate_encodes_query_param() {
        let q = build_browse_query(&DatabaseType::Weaviate, "A&B", "", "", 5).unwrap();
        assert!(q.contains("class=A%26B"));
    }

    #[test]
    fn build_browse_query_chromadb() {
        let q = build_browse_query(&DatabaseType::ChromaDb, "uuid-123", "cloud/db", "tenant /eu", 15).unwrap();
        assert!(q.starts_with("POST /api/v2/tenants/tenant%20%2Feu/databases/cloud%2Fdb/collections/uuid-123/get"));
        assert!(q.contains("\"limit\":15"));
    }

    #[test]
    fn build_browse_query_chromadb_keeps_local_defaults() {
        let q = build_browse_query(&DatabaseType::ChromaDb, "uuid-123", "", "", 15).unwrap();
        assert!(
            q.starts_with("POST /api/v2/tenants/default_tenant/databases/default_database/collections/uuid-123/get")
        );
    }

    #[test]
    fn build_browse_query_rejects_empty_collection() {
        let result = build_browse_query(&DatabaseType::Qdrant, "  ", "", "", 10);
        assert!(result.is_err());
    }

    #[test]
    fn build_browse_query_rejects_unsupported_type() {
        let result = build_browse_query(&DatabaseType::Postgres, "articles", "", "", 10);
        assert!(result.is_err());
    }

    // ── SQL confirmation binding tests ──────────────────────────────────────

    #[test]
    fn normalize_sql_only_trims_outer_whitespace() {
        assert_eq!(normalize_sql_for_confirmation("  CREATE TABLE users (id INT);\n"), "CREATE TABLE users (id INT);");
    }

    #[test]
    fn confirmed_sql_binding_rejects_quoted_identifier_case_change() {
        let confirmed = Some("DROP TABLE \"Users\"".to_string());
        assert!(!sql_matches_confirmed_write("DROP TABLE \"users\"", &confirmed));
    }

    #[test]
    fn confirmed_sql_binding_rejects_keyword_case_or_reformatting() {
        let confirmed = Some("DELETE FROM AuditLog WHERE id = 1".to_string());
        assert!(!sql_matches_confirmed_write("delete from AuditLog where id = 1", &confirmed));
        assert!(!sql_matches_confirmed_write("DELETE FROM AuditLog\nWHERE id = 1", &confirmed));
    }

    #[test]
    fn confirmed_sql_binding_rejects_line_comment_newline_change() {
        let confirmed = Some("DELETE FROM users -- only one record\nWHERE id = 1".to_string());
        assert!(!sql_matches_confirmed_write("DELETE FROM users -- only one record WHERE id = 1", &confirmed));
    }

    #[test]
    fn sql_matches_when_no_confirmation_required() {
        assert!(sql_matches_confirmed_write("DELETE FROM users WHERE id = 1", &None));
    }

    #[test]
    fn sql_matches_when_only_outer_whitespace_differs() {
        // The confirmed statement itself must be unchanged; only surrounding
        // whitespace is ignored before comparison.
        let confirmed = Some("CREATE TABLE users (id INT)".to_string());
        assert!(sql_matches_confirmed_write("  CREATE TABLE users (id INT)  ", &confirmed,));
    }

    #[test]
    fn sql_mismatch_rejected_when_executed_differs_from_confirmed() {
        let confirmed = Some("CREATE TABLE users (id INT)".to_string());
        assert!(!sql_matches_confirmed_write("DROP TABLE users", &confirmed,));
    }

    #[test]
    fn confirmed_sql_binding_rejects_same_table_different_statement() {
        let confirmed = Some("INSERT INTO users (id, name) VALUES (1, 'test')".to_string());
        assert!(!sql_matches_confirmed_write("DELETE FROM users WHERE id = 1", &confirmed,));
    }

    #[test]
    fn confirmed_sql_binding_rejects_different_case_in_data_values() {
        // Confirmed VALUES ('Alice') must NOT match executed VALUES ('alice').
        // String-literal data values are preserved verbatim.
        let confirmed = Some("INSERT INTO users (name) VALUES ('Alice')".to_string());
        assert!(!sql_matches_confirmed_write("INSERT INTO users (name) VALUES ('alice')", &confirmed,));
    }

    #[test]
    fn confirmed_sql_binding_rejects_different_whitespace_in_data_values() {
        // Confirmed VALUES ('a b') must NOT match executed VALUES ('a  b').
        let confirmed = Some("INSERT INTO t (c) VALUES ('a b')".to_string());
        assert!(!sql_matches_confirmed_write("INSERT INTO t (c) VALUES ('a  b')", &confirmed,));
    }

    #[test]
    fn confirmed_sql_default_is_none() {
        let perms = AgentSqlPermissions::default();
        assert_eq!(perms.confirmed_write_sql, None);
    }

    #[test]
    fn confirmed_write_sql_diagnostics_redact_sensitive_literals() {
        let confirmed_sql = "CREATE USER app_user WITH PASSWORD 'secret-123'";
        let diagnostic = crate::sql_diagnostics::redact_sql_for_diagnostics(confirmed_sql);

        assert!(!diagnostic.contains("secret-123"));
        assert!(diagnostic.contains("'[REDACTED]'"));
    }

    #[test]
    fn confirmed_write_permissions_bind_only_a_nonproduction_nonempty_confirmation() {
        let confirmed_sql = Some("DELETE FROM sessions WHERE id = 7".to_string());
        let permissions = confirmed_write_sql_permissions(false, true, confirmed_sql.clone());

        assert!(permissions.allow_writes);
        assert!(permissions.allow_dangerous);
        assert_eq!(permissions.confirmed_write_sql, confirmed_sql);
        assert!(!sql_matches_confirmed_write("DROP TABLE sessions", &permissions.confirmed_write_sql));
    }

    #[test]
    fn confirmed_write_permissions_fail_closed_for_production_or_empty_confirmation() {
        for (production_database, confirmed_write_sql) in
            [(true, Some("DELETE FROM sessions".to_string())), (false, None), (false, Some("  \n".to_string()))]
        {
            let permissions = confirmed_write_sql_permissions(production_database, true, confirmed_write_sql);
            assert!(!permissions.allow_writes);
            assert!(!permissions.allow_dangerous);
            assert_eq!(permissions.confirmed_write_sql, None);
        }
    }

    #[test]
    fn confirmed_write_target_binding_rejects_replay_to_another_scope() {
        let confirmed_sql = Some("DELETE FROM sessions WHERE id = 7".to_string());
        let matching = verify_confirmed_target(
            Some(true),
            confirmed_sql.clone(),
            Some("connection-1".to_string()),
            Some("app".to_string()),
            Some("public".to_string()),
            "connection-1",
            "app",
            Some("public"),
        );
        assert_eq!(matching, (Some(true), confirmed_sql.clone()));

        for (connection_id, database, schema) in [
            ("connection-2", "app", Some("public")),
            ("connection-1", "audit", Some("public")),
            ("connection-1", "app", Some("private")),
        ] {
            let rejected = verify_confirmed_target(
                Some(true),
                confirmed_sql.clone(),
                Some("connection-1".to_string()),
                Some("app".to_string()),
                Some("public".to_string()),
                connection_id,
                database,
                schema,
            );
            assert_eq!(rejected, (Some(false), None));
        }
    }

    #[test]
    fn confirmed_sql_preserved_through_permission_construction() {
        let perms = AgentSqlPermissions {
            allow_writes: true,
            allow_dangerous: true,
            confirmed_write_sql: Some("CREATE TABLE t (c INT)".to_string()),
        };
        assert_eq!(perms.confirmed_write_sql.as_deref(), Some("CREATE TABLE t (c INT)"));
    }

    #[test]
    fn write_allowed_when_confirmed_sql_is_none_and_writes_enabled() {
        // confirmed_write_sql=None + allow_writes=true: write SQL is allowed
        // (the check passes because sql_matches_confirmed_write returns true
        // when no confirmation is required). This documents the current
        // contract — the frontend is responsible for only sending
        // allow_write_sql=true when a specific SQL was confirmed.
        assert!(sql_matches_confirmed_write("INSERT INTO t VALUES (1)", &None));
    }

    // ── get_current_time tests ────────────────────────────────────────────

    #[test]
    fn get_current_time_is_in_all_tools_postgres() {
        let tools = all_tools(DatabaseType::Postgres, AgentSqlPermissions::default());
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();
        assert!(names.contains(&"get_current_time"), "get_current_time missing from all_tools(Postgres)");
    }

    #[test]
    fn get_current_time_is_in_read_only_tools_postgres() {
        let tools = read_only_tools(DatabaseType::Postgres);
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();
        assert!(names.contains(&"get_current_time"), "get_current_time missing from read_only_tools(Postgres)");
    }

    #[test]
    fn get_current_time_is_in_all_tools_qdrant() {
        let tools = all_tools(DatabaseType::Qdrant, AgentSqlPermissions::default());
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();
        assert!(names.contains(&"get_current_time"), "get_current_time missing from all_tools(Qdrant)");
    }

    #[test]
    fn get_current_time_is_in_read_only_tools_qdrant() {
        let tools = read_only_tools(DatabaseType::Qdrant);
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();
        assert!(names.contains(&"get_current_time"), "get_current_time missing from read_only_tools(Qdrant)");
    }

    #[test]
    fn get_current_time_tool_is_read_only_and_parallel_ok() {
        let tool = get_current_time_tool();
        assert!(tool.read_only, "get_current_time must be read_only");
        assert!(tool.parallel_ok, "get_current_time must be parallel_ok");
    }

    #[test]
    fn execute_get_current_time_returns_valid_timestamps() {
        let before_secs = chrono::Utc::now().timestamp();
        let tool_call = ToolCall {
            id: "call-gct".to_string(),
            name: "get_current_time".to_string(),
            arguments: serde_json::json!({ "utc_offset_minutes": 480, "timezone": "Asia/Shanghai" }),
            provider_payload: None,
        };
        let result = execute_get_current_time(&tool_call).expect("get_current_time should succeed");
        let after_secs = chrono::Utc::now().timestamp();

        let parsed: serde_json::Value =
            serde_json::from_str(&result).expect("get_current_time result should be valid JSON");

        let utc_str = parsed["utc"].as_str().expect("utc field should be a string");
        let local_str = parsed["local"].as_str().expect("local field should be a string");

        // Parse as RFC3339 timestamps.
        let _utc_dt = chrono::DateTime::parse_from_rfc3339(utc_str).expect("utc should be valid RFC3339");
        let local_dt = chrono::DateTime::parse_from_rfc3339(local_str).expect("local should be valid RFC3339");

        // Verify UTC is within tolerance.
        let utc_dt_utc = chrono::DateTime::parse_from_rfc3339(utc_str)
            .expect("utc should parse as rfc3339")
            .with_timezone(&chrono::Utc);
        let utc_ts = utc_dt_utc.timestamp();
        assert!(
            utc_ts >= before_secs && utc_ts <= after_secs + 1,
            "UTC timestamp {utc_ts} should be within [{before_secs}, {after_secs}+1]"
        );

        // Verify local is within tolerance (converted to UTC).
        let local_ts = local_dt.with_timezone(&chrono::Utc).timestamp();
        assert!(
            local_ts >= before_secs && local_ts <= after_secs + 1,
            "Local timestamp {local_ts} (UTC) should be within [{before_secs}, {after_secs}+1]"
        );

        // utc_offset_minutes should match the offset in local.
        let offset_minutes =
            parsed["utc_offset_minutes"].as_i64().expect("utc_offset_minutes should be an integer") as i32;
        let local_offset_secs = local_dt.offset().local_minus_utc();
        // The offset from the RFC3339 timestamp should match utc_offset_minutes * 60.
        assert_eq!(
            local_offset_secs / 60,
            offset_minutes,
            "utc_offset_minutes {offset_minutes} does not match local offset {}",
            local_offset_secs / 60
        );
        assert_eq!(offset_minutes, 480);
        assert_eq!(parsed["timezone"], "Asia/Shanghai");

        // readable should be a non-empty string.
        let readable = parsed["readable"].as_str().expect("readable field should be a string");
        assert!(!readable.is_empty(), "readable should not be empty");
    }

    #[test]
    fn execute_get_current_time_defaults_to_utc_without_client_context() {
        let tool_call = ToolCall {
            id: "call-gct".to_string(),
            name: "get_current_time".to_string(),
            arguments: serde_json::json!({}),
            provider_payload: None,
        };
        let result = execute_get_current_time(&tool_call).expect("get_current_time should succeed");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["utc_offset_minutes"], 0);
        assert_eq!(parsed["timezone"], "UTC");
        assert!(parsed["local"].as_str().unwrap().ends_with("+00:00"));
    }

    #[test]
    fn execute_get_current_time_labels_offset_when_timezone_name_is_missing() {
        let tool_call = ToolCall {
            id: "call-gct".to_string(),
            name: "get_current_time".to_string(),
            arguments: serde_json::json!({ "utc_offset_minutes": -300 }),
            provider_payload: None,
        };
        let result = execute_get_current_time(&tool_call).expect("get_current_time should succeed");
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();

        assert_eq!(parsed["timezone"], "UTC-05:00");
        assert!(parsed["local"].as_str().unwrap().ends_with("-05:00"));
    }

    #[test]
    fn execute_tool_get_current_time_is_not_error() {
        // Test via execute_tool dispatch. All args can be dummy since the tool
        // does not use any of them.
        let temp_dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let storage = crate::storage::Storage::open(&temp_dir.path().join("storage.db")).await.unwrap();
            let state = std::sync::Arc::new(crate::connection::AppState::new(storage));
            let tool_call = ToolCall {
                id: "call-gct".to_string(),
                name: "get_current_time".to_string(),
                arguments: serde_json::json!({}),
                provider_payload: None,
            };
            let result = execute_tool(
                &tool_call,
                &state,
                "dummy",
                "dummy",
                None,
                &DatabaseType::Postgres,
                AgentSqlPermissions::default(),
            )
            .await;
            assert!(!result.is_error, "execute_tool get_current_time should not error: {}", result.content);
            let parsed: serde_json::Value = serde_json::from_str(&result.content).expect("result should be valid JSON");
            assert!(parsed["utc"].is_string());
            assert!(parsed["local"].is_string());
            assert!(parsed["readable"].is_string());
        });
    }
}
