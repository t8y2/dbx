use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use dbx_core::persistence::task_history::{TaskHistoryStorageError, TaskLifecycleOwner, TransferTaskJournal};
use dbx_core::transfer::{self, TransferRequest, TransferStatus};
use futures::stream::Stream;
use serde::Deserialize;
use tokio::time::{sleep, Duration};

use crate::error::AppError;
use crate::sse::{TransferProgressChannel, TransferReplayEventKind};
use crate::state::WebState;

const COMPLETED_TRANSFER_CHANNEL_TTL: Duration = Duration::from_secs(60);

fn send_transfer_progress(channel: &TransferProgressChannel, progress: &transfer::TransferProgress) {
    if progress.terminal {
        channel.remember_terminal_progress(progress.clone());
    }
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
    channel.finish_task_history().await;
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
    pub operation_timeout_secs: Option<u64>,
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
    let operation_timeout_secs = body.operation_timeout_secs;
    let req = body.request;
    transfer::validate_transfer_request(&req).map_err(AppError::from)?;
    transfer::validate_transfer_operation_timeout(operation_timeout_secs).map_err(AppError::from)?;

    // Demo mode skips connection-backed validation: the simulated web build may not
    // carry the requested connections, and the spawned task reports failures as
    // terminal progress events instead of HTTP errors.
    let (source_db_type, target_db_type) = if state.demo_mode {
        (dbx_core::models::connection::DatabaseType::Sqlite, dbx_core::models::connection::DatabaseType::Sqlite)
    } else {
        // Reject transfer early if the target connection is read-only
        if let Some(name) = dbx_core::query::connection_readonly_name(&state.app, &req.target_connection_id).await {
            return Err(AppError::from(format!(
                "Read-only mode: target connection '{}' has read-only protection enabled. Transfer blocked.",
                name
            )));
        }

        let source_db_type =
            transfer::get_db_type(&state.app, &req.source_connection_id).await.map_err(AppError::from)?;
        let target_db_type =
            transfer::get_db_type(&state.app, &req.target_connection_id).await.map_err(AppError::from)?;
        transfer::validate_transfer_database_pair(&req, &source_db_type, &target_db_type).map_err(AppError::from)?;

        // `drop_target_before_create` rebuilds target tables. Gate it before responding so the
        // caller sees the error code rather than a progress stream that fails later.
        if req.drop_target_before_create {
            dbx_core::transfer_rebuild::ensure_drop_target_allowed(
                &state.app,
                &req.target_connection_id,
                &req.target_database,
                target_db_type,
                req.drop_target_before_create,
                req.drop_target_confirmed,
            )
            .await
            .map_err(AppError::from)?;
        }
        (source_db_type, target_db_type)
    };

    let transfer_id = req.transfer_id.clone();
    let history = if state.demo_mode {
        None
    } else {
        match TransferTaskJournal::accept(&state.app.storage, &state.app, &req, TaskLifecycleOwner::Web).await {
            Ok(history) => history,
            Err(TaskHistoryStorageError::RunIdConflict) => {
                return Err(AppError::conflict("TRANSFER_RUN_ID_CONFLICT"));
            }
            Err(error) => return Err(AppError::internal(error.code())),
        }
    };

    // Keep bounded replay state so a web EventSource opened after this POST
    // still receives early table failures and the terminal result.
    let progress_channel = Arc::new(TransferProgressChannel::new());
    progress_channel.set_task_history_journal(history.clone());
    state.transfer_progress_channels.write().await.insert(transfer_id.clone(), progress_channel.clone());

    let app = state.app.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
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

        let source_pool_key = match transfer::ensure_transfer_pool(
            &app,
            &req.source_connection_id,
            &req.source_database,
            req.source_catalog.as_deref(),
        )
        .await
        {
            Ok(key) => key,
            Err(error) => {
                send_transfer_progress(&progress_channel, &terminal_transfer_error(&req, error));
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
            Ok(key) => key,
            Err(error) => {
                send_transfer_progress(&progress_channel, &terminal_transfer_error(&req, error));
                finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
                return;
            }
        };

        if let Err(error) = transfer::with_transfer_operation_timeout(
            operation_timeout_secs,
            transfer::ensure_transfer_source_types_supported(&app, &req, &source_pool_key),
        )
        .await
        {
            send_transfer_progress(&progress_channel, &terminal_transfer_error(&req, error));
            finish_transfer_channel(&state_clone, &req.transfer_id, &progress_channel).await;
            return;
        }

        let task_transfer_id = req.transfer_id.clone();
        let progress_channel_for_run = progress_channel.clone();
        let terminal = dbx_core::transfer_runner::run_transfer(
            app,
            req,
            source_db_type,
            target_db_type,
            source_pool_key,
            target_pool_key,
            history,
            operation_timeout_secs,
            move |progress| send_transfer_progress(&progress_channel_for_run, &progress),
        )
        .await;
        send_transfer_progress(&progress_channel, &terminal);
        finish_transfer_channel(&state_clone, &task_transfer_id, &progress_channel).await;
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
    transfer::validate_transfer_database_pair(&req, &source_db_type, &target_db_type).map_err(AppError::from)?;
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
        default_connect_timeout_secs, default_idle_disconnect_secs, default_idle_timeout_secs,
        default_keepalive_interval_secs, default_manual_transaction_timeout_secs, default_query_timeout_secs,
        ConnectionConfig, DatabaseType,
    };
    use dbx_core::persistence::task_history::{TaskRunItemsQuery, TaskRunStatus, TransferObjectSelectionMode};
    use dbx_core::transfer::{
        TransferColumnNameCase, TransferContent, TransferMode, TransferOwnershipPolicy, TransferRequest,
        TransferTableNameCase,
    };

    fn sqlite_config(id: &str, path: &str) -> ConnectionConfig {
        ConnectionConfig {
            oracle_oci_nls_lang: None,
            oracle_oci_tns_admin: None,
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
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            sidebar_auto_load_all_tables: false,
            show_database_links: None,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: default_connect_timeout_secs(),
            query_timeout_secs: default_query_timeout_secs(),
            idle_timeout_secs: default_idle_timeout_secs(),
            manual_transaction_timeout_secs: default_manual_transaction_timeout_secs(),
            idle_disconnect_secs: default_idle_disconnect_secs(),
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
            redis_key_templates: Vec::new(),
            redis_key_filter: None,
            redis_key_grouping: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            plugin_id: None,
            plugin_connection_provider: None,
            plugin_connection_type: None,
            connection_secrets: Default::default(),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            production_badge_scope: None,
            database_info: None,
        }
    }

    async fn test_web_state() -> (Arc<WebState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-web-transfer-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState::for_tests(app, dir.clone()));
        (state, dir)
    }

    fn transfer_request(source: &str, target: &str, dir: &std::path::Path) -> TransferRequest {
        let db = dir.join("main.db").to_string_lossy().to_string();
        TransferRequest {
            table_filters: std::collections::HashMap::new(),
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
            drop_target_before_create: false,
            drop_target_confirmed: false,
            content: TransferContent::DataOnly,
            objects: Some(Vec::new()),
            mode: TransferMode::Append,
            target_table_name_case: TransferTableNameCase::Preserve,
            target_column_name_case: TransferColumnNameCase::Preserve,
            quote_target_column_names: true,
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
        let response = start_transfer(
            State(state.clone()),
            Json(StartTransferRequest { request: req, operation_timeout_secs: None }),
        )
        .await
        .unwrap();
        let _ = response.into_response();

        let duplicate = start_transfer(
            State(state.clone()),
            Json(StartTransferRequest { request: transfer_request("src", "dst", &dir), operation_timeout_secs: None }),
        )
        .await
        .unwrap_err();
        assert_eq!(duplicate.status, axum::http::StatusCode::CONFLICT);

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
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let task_run = loop {
            let run = state.app.storage.get_task_run_detail(&transfer_id).await.unwrap();
            if run.as_ref().is_some_and(|detail| detail.run.status.is_terminal()) {
                break run.unwrap();
            }
            if std::time::Instant::now() > deadline {
                panic!("task history did not reach a terminal state");
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        assert_eq!(task_run.run.lifecycle_owner, TaskLifecycleOwner::Web);
        assert_eq!(task_run.run.status, TaskRunStatus::Succeeded);
        assert!(task_run.run.history_complete);
        let transfer_details = task_run.transfer.expect("accepted transfer details persisted");
        assert_eq!(transfer_details.object_selection_mode, TransferObjectSelectionMode::Explicit);
        assert_eq!(transfer_details.selected_object_count, Some(0));
        let items = state.app.storage.list_task_run_items(&transfer_id, TaskRunItemsQuery::default()).await.unwrap();
        assert!(items.items.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn demo_mode_transfer_does_not_write_task_history() {
        let (mut state, dir) = test_web_state().await;
        Arc::get_mut(&mut state).unwrap().demo_mode = true;
        let req = transfer_request("src", "dst", &dir);
        let transfer_id = req.transfer_id.clone();
        let _ = start_transfer(
            State(state.clone()),
            Json(StartTransferRequest { request: req, operation_timeout_secs: None }),
        )
        .await
        .unwrap();
        let channel = {
            let channels = state.transfer_progress_channels.read().await;
            channels.get(&transfer_id).cloned().expect("transfer channel registered")
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if channel
                .latest()
                .and_then(|data| serde_json::from_str::<serde_json::Value>(&data).ok())
                .is_some_and(|progress| progress["terminal"].as_bool() == Some(true))
            {
                break;
            }
            if std::time::Instant::now() > deadline {
                panic!("demo transfer did not reach a terminal event");
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(state.app.storage.get_task_run_detail(&transfer_id).await.unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
