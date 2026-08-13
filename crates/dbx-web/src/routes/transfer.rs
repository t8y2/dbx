use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::transfer::{self, TransferRequest, TransferStatus};
use futures::stream::Stream;
use serde::Deserialize;
use tokio::time::{sleep, Duration};

use crate::error::AppError;
use crate::sse::{TransferProgressChannel, TransferReplayEventKind};
use crate::state::WebState;

const COMPLETED_TRANSFER_CHANNEL_TTL: Duration = Duration::from_secs(60);

fn send_transfer_progress(channel: &TransferProgressChannel, progress: &transfer::TransferProgress) {
    if let Ok(json) = serde_json::to_string(progress) {
        let kind = if progress.terminal {
            TransferReplayEventKind::Terminal
        } else if matches!(&progress.status, TransferStatus::Error) {
            TransferReplayEventKind::Failure
        } else {
            TransferReplayEventKind::Progress
        };
        channel.send(json, kind);
    }
}

fn terminal_transfer_error(req: &TransferRequest, error: impl ToString) -> transfer::TransferProgress {
    transfer::TransferProgress {
        transfer_id: req.transfer_id.clone(),
        table: String::new(),
        table_index: 0,
        total_tables: req.tables.len(),
        rows_transferred: 0,
        total_rows: None,
        status: TransferStatus::Error,
        error: Some(error.to_string()),
        terminal: true,
    }
}

