use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use dbx_core::connection::{
    connection_configs_pool_equivalent, connection_configs_session_credentials_compatible, AppState, PoolKind,
};
use dbx_core::models::connection::{ConnectionConfig, ConnectionTestResult, DatabaseConnectionInfo, DatabaseType};
use dbx_core::nacos::config::{
    take_transient_passwords, NACOS_CONSOLE_SESSION_PASSWORD, NACOS_PRIMARY_SESSION_PASSWORD,
};
use dbx_core::runtime_config::{
    release_runtime_config_on_disconnect, should_retain_runtime_config, TEST_PROBE_ID_PREFIX,
};
use dbx_core::session_credentials::{PurposeSessionCredentialWriteToken, SessionCredentialWriteToken};
use serde::{Deserialize, Serialize};

use crate::auth::session_token_from_headers;
use crate::error::AppError;
use crate::state::WebState;

const MONGO_LEGACY_DRIVER_PROFILE: &str = "mongodb-legacy";
const MONGO_LEGACY_DRIVER_LABEL: &str = "MongoDB (Legacy)";

#[derive(Default)]
struct NoSaveRuntimeSecrets {
    primary: Option<String>,
    console: Option<String>,
}

#[derive(Default)]
struct SessionCredentialWrites {
    primary: Option<SessionCredentialWriteToken>,
    purposes: Vec<PurposeSessionCredentialWriteToken>,
}

fn prepare_runtime_config(mut config: ConnectionConfig) -> (ConnectionConfig, NoSaveRuntimeSecrets) {
    if config.save_password {
        return (config, NoSaveRuntimeSecrets::default());
    }
    if config.db_type == DatabaseType::Nacos {
        let passwords = take_transient_passwords(&mut config);
        return (config, NoSaveRuntimeSecrets { primary: passwords.primary, console: passwords.console });
    }
    let primary = std::mem::take(&mut config.password);
    (config, NoSaveRuntimeSecrets { primary: (!primary.is_empty()).then_some(primary), console: None })
}

fn record_session_credentials(
    app: &AppState,
    owner: &str,
    connection_id: &str,
    secrets: &NoSaveRuntimeSecrets,
    nacos: bool,
) -> SessionCredentialWrites {
    let primary =
        secrets.primary.as_deref().and_then(|password| app.session_credentials.set(owner, connection_id, password));
    let mut purposes = Vec::new();
    if nacos {
        if let Some(token) = secrets.primary.as_deref().and_then(|password| {
            app.session_credentials.set_for_purpose_with_token(
                owner,
                connection_id,
                NACOS_PRIMARY_SESSION_PASSWORD,
                password,
            )
        }) {
            purposes.push(token);
        }
        if let Some(token) = secrets.console.as_deref().and_then(|password| {
            app.session_credentials.set_for_purpose_with_token(
                owner,
                connection_id,
                NACOS_CONSOLE_SESSION_PASSWORD,
                password,
            )
        }) {
            purposes.push(token);
        }
    }
    SessionCredentialWrites { primary, purposes }
}

