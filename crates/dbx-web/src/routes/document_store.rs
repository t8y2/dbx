use std::future::Future;
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

async fn run_cancellable<T, F>(state: &Arc<WebState>, execution_id: Option<String>, future: F) -> Result<T, AppError>
where
    F: Future<Output = Result<T, String>>,
{
    let registered = execution_id
        .as_ref()
        .filter(|id| !id.trim().is_empty())
        .map(|id| state.app.running_queries.register(id.clone()));
    if let Some(query) = registered.as_ref() {
        let token = query.token();
        tokio::select! {
            biased;
            _ = token.cancelled() => Err(AppError(dbx_core::query::canceled_error())),
            result = future => result.map_err(AppError),
        }
    } else {
        future.await.map_err(AppError)
    }
}

async fn ensure_writable(
    app: &dbx_core::connection::AppState,
    connection_id: &str,
    action: &str,
) -> Result<(), AppError> {
    if let Some(name) = dbx_core::query::connection_readonly_name(app, connection_id).await {
        return Err(AppError(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            name, action
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentListDatabasesRequest {
    pub connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentListCollectionsRequest {
    pub connection_id: String,
    pub database: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFindRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub skip: Option<u64>,
    pub limit: Option<i64>,
    pub filter: Option<String>,
    pub projection: Option<String>,
    pub sort: Option<String>,
    pub execution_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInsertRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub doc_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentUpdateRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
    pub doc_json: String,
    pub routing: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDeleteRequest {
    pub connection_id: String,
    pub database: String,
    pub collection: String,
    pub id: String,
    pub routing: Option<String>,
}

pub async fn list_databases(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentListDatabasesRequest>,
) -> Result<Json<Vec<String>>, AppError> {
    let result = dbx_core::document_ops::list_databases_core(&state.app, &req.connection_id).await.map_err(AppError)?;
    Ok(Json(result))
}

pub async fn list_collections(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentListCollectionsRequest>,
) -> Result<Json<Vec<dbx_core::document_ops::CollectionInfo>>, AppError> {
    let result = dbx_core::document_ops::list_collections_core(&state.app, &req.connection_id, &req.database)
        .await
        .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn find_documents(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentFindRequest>,
) -> Result<Json<dbx_core::db::mongo_driver::MongoDocumentResult>, AppError> {
    let result = run_cancellable(
        &state,
        req.execution_id,
        dbx_core::document_ops::find_documents_core(
            &state.app,
            &req.connection_id,
            &req.database,
            &req.collection,
            req.skip.unwrap_or(0),
            req.limit.unwrap_or(50),
            req.filter.as_deref(),
            req.projection.as_deref(),
            req.sort.as_deref(),
        ),
    )
    .await?;
    Ok(Json(result))
}

pub async fn insert_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentInsertRequest>,
) -> Result<Json<String>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Insert").await?;
    let result = dbx_core::document_ops::insert_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.doc_json,
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn update_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentUpdateRequest>,
) -> Result<Json<u64>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Update").await?;
    let result = dbx_core::document_ops::update_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.id,
        &req.doc_json,
        req.routing.as_deref(),
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}

pub async fn delete_document(
    State(state): State<Arc<WebState>>,
    Json(req): Json<DocumentDeleteRequest>,
) -> Result<Json<u64>, AppError> {
    ensure_writable(&state.app, &req.connection_id, "Delete").await?;
    let result = dbx_core::document_ops::delete_document_core(
        &state.app,
        &req.connection_id,
        &req.database,
        &req.collection,
        &req.id,
        req.routing.as_deref(),
    )
    .await
    .map_err(AppError)?;
    Ok(Json(result))
}
