use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use crate::connection::AppState;
use crate::data_view_params::{substitute, DataViewParamValue, SubstituteDialect};
use crate::models::connection::DatabaseType;
use crate::query_cancel::RunningTaskMetadata;

fn default_display_mode() -> String {
    "table".to_string()
}

fn default_variable_kind() -> String {
    "string".to_string()
}

fn default_input_type() -> String {
    "text".to_string()
}

fn default_query_kind() -> String {
    "query".to_string()
}

/// A shared variable exposed to the data-view runner. Every sub-query in the
/// view resolves its `${name}` placeholders from this view-level set, so the
/// viewer only fills in one input per variable regardless of how many
/// sub-queries reference it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataViewVariable {
    pub name: String,
    #[serde(default)]
    pub label: String,
    /// One of `string` | `number` | `boolean` | `date`. Drives safe literal
    /// quoting during server-side substitution.
    #[serde(default = "default_variable_kind")]
    pub kind: String,
    /// `text` | `select`.
    #[serde(default = "default_input_type")]
    pub input_type: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default_value: Option<String>,
}

/// A saved query's position and size in the Runner's 12-column dashboard grid.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct DataViewGridPos {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// One saved query inside a data view. Each sub-query carries its own
/// connection so a single view can span multiple data sources.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataViewQuery {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub connection_id: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub catalog: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    /// SQL with `${name}` placeholders resolved from the view's variables.
    pub sql_template: String,
    /// `query` (read, default) or `mutation` (write: INSERT/UPDATE/DELETE).
    #[serde(default = "default_query_kind")]
    pub kind: String,
    /// Per-query override of the view's default display mode.
    #[serde(default)]
    pub display_mode: Option<String>,
    #[serde(default)]
    pub chart_config: Option<serde_json::Value>,
    #[serde(default)]
    pub order_index: i64,
    /// Runner dashboard-grid placement; absent until the user first edits the layout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid_pos: Option<DataViewGridPos>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataView {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "default_display_mode")]
    pub default_display_mode: String,
    #[serde(default)]
    pub queries: Vec<DataViewQuery>,
    #[serde(default)]
    pub variables: Vec<DataViewVariable>,
    /// Reserved for future ownership/permission enforcement; unused today.
    #[serde(default)]
    pub owner_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Lightweight row for the data-view list page. Omits `queries`/`variables`
/// so the listing stays cheap.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataViewSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub default_display_mode: String,
    pub query_count: i64,
    #[serde(default)]
    pub owner_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Result of running one sub-query. Errors are isolated per query so one
/// failing sub-query never aborts the rest of the view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataViewQueryResult {
    pub query_id: String,
    pub title: String,
    pub display_mode: String,
    pub result: Option<crate::db::QueryResult>,
    /// Raw Redis command result (see `redis_ops::redis_execute_command_core`), returned instead of
    /// `result` for Redis queries — the frontend already owns the value→table conversion heuristics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redis_value: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteDataViewResponse {
    pub results: Vec<DataViewQueryResult>,
}

#[derive(Debug, Clone, Default)]
pub struct DataViewExecuteOptions {
    pub max_rows: Option<usize>,
    pub timeout_secs: Option<u64>,
    pub client_session_id: Option<String>,
    /// When set, only sub-queries with these ids run. Used to run reads and
    /// writes independently (mutations execute one at a time on demand).
    pub query_ids: Option<Vec<String>>,
    /// When false, any query with `kind == "mutation"` is rejected. Callers
    /// that have obtained explicit user confirmation (the Runner's destructive-
    /// operation dialog, or the Editor's mutation-preview dialog) must set this
    /// to true. This prevents the Editor's unconditional `previewQuery` path
    /// from executing writes without confirmation.
    pub allow_mutations: bool,
}

