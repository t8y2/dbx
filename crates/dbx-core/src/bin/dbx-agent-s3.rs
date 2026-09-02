use std::collections::HashMap;
use std::io::{self, BufRead, Write};

use base64::Engine as _;
use dbx_core::db::agent_driver::AgentMethod;
use dbx_core::s3::agent_protocol::{
    S3BucketParams, S3ListObjectsParams, S3ObjectParams, S3PreviewObjectParams, S3UploadObjectParams,
    S3_AGENT_CAPABILITY_OBJECT_STORAGE, S3_AGENT_METHOD_CREATE_BUCKET, S3_AGENT_METHOD_DELETE_OBJECT,
    S3_AGENT_METHOD_DOWNLOAD_OBJECT, S3_AGENT_METHOD_HEAD_OBJECT, S3_AGENT_METHOD_LIST_BUCKETS,
    S3_AGENT_METHOD_LIST_OBJECTS, S3_AGENT_METHOD_PREVIEW_OBJECT, S3_AGENT_METHOD_UPLOAD_OBJECT,
};
use dbx_core::s3::{
    s3_create_bucket_with_client, s3_delete_object_with_client, s3_download_object_with_client,
    s3_head_object_with_client, s3_list_buckets_with_client, s3_list_objects_with_client,
    s3_preview_object_with_client, s3_put_object_with_client, S3Client, S3Config,
};
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_SESSION_ID: &str = "__default__";

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

struct RuntimeState {
    sessions: HashMap<String, S3Client>,
}

impl RuntimeState {
    fn new() -> Self {
        Self { sessions: HashMap::new() }
    }

