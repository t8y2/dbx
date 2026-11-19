use std::collections::HashSet;
use std::sync::Mutex;

use dbx_plugin_sdk::{PluginEmitter, PluginError, PluginHandler, PluginMetadata, PluginServer, RequestContext};
use serde_json::{json, Value};

#[derive(Default)]
struct Plugin {
    connections: Mutex<HashSet<String>>,
}

impl PluginHandler for Plugin {
    fn handle(
        &self,
        _context: RequestContext,
        method: &str,
        params: Value,
        _emitter: &PluginEmitter,
    ) -> Result<Value, PluginError> {
        match method {
            "connection/test" => {
                let connection = params.get("connection").cloned().unwrap_or_default();
                Ok(json!({
                    "success": true,
                    "message": format!(
                        "{{PLUGIN_NAME_RUST}} is ready for {}:{}.",
                        connection.get("host").and_then(Value::as_str).unwrap_or("localhost"),
                        connection.get("port").and_then(Value::as_u64).unwrap_or(0)
                    )
                }))
            }
            "connection/connect" => {
                let connection_id = connection_id(&params)?;
                self.connections
                    .lock()
                    .map_err(|_| PluginError::new(-32000, "Connection registry is poisoned"))?
                    .insert(connection_id.to_string());
                Ok(json!({ "success": true }))
            }
            "connection/disconnect" => {
                let connection_id = connection_id(&params)?;
                self.connections
                    .lock()
                    .map_err(|_| PluginError::new(-32000, "Connection registry is poisoned"))?
                    .remove(connection_id);
                Ok(json!({ "success": true }))
            }
            "{{METHOD_PREFIX}}/ping" => Ok(json!({
                "ok": true,
                "plugin": "{{PLUGIN_ID}}",
                "language": "rust",
                "connectionId": params.get("connectionId").cloned().unwrap_or(Value::Null)
            })),
            _ => Err(PluginError::method_not_found(method)),
        }
    }
}

fn connection_id(params: &Value) -> Result<&str, PluginError> {
    params
        .get("connection")
        .and_then(|connection| connection.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| PluginError::new(-32602, "Missing connection id"))
}

fn main() -> std::io::Result<()> {
    let metadata = PluginMetadata::new("{{PLUGIN_ID}}", env!("CARGO_PKG_VERSION")).with_capability("connections");
    PluginServer::new(metadata, Plugin::default()).serve()
}
