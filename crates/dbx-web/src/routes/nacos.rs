use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::body::Body;
use axum::extract::{Multipart, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::Response;
use axum::Json;
use futures::Stream;
use tokio::io::AsyncWriteExt;

use crate::error::AppError;
use crate::state::{NacosImportContext, WebState};

const MAX_NACOS_ARCHIVE_BYTES: usize = 100 * 1024 * 1024;
const NACOS_IMPORT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const NACOS_SEARCH_PROGRESS_BUFFER: usize = 16;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnReq {
    connection_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NamespaceCreateReq {
    connection_id: String,
    req: dbx_core::nacos::NacosNamespaceCreate,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NamespaceUpdateReq {
    connection_id: String,
    req: dbx_core::nacos::NacosNamespaceUpdate,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigListReq {
    connection_id: String,
    query: dbx_core::nacos::NacosConfigQuery,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigKeyReq {
    connection_id: String,
    key: dbx_core::nacos::NacosConfigKey,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigPublishReq {
    connection_id: String,
    req: dbx_core::nacos::NacosConfigUpsert,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigHistoryListReq {
    connection_id: String,
    query: dbx_core::nacos::NacosConfigHistoryQuery,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigHistoryKeyReq {
    connection_id: String,
    key: dbx_core::nacos::NacosConfigHistoryKey,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigRollbackReq {
    connection_id: String,
    req: dbx_core::nacos::NacosConfigRollbackRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RNacosConsoleLoginReq {
    connection_id: String,
    #[serde(default)]
    captcha: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceListReq {
    connection_id: String,
    query: dbx_core::nacos::NacosServiceQuery,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceListReq {
    connection_id: String,
    query: dbx_core::nacos::NacosInstanceQuery,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceUpdateReq {
    connection_id: String,
    req: dbx_core::nacos::NacosInstanceUpdate,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardReq {
    connection_id: String,
    query: dbx_core::nacos::NacosDashboardQuery,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawReq {
    connection_id: String,
    req: dbx_core::nacos::NacosRawRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContentSearchReq {
    connection_id: String,
    req: dbx_core::nacos::NacosContentSearchRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelOperationReq {
    operation_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigExportReq {
    connection_id: String,
    selector: dbx_core::nacos::NacosConfigSelector,
    #[serde(default)]
    file_name: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigImportApplyReq {
    connection_id: String,
    operation_id: String,
    target_namespace: String,
    archive_token: String,
    plan_hash: String,
    conflict_policy: dbx_core::nacos::NacosConflictPolicy,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigTransferReq {
    req: dbx_core::nacos::NacosConfigTransferRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigTransferApplyReq {
    req: dbx_core::nacos::NacosConfigTransferRequest,
    plan_hash: String,
}

pub async fn test_connection(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConnReq>,
) -> Result<Json<dbx_core::nacos::NacosConnectionInfo>, AppError> {
    let result = dbx_core::nacos::service::nacos_test_connection_core(&state.app, &req.connection_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_namespaces(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConnReq>,
) -> Result<Json<Vec<dbx_core::nacos::NacosNamespaceInfo>>, AppError> {
    let result = dbx_core::nacos::service::nacos_list_namespaces_core(&state.app, &req.connection_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn create_namespace(
    State(state): State<Arc<WebState>>,
    Json(req): Json<NamespaceCreateReq>,
) -> Result<Json<()>, AppError> {
    dbx_core::nacos::service::nacos_create_namespace_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn update_namespace(
    State(state): State<Arc<WebState>>,
    Json(req): Json<NamespaceUpdateReq>,
) -> Result<Json<()>, AppError> {
    dbx_core::nacos::service::nacos_update_namespace_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn list_configs(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigListReq>,
) -> Result<Json<dbx_core::nacos::NacosConfigList>, AppError> {
    let result = dbx_core::nacos::service::nacos_list_configs_core(&state.app, &req.connection_id, req.query)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_config(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigKeyReq>,
) -> Result<Json<dbx_core::nacos::NacosConfigItem>, AppError> {
    let result = dbx_core::nacos::service::nacos_get_config_core(&state.app, &req.connection_id, req.key)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn publish_config(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigPublishReq>,
) -> Result<Json<()>, AppError> {
    dbx_core::nacos::service::nacos_publish_config_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_config(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigKeyReq>,
) -> Result<Json<()>, AppError> {
    dbx_core::nacos::service::nacos_delete_config_core(&state.app, &req.connection_id, req.key)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn list_config_history(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigHistoryListReq>,
) -> Result<Json<dbx_core::nacos::NacosConfigHistoryList>, AppError> {
    let result = dbx_core::nacos::service::nacos_list_config_history_core(&state.app, &req.connection_id, req.query)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn get_config_history(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigHistoryKeyReq>,
) -> Result<Json<dbx_core::nacos::NacosConfigItem>, AppError> {
    let result = dbx_core::nacos::service::nacos_get_config_history_core(&state.app, &req.connection_id, req.key)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn rollback_config(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigRollbackReq>,
) -> Result<Json<()>, AppError> {
    dbx_core::nacos::service::nacos_rollback_config_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn get_rnacos_console_captcha(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConnReq>,
) -> Result<Json<dbx_core::nacos::NacosRNacosConsoleCaptcha>, AppError> {
    let result = dbx_core::nacos::service::nacos_get_rnacos_console_captcha_core(&state.app, &req.connection_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn login_rnacos_console(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RNacosConsoleLoginReq>,
) -> Result<Json<()>, AppError> {
    dbx_core::nacos::service::nacos_login_rnacos_console_core(&state.app, &req.connection_id, req.captcha)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn list_services(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ServiceListReq>,
) -> Result<Json<dbx_core::nacos::NacosServiceList>, AppError> {
    let result = dbx_core::nacos::service::nacos_list_services_core(&state.app, &req.connection_id, req.query)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn list_instances(
    State(state): State<Arc<WebState>>,
    Json(req): Json<InstanceListReq>,
) -> Result<Json<Vec<dbx_core::nacos::NacosInstanceInfo>>, AppError> {
    let result = dbx_core::nacos::service::nacos_list_instances_core(&state.app, &req.connection_id, req.query)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn update_instance(
    State(state): State<Arc<WebState>>,
    Json(req): Json<InstanceUpdateReq>,
) -> Result<Json<()>, AppError> {
    dbx_core::nacos::service::nacos_update_instance_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn get_dashboard(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DashboardReq>,
) -> Result<Json<dbx_core::nacos::NacosDashboardSnapshot>, AppError> {
    let result = dbx_core::nacos::service::nacos_get_dashboard_core(&state.app, &req.connection_id, req.query)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn raw_request(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RawReq>,
) -> Result<Json<dbx_core::nacos::NacosRawResponse>, AppError> {
    let result = dbx_core::nacos::service::nacos_raw_request_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}

pub async fn search_config_content(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ContentSearchReq>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(NACOS_SEARCH_PROGRESS_BUFFER);
    let stream = async_stream::stream! {
        let progress_tx = tx.clone();
        // Keep the channel open until the search future yields its terminal
        // result so the biased receiver branch never wins with `None`.
        let _channel_guard = tx;
        let search = dbx_core::nacos::service::nacos_search_config_content_core(
            &state.app,
            &req.connection_id,
            req.req,
            move |progress| {
                let progress_tx = progress_tx.clone();
                let event = serde_json::json!({ "type": "progress", "progress": progress });
                async move {
                    let _ = progress_tx.send(event.to_string()).await;
                }
            },
        );
        tokio::pin!(search);

        loop {
            tokio::select! {
                biased;
                data = rx.recv() => {
                    if let Some(data) = data {
                        yield Ok(Event::default().data(data));
                    }
                }
                result = &mut search => {
                    let event = match result {
                        Ok(result) => serde_json::json!({ "type": "result", "result": result }),
                        Err(error) => serde_json::json!({ "type": "error", "error": error }),
                    };
                    yield Ok(Event::default().data(event.to_string()));
                    break;
                }
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

pub async fn cancel_operation(Json(req): Json<CancelOperationReq>) -> Json<serde_json::Value> {
    let cancelled = dbx_core::nacos::service::nacos_cancel_operation_core(&req.operation_id);
    Json(serde_json::json!({ "cancelled": cancelled }))
}

pub async fn export_configs(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigExportReq>,
) -> Result<Response, AppError> {
    let export_dir = state.data_dir.join("tmp").join("nacos_export");
    tokio::fs::create_dir_all(&export_dir).await.map_err(|error| AppError::from(error.to_string()))?;
    let archive_path = export_dir.join(format!("{}.zip", uuid::Uuid::new_v4()));

    let export_result = dbx_core::nacos::batch::nacos_export_config_archive_core(
        &state.app,
        &req.connection_id,
        req.selector,
        &archive_path,
    )
    .await;
    if let Err(error) = export_result {
        let _ = tokio::fs::remove_file(&archive_path).await;
        return Err(AppError::from(error));
    }

    let archive = tokio::fs::read(&archive_path).await.map_err(|error| AppError::from(error.to_string()));
    let _ = tokio::fs::remove_file(&archive_path).await;
    let archive = archive?;
    let file_name = sanitize_archive_file_name(req.file_name.as_deref().unwrap_or("nacos-configs.zip"));
    let content_disposition = archive_content_disposition(&file_name);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_DISPOSITION, content_disposition)
        .body(Body::from(archive))
        .map_err(|error| AppError::from(error.to_string()))
}

pub async fn preview_config_import(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let import_dir = nacos_import_dir(&state.data_dir);
    tokio::fs::create_dir_all(&import_dir).await.map_err(|error| AppError::from(error.to_string()))?;
    cleanup_expired_nacos_imports(&state, &import_dir, NACOS_IMPORT_TTL).await;

    let archive_token = uuid::Uuid::new_v4().to_string();
    let archive_path = import_dir.join(format!("{archive_token}.zip"));
    let mut connection_id = None;
    let mut target_namespace = None;
    let mut uploaded = false;

    while let Some(mut field) = multipart.next_field().await.map_err(|error| AppError::from(error.to_string()))? {
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "file" => {
                if uploaded {
                    cleanup_nacos_import(&archive_path).await;
                    return Err(AppError::from("Only one Nacos archive may be uploaded".to_string()));
                }
                if let Err(error) = write_nacos_archive(&mut field, &archive_path).await {
                    cleanup_nacos_import(&archive_path).await;
                    return Err(error);
                }
                uploaded = true;
            }
            "connectionId" => {
                connection_id = Some(field.text().await.map_err(|error| AppError::from(error.to_string()))?);
            }
            "targetNamespace" => {
                target_namespace = Some(field.text().await.map_err(|error| AppError::from(error.to_string()))?);
            }
            _ => {}
        }
    }

    let Some(connection_id) = connection_id.filter(|value| !value.trim().is_empty()) else {
        cleanup_nacos_import(&archive_path).await;
        return Err(AppError::from("connectionId is required".to_string()));
    };
    let Some(target_namespace) = target_namespace else {
        cleanup_nacos_import(&archive_path).await;
        return Err(AppError::from("targetNamespace is required".to_string()));
    };
    if !uploaded {
        return Err(AppError::from("No Nacos archive uploaded".to_string()));
    }

    let preview = dbx_core::nacos::batch::nacos_preview_config_import_core(
        &state.app,
        &connection_id,
        &target_namespace,
        &archive_path,
    )
    .await;
    let preview = match preview {
        Ok(preview) => preview,
        Err(error) => {
            cleanup_nacos_import(&archive_path).await;
            return Err(AppError::from(error));
        }
    };

    let plan_hash = preview.plan_hash.clone();
    let mut value = serde_json::to_value(preview).map_err(|error| AppError::from(error.to_string()))?;
    let object = value.as_object_mut().ok_or_else(|| AppError::from("Invalid Nacos import preview".to_string()))?;
    object.insert("archiveToken".to_string(), serde_json::Value::String(archive_token.clone()));
    state.nacos_imports.write().await.insert(
        archive_token,
        NacosImportContext {
            owner_session: crate::auth::session_token_from_headers(&headers),
            connection_id,
            target_namespace,
            plan_hash,
        },
    );
    Ok(Json(value))
}

pub async fn apply_config_import(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    Json(req): Json<ConfigImportApplyReq>,
) -> Result<Json<dbx_core::nacos::NacosBatchReport>, AppError> {
    let archive_path = match nacos_import_path(&state.data_dir, &req.archive_token) {
        Ok(path) => path,
        Err(error) => {
            state.nacos_imports.write().await.remove(&req.archive_token);
            return Err(error);
        }
    };
    let import_context = match state.nacos_imports.write().await.remove(&req.archive_token) {
        Some(context) => context,
        None => {
            cleanup_nacos_import(&archive_path).await;
            return Err(AppError::from("Nacos import preview token is missing or expired".to_string()));
        }
    };
    if let Err(error) = validate_nacos_import_context(
        &import_context,
        crate::auth::session_token_from_headers(&headers).as_deref(),
        &req,
    ) {
        cleanup_nacos_import(&archive_path).await;
        return Err(error);
    }
    let result = dbx_core::nacos::batch::nacos_apply_config_import_core(
        &state.app,
        &req.connection_id,
        &req.target_namespace,
        &archive_path,
        &req.operation_id,
        &req.plan_hash,
        &req.conflict_policy,
    )
    .await;
    cleanup_nacos_import(&archive_path).await;
    result.map(Json).map_err(AppError::from)
}

pub async fn preview_config_transfer(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigTransferReq>,
) -> Result<Json<dbx_core::nacos::NacosBatchPreview>, AppError> {
    dbx_core::nacos::batch::nacos_preview_config_transfer_core(&state.app, &req.req)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn apply_config_transfer(
    State(state): State<Arc<WebState>>,
    Json(req): Json<ConfigTransferApplyReq>,
) -> Result<Json<dbx_core::nacos::NacosBatchReport>, AppError> {
    dbx_core::nacos::batch::nacos_apply_config_transfer_core(&state.app, &req.req, &req.plan_hash)
        .await
        .map(Json)
        .map_err(AppError::from)
}

fn nacos_import_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tmp").join("nacos_import")
}

fn nacos_import_path(data_dir: &Path, archive_token: &str) -> Result<PathBuf, AppError> {
    uuid::Uuid::parse_str(archive_token).map_err(|_| AppError::from("Invalid Nacos archive token".to_string()))?;
    let path = nacos_import_dir(data_dir).join(format!("{archive_token}.zip"));
    if !path.is_file() {
        return Err(AppError::from("Nacos import archive is no longer available".to_string()));
    }
    let metadata = std::fs::metadata(&path).map_err(|error| AppError::from(error.to_string()))?;
    if metadata
        .modified()
        .ok()
        .is_some_and(|modified| archive_is_expired(modified, SystemTime::now(), NACOS_IMPORT_TTL))
    {
        let _ = std::fs::remove_file(&path);
        return Err(AppError::from("Nacos import archive token has expired".to_string()));
    }
    Ok(path)
}

fn archive_is_expired(modified: SystemTime, now: SystemTime, max_age: Duration) -> bool {
    now.duration_since(modified).is_ok_and(|age| age > max_age)
}

fn validate_nacos_import_context(
    context: &NacosImportContext,
    owner_session: Option<&str>,
    req: &ConfigImportApplyReq,
) -> Result<(), AppError> {
    if context.owner_session.as_deref() != owner_session
        || context.connection_id != req.connection_id
        || context.target_namespace != req.target_namespace
        || context.plan_hash != req.plan_hash
    {
        return Err(AppError::from("Nacos import preview token does not match this apply request".to_string()));
    }
    Ok(())
}

async fn write_nacos_archive(
    field: &mut axum::extract::multipart::Field<'_>,
    archive_path: &Path,
) -> Result<(), AppError> {
    let mut archive = tokio::fs::File::create(archive_path).await.map_err(|error| AppError::from(error.to_string()))?;
    let mut uploaded_bytes = 0usize;
    while let Some(chunk) = field.chunk().await.map_err(|error| AppError::from(error.to_string()))? {
        uploaded_bytes = uploaded_bytes.saturating_add(chunk.len());
        if uploaded_bytes > MAX_NACOS_ARCHIVE_BYTES {
            return Err(AppError::from(format!(
                "Nacos archive is too large: {uploaded_bytes} bytes received (max {MAX_NACOS_ARCHIVE_BYTES} bytes)"
            )));
        }
        archive.write_all(&chunk).await.map_err(|error| AppError::from(error.to_string()))?;
    }
    archive.flush().await.map_err(|error| AppError::from(error.to_string()))
}

async fn cleanup_nacos_import(path: &Path) {
    let _ = tokio::fs::remove_file(path).await;
}

async fn cleanup_expired_nacos_imports(state: &WebState, dir: &Path, max_age: Duration) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let now = SystemTime::now();
    let mut expired_tokens = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        let expired = metadata.modified().ok().and_then(|modified| now.duration_since(modified).ok());
        if expired.is_some_and(|age| age > max_age) {
            if let Some(token) = entry.path().file_stem().and_then(|token| token.to_str()) {
                expired_tokens.push(token.to_string());
            }
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
    if !expired_tokens.is_empty() {
        let mut imports = state.nacos_imports.write().await;
        for token in expired_tokens {
            imports.remove(&token);
        }
    }
}

fn sanitize_archive_file_name(value: &str) -> String {
    let file_name =
        value.rsplit(['/', '\\']).next().unwrap_or("nacos-configs.zip").replace(['\r', '\n', '"', ';'], "_");
    let file_name = file_name.trim();
    let file_name = if file_name.is_empty() { "nacos-configs.zip" } else { file_name };
    if file_name.to_ascii_lowercase().ends_with(".zip") {
        file_name.to_string()
    } else {
        format!("{file_name}.zip")
    }
}

fn archive_content_disposition(file_name: &str) -> String {
    let fallback = file_name
        .chars()
        .map(|character| if character.is_ascii_graphic() { character } else { '_' })
        .collect::<String>();
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{}", encode_rfc5987_value(file_name))
}

fn encode_rfc5987_value(value: &str) -> String {
    use std::fmt::Write;

    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
        {
            encoded.push(char::from(byte));
        } else {
            write!(&mut encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    #[test]
    fn archive_tokens_cannot_escape_the_upload_directory() {
        let data_dir = Path::new("/tmp/dbx-nacos-route-test");
        assert!(nacos_import_path(data_dir, "../outside").is_err());
        assert!(nacos_import_path(data_dir, "not-a-uuid").is_err());
    }

    #[test]
    fn archive_download_names_are_safe_and_have_zip_extension() {
        assert_eq!(sanitize_archive_file_name("../../prod\r\n\".zip"), "prod___.zip");
        assert_eq!(sanitize_archive_file_name("configs"), "configs.zip");
        assert_eq!(sanitize_archive_file_name(""), "nacos-configs.zip");
        assert_eq!(
            archive_content_disposition("配置.zip"),
            "attachment; filename=\"__.zip\"; filename*=UTF-8''%E9%85%8D%E7%BD%AE.zip"
        );
    }

    #[test]
    fn archive_token_expiration_uses_the_configured_ttl() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(2 * 24 * 60 * 60);
        assert!(!archive_is_expired(now - NACOS_IMPORT_TTL, now, NACOS_IMPORT_TTL));
        assert!(archive_is_expired(now - NACOS_IMPORT_TTL - Duration::from_secs(1), now, NACOS_IMPORT_TTL));
        assert!(!archive_is_expired(now + Duration::from_secs(1), now, NACOS_IMPORT_TTL));
    }

    #[test]
    fn import_tokens_require_the_preview_session_and_context() {
        let context = NacosImportContext {
            owner_session: Some("preview-session".to_string()),
            connection_id: "connection-a".to_string(),
            target_namespace: "namespace-a".to_string(),
            plan_hash: "preview-plan".to_string(),
        };
        let mut request = ConfigImportApplyReq {
            connection_id: "connection-a".to_string(),
            operation_id: "operation".to_string(),
            target_namespace: "namespace-a".to_string(),
            archive_token: uuid::Uuid::new_v4().to_string(),
            plan_hash: "preview-plan".to_string(),
            conflict_policy: Default::default(),
        };

        assert!(validate_nacos_import_context(&context, Some("preview-session"), &request).is_ok());
        assert!(validate_nacos_import_context(&context, Some("other-session"), &request).is_err());
        request.connection_id = "connection-b".to_string();
        assert!(validate_nacos_import_context(&context, Some("preview-session"), &request).is_err());
    }
}
