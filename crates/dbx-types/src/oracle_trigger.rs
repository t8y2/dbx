use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Opt-in identity semantics. An old provider omitting trigger metadata has not
/// proved this contract even when it accepts the request parameter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetadataIdentityMode {
    Exact,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataReadOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_mode: Option<MetadataIdentityMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
}

impl MetadataReadOptions {
    pub fn is_exact(&self) -> bool {
        self.identity_mode == Some(MetadataIdentityMode::Exact)
    }

    /// Existing Agent and plugin methods use snake-case request fields.
    pub fn apply_to(&self, params: &mut serde_json::Value) {
        if let Some(mode) = self.identity_mode {
            params["identity_mode"] = serde_json::json!(mode);
        }
        if let Some(catalog) = &self.catalog {
            params["catalog"] = serde_json::json!(catalog);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTriggerParent {
    pub owner: String,
    pub name: String,
    pub object_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTriggerDefinition {
    pub origin: String,
    pub format: String,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTriggerError {
    pub sequence: i64,
    pub line: i64,
    pub position: i64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTriggerReadState {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleTriggerMetadata {
    pub contract_version: u8,
    pub identity_mode: MetadataIdentityMode,
    pub engine: String,
    pub engine_version: Option<String>,
    pub owner: String,
    pub name: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_type: Option<String>,
    pub scope_owner: Option<String>,
    pub parent: Option<OracleTriggerParent>,
    // Dictionary IDs may exceed JavaScript's exact integer range.
    pub object_id: Option<String>,
    pub last_ddl_time: Option<String>,
    pub definition: Option<OracleTriggerDefinition>,
    pub errors: Option<Vec<OracleTriggerError>>,
    #[serde(default)]
    pub reads: BTreeMap<String, OracleTriggerReadState>,
}
