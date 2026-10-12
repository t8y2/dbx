use crate::{error::AppError, state::WebState};
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::StatusCode,
    Json,
};
use dbx_core::favorites::{
    CreateTableFavorite, CreatedTableFavorite, RelinkTableFavorite, TableFavorite, TableFavorites, UpdateTableFavorite,
};
use std::sync::Arc;

// Keep the shared error envelope; the detail prefix is identical to Tauri.
fn favorite_error(message: String) -> AppError {
    let code = message.split(':').next().unwrap_or("");
    let status = match code {
        "INVALID_FAVORITE" => StatusCode::BAD_REQUEST,
        "FAVORITE_NOT_FOUND" | "CONNECTION_NOT_FOUND" => StatusCode::NOT_FOUND,
        "FAVORITE_CODE_CONFLICT" | "FAVORITE_REVISION_CONFLICT" | "FAVORITE_TARGET_CONFLICT" => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let mut error = AppError::from(message);
    error.status = status;
    error
}

pub async fn list(State(state): State<Arc<WebState>>) -> Result<Json<TableFavorites>, AppError> {
    state.app.storage.list_table_favorites().await.map(Json).map_err(favorite_error)
}

pub async fn create(
    State(state): State<Arc<WebState>>,
    input: Result<Json<CreateTableFavorite>, JsonRejection>,
) -> Result<(StatusCode, Json<CreatedTableFavorite>), AppError> {
    let Json(input) = input.map_err(|_| favorite_error("INVALID_FAVORITE: invalid request body".into()))?;
    let result = state.app.storage.create_table_favorite(input).await.map_err(favorite_error)?;
    Ok((if result.created { StatusCode::CREATED } else { StatusCode::OK }, Json(result)))
}

pub async fn update(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    input: Result<Json<UpdateTableFavorite>, JsonRejection>,
) -> Result<Json<TableFavorite>, AppError> {
    let Json(input) = input.map_err(|_| favorite_error("INVALID_FAVORITE: invalid request body".into()))?;
    state.app.storage.update_table_favorite(id, input).await.map(Json).map_err(favorite_error)
}

pub async fn relink(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    input: Result<Json<RelinkTableFavorite>, JsonRejection>,
) -> Result<Json<TableFavorite>, AppError> {
    let Json(input) = input.map_err(|_| favorite_error("INVALID_FAVORITE: invalid request body".into()))?;
    state.app.storage.relink_table_favorite(id, input).await.map(Json).map_err(favorite_error)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveQuery {
    expected_revision: i64,
}

pub async fn remove(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    input: Result<Query<RemoveQuery>, QueryRejection>,
) -> Result<StatusCode, AppError> {
    let Query(input) = input.map_err(|_| favorite_error("INVALID_FAVORITE: invalid expectedRevision".into()))?;
    state.app.storage.remove_table_favorite(id, input.expected_revision).await.map_err(favorite_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn favorites_http_error_status_matches_contract() {
        for (code, expected) in [
            ("INVALID_FAVORITE", 400),
            ("FAVORITE_NOT_FOUND", 404),
            ("CONNECTION_NOT_FOUND", 404),
            ("FAVORITE_CODE_CONFLICT", 409),
            ("FAVORITE_TARGET_CONFLICT", 409),
            ("FAVORITE_REVISION_CONFLICT", 409),
            ("database is locked", 500),
        ] {
            let error = favorite_error(format!("{code}: detail"));
            assert_eq!(error.status.as_u16(), expected);
            assert_eq!(error.message, format!("{code}: detail"));
        }
    }
}