async fn finish_transfer_channel(state: &Arc<WebState>, transfer_id: &str, channel: &Arc<TransferProgressChannel>) {
    transfer::clear_cancelled(transfer_id).await;
    let state = state.clone();
    let transfer_id = transfer_id.to_string();
    let channel = channel.clone();
    tokio::spawn(async move {
        sleep(COMPLETED_TRANSFER_CHANNEL_TTL).await;
        let mut channels = state.transfer_progress_channels.write().await;
        if channels.get(&transfer_id).is_some_and(|current| Arc::ptr_eq(current, &channel)) {
            channels.remove(&transfer_id);
        }
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTransferRequest {
    pub request: TransferRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTransferRequest {
    pub transfer_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTransferOwnershipRequest {
    pub request: TransferRequest,
}

pub async fn start_transfer(
    State(state): State<Arc<WebState>>,
    Json(body): Json<StartTransferRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let req = body.request;
    transfer::validate_transfer_request(&req).map_err(AppError::from)?;

    // Reject transfer early if the target connection is read-only
    if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.target_connection_id).await {
        return Err(AppError::from(format!(
            "Read-only mode: target connection '{}' has read-only protection enabled. Transfer blocked.",
            name
        )));
    }

    let transfer_id = req.transfer_id.clone();

    // Keep bounded replay state so a web EventSource opened after this POST
    // still receives early table failures and the terminal result.
    let progress_channel = Arc::new(TransferProgressChannel::new());
    state.transfer_progress_channels.write().await.insert(transfer_id.clone(), progress_channel.clone());

    let app = state.app.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        let source_db_type = match transfer::get_db_type(&app, &req.source_connection_id).await {
            Ok(t) => t,
            Err(e) => {
                send_transfer_progress(&progress_channel, &terminal_transfer_error(&req, e));
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }
        };
        let target_db_type = match transfer::get_db_type(&app, &req.target_connection_id).await {
            Ok(t) => t,
            Err(e) => {
                send_transfer_progress(&progress_channel, &terminal_transfer_error(&req, e));
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }
        };

        // Cross-family object transfers are validated inside transfer_schema_objects:
        // only mechanically rewriteable kinds (views, sequences) are allowed; any
        // other selection fails with a descriptive error. Structure-only data
        // transfer is unsupported for MongoDB.
        if matches!(req.content, transfer::TransferContent::StructureOnly)
            && (matches!(source_db_type, dbx_core::models::connection::DatabaseType::MongoDb)
                || matches!(target_db_type, dbx_core::models::connection::DatabaseType::MongoDb))
        {
            send_transfer_progress(
                &progress_channel,
                &terminal_transfer_error(&req, "MongoDB 暂不支持仅结构传输".to_string()),
            );
            finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
            return;
        }

        // External Doris/StarRocks catalogs: pool is created with `catalog=` URL
        // setup (SET catalog) and without USE <external-db>. See ensure_transfer_pool.
        let source_pool_key = match transfer::ensure_transfer_pool(
            &app,
            &req.source_connection_id,
            &req.source_database,
            req.source_catalog.as_deref(),
        )
        .await
        {
            Ok(k) => k,
            Err(e) => {
                send_transfer_progress(&progress_channel, &terminal_transfer_error(&req, e));
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }
        };
        let target_pool_key = match transfer::ensure_transfer_pool(
            &app,
            &req.target_connection_id,
            &req.target_database,
            req.target_catalog.as_deref(),
        )
        .await
        {
            Ok(k) => k,
            Err(e) => {
                send_transfer_progress(&progress_channel, &terminal_transfer_error(&req, e));
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }
        };

        let tables = req.tables.clone();
        // Sort by FK dependency so referenced tables are transferred first.
        // Skip for external Doris/StarRocks catalogs — the database name does
        // not exist in the default catalog and sorting is unnecessary.
        let tables = {
            let skip_fk_sort = {
                let configs = app.configs.read().await;
                configs
                    .get(&req.source_connection_id)
                    .and_then(|config| {
                        transfer::resolve_external_transfer_catalog_for_config(req.source_catalog.as_deref(), config)
                    })
                    .is_some()
            };
            if skip_fk_sort {
                tables
            } else {
                transfer::sort_tables_by_fk_dependency(
                    &app,
                    &req.source_connection_id,
                    &req.source_database,
                    &req.source_schema,
                    &tables,
                    true,
                )
                .await
                .unwrap_or_else(|e| {
                    log::warn!("[transfer] failed to sort tables by FK dependency, using original order: {e}");
                    tables
                })
            }
        };
        let mut failed_tables: Vec<String> = Vec::new();

        if matches!(source_db_type, dbx_core::models::connection::DatabaseType::Postgres)
            && matches!(target_db_type, dbx_core::models::connection::DatabaseType::Postgres)
        {
            let progress_channel_clone = progress_channel.clone();
            match transfer::transfer_postgres_schema_dependencies(
                &app,
                &req,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    send_transfer_progress(&progress_channel_clone, &progress);
                },
            )
            .await
            {
                Ok(()) => {}
                Err(e) if e == "Cancelled" => {
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: "schema dependencies".to_string(),
                        table_index: 0,
                        total_tables: tables.len(),
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Cancelled,
                        error: None,
                        terminal: true,
                    };
                    send_transfer_progress(&progress_channel, &progress);
                    finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                    return;
                }
                Err(e) => {
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: "schema dependencies".to_string(),
                        table_index: 0,
                        total_tables: tables.len(),
                        rows_transferred: 0,
                        total_rows: None,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: true,
                    };
                    send_transfer_progress(&progress_channel, &progress);
                    finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                    return;
                }
            }
        }

        for (i, table) in tables.iter().enumerate() {
            if transfer::is_cancelled(&req.transfer_id).await {
                let progress = transfer::TransferProgress {
                    transfer_id: req.transfer_id.clone(),
                    table: table.clone(),
                    table_index: i,
                    total_tables: tables.len(),
                    rows_transferred: 0,
                    total_rows: None,
                    status: TransferStatus::Cancelled,
                    error: None,
                    terminal: true,
                };
                send_transfer_progress(&progress_channel, &progress);
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }

            let progress_channel_clone = progress_channel.clone();
            let mut last_rows_transferred = 0_u64;
            let mut last_total_rows = None;
            let result = transfer::transfer_table(
                &app,
                &req,
                table,
                i,
                &source_db_type,
                &target_db_type,
                &source_pool_key,
                &target_pool_key,
                |progress| {
                    last_rows_transferred = progress.rows_transferred;
                    last_total_rows = progress.total_rows;
                    send_transfer_progress(&progress_channel_clone, &progress);
                },
            )
            .await;

            match result {
                Ok(rows) => {
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables: tables.len(),
                        rows_transferred: rows,
                        total_rows: last_total_rows.or(Some(rows)),
                        status: TransferStatus::TableDone,
                        error: None,
                        terminal: false,
                    };
                    send_transfer_progress(&progress_channel, &progress);
                }
                Err(e) => {
                    if e == "Cancelled" {
                        let progress = transfer::TransferProgress {
                            transfer_id: req.transfer_id.clone(),
                            table: table.clone(),
                            table_index: i,
                            total_tables: tables.len(),
                            rows_transferred: 0,
                            total_rows: None,
                            status: TransferStatus::Cancelled,
                            error: None,
                            terminal: true,
                        };
                        send_transfer_progress(&progress_channel, &progress);
                        finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                        return;
                    }
                    failed_tables.push(table.clone());
                    let progress = transfer::TransferProgress {
                        transfer_id: req.transfer_id.clone(),
                        table: table.clone(),
                        table_index: i,
                        total_tables: tables.len(),
                        rows_transferred: last_rows_transferred,
                        total_rows: last_total_rows,
                        status: TransferStatus::Error,
                        error: Some(e),
                        terminal: false,
                    };
                    send_transfer_progress(&progress_channel, &progress);
                }
            }
        }

        // Transfer selected non-table objects (views, procedures, functions,
        // triggers, sequences, events) after the per-table loop. The shared
        // Core decision handles all content modes: DataOnly never
        // transfers schema objects; PG→PG keeps the legacy empty-selection
        // default only when structure participates in the transfer.
        let mut object_outcome = transfer::TransferObjectOutcome::default();
        let progress_channel_clone = progress_channel.clone();
        match transfer::transfer_schema_objects(&app, &req, &source_pool_key, &target_pool_key, |progress| {
            send_transfer_progress(&progress_channel_clone, &progress);
        })
        .await
        {
            Ok(outcome) => {
                object_outcome = outcome;
            }
            Err(e) if e == "Cancelled" => {
                let progress = transfer::TransferProgress {
                    transfer_id: req.transfer_id.clone(),
                    table: "schema objects".to_string(),
                    table_index: tables.len(),
                    total_tables: tables.len(),
                    rows_transferred: 0,
                    total_rows: None,
                    status: TransferStatus::Cancelled,
                    error: None,
                    terminal: true,
                };
                send_transfer_progress(&progress_channel, &progress);
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }
            Err(e) => {
                failed_tables.push("schema objects".to_string());
                let progress = transfer::TransferProgress {
                    transfer_id: req.transfer_id.clone(),
                    table: "schema objects".to_string(),
                    table_index: tables.len(),
                    total_tables: tables.len(),
                    rows_transferred: 0,
                    total_rows: None,
                    status: TransferStatus::Error,
                    error: Some(e),
                    terminal: false,
                };
                send_transfer_progress(&progress_channel, &progress);
            }
        }

        // Send done
        if !object_outcome.failed.is_empty() {
            failed_tables.push(format!("schema objects ({})", object_outcome.failed.len()));
        }
        let skip_suffix = if !object_outcome.skipped.is_empty() && failed_tables.is_empty() {
            format!("，跳过 {} 个已存在对象", object_outcome.skipped.len())
        } else if !object_outcome.skipped.is_empty() {
            format!("；跳过 {} 个已存在对象", object_outcome.skipped.len())
        } else {
            String::new()
        };
        let done = transfer::TransferProgress {
            transfer_id: req.transfer_id.clone(),
            table: String::new(),
            table_index: tables.len(),
            total_tables: tables.len(),
            rows_transferred: 0,
            total_rows: None,
            status: if failed_tables.is_empty() { TransferStatus::Done } else { TransferStatus::Error },
            error: if failed_tables.is_empty() {
                if skip_suffix.is_empty() {
                    None
                } else {
                    Some(skip_suffix.clone())
                }
            } else {
                Some(format!(
                    "{} table(s) failed: {}{}",
                    failed_tables.len(),
                    failed_tables.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
                    skip_suffix
                ))
            },
            terminal: true,
        };
        send_transfer_progress(&progress_channel, &done);
        finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
    });

    Ok(Json(serde_json::json!({ "transferId": transfer_id })))
}