fn rollback_session_credential_writes(app: &AppState, writes: &SessionCredentialWrites) {
    for token in &writes.purposes {
        app.session_credentials.remove_purpose_if_current(token);
    }
    if let Some(token) = writes.primary.as_ref() {
        app.session_credentials.remove_if_current(token);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub config: ConnectionConfig,
    pub client_attempt: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectRequest {
    pub connection_id: String,
    pub client_attempt: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDatabaseConnectionRequest {
    pub connection_id: String,
    pub database: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCredentialStatusRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceNacosSessionCredentialRequest {
    pub connection_id: String,
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionIdentifierQuoteRequest {
    pub connection_id: String,
    pub database: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionDatabaseInfoRequest {
    pub connection_id: String,
    pub database_info: Option<DatabaseConnectionInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockConnectionWritesRequest {
    pub connection_id: String,
    pub duration_secs: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteUnlockStateResponse {
    pub remaining_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnectionsRequest {
    pub configs: Vec<ConnectionConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAddConnectionRequest {
    pub config: ConnectionConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDuplicateConnectionRequest {
    pub source_id: String,
    pub copy_id: String,
    pub copy_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRemoveConnectionRequest {
    pub connection_id: String,
}

fn is_connection_info_capability_unsupported(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("connectioninfo")
        && (error.contains("unsupported") || error.contains("unknown method") || error.contains("method not found"))
}

fn mark_mongo_legacy_driver(config: &mut ConnectionConfig) -> bool {
    if config.db_type != DatabaseType::MongoDb {
        return false;
    }
    let changed = config.driver_profile.as_deref() != Some(MONGO_LEGACY_DRIVER_PROFILE)
        || config.driver_label.as_deref() != Some(MONGO_LEGACY_DRIVER_LABEL);
    config.driver_profile = Some(MONGO_LEGACY_DRIVER_PROFILE.to_string());
    config.driver_label = Some(MONGO_LEGACY_DRIVER_LABEL.to_string());
    changed
}

fn mongo_fallback_config_matches(current: &ConnectionConfig, expected: &ConnectionConfig) -> bool {
    let mut current = current.clone();
    let mut expected = expected.clone();
    current.note.clear();
    current.database_info = None;
    expected.note.clear();
    expected.database_info = None;
    if current == expected {
        return true;
    }
    if current.driver_profile.as_deref() != Some(MONGO_LEGACY_DRIVER_PROFILE)
        || current.driver_label.as_deref() != Some(MONGO_LEGACY_DRIVER_LABEL)
    {
        return false;
    }
    current.driver_profile = expected.driver_profile.clone();
    current.driver_label = expected.driver_label.clone();
    current == expected
}

async fn apply_mongo_legacy_driver_profile(state: &WebState, config: &ConnectionConfig) -> Result<(), AppError> {
    if config.db_type != DatabaseType::MongoDb {
        return Ok(());
    }

    // Draft and one-time connections have no durable profile to update.
    let persisted = if config.one_time {
        true
    } else {
        state
            .app
            .storage
            .save_connection_driver_profile(
                config,
                Some(MONGO_LEGACY_DRIVER_PROFILE.to_string()),
                Some(MONGO_LEGACY_DRIVER_LABEL.to_string()),
            )
            .await
            .map_err(AppError::from)?
    };
    if !persisted {
        return Ok(());
    }
    let mut runtime_configs = state.app.configs.write().await;
    if let Some(current) =
        runtime_configs.get_mut(&config.id).filter(|current| mongo_fallback_config_matches(current, config))
    {
        mark_mongo_legacy_driver(current);
    }
    Ok(())
}

/// The core connector can choose the Legacy Agent after a native MongoDB
/// handshake failure. Keep Web's runtime and saved profile aligned so the UI
/// does not expose native-only collection rename for that session.
async fn sync_mongo_legacy_driver_fallback(state: &WebState, config: &ConnectionConfig) -> Result<(), AppError> {
    if config.db_type != DatabaseType::MongoDb {
        return Ok(());
    }
    let uses_legacy_agent = {
        let connections = state.app.connections.read().await;
        matches!(connections.get(&config.id), Some(PoolKind::Agent(_)))
    };
    if !uses_legacy_agent {
        return Ok(());
    }
    apply_mongo_legacy_driver_profile(state, config).await
}

async fn run_temporary_connection_test(
    app: &Arc<AppState>,
    config: ConnectionConfig,
    include_database_info: bool,
) -> Result<ConnectionTestResult, String> {
    let temp_id = format!("{TEST_PROBE_ID_PREFIX}{}", uuid::Uuid::new_v4());
    app.configs.write().await.insert(temp_id.clone(), config.clone());
    let mut nacos_database_info = None;

    let pool_result = if config.db_type == DatabaseType::Nacos {
        match app.nacos_admin_config_for_connection(&temp_id, &config).await {
            Ok(admin_config) => match app.nacos_registry.build_transient_config(admin_config).await {
                Ok(adapter) => adapter.test_connection_with_scope_validation().await.map(|info| {
                    nacos_database_info = dbx_core::nacos::service::database_info_from_connection(&info);
                    temp_id.clone()
                }),
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        }
    } else {
        app.get_or_create_pool(&temp_id, config.database.as_deref()).await
    };
    let database_info = if include_database_info && config.db_type == DatabaseType::Nacos {
        nacos_database_info
    } else if include_database_info {
        match &pool_result {
            Ok(_) => match app.connection_database_info(&temp_id, config.database.as_deref()).await {
                Ok(info) => info,
                Err(error) if is_connection_info_capability_unsupported(&error) => {
                    log::debug!("Connection information capability is unavailable: {error}");
                    None
                }
                Err(error) => {
                    log::warn!("Failed to read optional connection information: {error}");
                    None
                }
            },
            Err(_) => None,
        }
    } else {
        None
    };

    // Keep all fallible post-connect checks inside this block so cleanup below
    // runs before either a successful result or an error is returned.
    let result: Result<ConnectionTestResult, String> = async {
        let success_message = if pool_result.is_ok() && config.db_type == DatabaseType::Consul {
            let client = {
                let connections = app.connections.read().await;
                match connections.get(&temp_id) {
                    Some(PoolKind::Consul(client)) => Some(client.clone()),
                    _ => None,
                }
            };
            if let Some(client) = client {
                let configured_target =
                    dbx_core::consul::ConsulConfig::from_connection(&config)?.agent_target.is_some();
                let identity = if configured_target {
                    Some(client.validate_configured_agent_target().await?)
                } else {
                    client.agent_self().await.ok()
                };
                identity
                    .map(|identity| format!("Connection successful (Agent: {} at {})", identity.node, identity.address))
                    .unwrap_or_else(|| {
                        "Connection successful (Agent identity unavailable; Agent writes disabled)".to_string()
                    })
            } else {
                "Connection successful (Agent identity unavailable; Agent writes disabled)".to_string()
            }
        } else {
            "Connection successful".to_string()
        };

        pool_result.map(|_| ConnectionTestResult::success(success_message).with_database_info(database_info))
    }
    .await;

    app.remove_connection_pools(&temp_id).await;
    // Pool drain intentionally keeps durable MQ adapters for reconnect reuse; temporary
    // probes must still release any registry entry if a cached path was used.
    #[cfg(feature = "mq-admin")]
    app.mq_registry.drop_connection(&temp_id).await;
    app.reset_connection_transport_for_config(&temp_id, &config).await;
    app.configs.write().await.remove(&temp_id);

    result
}

pub async fn test_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<String>, AppError> {
    run_temporary_connection_test(&state.app, body.config, false)
        .await
        .map(|result| Json(result.message))
        .map_err(AppError::from)
}

pub async fn test_connection_with_info(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<ConnectionTestResult>, AppError> {
    run_temporary_connection_test(&state.app, body.config, true).await.map(Json).map_err(AppError::from)
}

pub async fn connect_db(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<String>, AppError> {
    let config = body.config;
    if config.db_type == dbx_core::models::connection::DatabaseType::Sqlite {
        dbx_core::db::sqlite::validate_persistent_attachments(
            &config.host,
            &config.password,
            !config.attached_databases.is_empty(),
        )
        .map_err(AppError::from)?;
    }
    let app = &state.app;
    let connection_id = config.id.clone();
    let owner = session_token_from_headers(&headers).unwrap_or_default();
    let attempt = app.begin_connection_attempt_with_client_attempt(&connection_id, body.client_attempt).await;

    // save_password=false 连接：
    // 1) 先把本次输入的密码按 owner（登录会话）记入内存会话凭据仓库，供池创建/
    //    池重建按 owner 读取（见 apply_session_credential）；
    // 2) 存入全局运行态 configs 的配置必须脱敏（password 恒为空），禁止明文驻留
    //    AppState.configs——否则其他登录会话借池重建即可读到它，绕过 owner 隔离。
    // 只有本次请求确实写入/替换了会话凭据（输入了非空密码）时，才需要在连接
    // 失败时回滚它；无密码重连复用的是既有有效凭据，失败不应清掉它，否则瞬时的
    // 数据库/网络抖动就会让"本次会话内记住密码"失效、下次又弹窗。
    let (runtime_config, runtime_secrets) = prepare_runtime_config(config.clone());
    let session_credential_writes = record_session_credentials(
        app,
        &owner,
        &connection_id,
        &runtime_secrets,
        config.db_type == DatabaseType::Nacos,
    );

    app.remove_connection_pools_detached(&connection_id).await;
    app.nacos_registry.drop_connection(&connection_id).await;
    app.reset_connection_transport_for_config(&connection_id, &runtime_config).await;
    app.configs.write().await.insert(connection_id.clone(), runtime_config);

    if let Err(error) = app.get_or_create_pool_for_connection_attempt(&connection_id, None, attempt).await {
        // 连接失败：仅回滚本次请求刚写入的会话凭据，避免前端误判"已记住密码"而用
        // 失败密码免弹窗重试；无密码重连复用的既有凭据不受瞬时失败影响。
        rollback_session_credential_writes(app, &session_credential_writes);
        return Err(AppError::from(error));
    }
    if let Err(error) = sync_mongo_legacy_driver_fallback(&state, &config).await {
        app.remove_connection_pools_detached(&connection_id).await;
        app.reset_connection_transport_for_config(&connection_id, &config).await;
        rollback_session_credential_writes(app, &session_credential_writes);
        return Err(error);
    }

    Ok(Json(connection_id))
}

pub async fn connected_database_info(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectionIdentifierQuoteRequest>,
) -> Result<Json<Option<DatabaseConnectionInfo>>, AppError> {
    state
        .app
        .connection_database_info(&body.connection_id, body.database.as_deref())
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn save_connection_database_info(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveConnectionDatabaseInfoRequest>,
) -> Result<Json<()>, AppError> {
    state
        .app
        .save_connection_database_info(&body.connection_id, body.database_info)
        .await
        .map(|_| Json(()))
        .map_err(AppError::from)
}

pub async fn unlock_connection_writes(
    State(state): State<Arc<WebState>>,
    Json(body): Json<UnlockConnectionWritesRequest>,
) -> Result<Json<WriteUnlockStateResponse>, AppError> {
    if !state.app.configs.read().await.contains_key(&body.connection_id) {
        return Err(AppError::from("Connection not found".to_string()));
    }
    let remaining_ms =
        state.app.write_unlock_windows.unlock(&body.connection_id, body.duration_secs).await.map_err(AppError::from)?;
    Ok(Json(WriteUnlockStateResponse { remaining_ms }))
}

pub async fn lock_connection_writes(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectionIdentifierQuoteRequest>,
) -> Result<Json<()>, AppError> {
    state.app.write_unlock_windows.lock(&body.connection_id).await;
    Ok(Json(()))
}

pub async fn connection_write_unlock_state(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectionIdentifierQuoteRequest>,
) -> Result<Json<WriteUnlockStateResponse>, AppError> {
    Ok(Json(WriteUnlockStateResponse {
        remaining_ms: state.app.write_unlock_windows.remaining_ms(&body.connection_id).await,
    }))
}

pub async fn connection_final_proxy_port(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(body): Json<ConnectRequest>,
) -> Result<Json<u16>, AppError> {
    let runtime_config = body.config.canonicalized();
    if !runtime_config.has_effective_transport_layers() {
        return Err(AppError::from("Connection has no configured transport layers".to_string()));
    }
    if runtime_config.db_type == dbx_core::models::connection::DatabaseType::Sqlite {
        dbx_core::db::sqlite::validate_persistent_attachments(
            &runtime_config.host,
            &runtime_config.password,
            !runtime_config.attached_databases.is_empty(),
        )
        .map_err(AppError::from)?;
    }

    let app = &state.app;
    let connection_id = runtime_config.id.clone();
    let db_config = dbx_core::connection::metadata_connection_config(&runtime_config);
    // Tunnel resolution needs a runtime config lookup, but a no-save password
    // must never enter the shared Web config cache and bypass owner isolation.
    let (stored_config, runtime_secrets) = prepare_runtime_config(runtime_config.clone());
    app.configs.write().await.insert(connection_id.clone(), stored_config);

    let (_, port) = app.connection_host_port(&connection_id, &db_config).await.map_err(AppError::from)?;
    let owner = session_token_from_headers(&headers).unwrap_or_default();
    record_session_credentials(
        app,
        &owner,
        &connection_id,
        &runtime_secrets,
        runtime_config.db_type == DatabaseType::Nacos,
    );
    Ok(Json(port))
}

pub async fn disconnect_db(
    State(state): State<Arc<WebState>>,
    Json(body): Json<DisconnectRequest>,
) -> Result<Json<()>, AppError> {
    let app = &state.app;

    let should_disconnect = if let Some(client_attempt) = body.client_attempt {
        app.supersede_connection_attempt_if_client_attempt(&body.connection_id, client_attempt).await
    } else {
        app.supersede_connection_attempt(&body.connection_id).await;
        true
    };
    if !should_disconnect {
        return Ok(Json(()));
    }
    app.running_queries.cancel_connection(&body.connection_id);
    app.remove_connection_pools_detached(&body.connection_id).await;
    app.nacos_registry.drop_connection(&body.connection_id).await;
    #[cfg(feature = "mq-admin")]
    app.mq_registry.drop_connection(&body.connection_id).await;
    app.reset_connection_transport(&body.connection_id).await;
    release_runtime_config_on_disconnect(app, &body.connection_id).await;

    Ok(Json(()))
}

pub async fn check_connection_health(
    State(state): State<Arc<WebState>>,
    Json(body): Json<DisconnectRequest>,
) -> Result<Json<()>, AppError> {
    state.app.check_connection_health(&body.connection_id).await.map_err(AppError::from)?;
    Ok(Json(()))
}

/// 查询连接在本次运行期是否已输入并暂存密码（`save_password=false`）。
/// 供前端决定是否需要弹密码框；仅返回布尔状态，不泄露密码本身。
/// 按当前登录会话（owner）查询，不会暴露其他会话的凭据状态。
pub async fn session_credential_status(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(body): Json<SessionCredentialStatusRequest>,
) -> Result<Json<bool>, AppError> {
    let owner = session_token_from_headers(&headers).unwrap_or_default();
    Ok(Json(state.app.session_credentials.has(&owner, &body.connection_id)))
}

/// "断开并忘记本次密码"：清除连接本次运行期的临时密码，下次连接需重新输入。
/// 只清当前登录会话的内存凭据，不影响其他会话与持久化配置。
pub async fn forget_session_credential(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(body): Json<SessionCredentialStatusRequest>,
) -> Result<Json<()>, AppError> {
    let owner = session_token_from_headers(&headers).unwrap_or_default();
    if !state.app.session_credentials.has(&owner, &body.connection_id) {
        return Err(AppError::from(format!(
            "Connection has no transient session credential to forget: {}",
            body.connection_id
        )));
    }
    state.app.session_credentials.remove(&owner, &body.connection_id);
    Ok(Json(()))
}

pub async fn replace_nacos_session_credential(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(body): Json<ReplaceNacosSessionCredentialRequest>,
) -> Result<Json<()>, AppError> {
    let owner = session_token_from_headers(&headers).unwrap_or_default();
    state
        .app
        .replace_nacos_session_credential(&owner, &body.connection_id, &body.username, &body.password)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn connection_identifier_quote(
    State(state): State<Arc<WebState>>,
    Json(body): Json<ConnectionIdentifierQuoteRequest>,
) -> Result<Json<Option<String>>, AppError> {
    state
        .app
        .connection_identifier_quote(&body.connection_id, body.database.as_deref())
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn close_database_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<CloseDatabaseConnectionRequest>,
) -> Result<Json<bool>, AppError> {
    let database = body.database.trim();
    let database = if database.is_empty() { None } else { Some(database) };
    state.app.close_database_pool(&body.connection_id, database).await.map(Json).map_err(AppError::from)
}

pub async fn save_connections(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(body): Json<SaveConnectionsRequest>,
) -> Result<Json<()>, AppError> {
    for config in &body.configs {
        if config.db_type == dbx_core::models::connection::DatabaseType::Sqlite {
            dbx_core::db::sqlite::validate_persistent_attachments(
                &config.host,
                &config.password,
                !config.attached_databases.is_empty(),
            )
            .map_err(AppError::from)?;
        }
    }
    state.app.storage.save_connections(&body.configs).await.map_err(AppError::from)?;
    let owner = session_token_from_headers(&headers).unwrap_or_default();
    let runtime_configs = body.configs.iter().cloned().map(prepare_runtime_config).collect::<Vec<_>>();
    let sanitized_configs = runtime_configs.iter().map(|(config, _)| config.clone()).collect::<Vec<_>>();
    let sync = sync_connection_configs(&state, &sanitized_configs).await;
    for (config, secrets) in &runtime_configs {
        record_session_credentials(&state.app, &owner, &config.id, secrets, config.db_type == DatabaseType::Nacos);
    }
    remove_connection_pools_for_connection_ids(&state, &sync.connection_pool_ids_to_drop).await;
    drop_nacos_adapters_for_connection_ids(&state, &sync.nacos_adapter_ids_to_drop).await;
    drop_mq_adapters_for_connection_ids(&state, &sync.mq_adapter_ids_to_drop).await;
    Ok(Json(()))
}

pub async fn mcp_add_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<McpAddConnectionRequest>,
) -> Result<Json<ConnectionConfig>, AppError> {
    let saved = state.app.storage.add_connection_for_mcp(body.config).await.map_err(AppError::from)?;
    state.app.session_credentials.clear_connection(&saved.id);
    state.app.remove_connection_pools_detached(&saved.id).await;
    state.app.configs.write().await.insert(saved.id.clone(), saved.clone());
    Ok(Json(saved))
}

pub async fn mcp_duplicate_connection(
    State(state): State<Arc<WebState>>,
    Json(body): Json<McpDuplicateConnectionRequest>,
) -> Result<Json<ConnectionConfig>, AppError> {
    let saved = state
        .app
        .storage
        .duplicate_connection_for_mcp(&body.source_id, &body.copy_id, &body.copy_name)
        .await
        .map_err(AppError::from)?;
    state.app.session_credentials.clear_connection(&saved.id);
    state.app.remove_connection_pools_detached(&saved.id).await;
    state.app.configs.write().await.insert(saved.id.clone(), saved.clone());
    Ok(Json(saved))
}

pub async fn mcp_remove_connection(
    State(state): State<Arc<WebState>>,
    _headers: HeaderMap,
    Json(body): Json<McpRemoveConnectionRequest>,
) -> Result<Json<bool>, AppError> {
    let connection_id = body.connection_id;
    let removed = state.app.storage.remove_connection_for_mcp(&connection_id).await.map_err(AppError::from)?;
    if removed {
        state.app.configs.write().await.remove(&connection_id);
        state.app.session_credentials.clear_connection(&connection_id);
        state.app.remove_connection_pools_detached(&connection_id).await;
        state.app.nacos_registry.drop_connection(&connection_id).await;
        #[cfg(feature = "mq-admin")]
        state.app.mq_registry.drop_connection(&connection_id).await;
    }
    Ok(Json(removed))
}

pub async fn load_connections(
    State(state): State<Arc<WebState>>,
    _headers: HeaderMap,
) -> Result<Json<Vec<ConnectionConfig>>, AppError> {
    let configs = state.app.storage.load_connections().await.map_err(AppError::from)?;
    let sync = sync_connection_configs(&state, &configs).await;
    remove_connection_pools_for_connection_ids(&state, &sync.connection_pool_ids_to_drop).await;
    drop_nacos_adapters_for_connection_ids(&state, &sync.nacos_adapter_ids_to_drop).await;
    drop_mq_adapters_for_connection_ids(&state, &sync.mq_adapter_ids_to_drop).await;
    Ok(Json(configs))
}

struct ConnectionConfigSync {
    nacos_adapter_ids_to_drop: Vec<String>,
    mq_adapter_ids_to_drop: Vec<String>,
    connection_pool_ids_to_drop: Vec<String>,
}

async fn sync_connection_configs(state: &WebState, configs: &[ConnectionConfig]) -> ConnectionConfigSync {
    let saved_ids: HashSet<&str> = configs.iter().map(|config| config.id.as_str()).collect();
    let mut nacos_adapter_ids_to_drop = HashSet::new();
    let mut mq_adapter_ids_to_drop = HashSet::new();
    let mut connection_pool_ids_to_drop = HashSet::new();
    let mut runtime_configs = state.app.configs.write().await;
    runtime_configs.retain(|id, existing| {
        if saved_ids.contains(id.as_str()) || should_retain_runtime_config(id, existing) {
            true
        } else {
            connection_pool_ids_to_drop.insert(id.clone());
            // 连接已被全局删除：清除所有 Web owner 的临时凭据与池 owner。
            state.app.session_credentials.clear_connection(id);
            if existing.db_type == dbx_core::models::connection::DatabaseType::Nacos {
                nacos_adapter_ids_to_drop.insert(id.clone());
            }
            if existing.db_type == dbx_core::models::connection::DatabaseType::MessageQueue {
                mq_adapter_ids_to_drop.insert(id.clone());
            }
            false
        }
    });
    for config in configs {
        if config.db_type == dbx_core::models::connection::DatabaseType::Nacos {
            nacos_adapter_ids_to_drop.insert(config.id.clone());
        }
        if config.db_type == dbx_core::models::connection::DatabaseType::MessageQueue {
            mq_adapter_ids_to_drop.insert(config.id.clone());
        }
        if let Some(previous) = runtime_configs.insert(config.id.clone(), config.clone()) {
            if previous.db_type == dbx_core::models::connection::DatabaseType::Nacos {
                nacos_adapter_ids_to_drop.insert(config.id.clone());
            }
            if previous.db_type == dbx_core::models::connection::DatabaseType::MessageQueue {
                mq_adapter_ids_to_drop.insert(config.id.clone());
            }
            if !connection_configs_session_credentials_compatible(&previous, config) {
                // 全局端点或认证身份变化时清除所有 owner 的旧凭据；显示范围等
                // 本地设置不改变凭据归属，必须保留各 owner 的 no-save 密码。
                state.app.session_credentials.clear_connection(&config.id);
            }
            // 仅在真实连接参数变化时销毁池；save_password=false 连接因持久化
            // 空密码与运行态密码产生的差异被忽略（见 connection_configs_pool_equivalent）。
            if !connection_configs_pool_equivalent(&previous, config) {
                connection_pool_ids_to_drop.insert(config.id.clone());
            }
        }
    }
    ConnectionConfigSync {
        nacos_adapter_ids_to_drop: nacos_adapter_ids_to_drop.into_iter().collect(),
        mq_adapter_ids_to_drop: mq_adapter_ids_to_drop.into_iter().collect(),
        connection_pool_ids_to_drop: connection_pool_ids_to_drop.into_iter().collect(),
    }
}

async fn drop_nacos_adapters_for_connection_ids(state: &WebState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.app.nacos_registry.drop_connection(connection_id).await;
    }
}

#[cfg(feature = "mq-admin")]
async fn drop_mq_adapters_for_connection_ids(state: &WebState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.app.mq_registry.drop_connection(connection_id).await;
    }
}

#[cfg(not(feature = "mq-admin"))]
async fn drop_mq_adapters_for_connection_ids(_state: &WebState, _connection_ids: &[String]) {}

async fn remove_connection_pools_for_connection_ids(state: &WebState, connection_ids: &[String]) {
    for connection_id in connection_ids {
        state.app.remove_connection_pools_detached(connection_id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_mongo_legacy_driver_profile, connect_db, connection_final_proxy_port, disconnect_db, load_connections,
        mark_mongo_legacy_driver, mcp_add_connection, mcp_duplicate_connection, mcp_remove_connection,
        run_temporary_connection_test, save_connection_database_info, save_connections, sync_connection_configs,
        test_connection, test_connection_with_info, ConnectRequest, DisconnectRequest, McpAddConnectionRequest,
        McpDuplicateConnectionRequest, McpRemoveConnectionRequest, SaveConnectionDatabaseInfoRequest,
        SaveConnectionsRequest,
    };
    use crate::state::WebState;
    use axum::extract::State;
    use axum::http::HeaderMap;
    use axum::Json;
    use dbx_core::connection::{AppState, PoolKind};
    use dbx_core::models::connection::{
        AttachedDatabaseConfig, ConnectionConfig, DatabaseConnectionInfo, DatabaseType, ProxyTunnelConfig, ProxyType,
        TransportLayerConfig,
    };
    use dbx_core::nacos::config::{
        NacosAuthConfig, NacosRNacosConsoleAuth, NACOS_CONSOLE_SESSION_PASSWORD, NACOS_PRIMARY_SESSION_PASSWORD,
    };
    use dbx_core::storage::{McpGlobalPolicy, Storage};
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

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
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: dbx_core::models::connection::default_connect_timeout_secs(),
            query_timeout_secs: dbx_core::models::connection::default_query_timeout_secs(),
            idle_timeout_secs: dbx_core::models::connection::default_idle_timeout_secs(),
            keepalive_interval_secs: dbx_core::models::connection::default_keepalive_interval_secs(),
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

    fn mq_config(id: &str, admin_url: &str) -> ConnectionConfig {
        let mut config = sqlite_config(id, "");
        config.name = "Pulsar".to_string();
        config.db_type = DatabaseType::MessageQueue;
        config.external_config = Some(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": admin_url,
            "auth": { "kind": "none" },
            "pinnedVersion": "3.1"
        }));
        config
    }

    fn nacos_config(id: &str) -> ConnectionConfig {
        let mut config = sqlite_config(id, "");
        config.name = "Nacos".to_string();
        config.db_type = DatabaseType::Nacos;
        config.host = "127.0.0.1".to_string();
        config.port = 8848;
        config.username = "ordinary-user".to_string();
        config.save_password = false;
        config.visible_databases = Some(vec!["namespace-a".to_string()]);
        config.external_config = Some(serde_json::json!({
            "implementation": "nacos",
            "versionMode": "v3",
            "apiPlane": "admin",
            "serverAddr": "http://127.0.0.1:8848",
            "managedNamespaces": ["namespace-a"],
            "rnacosConsoleAddr": "http://127.0.0.1:10848",
            "rnacosConsoleAuth": {
                "kind": "usernamePassword",
                "username": "console-user",
                "password": "console-password"
            },
            "auth": {
                "kind": "usernamePassword",
                "username": "ordinary-user",
                "password": "old-password"
            }
        }));
        config
    }

    fn consul_config(id: &str, server_addr: &str) -> ConnectionConfig {
        let parsed = reqwest::Url::parse(server_addr).unwrap();
        let mut config = sqlite_config(id, "");
        config.name = "Consul".to_string();
        config.db_type = DatabaseType::Consul;
        config.host = parsed.host_str().unwrap().to_string();
        config.port = parsed.port().unwrap();
        config.external_config = Some(serde_json::json!({
            "serverAddr": server_addr,
            "agentTarget": {
                "node": "expected-agent",
                "address": "127.0.0.1"
            }
        }));
        config
    }

    #[test]
    fn mongo_legacy_marker_updates_only_mongodb_profiles() {
        let mut mongo = sqlite_config("mongo", "");
        mongo.db_type = DatabaseType::MongoDb;
        mongo.driver_profile = Some("legacy".to_string());
        assert!(mark_mongo_legacy_driver(&mut mongo));
        assert_eq!(mongo.driver_profile.as_deref(), Some("mongodb-legacy"));
        assert_eq!(mongo.driver_label.as_deref(), Some("MongoDB (Legacy)"));
        assert!(!mark_mongo_legacy_driver(&mut mongo));

        let mut sqlite = sqlite_config("sqlite", ":memory:");
        assert!(!mark_mongo_legacy_driver(&mut sqlite));
        assert_eq!(sqlite.driver_profile, None);
    }

    #[tokio::test]
    async fn mongo_legacy_profile_sync_preserves_unrelated_saved_connections() {
        let (state, dir) = test_web_state().await;
        let mut mongo = sqlite_config("mongo", "");
        mongo.db_type = DatabaseType::MongoDb;
        let other = sqlite_config("other", ":memory:");
        state.app.storage.save_connections(&[mongo.clone(), other.clone()]).await.unwrap();
        let mut current = mongo.clone();
        current.note = "Updated while connecting".to_string();
        state.app.configs.write().await.insert(current.id.clone(), current);

        apply_mongo_legacy_driver_profile(&state, &mongo).await.unwrap();

        let runtime = state.app.configs.read().await.get(&mongo.id).cloned().unwrap();
        assert_eq!(runtime.note, "Updated while connecting");
        assert_eq!(runtime.driver_profile.as_deref(), Some("mongodb-legacy"));
        assert_eq!(runtime.driver_label.as_deref(), Some("MongoDB (Legacy)"));
        let saved = state.app.storage.load_connections().await.unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!(
            saved.iter().find(|config| config.id == mongo.id).and_then(|config| config.driver_profile.as_deref()),
            Some("mongodb-legacy")
        );
        assert!(saved.iter().any(|config| config.id == other.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mongo_legacy_profile_sync_does_not_overwrite_a_replacement_connection() {
        let (state, dir) = test_web_state().await;
        let mut original = sqlite_config("mongo", "");
        original.db_type = DatabaseType::MongoDb;
        state.app.storage.save_connections(std::slice::from_ref(&original)).await.unwrap();

        let mut replacement = original.clone();
        replacement.host = "replacement.example.com".to_string();
        replacement.name = "Replacement MongoDB".to_string();
        state.app.storage.save_connections(std::slice::from_ref(&replacement)).await.unwrap();
        state.app.configs.write().await.insert(replacement.id.clone(), replacement.clone());

        apply_mongo_legacy_driver_profile(&state, &original).await.unwrap();

        assert_eq!(state.app.configs.read().await.get(&replacement.id), Some(&replacement));
        assert_eq!(state.app.storage.load_connections().await.unwrap(), vec![replacement]);

        let _ = std::fs::remove_dir_all(dir);
    }

    async fn test_web_state() -> (Arc<WebState>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbx-web-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState::for_tests(app, dir.clone()));
        (state, dir)
    }

    #[tokio::test]
    async fn connection_test_info_preserves_legacy_string_and_cleans_up_temporary_state() {
        let (state, dir) = test_web_state().await;
        let db_path = dir.join("test-info.db");
        std::fs::File::create(&db_path).unwrap();
        let config = sqlite_config("sqlite-test", &db_path.to_string_lossy());

        let legacy = test_connection(
            State(state.clone()),
            Json(ConnectRequest { config: config.clone(), client_attempt: None }),
        )
        .await
        .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(legacy.0, "Connection successful");

        let detailed =
            test_connection_with_info(State(state.clone()), Json(ConnectRequest { config, client_attempt: None }))
                .await
                .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(detailed.0.message, "Connection successful");
        assert_eq!(detailed.0.database_info, None);
        assert!(state.app.configs.read().await.keys().all(|key| !key.starts_with("__test_")));
        assert!(state.app.connections.read().await.keys().all(|key| !key.starts_with("__test_")));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn failed_consul_agent_target_validation_cleans_up_temporary_state() {
        let (state, dir) = test_web_state().await;
        let server_addr = spawn_consul_agent_server().await;
        let config = consul_config("consul-test", &server_addr);

        let error = run_temporary_connection_test(&state.app, config, false).await.unwrap_err();

        assert!(error.contains("CONSUL_AGENT_TARGET_MISMATCH"), "unexpected error: {error}");
        assert!(state.app.configs.read().await.keys().all(|key| !key.starts_with("__test_")));
        assert!(state.app.connections.read().await.keys().all(|key| !key.starts_with("__test_")));

        let _ = std::fs::remove_dir_all(dir);
    }

    async fn spawn_consul_agent_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0_u8; 2048];
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let body = if request.starts_with("GET /v1/agent/self ") {
                        r#"{"Config":{"NodeName":"actual-agent","Datacenter":"dc1"},"Member":{"Addr":"127.0.0.1","Tags":{}}}"#
                    } else {
                        "[]"
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn mq_connection_test_does_not_retain_temporary_adapter() {
        let (state, dir) = test_web_state().await;
        let admin_url = spawn_pulsar_clusters_server().await;
        let config = mq_config("pulsar-probe", &admin_url);

        let result = test_connection(State(state.clone()), Json(ConnectRequest { config, client_attempt: None }))
            .await
            .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(result.0, "Connection successful");

        assert!(state.app.configs.read().await.keys().all(|key| !key.starts_with("__test_")));
        assert!(state.app.connections.read().await.keys().all(|key| !key.starts_with("__test_")));
        let cached = state.app.mq_registry.cached_connection_ids().await;
        assert!(
            cached.iter().all(|id| !id.starts_with("__test_")),
            "temporary MQ connection tests must not retain registry adapters: {cached:?}"
        );
        assert!(!state.app.mq_registry.has_cached_connection("pulsar-probe").await);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn invalid_persistent_sqlite_attachments_do_not_replace_live_web_state() {
        let (state, dir) = test_web_state().await;
        let initial = sqlite_config("sqlite-memory", ":memory:");
        let pool = dbx_core::db::sqlite::connect_path(":memory:").await.unwrap();
        dbx_core::db::sqlite::execute_query(
            &pool,
            "CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('yes');",
        )
        .await
        .unwrap();
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.app.connections.write().await.insert(initial.id.clone(), PoolKind::Sqlite(pool.clone()));

        let mut invalid = initial.clone();
        invalid.attached_databases.push(AttachedDatabaseConfig {
            name: "analytics".to_string(),
            path: dir.join("analytics.sqlite").to_string_lossy().to_string(),
        });
        let connect_error = connect_db(
            State(state.clone()),
            HeaderMap::new(),
            Json(ConnectRequest { config: invalid.clone(), client_attempt: None }),
        )
        .await
        .unwrap_err();
        assert!(connect_error.message.contains("in-memory main database"), "{}", connect_error.message);

        invalid.transport_layers.push(TransportLayerConfig::Proxy(ProxyTunnelConfig {
            id: "proxy".to_string(),
            name: "Proxy".to_string(),
            enabled: true,
            proxy_type: ProxyType::Socks5,
            host: "127.0.0.1".to_string(),
            port: 1080,
            username: String::new(),
            password: String::new(),
            test_target: None,
            profile_id: String::new(),
        }));
        let proxy_error = connection_final_proxy_port(
            State(state.clone()),
            HeaderMap::new(),
            Json(ConnectRequest { config: invalid, client_attempt: None }),
        )
        .await
        .unwrap_err();
        assert!(proxy_error.message.contains("in-memory main database"), "{}", proxy_error.message);

        assert!(state.app.connections.read().await.contains_key(&initial.id));
        assert_eq!(state.app.configs.read().await.get(&initial.id), Some(&initial));
        let retained = dbx_core::db::sqlite::execute_query(&pool, "SELECT value FROM retained;").await.unwrap();
        assert_eq!(retained.rows[0][0], serde_json::json!("yes"));

        drop(pool);
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    async fn spawn_pulsar_clusters_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0_u8; 1024];
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let status =
                        if request.starts_with("GET /admin/v2/clusters ") { "200 OK" } else { "404 Not Found" };
                    let body = if status.starts_with("200") { r#"["ec-pulsar"]"# } else { r#"{"reason":"missing"}"# };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn save_connections_updates_runtime_config_cache() {
        let (state, dir) = test_web_state().await;
        let db_path = dir.join("app.db");
        let config = sqlite_config("sqlite-conn", &db_path.to_string_lossy());

        let result = save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest { configs: vec![config.clone()] }),
        )
        .await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        assert_eq!(configs.get("sqlite-conn").map(|c| c.host.as_str()), Some(config.host.as_str()));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mcp_connection_routes_preserve_unrelated_concurrent_changes() {
        let (state, dir) = test_web_state().await;
        let mut existing = sqlite_config("existing", &dir.join("before.db").to_string_lossy());
        state.app.storage.save_connections(std::slice::from_ref(&existing)).await.unwrap();
        state
            .app
            .storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: false,
                allow_dangerous_sql: false,
                allowed_connection_ids: Some(vec![existing.id.clone()]),
            })
            .await
            .unwrap();

        // Simulate a Web UI edit after the MCP client last observed the list.
        existing.host = dir.join("after.db").to_string_lossy().into_owned();
        state.app.storage.save_connections(std::slice::from_ref(&existing)).await.unwrap();
        let added = sqlite_config("added", &dir.join("added.db").to_string_lossy());
        let result =
            mcp_add_connection(State(state.clone()), Json(McpAddConnectionRequest { config: added.clone() })).await;
        assert!(result.is_ok());

        let persisted = state.app.storage.load_connections().await.unwrap();
        assert_eq!(persisted.len(), 2);
        assert_eq!(
            persisted.iter().find(|config| config.id == existing.id).map(|config| config.host.as_str()),
            Some(existing.host.as_str())
        );
        assert!(persisted.iter().any(|config| config.id == added.id));
        assert!(state.app.configs.read().await.contains_key(&added.id));

        state
            .app
            .storage
            .save_sidebar_layout(&serde_json::json!({
                "groups": [{ "id": "group", "name": "Group" }],
                "order": [{
                    "type": "group",
                    "id": "group",
                    "children": [{ "type": "connection", "id": "existing" }]
                }, { "type": "connection", "id": "added" }],
                "concurrentField": "keep"
            }))
            .await
            .unwrap();
        let copied = mcp_duplicate_connection(
            State(state.clone()),
            Json(McpDuplicateConnectionRequest {
                source_id: existing.id.clone(),
                copy_id: "copy".to_string(),
                copy_name: "Existing Copy".to_string(),
            }),
        )
        .await
        .unwrap_or_else(|error| panic!("{}", error.message))
        .0;
        assert_eq!(state.app.configs.read().await.get(&copied.id), Some(&copied));
        let persisted = state.app.storage.load_connections().await.unwrap();
        assert_eq!(persisted.iter().find(|config| config.id == existing.id).unwrap().host, existing.host);
        assert!(persisted.iter().any(|config| config.id == added.id));
        let layout = state.app.storage.load_sidebar_layout().await.unwrap().unwrap();
        assert_eq!(layout["concurrentField"], "keep");
        assert_eq!(layout["order"][0]["children"][0]["id"], existing.id);
        assert_eq!(layout["order"][0]["children"][1]["id"], copied.id);
        assert_eq!(layout["order"][1]["id"], added.id);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn mcp_connection_routes_recheck_read_only_and_allowlist_in_the_mutation_transaction() {
        let (state, dir) = test_web_state().await;
        let kept = sqlite_config("kept", &dir.join("kept.db").to_string_lossy());
        let removed = sqlite_config("removed", &dir.join("removed.db").to_string_lossy());
        state.app.storage.save_connections(&[kept.clone(), removed.clone()]).await.unwrap();
        state
            .app
            .storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: false,
                allow_dangerous_sql: false,
                allowed_connection_ids: Some(vec![removed.id.clone()]),
            })
            .await
            .unwrap();

        let removed_result = mcp_remove_connection(
            State(state.clone()),
            HeaderMap::new(),
            Json(McpRemoveConnectionRequest { connection_id: removed.id.clone() }),
        )
        .await
        .unwrap_or_else(|error| panic!("{}", error.message));
        assert!(removed_result.0);
        assert_eq!(state.app.storage.load_connections().await.unwrap()[0].id, kept.id);

        let scope_error = mcp_remove_connection(
            State(state.clone()),
            HeaderMap::new(),
            Json(McpRemoveConnectionRequest { connection_id: kept.id.clone() }),
        )
        .await
        .unwrap_err();
        assert!(scope_error.message.starts_with("CONNECTION_OUT_OF_SCOPE:"));

        state
            .app
            .storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: true,
                allow_dangerous_sql: false,
                allowed_connection_ids: None,
            })
            .await
            .unwrap();
        let read_only_error = mcp_add_connection(
            State(state.clone()),
            Json(McpAddConnectionRequest { config: sqlite_config("new", &dir.join("new.db").to_string_lossy()) }),
        )
        .await
        .unwrap_err();
        assert!(read_only_error.message.starts_with("MCP_READ_ONLY:"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn save_connection_database_info_preserves_connected_pool() {
        let (state, dir) = test_web_state().await;
        let config = mq_config("mq-info", "http://127.0.0.1:8080");
        state.app.storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
        state.app.configs.write().await.insert(config.id.clone(), config.clone());
        state.app.connections.write().await.insert(config.id.clone(), PoolKind::MessageQueue);
        let database_info = DatabaseConnectionInfo {
            product_name: Some("Apache Pulsar".to_string()),
            product_version: Some("3.3.0".to_string()),
            ..DatabaseConnectionInfo::default()
        };

        let result = save_connection_database_info(
            State(state.clone()),
            Json(SaveConnectionDatabaseInfoRequest {
                connection_id: config.id.clone(),
                database_info: Some(database_info.clone()),
            }),
        )
        .await;

        assert!(result.is_ok());
        assert!(state.app.connections.read().await.contains_key(&config.id));
        assert_eq!(state.app.configs.read().await[&config.id].database_info, Some(database_info.clone()));
        assert_eq!(state.app.storage.load_connections().await.unwrap()[0].database_info, Some(database_info));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn save_connections_drops_cached_mq_adapter_for_updated_config() {
        let (state, dir) = test_web_state().await;
        let initial = mq_config("mq-conn", "http://127.0.0.1:8080");
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.app.connections.write().await.insert(initial.id.clone(), PoolKind::MessageQueue);
        let first = state.app.mq_registry.get_or_build(&initial).await.unwrap().adapter;

        let updated = mq_config("mq-conn", "http://127.0.0.1:8081");
        let result = save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest { configs: vec![updated.clone()] }),
        )
        .await;
        assert!(result.is_ok());

        let cached_admin_url = state
            .app
            .configs
            .read()
            .await
            .get("mq-conn")
            .and_then(|config| config.external_config.as_ref())
            .and_then(|external| external.get("adminUrl"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        assert_eq!(cached_admin_url.as_deref(), Some("http://127.0.0.1:8081"));

        let second = state.app.mq_registry.get_or_build(&updated).await.unwrap().adapter;
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(!state.app.connections.read().await.contains_key(&initial.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn connect_db_rebuilds_mq_adapter_for_updated_config_with_same_id() {
        let (state, dir) = test_web_state().await;
        let initial = mq_config("mq-conn", "http://127.0.0.1:8080");
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.app.connections.write().await.insert(initial.id.clone(), PoolKind::MessageQueue);
        let first = state.app.mq_registry.get_or_build(&initial).await.unwrap().adapter;

        let updated = mq_config("mq-conn", &spawn_pulsar_clusters_server().await);
        let result = connect_db(
            State(state.clone()),
            HeaderMap::new(),
            Json(ConnectRequest { config: updated.clone(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        let second = state.app.mq_registry.get_or_build(&updated).await.unwrap().adapter;
        assert!(!Arc::ptr_eq(&first, &second));

        let _ = std::fs::remove_dir_all(dir);
    }

    fn cookie_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("cookie", format!("dbx_session={token}").parse().unwrap());
        headers
    }

    /// 回归：Web connect_db 不得把明文 no-save 密码写入全局 AppState.configs，
    /// 且凭据严格按登录会话隔离——会话 B 无法复用/重建出会话 A 的密码。
    #[tokio::test]
    async fn connect_db_sanitizes_global_config_and_scopes_password_by_session() {
        let (state, dir) = test_web_state().await;
        let db_path = dir.join("a.db").to_string_lossy().to_string();
        std::fs::File::create(&db_path).unwrap();
        {
            let mut sessions = state.sessions.write().await;
            sessions.insert("token-a".to_string());
            sessions.insert("token-b".to_string());
        }
        let headers_a = cookie_headers("token-a");

        let mut config = sqlite_config("conn-a", &db_path);
        config.save_password = false;
        config.password = "hunter2".to_string();

        // 会话 A 以输入的密码连接（在 A 的 owner 作用域内，模拟中间件注入）。
        let connect_guard = state.clone();
        let result = dbx_core::session_credentials::with_credential_owner(Some("token-a".to_string()), async move {
            connect_db(
                State(connect_guard),
                headers_a,
                Json(ConnectRequest { config: config.clone(), client_attempt: None }),
            )
            .await
        })
        .await;
        assert!(result.is_ok());

        // 全局运行态配置不含明文密码（泄露面消除）。
        let stored = state.app.configs.read().await.get("conn-a").cloned().unwrap();
        assert_eq!(stored.password, "");
        // A 的凭据按 owner 记录；B 不可见。
        assert!(state.app.session_credentials.has("token-a", "conn-a"));
        assert!(!state.app.session_credentials.has("token-b", "conn-a"));

        // A 自身重建（owner=token-a 作用域）能从会话仓库取回密码。
        dbx_core::session_credentials::with_credential_owner(Some("token-a".to_string()), async {
            let mut db_config = dbx_core::connection::metadata_connection_config(&stored);
            state.app.apply_session_credential(&stored, &mut db_config, "conn-a");
            assert_eq!(db_config.password, "hunter2");
        })
        .await;
        // 会话 B 重建只能得到空密码——拿不到 A 的密码。
        dbx_core::session_credentials::with_credential_owner(Some("token-b".to_string()), async {
            let mut db_config = dbx_core::connection::metadata_connection_config(&stored);
            state.app.apply_session_credential(&stored, &mut db_config, "conn-a");
            assert_eq!(db_config.password, "");
        })
        .await;

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn save_connections_scopes_all_nacos_no_save_passwords_to_the_request_owner() {
        let (state, dir) = test_web_state().await;
        let config = nacos_config("nacos-a");
        let headers_a = cookie_headers("token-a");

        let _ =
            save_connections(State(state.clone()), headers_a, Json(SaveConnectionsRequest { configs: vec![config] }))
                .await
                .unwrap();

        let runtime = state.app.configs.read().await.get("nacos-a").cloned().unwrap();
        assert!(runtime.password.is_empty());
        let external = runtime.external_config.as_ref().unwrap();
        assert_eq!(external["auth"]["password"], "");
        assert_eq!(external["rnacosConsoleAuth"]["password"], "");
        assert_eq!(
            state
                .app
                .session_credentials
                .get_for_purpose("token-a", "nacos-a", NACOS_PRIMARY_SESSION_PASSWORD)
                .as_deref(),
            Some("old-password")
        );
        assert_eq!(
            state
                .app
                .session_credentials
                .get_for_purpose("token-a", "nacos-a", NACOS_CONSOLE_SESSION_PASSWORD)
                .as_deref(),
            Some("console-password")
        );
        assert_eq!(
            state.app.session_credentials.get_for_purpose("token-b", "nacos-a", NACOS_PRIMARY_SESSION_PASSWORD),
            None
        );
        assert_eq!(
            state.app.session_credentials.get_for_purpose("token-b", "nacos-a", NACOS_CONSOLE_SESSION_PASSWORD),
            None
        );

        dbx_core::session_credentials::with_credential_owner(Some("token-a".to_string()), async {
            let parsed = state.app.nacos_admin_config_for_connection("nacos-a", &runtime).await.unwrap();
            assert!(matches!(
                parsed.auth,
                NacosAuthConfig::UsernamePassword { ref password, .. } if password == "old-password"
            ));
            assert!(matches!(
                parsed.rnacos_console_auth,
                NacosRNacosConsoleAuth::UsernamePassword { ref password, .. } if password == "console-password"
            ));
        })
        .await;
        dbx_core::session_credentials::with_credential_owner(Some("token-b".to_string()), async {
            let parsed = state.app.nacos_admin_config_for_connection("nacos-a", &runtime).await.unwrap();
            assert!(matches!(
                parsed.auth,
                NacosAuthConfig::UsernamePassword { ref password, .. } if password.is_empty()
            ));
            assert!(matches!(
                parsed.rnacos_console_auth,
                NacosRNacosConsoleAuth::UsernamePassword { ref password, .. } if password.is_empty()
            ));
        })
        .await;

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn connection_final_proxy_port_sanitizes_no_save_passwords() {
        let (state, dir) = test_web_state().await;
        let mut config = sqlite_config("conn-a", "127.0.0.1");
        config.port = 3306;
        config.save_password = false;
        config.password = "session-secret".to_string();
        config.transport_layers.push(TransportLayerConfig::Proxy(ProxyTunnelConfig {
            id: "proxy".to_string(),
            name: "Proxy".to_string(),
            enabled: true,
            proxy_type: ProxyType::Socks5,
            host: "127.0.0.1".to_string(),
            port: 65000,
            username: String::new(),
            password: String::new(),
            test_target: None,
            profile_id: String::new(),
        }));

        let result = connection_final_proxy_port(
            State(state.clone()),
            cookie_headers("token-a"),
            Json(ConnectRequest { config, client_attempt: None }),
        )
        .await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(state.app.configs.read().await["conn-a"].password, "");
        assert!(state.app.session_credentials.has("token-a", "conn-a"));
        assert!(!state.app.session_credentials.has("token-b", "conn-a"));

        state.app.reset_connection_transport("conn-a").await;
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 回归：无密码重连（复用既有会话凭据）失败时，不得清除既有凭据——瞬时
    /// 数据库/网络故障不应让"本次会话内记住密码"失效、下次又弹窗。
    #[tokio::test]
    async fn failed_passwordless_reconnect_preserves_existing_session_credential() {
        let (state, dir) = test_web_state().await;
        let headers_a = cookie_headers("token-a");

        let mut config = sqlite_config("conn-a", &dir.join("missing.db").to_string_lossy());
        config.save_password = false;
        config.password.clear();

        // 会话 A 已持有该连接的有效会话凭据。
        let _ = state.app.session_credentials.set("token-a", "conn-a", "hunter2");
        assert!(state.app.session_credentials.has("token-a", "conn-a"));

        // 无密码重连（配置里没带密码，应复用既有凭据）因目标文件缺失而失败。
        let result = connect_db(
            State(state.clone()),
            headers_a,
            Json(ConnectRequest { config: config.clone(), client_attempt: None }),
        )
        .await;
        assert!(result.is_err());

        // 既有会话凭据必须保留，下次重连无需重新输入密码。
        assert!(state.app.session_credentials.has("token-a", "conn-a"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn load_connections_drops_cached_pool_for_updated_config() {
        let (state, dir) = test_web_state().await;
        let initial = mq_config("mq-conn", "http://127.0.0.1:8080");
        let updated = mq_config("mq-conn", "http://127.0.0.1:8081");
        state.app.storage.save_connections(std::slice::from_ref(&updated)).await.unwrap();
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        state.app.connections.write().await.insert(initial.id.clone(), PoolKind::MessageQueue);

        let result = load_connections(State(state.clone()), HeaderMap::new()).await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        let cached_admin_url = configs
            .get("mq-conn")
            .and_then(|config| config.external_config.as_ref())
            .and_then(|external| external.get("adminUrl"))
            .and_then(serde_json::Value::as_str);
        assert_eq!(cached_admin_url, Some("http://127.0.0.1:8081"));
        drop(configs);
        assert!(!state.app.connections.read().await.contains_key(&initial.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sync_connection_configs_ignores_password_only_changes() {
        let (state, dir) = test_web_state().await;
        let mut initial = sqlite_config("conn-a", &dir.join("a.db").to_string_lossy());
        initial.save_password = false;
        initial.password = "session-secret".to_string();
        let _ = state.app.session_credentials.set("", "conn-a", "session-secret");
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());

        // 持久化同步的空密码 config 覆盖运行态：save_password=false 连接仅密码
        // 差异不应销毁池（会话密码由内存仓库提供，与运行态 config 无关）。
        let mut updated = initial.clone();
        updated.password.clear();
        let sync = sync_connection_configs(&state, std::slice::from_ref(&updated)).await;
        assert!(sync.connection_pool_ids_to_drop.is_empty());
        assert_eq!(state.app.configs.read().await.get("conn-a").map(|c| c.password.as_str()), Some(""));
        assert!(state.app.session_credentials.has("", "conn-a"));

        // 真实连接参数（host）变化应销毁池，并清除旧会话凭据以便重新输入。
        let mut host_changed = updated.clone();
        host_changed.host = "other-host.db".to_string();
        let sync2 = sync_connection_configs(&state, std::slice::from_ref(&host_changed)).await;
        assert_eq!(sync2.connection_pool_ids_to_drop.as_slice(), &["conn-a".to_string()]);
        assert!(!state.app.session_credentials.has("", "conn-a"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sync_connection_configs_clears_all_owner_credentials_on_global_edit() {
        let (state, dir) = test_web_state().await;
        let mut initial = sqlite_config("conn-a", &dir.join("a.db").to_string_lossy());
        initial.save_password = false;
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        let _ = state.app.session_credentials.set("token-a", "conn-a", "owner-a-secret");
        let _ = state.app.session_credentials.set("token-b", "conn-a", "owner-b-secret");
        state.app.session_credentials.record_pool_owner("conn-a", "token-a");
        assert!(state.app.session_credentials.pool_owner_mismatch("conn-a", "token-b"));

        let mut updated = initial;
        updated.host = dir.join("updated.db").to_string_lossy().to_string();
        let sync = sync_connection_configs(&state, std::slice::from_ref(&updated)).await;

        assert_eq!(sync.connection_pool_ids_to_drop.as_slice(), &["conn-a".to_string()]);
        assert!(!state.app.session_credentials.has("token-a", "conn-a"));
        assert!(!state.app.session_credentials.has("token-b", "conn-a"));
        assert!(!state.app.session_credentials.has_pool_owner("conn-a"));
        assert!(state.app.session_credentials.pool_owner_mismatch("conn-a", "token-b"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sync_connection_configs_preserves_all_nacos_owner_passwords_for_scope_updates() {
        let (state, dir) = test_web_state().await;
        let initial = nacos_config("nacos-a");
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        for (owner, password) in [("token-a", "owner-a-secret"), ("token-b", "owner-b-secret")] {
            let _ = state.app.session_credentials.set(owner, &initial.id, password);
            state.app.session_credentials.set_for_purpose(owner, &initial.id, "nacos-primary-password", password);
        }

        let mut scope_updated = initial.clone();
        scope_updated.visible_databases = Some(vec!["namespace-a".to_string(), "namespace-b".to_string()]);
        scope_updated.external_config.as_mut().unwrap()["managedNamespaces"] =
            serde_json::json!(["namespace-a", "namespace-b"]);
        let sync = sync_connection_configs(&state, std::slice::from_ref(&scope_updated)).await;

        assert_eq!(sync.connection_pool_ids_to_drop.as_slice(), std::slice::from_ref(&initial.id));
        for (owner, password) in [("token-a", "owner-a-secret"), ("token-b", "owner-b-secret")] {
            assert_eq!(state.app.session_credentials.get(owner, &initial.id).as_deref(), Some(password));
            assert_eq!(
                state.app.session_credentials.get_for_purpose(owner, &initial.id, "nacos-primary-password").as_deref(),
                Some(password)
            );
        }

        let mut endpoint_updated = scope_updated;
        endpoint_updated.host = "nacos.internal".to_string();
        endpoint_updated.external_config.as_mut().unwrap()["serverAddr"] =
            serde_json::json!("http://nacos.internal:8848");
        sync_connection_configs(&state, std::slice::from_ref(&endpoint_updated)).await;
        for owner in ["token-a", "token-b"] {
            assert!(!state.app.session_credentials.has(owner, &initial.id));
            assert_eq!(
                state.app.session_credentials.get_for_purpose(owner, &initial.id, "nacos-primary-password"),
                None
            );
        }

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sync_connection_configs_clears_all_owner_credentials_on_delete_and_id_reuse() {
        let (state, dir) = test_web_state().await;
        let mut initial = sqlite_config("conn-a", &dir.join("old.db").to_string_lossy());
        initial.save_password = false;
        state.app.configs.write().await.insert(initial.id.clone(), initial.clone());
        let _ = state.app.session_credentials.set("token-a", "conn-a", "owner-a-secret");
        let _ = state.app.session_credentials.set("token-b", "conn-a", "owner-b-secret");
        state.app.session_credentials.record_pool_owner("conn-a", "token-a");

        let deleted = sync_connection_configs(&state, &[]).await;
        assert_eq!(deleted.connection_pool_ids_to_drop.as_slice(), &["conn-a".to_string()]);
        assert!(!state.app.session_credentials.has("token-a", "conn-a"));
        assert!(!state.app.session_credentials.has("token-b", "conn-a"));
        assert!(!state.app.session_credentials.has_pool_owner("conn-a"));
        assert!(state.app.session_credentials.pool_owner_mismatch("conn-a", "token-b"));

        let _ = state.app.session_credentials.set("token-a", "conn-a", "stale-owner-a-secret");
        let _ = state.app.session_credentials.set("token-b", "conn-a", "stale-owner-b-secret");
        state.app.session_credentials.record_pool_owner("conn-a", "token-a");
        let mut recreated = sqlite_config("conn-a", &dir.join("new.db").to_string_lossy());
        recreated.save_password = false;

        let reused =
            mcp_add_connection(State(state.clone()), Json(McpAddConnectionRequest { config: recreated.clone() }))
                .await
                .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(reused.0.host, recreated.host);
        assert!(!state.app.session_credentials.has("token-a", "conn-a"));
        assert!(!state.app.session_credentials.has("token-b", "conn-a"));
        assert!(!state.app.session_credentials.has_pool_owner("conn-a"));
        assert!(state.app.session_credentials.pool_owner_mismatch("conn-a", "token-b"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn save_connections_removes_deleted_runtime_config_and_mq_adapter() {
        let (state, dir) = test_web_state().await;
        let kept = sqlite_config("kept", &dir.join("kept.db").to_string_lossy());
        let removed = mq_config("removed-mq", "http://127.0.0.1:8080");
        {
            let mut configs = state.app.configs.write().await;
            configs.insert(kept.id.clone(), kept.clone());
            configs.insert(removed.id.clone(), removed.clone());
        }
        let stale = state.app.mq_registry.get_or_build(&removed).await.unwrap().adapter;

        let result = save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest { configs: vec![kept.clone()] }),
        )
        .await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        assert!(configs.contains_key("kept"));
        assert!(!configs.contains_key("removed-mq"));
        drop(configs);

        let rebuilt = state.app.mq_registry.get_or_build(&removed).await.unwrap().adapter;
        assert!(!Arc::ptr_eq(&stale, &rebuilt));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn save_connections_removes_deleted_connection_pools() {
        let (state, dir) = test_web_state().await;
        let kept = sqlite_config("kept", &dir.join("kept.db").to_string_lossy());
        let removed = mq_config("removed-mq", "http://127.0.0.1:8080");
        {
            let mut configs = state.app.configs.write().await;
            configs.insert(kept.id.clone(), kept.clone());
            configs.insert(removed.id.clone(), removed.clone());
        }
        state.app.connections.write().await.insert(removed.id.clone(), PoolKind::MessageQueue);

        let result = save_connections(
            State(state.clone()),
            HeaderMap::new(),
            Json(SaveConnectionsRequest { configs: vec![kept.clone()] }),
        )
        .await;
        assert!(result.is_ok());

        assert!(!state.app.connections.read().await.contains_key(&removed.id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn disconnect_db_keeps_connections_with_similar_prefixes() {
        let (state, dir) = test_web_state().await;
        let conn_path = dir.join("conn.db");
        let conn2_path = dir.join("conn2.db");
        std::fs::File::create(&conn_path).unwrap();
        std::fs::File::create(&conn2_path).unwrap();
        let conn_pool = dbx_core::db::sqlite::connect_path(&conn_path.to_string_lossy()).await.unwrap();
        let conn2_pool = dbx_core::db::sqlite::connect_path(&conn2_path.to_string_lossy()).await.unwrap();

        {
            let mut connections = state.app.connections.write().await;
            connections.insert("conn".to_string(), PoolKind::Sqlite(conn_pool));
            connections.insert("conn2".to_string(), PoolKind::Sqlite(conn2_pool));
        }

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: "conn".to_string(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        let connections = state.app.connections.read().await;
        assert!(!connections.contains_key("conn"));
        assert!(connections.contains_key("conn2"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn disconnect_db_ignores_stale_client_attempt_cancel() {
        let (state, dir) = test_web_state().await;
        let conn_path = dir.join("conn.db");
        std::fs::File::create(&conn_path).unwrap();
        let conn_pool = dbx_core::db::sqlite::connect_path(&conn_path.to_string_lossy()).await.unwrap();
        state.app.begin_connection_attempt_with_client_attempt("conn", Some(1)).await;
        let current_attempt = state.app.begin_connection_attempt_with_client_attempt("conn", Some(2)).await;
        state.app.connections.write().await.insert("conn".to_string(), PoolKind::Sqlite(conn_pool));

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: "conn".to_string(), client_attempt: Some(1) }),
        )
        .await;
        assert!(result.is_ok());

        assert!(state.app.connections.read().await.contains_key("conn"));
        assert!(state.app.ensure_current_connection_attempt("conn", Some(current_attempt)).await.is_ok());

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: "conn".to_string(), client_attempt: Some(2) }),
        )
        .await;
        assert!(result.is_ok());

        assert!(!state.app.connections.read().await.contains_key("conn"));
        assert!(state.app.ensure_current_connection_attempt("conn", Some(current_attempt)).await.is_err());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn disconnect_db_keeps_connection_config_for_reconnect() {
        let (state, dir) = test_web_state().await;
        let conn_path = dir.join("conn.db");
        std::fs::File::create(&conn_path).unwrap();
        let conn_pool = dbx_core::db::sqlite::connect_path(&conn_path.to_string_lossy()).await.unwrap();

        {
            let mut connections = state.app.connections.write().await;
            connections.insert("conn".to_string(), PoolKind::Sqlite(conn_pool));
        }
        {
            let mut configs = state.app.configs.write().await;
            configs.insert("conn".to_string(), sqlite_config("conn", &conn_path.to_string_lossy()));
        }

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: "conn".to_string(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        assert!(configs.contains_key("conn"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(feature = "mq-admin")]
    #[tokio::test]
    async fn disconnect_db_drops_cached_mq_adapter() {
        let (state, dir) = test_web_state().await;
        let config = mq_config("mq-conn", "http://127.0.0.1:8080");
        state.app.configs.write().await.insert(config.id.clone(), config.clone());
        state.app.connections.write().await.insert(config.id.clone(), PoolKind::MessageQueue);
        let first = state.app.mq_registry.get_or_build(&config).await.unwrap().adapter;

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: config.id.clone(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        assert!(!state.app.connections.read().await.contains_key(&config.id));
        let second = state.app.mq_registry.get_or_build(&config).await.unwrap().adapter;
        assert!(!Arc::ptr_eq(&first, &second));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn disconnect_db_removes_visible_database_draft_config() {
        let (state, dir) = test_web_state().await;
        let conn_path = dir.join("draft.db");
        let draft_id = "__visible_draft_test";
        std::fs::File::create(&conn_path).unwrap();

        {
            let mut configs = state.app.configs.write().await;
            configs.insert(draft_id.to_string(), sqlite_config(draft_id, &conn_path.to_string_lossy()));
        }

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: draft_id.to_string(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        let configs = state.app.configs.read().await;
        assert!(!configs.contains_key(draft_id));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sync_connection_configs_retains_one_time_runtime_config_and_its_pool() {
        let (state, dir) = test_web_state().await;
        let mut one_time = sqlite_config("preview-file", &dir.join("preview.db").to_string_lossy());
        one_time.one_time = true;
        state.app.configs.write().await.insert(one_time.id.clone(), one_time.clone());

        // Any other browser tab saving any connection syncs a list that excludes
        // one-time connections.
        let sync = sync_connection_configs(&state, &[]).await;

        assert!(state.app.configs.read().await.contains_key(&one_time.id));
        assert!(
            !sync.connection_pool_ids_to_drop.contains(&one_time.id),
            "one_time connection pool must not be torn down by save sync"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn disconnect_db_removes_one_time_config_and_its_session_credential() {
        let (state, dir) = test_web_state().await;
        let mut one_time = sqlite_config("preview-file", &dir.join("preview.db").to_string_lossy());
        one_time.one_time = true;
        one_time.save_password = false;
        state.app.configs.write().await.insert(one_time.id.clone(), one_time.clone());
        let _ = state.app.session_credentials.set("token-a", &one_time.id, "owner-a-secret");

        let result = disconnect_db(
            State(state.clone()),
            Json(DisconnectRequest { connection_id: one_time.id.clone(), client_attempt: None }),
        )
        .await;
        assert!(result.is_ok());

        assert!(!state.app.configs.read().await.contains_key(&one_time.id));
        assert!(
            !state.app.session_credentials.has("token-a", &one_time.id),
            "the plaintext session password must be cleared along with the config"
        );

        let _ = std::fs::remove_dir_all(dir);
    }
}
