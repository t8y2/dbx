use std::sync::Arc;

use serde_json::json;

use crate::agent_events::{ToolCall, ToolDefinition, ToolResult};
use crate::connection::AppState;
use crate::db::vector_driver;
use crate::models::connection::DatabaseType;
use crate::query::QueryExecutionOptions;
use crate::query_execution_sql::{build_explain_sql, supports_explain_plan, supports_sql_query, ExplainSqlOptions};
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentSqlPermissions {
    pub allow_writes: bool,
    pub allow_dangerous: bool,
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

/// Execute a read-only SQL query via the execute_query tool.
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

    // Classify SQL risk using sqlparser AST
    let db_type_str = format!("{:?}", db_type).to_lowercase();
    let risk = crate::sql_risk::classify_sql_risk(sql, &db_type_str)?;
    if !sql_risk_allowed(risk, sql_permissions) {
        if risk == SqlRisk::Transaction {
            return Err("Blocked: transaction control statements are not available to the AI agent.".to_string());
        }
        return Err(format!(
            "Blocked: {} statement detected. Ask the user to confirm the proposed database change before executing it.",
            risk
        ));
    }

    // Execute query using existing infrastructure
    let options = QueryExecutionOptions { max_rows: Some(limit), timeout_secs: Some(30), ..Default::default() };
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

    let schema = tool_call.arguments.get("schema").and_then(|v| v.as_str());
    let limit = tool_call
        .arguments
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|l| (l as usize).min(MAX_ALLOWED_ROWS))
        .unwrap_or(SAMPLE_DATA_LIMIT);

    // Build SELECT * FROM table LIMIT N
    let schema_prefix = schema.filter(|s| !s.is_empty()).map(|s| format!("\"{}\".", s)).unwrap_or_default();
    let sql = format!("SELECT * FROM {}\"{}\" LIMIT {}", schema_prefix, table, limit);

    // Delegate to execute_execute_query with a synthetic tool call
    let synthetic_call = ToolCall {
        id: tool_call.id.clone(),
        name: "execute_query".to_string(),
        arguments: serde_json::json!({ "sql": sql, "limit": limit }),
    };
    execute_execute_query(&synthetic_call, state, connection_id, database, db_type, AgentSqlPermissions::default())
        .await
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
    let db_type_str = format!("{:?}", db_type).to_lowercase();
    let risk = match crate::sql_risk::classify_sql_risk(sql, &db_type_str) {
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
    let explain_result = build_explain_sql(ExplainSqlOptions { database_type: Some(*db_type), sql: sql.to_string() });

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
        let tools = all_tools(DatabaseType::Mysql, AgentSqlPermissions { allow_writes: true, allow_dangerous: true });
        let execute_query = tools.iter().find(|tool| tool.name == "execute_query").unwrap();

        assert!(execute_query.description.contains("explicitly confirmed"));
        assert!(execute_query.description.contains("DDL"));
    }

    #[test]
    fn sql_permissions_keep_writes_blocked_until_confirmation() {
        assert!(!sql_risk_allowed(SqlRisk::Write, AgentSqlPermissions::default()));
        assert!(!sql_risk_allowed(SqlRisk::Ddl, AgentSqlPermissions::default()));
        assert!(sql_risk_allowed(SqlRisk::Ddl, AgentSqlPermissions { allow_writes: true, allow_dangerous: true }));
        assert!(!sql_risk_allowed(
            SqlRisk::Transaction,
            AgentSqlPermissions { allow_writes: true, allow_dangerous: true }
        ));
    }

    #[test]
    fn oracle_agent_tools_include_explain_query() {
        let tools = all_tools(DatabaseType::Oracle, AgentSqlPermissions::default());
        let names: Vec<&str> = tools.iter().map(|tool| tool.name).collect();

        assert!(names.contains(&"explain_query"));
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
}