fn is_redis_write_command(command_text: &str) -> bool {
    let trimmed = command_text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let argv = match crate::db::redis_driver::parse_command_argv(trimmed) {
        Ok(argv) => argv,
        Err(_) => {
            // Fallback to the first whitespace-delimited token when the command
            // cannot be parsed (e.g. an incomplete quote left by substitution).
            let first = trimmed.split_whitespace().next().unwrap_or("").to_string();
            vec![first]
        }
    };
    let Some(cmd) = argv.first().map(|s| s.as_str()).filter(|s| !s.is_empty()) else {
        return false;
    };
    !matches!(crate::db::redis_driver::classify_command(cmd), crate::db::redis_driver::RedisCommandSafety::Allowed)
}

fn is_write_sql_for_view(sql: &str, db_type: Option<DatabaseType>) -> bool {
    match db_type {
        Some(db_type) => crate::query_execution_sql::is_write_sql_for_database(sql, db_type),
        None => crate::query_execution_sql::is_write_sql(sql),
    }
}

#[allow(dead_code)]
pub(crate) fn data_view_gate_error(
    sql: &str,
    db_type: Option<DatabaseType>,
    is_redis: bool,
    kind: &str,
    allow_mutations: bool,
) -> Option<String> {
    let is_mutation_kind = kind == "mutation";
    let is_write = if is_redis { is_redis_write_command(sql) } else { is_write_sql_for_view(sql, db_type) };
    if is_write && !is_mutation_kind {
        return Some(format!(
            "Write operation requires mutation kind: query is declared as \"query\" but the SQL contains a write. Mark it as \"mutation\" and confirm before running."
        ));
    }
    if is_mutation_kind && !allow_mutations {
        return Some(
            "Mutation requires explicit confirmation. Confirm the destructive operation before execution.".to_string(),
        );
    }
    None
}