pub async fn preview_transfer_ownership(
    State(state): State<Arc<WebState>>,
    Json(body): Json<PreviewTransferOwnershipRequest>,
) -> Result<Json<dbx_core::transfer::TransferOwnershipPreview>, AppError> {
    let req = body.request;
    transfer::validate_transfer_request(&req).map_err(AppError::from)?;
    let source_db_type = transfer::get_db_type(&state.app, &req.source_connection_id).await.map_err(AppError::from)?;
    let target_db_type = transfer::get_db_type(&state.app, &req.target_connection_id).await.map_err(AppError::from)?;
    let source_pool_key = transfer::ensure_transfer_pool(
        &state.app,
        &req.source_connection_id,
        &req.source_database,
        req.source_catalog.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    let target_pool_key = transfer::ensure_transfer_pool(
        &state.app,
        &req.target_connection_id,
        &req.target_database,
        req.target_catalog.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    let preview = transfer::preview_transfer_ownership(
        &state.app,
        &req,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(preview))
}

pub async fn transfer_progress(
    State(state): State<Arc<WebState>>,
    Path(transfer_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let channels = state.transfer_progress_channels.read().await;
    let channel =
        channels.get(&transfer_id).cloned().ok_or_else(|| AppError::from("Transfer not found".to_string()))?;
    drop(channels);
    Ok(crate::sse::sse_from_transfer_channel(channel))
}

pub async fn cancel_transfer(
    State(_state): State<Arc<WebState>>,
    Json(req): Json<CancelTransferRequest>,
) -> Json<serde_json::Value> {
    transfer::set_cancelled(&req.transfer_id).await;
    Json(serde_json::json!({ "cancelled": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortTablesByFkRequest {
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub tables: Vec<String>,
    pub parents_first: bool,
}

pub async fn sort_tables_by_fk_dependency(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SortTablesByFkRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    transfer::sort_tables_by_fk_dependency(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.schema,
        &req.tables,
        req.parents_first,
    )
    .await
    .map(Json)
    .map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::response::IntoResponse;
    use dbx_core::connection::AppState;
    use dbx_core::models::connection::{
        default_connect_timeout_secs, default_idle_timeout_secs, default_keepalive_interval_secs,
        default_query_timeout_secs, ConnectionConfig, DatabaseType,
    };
    use dbx_core::storage::Storage;
    use dbx_core::transfer::{
        TransferContent, TransferMode, TransferOwnershipPolicy, TransferRequest, TransferTableNameCase,
    };

    fn sqlite_config(id: &str, path: &str) -> ConnectionConfig {
        ConnectionConfig {
            docs_notes_path: None,
            id: id.to_string(),
            name: "SQLite".to_string(),
            note: String::new(),
            db_type: DatabaseType::Sqlite,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: path.to_string(),
            port: 0,
            username: String::new(),
            password: String::new(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: default_connect_timeout_secs(),
            query_timeout_secs: default_query_timeout_secs(),
            idle_timeout_secs: default_idle_timeout_secs(),
            keepalive_interval_secs: default_keepalive_interval_secs(),
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
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    async fn test_web_state() -> (Arc<WebState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-web-transfer-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState::for_tests(app, dir.clone()));
        (state, dir)
    }

    fn transfer_request(source: &str, target: &str, dir: &std::path::Path) -> TransferRequest {
        let db = dir.join("main.db").to_string_lossy().to_string();
        TransferRequest {
            transfer_id: "transfer-entry-test".to_string(),
            source_connection_id: source.to_string(),
            source_database: db.clone(),
            source_schema: "main".to_string(),
            source_catalog: None,
            target_connection_id: target.to_string(),
            target_database: db,
            target_schema: "main".to_string(),
            target_catalog: None,
            tables: Vec::new(),
            create_table: false,
            content: TransferContent::DataOnly,
            objects: Vec::new(),
            mode: TransferMode::Append,
            target_table_name_case: TransferTableNameCase::Preserve,
            ownership_policy: TransferOwnershipPolicy::Preserve,
            batch_size: 1000,
        }
    }

    #[tokio::test]
    async fn data_only_empty_object_selection_completes_through_the_core_noop() {
        let (state, dir) = test_web_state().await;
        let src = sqlite_config("src", &dir.join("src.db").to_string_lossy());
        let dst = sqlite_config("dst", &dir.join("dst.db").to_string_lossy());
        // SQLite pools need the backing files to exist before connecting.
        std::fs::write(dir.join("src.db"), b"").unwrap();
        std::fs::write(dir.join("dst.db"), b"").unwrap();
        std::fs::write(dir.join("main.db"), b"").unwrap();
        state.app.configs.write().await.insert("src".to_string(), src);
        state.app.configs.write().await.insert("dst".to_string(), dst);

        let req = transfer_request("src", "dst", &dir);
        let transfer_id = req.transfer_id.clone();
        let response = start_transfer(State(state.clone()), Json(StartTransferRequest { request: req })).await.unwrap();
        let _ = response.into_response();

        // Both HTTP and Tauri call the same Core schema-object stage
        // unconditionally. DataOnly must resolve there to a no-op without an
        // object progress event or database-family fallback.
        let channel = {
            let channels = state.transfer_progress_channels.read().await;
            channels.get(&transfer_id).cloned().expect("transfer channel registered")
        };
        let mut saw_terminal = false;
        let mut saw_schema_objects = false;
        let mut terminal_error: Option<String> = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !saw_terminal {
            if let Some(data) = channel.latest() {
                let value: serde_json::Value = serde_json::from_str(&data).unwrap();
                if value["table"].as_str() == Some("schema objects") {
                    saw_schema_objects = true;
                }
                if value["terminal"].as_bool() == Some(true) {
                    saw_terminal = true;
                    terminal_error = value["error"].as_str().map(|s| s.to_string());
                }
            }
            if saw_terminal {
                break;
            }
            if std::time::Instant::now() > deadline {
                panic!("transfer did not reach a terminal event within 15s");
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(saw_terminal, "transfer must reach a terminal event");
        assert!(!saw_schema_objects, "DataOnly must not transfer schema objects");
        assert!(
            terminal_error.is_none(),
            "DataOnly must complete without a schema-object error, got: {terminal_error:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
