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
use crate::types::QueryResult;

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
    actual_connection_id: &str,
    actual_database: &str,
) -> (Option<bool>, Option<String>) {
    let Some(ref confirmed_sql) = confirmed_write_sql else {
        return (allow_write_sql, confirmed_write_sql);
    };
    // Only verify when a write SQL was actually confirmed.
    let target_mismatch = confirmed_connection_id.as_deref() != Some(actual_connection_id)
        || confirmed_database.as_deref() != Some(actual_database);
    if target_mismatch {
        log::warn!(
            "Write-SQL grant voided: confirmed target (conn={:?}, db={:?}) does not match actual (conn={}, db={}).",
            confirmed_connection_id,
            confirmed_database,
            actual_connection_id,
            actual_database,
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

/// Get read-only tool definitions for the given database type.
/// Returns vector tools for vector DBs, SQL tools otherwise.
pub fn read_only_tools(db_type: DatabaseType) -> Vec<ToolDefinition> {
    if is_vector_db(db_type) {
        vec![list_collections_tool()]
    } else {
        vec![list_tables_tool(), get_columns_tool()]
    }
}

/// Get all available tool definitions for the given database type.
/// Includes read-only tools plus execute_query, get_sample_data, and
/// explain_query for database types that support them.
pub fn all_tools(db_type: DatabaseType, sql_permissions: AgentSqlPermissions) -> Vec<ToolDefinition> {
    if is_vector_db(db_type) {
        return vec![list_collections_tool(), browse_collection_tool()];
    }
    let mut tools = vec![list_tables_tool(), get_columns_tool()];
    if supports_sql_query(db_type) {
        tools.push(execute_query_tool(sql_permissions));
        tools.push(get_sample_data_tool());
    }
    if supports_explain_plan(Some(db_type)) {
        tools.push(explain_query_tool());
    }
    tools
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
    db_type: &DatabaseType,
    sql_permissions: AgentSqlPermissions,
) -> ToolResult {
    let result = match tool_call.name.as_str() {
        "list_tables" => execute_list_tables(tool_call, state, connection_id, database, db_type).await,
        "get_columns" => execute_get_columns(tool_call, state, connection_id, database, db_type).await,
        "execute_query" => {
            execute_execute_query(tool_call, state, connection_id, database, db_type, sql_permissions).await
        }
        "get_sample_data" => execute_get_sample_data(tool_call, state, connection_id, database, db_type).await,
        "list_collections" => execute_list_collections(tool_call, state, connection_id, database, db_type).await,
        "browse_collection" => execute_browse_collection(tool_call, state, connection_id, database, db_type).await,
        "explain_query" => {
            let (text_result, explain_data) =
                execute_explain_query(tool_call, state, connection_id, database, db_type).await;
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
    _db_type: &DatabaseType,
) -> Result<String, String> {
    let schema = tool_call.arguments.get("schema").and_then(|v| v.as_str()).unwrap_or("").to_string();

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

    let schema = tool_call.arguments.get("schema").and_then(|v| v.as_str()).unwrap_or("").to_string();

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
    let result =
        crate::query::execute_sql_statement_with_options(state, connection_id, database, sql, None, None, options)
            .await?;

    format_query_result_as_text(&result, limit)
}

/// Format a QueryResult as a Markdown table for LLM consumption.
fn format_query_result_as_text(result: &QueryResult, limit: usize) -> Result<String, String> {
    if result.rows.is_empty() {
        return Ok("Query returned 0 rows.".to_string());
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
                serde_json::Value::String(s) => {
                    // Truncate long strings to keep result compact
                    if s.len() > 200 {
                        let truncated: String =
                            s.char_indices().take_while(|(i, _)| *i < 200).map(|(_, c)| c).collect();
                        format!("{}...", truncated)
                    } else {
                        s.clone()
                    }
                }
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

    Ok(lines.join("\n"))
}

/// Get sample data from a table via the get_sample_data tool.
async fn execute_get_sample_data(
    tool_call: &ToolCall,
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
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

    let schema = tool_call.arguments.get("schema").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty());
    let limit = tool_call
        .arguments
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|l| (l as usize).min(MAX_ALLOWED_ROWS))
        .unwrap_or(SAMPLE_DATA_LIMIT);

    // Reuse the table-data builder so identifier quoting and row limiting follow
    // the active database instead of assuming PostgreSQL syntax.
    let sql = build_sample_data_sql(db_type, schema, table, limit);

    // Delegate to execute_execute_query with a synthetic tool call
    let synthetic_call = ToolCall {
        id: tool_call.id.clone(),
        name: "execute_query".to_string(),
        arguments: serde_json::json!({ "sql": sql, "limit": limit }),
        provider_payload: None,
    };
    execute_execute_query(&synthetic_call, state, connection_id, database, db_type, AgentSqlPermissions::default())
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
            None,
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
    let explain_result =
        build_explain_sql(ExplainSqlOptions { database_type: Some(*db_type), format: None, sql: sql.to_string() });

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
        None,
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
    let text = match format_query_result_as_text(&result, 100) {
        Ok(t) => t,
        Err(e) => return (Err(e), None),
    };

    (Ok(text), explain_data)
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

    let query = build_browse_query(db_type, &collection_id, database, limit)?;

    let options = QueryExecutionOptions { max_rows: Some(limit), timeout_secs: Some(30), ..Default::default() };
    let result =
        crate::query::execute_sql_statement_with_options(state, connection_id, database, &query, None, None, options)
            .await?;

    format_query_result_as_text(&result, limit)
}

/// Build a browse query for the given vector database type.
/// Intentionally omits offset/pagination — Agent browse only fetches the first N items.
fn build_browse_query(
    db_type: &DatabaseType,
    collection: &str,
    database: &str,
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
        // TODO: ChromaDB Cloud 支持自定义租户和数据库，当前只实现了本地部署
        // （固定 default_tenant / default_database），后续支持云服务时需改为可配置。
        DatabaseType::ChromaDb => Ok(format!(
            "POST /api/v2/tenants/default_tenant/databases/default_database/collections/{}/get\n{}",
            collection,
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

    #[test]
    fn vector_read_only_tools_do_not_include_collection_browsing() {
        let tools = read_only_tools(DatabaseType::Qdrant);
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();

        assert_eq!(names, vec!["list_collections"]);
    }

    #[test]
    fn vector_agent_tools_include_collection_browsing() {
        let tools = all_tools(DatabaseType::Qdrant, AgentSqlPermissions::default());
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();

        assert_eq!(names, vec!["list_collections", "browse_collection"]);
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
    fn build_browse_query_qdrant() {
        let q = build_browse_query(&DatabaseType::Qdrant, "articles", "", 10).unwrap();
        assert!(q.starts_with("POST /collections/articles/points/scroll"));
        assert!(q.contains("\"limit\":10"));
        assert!(q.contains("\"with_payload\":true"));
    }

    #[test]
    fn build_browse_query_qdrant_encodes_url_chars() {
        let q = build_browse_query(&DatabaseType::Qdrant, "my collection", "", 10).unwrap();
        assert!(q.starts_with("POST /collections/my%20collection/points/scroll"));
    }

    #[test]
    fn build_browse_query_milvus() {
        let q = build_browse_query(&DatabaseType::Milvus, "articles", "custom_db", 20).unwrap();
        assert!(q.starts_with("POST /v2/vectordb/entities/query"));
        assert!(q.contains("\"dbName\":\"custom_db\""));
        assert!(q.contains("\"collectionName\":\"articles\""));
        assert!(q.contains("\"limit\":20"));
        assert!(!q.contains("outputFields"));
    }

    #[test]
    fn build_browse_query_milvus_default_db() {
        let q = build_browse_query(&DatabaseType::Milvus, "articles", "", 10).unwrap();
        assert!(q.contains("\"dbName\":\"default\""));
    }

    #[test]
    fn build_browse_query_weaviate() {
        let q = build_browse_query(&DatabaseType::Weaviate, "Articles", "", 5).unwrap();
        assert_eq!(q, "GET /v1/objects?class=Articles&limit=5");
    }

    #[test]
    fn build_browse_query_weaviate_encodes_query_param() {
        let q = build_browse_query(&DatabaseType::Weaviate, "A&B", "", 5).unwrap();
        assert!(q.contains("class=A%26B"));
    }

    #[test]
    fn build_browse_query_chromadb() {
        let q = build_browse_query(&DatabaseType::ChromaDb, "uuid-123", "", 15).unwrap();
        assert!(
            q.starts_with("POST /api/v2/tenants/default_tenant/databases/default_database/collections/uuid-123/get")
        );
        assert!(q.contains("\"limit\":15"));
    }

    #[test]
    fn build_browse_query_rejects_empty_collection() {
        let result = build_browse_query(&DatabaseType::Qdrant, "  ", "", 10);
        assert!(result.is_err());
    }

    #[test]
    fn build_browse_query_rejects_unsupported_type() {
        let result = build_browse_query(&DatabaseType::Postgres, "articles", "", 10);
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
}
