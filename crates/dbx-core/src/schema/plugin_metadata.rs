//! Narrow, read-only schema metadata exposed through the plugin Host API.
//!
//! The request is the wire representation of the desktop `PluginTableContext`:
//! it carries table identity only, never a connection config or credential. The
//! implementation deliberately enters the existing schema abstraction instead
//! of issuing driver-specific metadata SQL from the plugin layer.

use serde::{Deserialize, Serialize};

use crate::connection::AppState;
use crate::db;
use crate::types::ColumnMetadataCapabilities;

pub const MAX_PLUGIN_SCHEMA_METADATA_NAME_CHARS: usize = 256;
pub const CONNECTION_NOT_OPEN_ERROR: &str = "Connection is not open";
pub const TABLE_METADATA_SESSION_NOT_OPEN_ERROR: &str = "Connection session is not open for the requested database";

/// The Rust wire DTO intentionally mirrors the public TypeScript
/// `PluginTableContext` field-for-field. It is not a second table identity
/// model; it is the camelCase JSON boundary used by Tauri and Web transports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTableContext {
    pub connection_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTableMetadata {
    pub columns: Vec<PluginColumnMetadata>,
    /// Reports whether structured optional fields are exposed by the provider
    /// path. `unknown` is deliberate when an external provider gives DBX no
    /// provenance; the host never guesses from a database type.
    pub field_capabilities: PluginMetadataFieldCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginColumnMetadata {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precision: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<i32>,
    #[serde(rename = "default", default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMetadataFieldCapabilities {
    pub length: PluginMetadataFieldAvailability,
    pub precision: PluginMetadataFieldAvailability,
    pub scale: PluginMetadataFieldAvailability,
    #[serde(rename = "default")]
    pub default_value: PluginMetadataFieldAvailability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginMetadataFieldAvailability {
    Supported,
    Unsupported,
    Unknown,
}

/// Resolve one table's columns through DBX's existing metadata subsystem.
///
/// The open-connection check is intentionally before `get_columns_core`: that
/// ordinary DBX path is allowed to create metadata pools for the application,
/// but a plugin request must not turn a saved configuration into an implicit
/// connection. A closed request returns without touching the pool registry.
pub async fn get_table_metadata(state: &AppState, context: PluginTableContext) -> Result<PluginTableMetadata, String> {
    let context = validate_plugin_table_context(context)?;
    let config = {
        let configs = state.configs.read().await;
        configs.get(&context.connection_id).cloned()
    }
    .ok_or_else(|| "Connection config not found".to_string())?;

    if !state.is_connection_open(&context.connection_id).await {
        return Err(CONNECTION_NOT_OPEN_ERROR.to_string());
    }

    // A table contribution may omit a scope when the selected database does
    // not expose one. When the host already knows a saved/default scope, use
    // that existing identity; otherwise the schema subsystem receives the
    // same empty scope used by its normal metadata path.
    let database = context.database.as_deref().or_else(|| config.effective_database()).unwrap_or_default();
    let schema = context.schema.as_deref().or(config.default_schema.as_deref()).unwrap_or_default();
    let pool_key = state
        .existing_metadata_pool_key_for_session(&context.connection_id, Some(database), None)
        .await
        .ok_or_else(|| TABLE_METADATA_SESSION_NOT_OPEN_ERROR.to_string())?;
    let columns = super::get_columns_core_for_existing_pool(
        state,
        &context.connection_id,
        database,
        schema,
        &context.table,
        &pool_key,
    )
    .await?;
    if columns.is_empty() {
        return Err("Table metadata provider returned no columns".to_string());
    }
    let field_capabilities = field_capabilities(&columns);

    Ok(PluginTableMetadata { columns: columns.into_iter().map(map_column).collect(), field_capabilities })
}

fn validate_plugin_table_context(mut context: PluginTableContext) -> Result<PluginTableContext, String> {
    context.connection_id = required_identifier(context.connection_id, "connectionId")?;
    context.table = required_identifier(context.table, "table")?;
    context.database = optional_identifier(context.database, "database")?;
    context.schema = optional_identifier(context.schema, "schema")?;
    Ok(context)
}

fn required_identifier(value: String, name: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if value.chars().count() > MAX_PLUGIN_SCHEMA_METADATA_NAME_CHARS {
        return Err(format!("{name} must be at most {MAX_PLUGIN_SCHEMA_METADATA_NAME_CHARS} characters"));
    }
    Ok(value.to_string())
}

fn optional_identifier(value: Option<String>, name: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > MAX_PLUGIN_SCHEMA_METADATA_NAME_CHARS {
        return Err(format!("{name} must be at most {MAX_PLUGIN_SCHEMA_METADATA_NAME_CHARS} characters"));
    }
    Ok(Some(value.to_string()))
}

fn map_column(column: db::ColumnInfo) -> PluginColumnMetadata {
    PluginColumnMetadata {
        name: column.name,
        data_type: column.data_type,
        nullable: column.is_nullable,
        length: column.character_maximum_length,
        precision: column.numeric_precision,
        scale: column.numeric_scale,
        default_value: column.column_default,
    }
}

fn field_capabilities(columns: &[db::ColumnInfo]) -> PluginMetadataFieldCapabilities {
    PluginMetadataFieldCapabilities {
        length: field_capability(columns, |capabilities| capabilities.length),
        precision: field_capability(columns, |capabilities| capabilities.precision),
        scale: field_capability(columns, |capabilities| capabilities.scale),
        default_value: field_capability(columns, |capabilities| capabilities.default),
    }
}

fn field_capability(
    columns: &[db::ColumnInfo],
    field: impl Fn(ColumnMetadataCapabilities) -> bool,
) -> PluginMetadataFieldAvailability {
    let Some(first) = columns.first().and_then(|column| column.metadata_capabilities) else {
        return PluginMetadataFieldAvailability::Unknown;
    };
    if columns.iter().all(|column| column.metadata_capabilities.is_some_and(|capabilities| capabilities == first)) {
        if field(first) {
            PluginMetadataFieldAvailability::Supported
        } else {
            PluginMetadataFieldAvailability::Unsupported
        }
    } else {
        PluginMetadataFieldAvailability::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> crate::models::connection::ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "conn-1",
            "name": "Connection",
            "db_type": "postgres",
            "host": "127.0.0.1",
            "port": 5432,
            "username": "user",
            "password": "secret"
        }))
        .unwrap()
    }

    fn column(name: &str) -> db::ColumnInfo {
        db::ColumnInfo {
            name: name.to_string(),
            data_type: "character varying".to_string(),
            is_nullable: true,
            column_default: None,
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: Some(64),
            metadata_capabilities: Some(ColumnMetadataCapabilities::all_supported()),
            ..Default::default()
        }
    }

    #[test]
    fn maps_column_info_to_the_narrow_public_contract() {
        let metadata = PluginTableMetadata {
            columns: vec![map_column(column("name"))],
            field_capabilities: field_capabilities(&[column("name")]),
        };
        let value = serde_json::to_value(metadata).unwrap();
        assert_eq!(value["columns"][0]["name"], "name");
        assert_eq!(value["columns"][0]["dataType"], "character varying");
        assert_eq!(value["columns"][0]["nullable"], true);
        assert_eq!(value["columns"][0]["length"], 64);
        assert!(value["columns"][0].get("default").is_none());
        assert!(value["columns"][0].get("comment").is_none());
        assert_eq!(value["fieldCapabilities"]["length"], "supported");
    }

    #[test]
    fn does_not_guess_capabilities_without_provider_provenance() {
        let column = db::ColumnInfo { name: "id".to_string(), data_type: "integer".to_string(), ..Default::default() };
        let capabilities = field_capabilities(&[column]);
        assert_eq!(capabilities.length, PluginMetadataFieldAvailability::Unknown);
        assert_eq!(capabilities.precision, PluginMetadataFieldAvailability::Unknown);
    }

    #[test]
    fn preserves_unsupported_structured_fields_without_fabricating_values() {
        let mut column_info = column("id");
        column_info.character_maximum_length = None;
        column_info.numeric_precision = None;
        column_info.numeric_scale = None;
        column_info.metadata_capabilities = Some(ColumnMetadataCapabilities::default_only());
        let metadata = PluginTableMetadata {
            columns: vec![map_column(column_info)],
            field_capabilities: field_capabilities(&[db::ColumnInfo {
                metadata_capabilities: Some(ColumnMetadataCapabilities::default_only()),
                ..column("id")
            }]),
        };
        let value = serde_json::to_value(metadata).unwrap();
        assert!(value["columns"][0].get("length").is_none());
        assert_eq!(value["fieldCapabilities"]["length"], "unsupported");
        assert_eq!(value["fieldCapabilities"]["default"], "supported");
    }

    #[tokio::test]
    async fn saved_but_disconnected_context_is_rejected_without_creating_a_pool() {
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
        let state = AppState::new_with_plugin_dir(storage, dir.path().join("plugins"));
        let config = config();
        state.configs.write().await.insert(config.id.clone(), config);

        let context = PluginTableContext {
            connection_id: "conn-1".to_string(),
            database: Some("app".to_string()),
            schema: Some("public".to_string()),
            table: "users".to_string(),
        };
        let error = get_table_metadata(&state, context).await.unwrap_err();
        assert_eq!(error, CONNECTION_NOT_OPEN_ERROR);
        assert!(state.with_connection_pools(|pools| pools.is_empty()).await);
    }
}