/// Runs every sub-query in `view` after substituting `values` into each
/// `${name}` placeholder. Shared by the web and desktop backends.
pub async fn execute_data_view(
    state: &AppState,
    view: &DataView,
    values: &HashMap<String, DataViewParamValue>,
    opts: &DataViewExecuteOptions,
) -> ExecuteDataViewResponse {
    let mut queries = view.queries.clone();
    queries.sort_by_key(|q| q.order_index);
    if let Some(ids) = &opts.query_ids {
        queries.retain(|q| ids.contains(&q.id));
    }

    let mut results = Vec::with_capacity(queries.len());
    for query in queries {
        let display_mode = query.display_mode.clone().unwrap_or_else(|| view.default_display_mode.clone());
        let config = state.configs.read().await.get(&query.connection_id).cloned();
        let db_type = config.as_ref().map(|c| c.db_type);
        let is_redis = matches!(db_type, Some(DatabaseType::Redis));
        let dialect = if is_redis { SubstituteDialect::Redis } else { SubstituteDialect::Sql };
        let sql = match substitute(&query.sql_template, &view.variables, values, dialect) {
            Ok(sql) => sql,
            Err(err) => {
                results.push(DataViewQueryResult {
                    query_id: query.id.clone(),
                    title: query.title.clone(),
                    display_mode,
                    result: None,
                    redis_value: None,
                    error: Some(err.to_string()),
                });
                continue;
            }
        };

        // ---- Execution-boundary write semantics ----
        // 1) A write statement must be declared as `kind == "mutation"`. This
        //    catches the "把写 SQL 误标为 query" case where the normal Run
        //    button would otherwise execute it unconditionally.
        // 2) Any `mutation` query requires explicit opt-in via `allow_mutations`.
        //    This blocks the Editor's unconditional Preview path from running
        //    mutations without going through a destructive-operation confirmation.
        let is_mutation_kind = query.kind == "mutation";
        let is_write = if is_redis { is_redis_write_command(&sql) } else { is_write_sql_for_view(&sql, db_type) };
        if is_write && !is_mutation_kind {
            results.push(DataViewQueryResult {
                query_id: query.id.clone(),
                title: query.title.clone(),
                display_mode,
                result: None,
                redis_value: None,
                error: Some(format!(
                    "Write operation requires mutation kind: query \"{}\" is declared as \"query\" but the SQL contains a write. Mark it as \"mutation\" and confirm before running.",
                    query.title
                )),
            });
            continue;
        }
        if is_mutation_kind && !opts.allow_mutations {
            results.push(DataViewQueryResult {
                query_id: query.id.clone(),
                title: query.title.clone(),
                display_mode,
                result: None,
                redis_value: None,
                error: Some(format!(
                    "Mutation \"{}\" requires explicit confirmation. Confirm the destructive operation before execution.",
                    query.title
                )),
            });
            continue;
        }

        if is_redis {
            let db = query.database.trim().parse::<u32>().unwrap_or(0);
            // Redis commands are near-instant and `redis_execute_command_core` has no
            // cancellation hook, so this branch skips the running-task registration below.
            match crate::redis_ops::redis_execute_command_core(state, &query.connection_id, db, &sql, false).await {
                Ok(result) => results.push(DataViewQueryResult {
                    query_id: query.id.clone(),
                    title: query.title.clone(),
                    display_mode,
                    result: None,
                    redis_value: Some(result.value),
                    error: None,
                }),
                Err(error) => results.push(DataViewQueryResult {
                    query_id: query.id.clone(),
                    title: query.title.clone(),
                    display_mode,
                    result: None,
                    redis_value: None,
                    error: Some(error),
                }),
            }
            continue;
        }

        let execution_id = uuid::Uuid::new_v4().to_string();
        let registered = state.running_queries.register_task(
            execution_id.clone(),
            RunningTaskMetadata::query(
                query.connection_id.clone(),
                query.database.clone(),
                opts.client_session_id.clone(),
            ),
        );
        let cancel_token = registered.token();

        let outcome = crate::query::execute_sql_statement_with_options_typed(
            state,
            &query.connection_id,
            &query.database,
            &sql,
            query.schema.as_deref(),
            Some(cancel_token),
            crate::query::QueryExecutionOptions {
                max_rows: opts.max_rows,
                catalog: query.catalog.clone(),
                client_session_id: opts.client_session_id.clone(),
                timeout_secs: opts.timeout_secs,
                execution_id: Some(execution_id),
                ..Default::default()
            },
        )
        .await;

        registered.finish(&outcome);

        match outcome {
            Ok(result) => results.push(DataViewQueryResult {
                query_id: query.id.clone(),
                title: query.title.clone(),
                display_mode,
                result: Some(result),
                redis_value: None,
                error: None,
            }),
            Err(error) => results.push(DataViewQueryResult {
                query_id: query.id.clone(),
                title: query.title.clone(),
                display_mode,
                result: None,
                redis_value: None,
                error: Some(error.into_legacy_string()),
            }),
        }
    }

    ExecuteDataViewResponse { results }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::redis_driver::{classify_command, RedisCommandSafety};
    use crate::models::connection::DatabaseType;

    #[test]
    fn is_redis_write_command_classifies_correctly() {
        assert!(!is_redis_write_command("GET mykey"));
        assert!(!is_redis_write_command("get mykey"));
        assert!(!is_redis_write_command("MGET a b"));
        assert!(!is_redis_write_command("SCAN 0 MATCH *"));
        assert!(is_redis_write_command("SET mykey value"));
        assert!(is_redis_write_command("set mykey value"));
        assert!(is_redis_write_command("DEL mykey"));
        assert!(is_redis_write_command("del mykey"));
        assert!(is_redis_write_command("HSET myhash field value"));
        assert!(is_redis_write_command("FLUSHDB"));
        assert!(is_redis_write_command("EVAL \"return 1\" 0"));
        assert!(is_redis_write_command("UNKNOWNCOMMAND foo"));
        // Quoted form produced by substitute (Redis dialect)
        assert!(!is_redis_write_command("GET \"my key\""));
        assert!(is_redis_write_command("SET \"my key\" \"my value\""));
    }

    #[test]
    fn is_write_sql_for_view_detects_writes_per_dialect() {
        assert!(!is_write_sql_for_view("SELECT * FROM users", Some(DatabaseType::Mysql)));
        assert!(!is_write_sql_for_view("SELECT * FROM users", None));
        assert!(is_write_sql_for_view("INSERT INTO users VALUES (1)", Some(DatabaseType::Mysql)));
        assert!(is_write_sql_for_view("INSERT INTO users VALUES (1)", None));
        assert!(is_write_sql_for_view("UPDATE users SET name = 'x'", Some(DatabaseType::Postgres)));
        assert!(is_write_sql_for_view("DELETE FROM users", Some(DatabaseType::Sqlite)));
        // MySQL executable comment is only a write for MySQL
        let exec = "SELECT 1 /*! INTO OUTFILE '/tmp/probe' */";
        assert!(is_write_sql_for_view(exec, Some(DatabaseType::Mysql)));
        assert!(!is_write_sql_for_view(exec, Some(DatabaseType::Postgres)));
        // Postgres SELECT INTO table creation
        assert!(is_write_sql_for_view("SELECT * INTO new_table FROM old_table", Some(DatabaseType::Postgres)));
        assert!(!is_write_sql_for_view("SELECT * INTO new_table FROM old_table", Some(DatabaseType::Sqlite)));
    }

    #[test]
    fn redis_classify_matches_helper() {
        assert_eq!(classify_command("GET"), RedisCommandSafety::Allowed);
        assert_eq!(classify_command("SET"), RedisCommandSafety::Write);
        assert_eq!(classify_command("DEL"), RedisCommandSafety::Confirm);
        assert_eq!(classify_command("FLUSHALL"), RedisCommandSafety::Blocked);
        // Write helpers must agree on all non-Allowed kinds being considered writes
        assert!(!is_redis_write_command("GET key"));
        assert!(is_redis_write_command("DEL key"));
        assert!(is_redis_write_command("SET key val"));
        assert!(is_redis_write_command("FLUSHALL"));
    }

    #[test]
    fn gate_blocks_write_mislabeled_as_query() {
        // SQL write with kind=query must be rejected even when allow_mutations is true
        let err = data_view_gate_error("DELETE FROM users", Some(DatabaseType::Postgres), false, "query", true);
        assert!(err.is_some());
        assert!(err.unwrap().contains("Write operation requires mutation kind"));

        // Even with allow=false, same
        let err2 = data_view_gate_error("DELETE FROM users", Some(DatabaseType::Postgres), false, "query", false);
        assert!(err2.is_some());
    }

    #[test]
    fn gate_blocks_mutation_without_allow() {
        // Mutation without allow must be rejected even if the SQL is a read (defense-in-depth)
        let err = data_view_gate_error("SELECT * FROM users", Some(DatabaseType::Postgres), false, "mutation", false);
        assert!(err.is_some());
        assert!(err.unwrap().contains("requires explicit confirmation"));

        let err2 = data_view_gate_error("DELETE FROM users", Some(DatabaseType::Postgres), false, "mutation", false);
        assert!(err2.is_some());

        // With allow, both should pass
        assert!(data_view_gate_error("SELECT * FROM users", Some(DatabaseType::Postgres), false, "mutation", true)
            .is_none());
        assert!(
            data_view_gate_error("DELETE FROM users", Some(DatabaseType::Postgres), false, "mutation", true).is_none()
        );
    }

    #[test]
    fn gate_allows_read_query() {
        assert!(
            data_view_gate_error("SELECT * FROM users", Some(DatabaseType::Postgres), false, "query", false).is_none()
        );
        assert!(data_view_gate_error("SELECT * FROM users", None, false, "query", false).is_none());
    }

    #[test]
    fn gate_redis_write_detection() {
        assert!(data_view_gate_error("SET mykey val", Some(DatabaseType::Redis), true, "query", false).is_some());
        assert!(data_view_gate_error("GET mykey", Some(DatabaseType::Redis), true, "query", false).is_none());
        assert!(data_view_gate_error("SET mykey val", Some(DatabaseType::Redis), true, "mutation", false).is_some());
        assert!(data_view_gate_error("SET mykey val", Some(DatabaseType::Redis), true, "mutation", true).is_none());
    }
}
