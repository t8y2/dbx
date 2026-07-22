use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

pub struct AppError {
    pub message: String,
    pub status: StatusCode,
}

impl AppError {
    pub fn internal(msg: impl Into<String>) -> Self {
        AppError { message: msg.into(), status: StatusCode::INTERNAL_SERVER_ERROR }
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        AppError { message: msg.into(), status: StatusCode::BAD_REQUEST }
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError { message: msg.into(), status: StatusCode::NOT_FOUND }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status, self.message).into_response()
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError { message: s, status: StatusCode::INTERNAL_SERVER_ERROR }
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError { message: s.to_string(), status: StatusCode::INTERNAL_SERVER_ERROR }
    }
}
