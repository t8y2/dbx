#![cfg(feature = "duckdb-bundled")]

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::models::connection::AttachedDatabaseConfig;
use crate::types::ObjectSourceKind;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DuckDbWorkerRequest {
    pub id: String,
    pub method: DuckDbWorkerMethod,
    #[serde(default)]
    pub params: serde_json::Value,
}

impl DuckDbWorkerRequest {
    pub fn new(id: impl Into<String>, method: DuckDbWorkerMethod, params: impl Serialize) -> Result<Self, String> {
        let params = serde_json::to_value(params).map_err(|e| e.to_string())?;
        Ok(Self { id: id.into(), method, params })
    }

    pub fn parse_params<T: DeserializeOwned>(&self) -> Result<T, DuckDbWorkerError> {
        serde_json::from_value(self.params.clone()).map_err(|err| {
            DuckDbWorkerError::new("invalid_params", format!("Invalid params for {:?}: {err}", self.method))
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DuckDbWorkerMethod {
    Connect,
    Execute,
    ListDatabases,
    ListSchemas,
    ListTables,
    ListColumns,
    GetObjectSource,
    AttachDatabase,
    Cancel,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DuckDbWorkerResponse {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DuckDbWorkerError>,
}

impl DuckDbWorkerResponse {
    pub fn ok(id: impl Into<String>, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self { id: id.into(), ok: true, result: Some(result), error: None },
            Err(err) => Self::err(id, DuckDbWorkerError::new("serialization_failed", err.to_string())),
        }
    }

    pub fn ok_empty(id: impl Into<String>) -> Self {
        Self { id: id.into(), ok: true, result: None, error: None }
    }

    pub fn err(id: impl Into<String>, error: DuckDbWorkerError) -> Self {
        Self { id: id.into(), ok: false, result: None, error: Some(error) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DuckDbWorkerError {
    pub code: String,
    pub message: String,
}

impl DuckDbWorkerError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    pub fn from_message(code: &'static str, error: impl ToString) -> Self {
        Self::new(code, error.to_string())
    }
}

impl From<String> for DuckDbWorkerError {
    fn from(message: String) -> Self {
        Self::new("duckdb_worker_error", message)
    }
}

impl From<&str> for DuckDbWorkerError {
    fn from(message: &str) -> Self {
        Self::new("duckdb_worker_error", message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerConnectParams {
    pub path: String,
    #[serde(default)]
    pub attached_databases: Vec<AttachedDatabaseConfig>,
    #[serde(default)]
    pub init_script: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerExecuteParams {
    pub sql: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub max_rows: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerDatabaseParams {
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerTableParams {
    pub database: String,
    pub schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerColumnParams {
    pub database: String,
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerObjectSourceParams {
    pub database: String,
    pub schema: String,
    pub name: String,
    pub object_type: ObjectSourceKind,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_round_trips_connect_request() {
        let request = DuckDbWorkerRequest::new(
            "req-1",
            DuckDbWorkerMethod::Connect,
            DuckDbWorkerConnectParams {
                path: "D:/tmp/app.duckdb".to_string(),
                attached_databases: vec![AttachedDatabaseConfig {
                    name: "analytics".to_string(),
                    path: "D:/tmp/analytics.duckdb".to_string(),
                }],
                init_script: None,
            },
        )
        .expect("serialize request");

        let json = serde_json::to_string(&request).expect("request json");
        let parsed: DuckDbWorkerRequest = serde_json::from_str(&json).expect("parse request");
        let params: DuckDbWorkerConnectParams = parsed.parse_params().expect("parse params");

        assert_eq!(parsed.id, "req-1");
        assert_eq!(parsed.method, DuckDbWorkerMethod::Connect);
        assert_eq!(params.path, "D:/tmp/app.duckdb");
        assert_eq!(params.attached_databases[0].name, "analytics");
    }

    #[test]
    fn protocol_round_trips_error_response() {
        let response = DuckDbWorkerResponse::err(
            "req-2",
            DuckDbWorkerError::new("duckdb_open_failed", "DuckDB connection failed"),
        );

        let json = serde_json::to_string(&response).expect("response json");
        let parsed: DuckDbWorkerResponse = serde_json::from_str(&json).expect("parse response");

        assert!(!parsed.ok);
        assert_eq!(parsed.error.expect("error").code, "duckdb_open_failed");
    }

    #[test]
    fn protocol_round_trips_object_source_request() {
        let request = DuckDbWorkerRequest::new(
            "req-3",
            DuckDbWorkerMethod::GetObjectSource,
            DuckDbWorkerObjectSourceParams {
                database: "main".to_string(),
                schema: "main".to_string(),
                name: "active_orders".to_string(),
                object_type: ObjectSourceKind::View,
            },
        )
        .expect("serialize request");

        let json = serde_json::to_string(&request).expect("request json");
        let parsed: DuckDbWorkerRequest = serde_json::from_str(&json).expect("parse request");
        let params: DuckDbWorkerObjectSourceParams = parsed.parse_params().expect("parse params");

        assert_eq!(parsed.method, DuckDbWorkerMethod::GetObjectSource);
        assert_eq!(params.name, "active_orders");
        assert_eq!(params.object_type, ObjectSourceKind::View);
    }
}
