//! The public, deliberately bounded connection-management surface shared by CLI and MCP.
//! Updates leave driver-specific settings and credentials outside this surface untouched.

use crate::models::connection::ConnectionConfig;
use serde_json::{json, Value};

/// Avoid echoing connection URLs, DSNs, or terminal control sequences in management output.
/// Credential-bearing fields are never included by `connection_details` in the first place.
pub fn safe_connection_text(value: &str) -> String {
    let lower: String = value.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
    if value.contains("://")
        || value.contains('@')
        || value.contains(';')
        || ["password=", "pwd=", "token=", "secret=", "apikey=", "api_key=", "access_key=", "credential="]
            .iter()
            .any(|marker| lower.contains(marker))
    {
        return "[REDACTED]".to_string();
    }
    value.chars().filter(|c| !c.is_control()).collect()
}

/// Backend/HTTP errors can echo a submitted JSON body. Never forward arbitrary error
/// text from credential-bearing operations; preserve only known codes and fixed messages.
pub fn safe_connection_error(error: &str) -> String {
    for (code, message) in [
        ("MCP_READ_ONLY", "Global MCP read-only mode blocks connection changes."),
        ("MCP_POLICY_UNAVAILABLE", "The MCP access policy could not be loaded."),
        ("TOOL_OUT_OF_SCOPE", "This tool is not allowed by the MCP policy."),
        ("CONNECTION_OUT_OF_SCOPE", "The connection is outside the allowed scope."),
        ("CONNECTION_ALREADY_EXISTS", "A connection with this name already exists."),
        ("CONNECTION_NOT_FOUND", "The saved connection was not found."),
        ("AMBIGUOUS_CONNECTION", "Multiple connections match; use a connection ID."),
        ("INVALID_CONNECTION_TYPE", "Unsupported database type."),
        ("INVALID_CONNECTION", "Invalid connection settings or patch."),
        ("KEY_FILE_UNAVAILABLE", "The configured encryption key file is unavailable."),
        ("MISSING_MANAGED_KEY", "The existing encryption key is unavailable."),
        ("MISSING_EXTERNAL_KEY", "The existing encryption key is unavailable."),
        ("SECRET_KEY_UNAVAILABLE", "The existing encryption key is unavailable."),
        ("DATA_MIGRATION_REQUIRED", "Complete the data security upgrade in DBX first."),
    ] {
        if error.contains(&format!("{code}:")) || error.contains(&format!("[{code}]")) || error == code {
            return format!("{code}: {message}");
        }
    }
    "CONNECTION_STORE_ERROR: The connection store operation failed.".to_string()
}

/// A safe projection, rather than serializing a hydrated config and trying to blacklist secrets.
/// In particular, do not expose DSNs, URL parameters, scripts, plugin values, or tunnel credentials.
pub fn connection_details(config: &ConnectionConfig) -> Value {
    json!({
        "id": safe_connection_text(&config.id),
        "name": safe_connection_text(&config.name),
        "note": safe_connection_text(&config.note),
        "db_type": config.db_type,
        "host": safe_connection_text(&config.host),
        "port": config.port,
        "username": safe_connection_text(&config.username),
        "database": config.database.as_deref().map(safe_connection_text),
        "driver_profile": config.driver_profile.as_deref().map(safe_connection_text),
        "ssl": config.ssl,
        "read_only": config.read_only,
        "save_password": config.save_password,
        "is_production": config.is_production,
        "connect_timeout_secs": config.connect_timeout_secs,
        "query_timeout_secs": config.query_timeout_secs,
        "idle_timeout_secs": config.idle_timeout_secs,
        "keepalive_interval_secs": config.keepalive_interval_secs,
    })
}

/// Omitted fields are unchanged. An empty password explicitly clears the saved password;
/// null clears database/driver_profile. Null for other fields is rejected, never silently ignored.
/// IDs and database types are immutable; unsupported fields fail closed rather than being discarded.
pub fn validate_connection_patch(patch: &Value) -> Result<(), String> {
    let object = patch
        .as_object()
        .filter(|object| !object.is_empty())
        .ok_or_else(|| "INVALID_CONNECTION: changes must be a non-empty JSON object".to_string())?;
    for (key, value) in object {
        let valid = match key.as_str() {
            "name" | "host" => value.as_str().is_some_and(|value| !value.trim().is_empty()),
            "note" | "username" | "password" => value.is_string(),
            "database" | "driver_profile" => value.is_null() || value.is_string(),
            "port" => value.as_u64().is_some_and(|port| port <= u16::MAX as u64),
            "ssl" | "read_only" | "save_password" | "is_production" => value.is_boolean(),
            "connect_timeout_secs" | "query_timeout_secs" | "idle_timeout_secs" | "keepalive_interval_secs" => {
                value.as_u64().is_some()
            }
            // Never echo an unknown key: it may itself contain a pasted credential.
            _ => return Err("INVALID_CONNECTION: unsupported or immutable connection field".to_string()),
        };
        if !valid {
            return Err(format!("INVALID_CONNECTION: invalid value for {key}"));
        }
    }
    Ok(())
}
