use axum::Json;
use serde::Serialize;

/// A deliberately non-sensitive liveness response for HTTP deployment probes.
#[derive(Serialize)]
pub struct HealthStatus {
    pub status: &'static str,
    pub transport: &'static str,
}

pub async fn health() -> Json<HealthStatus> {
    Json(HealthStatus { status: "ok", transport: "streamable-http" })
}
