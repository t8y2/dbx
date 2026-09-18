use serde::{Deserialize, Serialize};

use crate::ai::AiConfigItem;

/// Stable DBX capability identifiers implemented by the optional CC-SWITCH plugin.
pub const CC_SWITCH_PLUGIN_ID: &str = "cc-switch";
pub const CC_SWITCH_PLUGIN_CAPABILITY: &str = "ai-config-import";
pub const CC_SWITCH_IMPORT_METHOD: &str = "import_ai_configs";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchImportSkipped {
    pub app_type: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchImportResult {
    pub configs: Vec<AiConfigItem>,
    pub skipped: Vec<CcSwitchImportSkipped>,
}
