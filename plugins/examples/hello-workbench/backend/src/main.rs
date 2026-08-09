use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use dbx_plugin_sdk::{PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext};
use serde_json::{json, Value};

#[derive(Default)]
struct HelloPlugin {
    connections: Mutex<HashMap<String, String>>,
}

impl PluginHandler for HelloPlugin {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "connection/test" => {
                let connection = params.get("connection").cloned().unwrap_or_default();
                Ok(json!({
                    "success": true,
                    "message": format!(
                        "Provider is ready for {}:{}.",
                        connection.get("host").and_then(Value::as_str).unwrap_or("localhost"),
                        connection.get("port").and_then(Value::as_u64).unwrap_or(0)
                    )
                }))
            }
            "connection/connect" => {
                let connection =
                    params.get("connection").ok_or_else(|| PluginError::new(-32602, "Missing connection"))?;
                let connection_id = connection
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| PluginError::new(-32602, "Missing connection id"))?;
                let connection_name = connection.get("name").and_then(Value::as_str).unwrap_or("Hello connection");
                self.connections
                    .lock()
                    .map_err(|_| PluginError::new(-32000, "Connection registry is poisoned"))?
                    .insert(connection_id.to_string(), connection_name.to_string());
                emitter
                    .event("hello/connectionChanged", json!({ "connectionId": connection_id, "state": "connected" }))?;
                Ok(json!({ "success": true }))
            }
            "connection/disconnect" => {
                let connection_id = params
                    .get("connection")
                    .and_then(|connection| connection.get("id"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| PluginError::new(-32602, "Missing connection id"))?;
                self.connections
                    .lock()
                    .map_err(|_| PluginError::new(-32000, "Connection registry is poisoned"))?
                    .remove(connection_id);
                emitter.event(
                    "hello/connectionChanged",
                    json!({ "connectionId": connection_id, "state": "disconnected" }),
                )?;
                Ok(json!({ "success": true }))
            }
            "connection/action" => {
                match params.get("action").and_then(|action| action.get("id")).and_then(Value::as_str) {
                    Some("suggest-greeting") => Ok(json!({
                        "success": true,
                        "message": "Greeting updated by the plugin action.",
                        "fieldValues": {
                            "greeting": "Hello from plugin action"
                        }
                    })),
                    Some(action_id) => Err(PluginError::new(-32602, format!("Unknown connection action: {action_id}"))),
                    None => Err(PluginError::new(-32602, "Missing connection action id")),
                }
            }
            "hello/greet" => {
                let connection_id = params.get("connectionId").and_then(Value::as_str).unwrap_or_default();
                let connection_name = self
                    .connections
                    .lock()
                    .map_err(|_| PluginError::new(-32000, "Connection registry is poisoned"))?
                    .get(connection_id)
                    .cloned()
                    .ok_or_else(|| PluginError::new(-32010, "Open a saved Hello connection first"))?;
                let name = params.get("name").and_then(Value::as_str).unwrap_or("DBX");
                emitter.event(
                    "hello/progress",
                    json!({ "stage": "started", "name": name, "connectionId": connection_id }),
                )?;
                thread::sleep(Duration::from_millis(120));
                emitter.event(
                    "hello/progress",
                    json!({ "stage": "finished", "name": name, "connectionId": connection_id }),
                )?;
                Ok(json!({
                    "message": format!("Hello, {name}, from {connection_name}!"),
                    "connectionId": connection_id,
                    "pluginId": std::env::var("DBX_PLUGIN_ID").unwrap_or_default(),
                    "dbxVersion": std::env::var("DBX_APP_VERSION").unwrap_or_default()
                }))
            }
            "filesystem/list" => {
                require_filesystem_provider(&params)?;
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or("hello:/");
                let entries = match uri {
                    "hello:/" => json!([
                        {
                            "name": "examples",
                            "uri": "hello:/examples/",
                            "kind": "directory",
                            "modifiedAt": "2026-07-28T00:00:00Z"
                        },
                        {
                            "name": "README.txt",
                            "uri": "hello:/README.txt",
                            "kind": "file",
                            "size": 78,
                            "modifiedAt": "2026-07-28T00:00:00Z",
                            "contentType": "text/plain"
                        }
                    ]),
                    "hello:/examples/" => json!([
                        {
                            "name": "hello.json",
                            "uri": "hello:/examples/hello.json",
                            "kind": "file",
                            "size": 55,
                            "modifiedAt": "2026-07-28T00:00:00Z",
                            "contentType": "application/json"
                        }
                    ]),
                    _ => return Err(PluginError::new(-32044, format!("Directory not found: {uri}"))),
                };
                Ok(json!({ "entries": entries }))
            }
            "filesystem/read" => {
                require_filesystem_provider(&params)?;
                let uri = params.get("uri").and_then(Value::as_str).unwrap_or_default();
                let content = match uri {
                    "hello:/README.txt" => "This virtual file is rendered by DBX's host-owned plugin file manager.\n",
                    "hello:/examples/hello.json" => "{\n  \"hello\": \"DBX\",\n  \"provider\": \"filesystem\"\n}\n",
                    _ => return Err(PluginError::new(-32044, format!("File not found: {uri}"))),
                };
                let max_bytes = params.get("maxBytes").and_then(Value::as_u64).unwrap_or(content.len() as u64);
                let preview_length = usize::try_from(max_bytes).unwrap_or(usize::MAX).min(content.len());
                let preview = &content.as_bytes()[..preview_length];
                Ok(json!({
                    "dataBase64": encode_base64(preview),
                    "contentType": if uri.ends_with(".json") { "application/json" } else { "text/plain" },
                    "truncated": preview_length < content.len(),
                    "etag": format!("hello-{preview_length}")
                }))
            }
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

fn require_filesystem_provider(params: &Value) -> Result<(), PluginError> {
    if params.get("providerId").and_then(Value::as_str) == Some("dbx.example.hello.files") {
        Ok(())
    } else {
        Err(PluginError::new(-32602, "Unknown filesystem provider"))
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(ALPHABET[(first >> 2) as usize] as char);
        encoded.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 { ALPHABET[(third & 0x3f) as usize] as char } else { '=' });
    }
    encoded
}

fn main() -> std::io::Result<()> {
    let metadata = PluginMetadata::new("dbx.example.hello", env!("CARGO_PKG_VERSION"))
        .with_capability("connections")
        .with_capability("events")
        .with_capability("filesystem");
    PluginServer::new(metadata, HelloPlugin::default()).serve()
}
