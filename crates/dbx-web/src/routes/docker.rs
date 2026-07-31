use std::convert::Infallible;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::StreamExt;

use crate::error::AppError;
use crate::state::WebState;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionRequest {
    connection_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContainerListRequest {
    connection_id: String,
    #[serde(default = "default_true")]
    all: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContainerRequest {
    connection_id: String,
    container_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContainerActionRequest {
    connection_id: String,
    container_id: String,
    action: dbx_core::docker::DockerContainerAction,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContainerStatsRequest {
    connection_id: String,
    container_ids: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateContainerRequest {
    connection_id: String,
    request: dbx_core::docker::DockerCreateContainerRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplyComposeRequest {
    connection_id: String,
    request: dbx_core::docker::DockerComposeApplyRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileRequest {
    connection_id: String,
    container_id: String,
    path: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageRequest {
    connection_id: String,
    image_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullImageRequest {
    connection_id: String,
    image: String,
    auth: Option<dbx_core::docker::DockerRegistryAuth>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushImageRequest {
    connection_id: String,
    source_image_id: String,
    target_reference: String,
    auth: Option<dbx_core::docker::DockerRegistryAuth>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateVolumeRequest {
    connection_id: String,
    request: dbx_core::docker::DockerCreateVolumeRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateNetworkRequest {
    connection_id: String,
    request: dbx_core::docker::DockerCreateNetworkRequest,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogStreamQuery {
    connection_id: String,
    container_id: String,
    tail: Option<usize>,
    timestamps: Option<bool>,
}

fn default_true() -> bool {
    true
}

fn ensure_web_writes_enabled(state: &WebState) -> Result<(), AppError> {
    if state.password_disabled {
        return Err(AppError {
            message: "Docker write operations are disabled when DBX password protection is disabled".to_string(),
            status: StatusCode::FORBIDDEN,
        });
    }
    Ok(())
}

pub async fn test_connection(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ConnectionRequest>,
) -> Result<Json<dbx_core::docker::DockerConnectionInfo>, AppError> {
    Ok(Json(
        dbx_core::docker::docker_test_connection_core(&state.app, &request.connection_id)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn engine_details(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ConnectionRequest>,
) -> Result<Json<dbx_core::docker::DockerEngineDetails>, AppError> {
    Ok(Json(
        dbx_core::docker::docker_get_engine_details_core(&state.app, &request.connection_id)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn list_containers(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ContainerListRequest>,
) -> Result<Json<Vec<dbx_core::docker::DockerContainer>>, AppError> {
    Ok(Json(
        dbx_core::docker::docker_list_containers_core(&state.app, &request.connection_id, request.all)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn list_images(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ConnectionRequest>,
) -> Result<Json<Vec<dbx_core::docker::DockerImage>>, AppError> {
    Ok(Json(
        dbx_core::docker::docker_list_images_core(&state.app, &request.connection_id).await.map_err(AppError::from)?,
    ))
}

pub async fn list_volumes(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ConnectionRequest>,
) -> Result<Json<Vec<dbx_core::docker::DockerVolume>>, AppError> {
    Ok(Json(
        dbx_core::docker::docker_list_volumes_core(&state.app, &request.connection_id).await.map_err(AppError::from)?,
    ))
}

pub async fn list_networks(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ConnectionRequest>,
) -> Result<Json<Vec<dbx_core::docker::DockerNetwork>>, AppError> {
    Ok(Json(
        dbx_core::docker::docker_list_networks_core(&state.app, &request.connection_id)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn container_action(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ContainerActionRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_web_writes_enabled(&state)?;
    dbx_core::docker::docker_container_action_core(
        &state.app,
        &request.connection_id,
        &request.container_id,
        request.action,
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

pub async fn create_container(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CreateContainerRequest>,
) -> Result<Json<dbx_core::docker::DockerCreateContainerResult>, AppError> {
    ensure_web_writes_enabled(&state)?;
    dbx_core::docker::docker_create_container_core(&state.app, &request.connection_id, request.request)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn apply_compose(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ApplyComposeRequest>,
) -> Result<Json<dbx_core::docker::DockerComposeApplyResult>, AppError> {
    ensure_web_writes_enabled(&state)?;
    dbx_core::docker::docker_apply_compose_core(&state.app, &request.connection_id, request.request)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn remove_container(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ContainerRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_web_writes_enabled(&state)?;
    dbx_core::docker::docker_remove_container_core(&state.app, &request.connection_id, &request.container_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

pub async fn remove_image(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ImageRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_web_writes_enabled(&state)?;
    dbx_core::docker::docker_remove_image_core(&state.app, &request.connection_id, &request.image_id)
        .await
        .map_err(AppError::from)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

pub async fn create_volume(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CreateVolumeRequest>,
) -> Result<Json<dbx_core::docker::DockerVolume>, AppError> {
    ensure_web_writes_enabled(&state)?;
    dbx_core::docker::docker_create_volume_core(&state.app, &request.connection_id, request.request)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn create_network(
    State(state): State<Arc<WebState>>,
    Json(request): Json<CreateNetworkRequest>,
) -> Result<Json<dbx_core::docker::DockerCreateNetworkResult>, AppError> {
    ensure_web_writes_enabled(&state)?;
    dbx_core::docker::docker_create_network_core(&state.app, &request.connection_id, request.request)
        .await
        .map(Json)
        .map_err(AppError::from)
}

pub async fn list_container_files(
    State(state): State<Arc<WebState>>,
    Json(request): Json<FileRequest>,
) -> Result<Json<Vec<dbx_core::docker::DockerFileEntry>>, AppError> {
    dbx_core::docker::docker_list_container_files_core(
        &state.app,
        &request.connection_id,
        &request.container_id,
        &request.path,
    )
    .await
    .map(Json)
    .map_err(AppError::from)
}

pub async fn preview_container_file(
    State(state): State<Arc<WebState>>,
    Json(request): Json<FileRequest>,
) -> Result<Json<dbx_core::docker::DockerFilePreview>, AppError> {
    dbx_core::docker::docker_preview_container_file_core(
        &state.app,
        &request.connection_id,
        &request.container_id,
        &request.path,
    )
    .await
    .map(Json)
    .map_err(AppError::from)
}

pub async fn export_image(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ImageRequest>,
) -> Result<Response, AppError> {
    let upstream =
        dbx_core::docker::docker_export_image_response_core(&state.app, &request.connection_id, &request.image_id)
            .await
            .map_err(AppError::from)?;
    let content_length = upstream.content_length();
    let mut response = Body::from_stream(upstream.bytes_stream()).into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-tar"));
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=\"docker-image.tar\""));
    if let Some(content_length) = content_length {
        if let Ok(value) = HeaderValue::from_str(&content_length.to_string()) {
            response.headers_mut().insert(header::CONTENT_LENGTH, value);
        }
    }
    Ok(response)
}

pub async fn stream_logs(
    State(state): State<Arc<WebState>>,
    Query(query): Query<LogStreamQuery>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, AppError> {
    let response = dbx_core::docker::docker_container_logs_response_core(
        &state.app,
        &query.connection_id,
        &query.container_id,
        dbx_core::docker::DockerLogOptions {
            tail: query.tail.unwrap_or(500),
            timestamps: query.timestamps.unwrap_or(false),
        },
    )
    .await
    .map_err(AppError::from)?;
    let stream = response.bytes_stream().scan(Vec::<u8>::new(), |buffer, item| {
        let event = match item {
            Ok(chunk) => {
                let decoded = dbx_core::docker::decode_multiplexed_stream_chunk(buffer, &chunk);
                Event::default().event("chunk").data(String::from_utf8_lossy(&decoded))
            }
            Err(error) => Event::default().event("error").data(error.to_string()),
        };
        std::future::ready(Some(Ok::<_, Infallible>(event)))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

pub async fn pull_image(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PullImageRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, AppError> {
    ensure_web_writes_enabled(&state)?;
    let response = dbx_core::docker::docker_pull_image_response_core(
        &state.app,
        &request.connection_id,
        &request.image,
        request.auth,
    )
    .await
    .map_err(AppError::from)?;
    let stream = response.bytes_stream().map(|item| {
        let event = match item {
            Ok(chunk) => Event::default().event("progress").data(String::from_utf8_lossy(&chunk)),
            Err(error) => Event::default().event("error").data(error.to_string()),
        };
        Ok::<_, Infallible>(event)
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

pub async fn push_image(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PushImageRequest>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, AppError> {
    ensure_web_writes_enabled(&state)?;
    let response = dbx_core::docker::docker_push_image_response_core(
        &state.app,
        &request.connection_id,
        &request.source_image_id,
        &request.target_reference,
        request.auth,
    )
    .await
    .map_err(AppError::from)?;
    let stream = response.bytes_stream().map(|item| {
        let event = match item {
            Ok(chunk) => Event::default().event("progress").data(String::from_utf8_lossy(&chunk)),
            Err(error) => Event::default().event("error").data(error.to_string()),
        };
        Ok::<_, Infallible>(event)
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

pub async fn inspect_container(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ContainerRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(
        dbx_core::docker::docker_inspect_container_core(&state.app, &request.connection_id, &request.container_id)
            .await
            .map_err(AppError::from)?,
    ))
}

pub async fn container_stats(
    State(state): State<Arc<WebState>>,
    Json(request): Json<ContainerStatsRequest>,
) -> Result<Json<Vec<dbx_core::docker::DockerContainerStats>>, AppError> {
    Ok(Json(
        dbx_core::docker::docker_container_stats_core(&state.app, &request.connection_id, request.container_ids)
            .await
            .map_err(AppError::from)?,
    ))
}