    fn session_id(params: &Value) -> Result<String, String> {
        params
            .get("agentSessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "agentSessionId is required".to_string())
    }

    async fn build_client(params: &Value) -> Result<S3Client, String> {
        let config = S3Config::from_agent_params(params)?;
        let client = S3Client::new(config).await?;
        client.probe().await?;
        Ok(client)
    }

    async fn handle(&mut self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "handshake" => Ok(json!({
                "protocolVersion": 2,
                "agentProtocolVersion": 1,
                "capabilities": [
                    "connect",
                    "test_connection",
                    "multi_session",
                    S3_AGENT_CAPABILITY_OBJECT_STORAGE
                ]
            })),
            "test_connection" => {
                Self::build_client(&params).await?;
                Ok(json!({
                    "ok": true,
                    "databaseInfo": {
                        "productName": "S3 Object Storage",
                        "driverName": "dbx-agent-s3"
                    }
                }))
            }
            "connect" => {
                let client = Self::build_client(&params).await?;
                self.sessions.insert(DEFAULT_SESSION_ID.to_string(), client);
                Ok(json!({ "ok": true }))
            }
            "open_session" => {
                let session_id = Self::session_id(&params)?;
                let client = Self::build_client(&params).await?;
                self.sessions.insert(session_id, client);
                Ok(json!({ "ok": true }))
            }
            "close_session" => {
                let session_id = Self::session_id(&params)?;
                self.sessions.remove(&session_id);
                Ok(json!({ "ok": true }))
            }
            "validate_session" => {
                let session_id = Self::session_id(&params)?;
                let client = self.sessions.get(&session_id).ok_or_else(|| "S3 session not found".to_string())?;
                client.probe().await?;
                Ok(json!({ "ok": true }))
            }
            "validate_connection" => {
                let client = self
                    .sessions
                    .get(DEFAULT_SESSION_ID)
                    .or_else(|| self.sessions.values().next())
                    .ok_or_else(|| "S3 connection is not open".to_string())?;
                client.probe().await?;
                Ok(json!({ "ok": true }))
            }
            "connection_info" => Ok(json!({
                "identifierQuote": "",
                "databaseInfo": {
                    "productName": "S3 Object Storage",
                    "driverName": "dbx-agent-s3"
                }
            })),
            "disconnect" => {
                self.sessions.remove(DEFAULT_SESSION_ID);
                Ok(json!({ "ok": true }))
            }
            "shutdown" => Ok(json!({ "ok": true })),
            S3_AGENT_METHOD_LIST_BUCKETS => {
                let session_id = Self::session_id(&params)?;
                let client = self.sessions.get(&session_id).ok_or_else(|| "S3 session not found".to_string())?;
                Ok(serde_json::to_value(s3_list_buckets_with_client(client).await?)
                    .map_err(|error| error.to_string())?)
            }
            S3_AGENT_METHOD_CREATE_BUCKET => {
                let session_id = Self::session_id(&params)?;
                let payload: S3BucketParams = serde_json::from_value(params).map_err(|error| error.to_string())?;
                let client = self.sessions.get(&session_id).ok_or_else(|| "S3 session not found".to_string())?;
                s3_create_bucket_with_client(client, &payload.bucket).await?;
                Ok(json!({ "ok": true }))
            }
            S3_AGENT_METHOD_LIST_OBJECTS => {
                let session_id = Self::session_id(&params)?;
                let payload: S3ListObjectsParams = serde_json::from_value(params).map_err(|error| error.to_string())?;
                let client = self.sessions.get(&session_id).ok_or_else(|| "S3 session not found".to_string())?;
                Ok(serde_json::to_value(
                    s3_list_objects_with_client(
                        client,
                        &payload.bucket,
                        &payload.prefix,
                        payload.delimiter.as_deref(),
                        payload.max_keys,
                        payload.continuation_token.as_deref(),
                    )
                    .await?,
                )
                .map_err(|error| error.to_string())?)
            }
            S3_AGENT_METHOD_HEAD_OBJECT => {
                let session_id = Self::session_id(&params)?;
                let payload: S3ObjectParams = serde_json::from_value(params).map_err(|error| error.to_string())?;
                let client = self.sessions.get(&session_id).ok_or_else(|| "S3 session not found".to_string())?;
                Ok(serde_json::to_value(s3_head_object_with_client(client, &payload.bucket, &payload.key).await?)
                    .map_err(|error| error.to_string())?)
            }
            S3_AGENT_METHOD_PREVIEW_OBJECT => {
                let session_id = Self::session_id(&params)?;
                let payload: S3PreviewObjectParams =
                    serde_json::from_value(params).map_err(|error| error.to_string())?;
                let client = self.sessions.get(&session_id).ok_or_else(|| "S3 session not found".to_string())?;
                Ok(serde_json::to_value(
                    s3_preview_object_with_client(client, &payload.bucket, &payload.key, payload.max_bytes).await?,
                )
                .map_err(|error| error.to_string())?)
            }
            S3_AGENT_METHOD_DOWNLOAD_OBJECT => {
                let session_id = Self::session_id(&params)?;
                let payload: S3ObjectParams = serde_json::from_value(params).map_err(|error| error.to_string())?;
                let client = self.sessions.get(&session_id).ok_or_else(|| "S3 session not found".to_string())?;
                Ok(serde_json::to_value(s3_download_object_with_client(client, &payload.bucket, &payload.key).await?)
                    .map_err(|error| error.to_string())?)
            }
            S3_AGENT_METHOD_UPLOAD_OBJECT => {
                let session_id = Self::session_id(&params)?;
                let payload: S3UploadObjectParams =
                    serde_json::from_value(params).map_err(|error| error.to_string())?;
                let client = self.sessions.get(&session_id).ok_or_else(|| "S3 session not found".to_string())?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(payload.payload_base64.trim())
                    .map_err(|error| format!("S3 upload payload is not valid base64: {error}"))?;
                s3_put_object_with_client(
                    client,
                    &payload.bucket,
                    &payload.key,
                    &bytes,
                    payload.content_type.as_deref(),
                )
                .await?;
                Ok(json!({ "ok": true }))
            }
            S3_AGENT_METHOD_DELETE_OBJECT => {
                let session_id = Self::session_id(&params)?;
                let payload: S3ObjectParams = serde_json::from_value(params).map_err(|error| error.to_string())?;
                let client = self.sessions.get(&session_id).ok_or_else(|| "S3 session not found".to_string())?;
                s3_delete_object_with_client(client, &payload.bucket, &payload.key).await?;
                Ok(json!({ "ok": true }))
            }
            _ => {
                if method == AgentMethod::CancelSession.as_str() {
                    return Ok(json!({ "ok": true }));
                }
                Err(format!("Unsupported method: {method}"))
            }
        }
    }
}

fn write_response(id: Value, result: Result<Value, String>) -> Result<(), String> {
    let value = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": error } }),
    };
    let line = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(line.as_bytes()).map_err(|error| error.to_string())?;
    stdout.write_all(b"\n").map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}

fn main() -> Result<(), String> {
    println!("{}", serde_json::to_string(&json!({ "ready": true })).map_err(|error| error.to_string())?);
    io::stdout().flush().map_err(|error| error.to_string())?;

    let runtime =
        tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| error.to_string())?;
    let stdin = io::stdin();
    let mut state = RuntimeState::new();

    for line in stdin.lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_response(Value::Null, Err(format!("Invalid JSON-RPC request: {error}")))?;
                continue;
            }
        };
        let should_exit = request.method == AgentMethod::Shutdown.as_str();
        let result = runtime.block_on(state.handle(&request.method, request.params));
        write_response(request.id, result)?;
        if should_exit {
            break;
        }
    }

    Ok(())
}
