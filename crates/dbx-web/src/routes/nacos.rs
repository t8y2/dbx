use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::AppError;
use crate::state::WebState;

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
pub(crate) struct RawReq {
    connection_id: String,
    req: dbx_core::nacos::NacosRawRequest,
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

pub async fn raw_request(
    State(state): State<Arc<WebState>>,
    Json(req): Json<RawReq>,
) -> Result<Json<dbx_core::nacos::NacosRawResponse>, AppError> {
    let result = dbx_core::nacos::service::nacos_raw_request_core(&state.app, &req.connection_id, req.req)
        .await
        .map_err(AppError::from)?;
    Ok(Json(result))
}
