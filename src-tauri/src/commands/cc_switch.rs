use std::sync::Arc;

use tauri::{AppHandle, Manager};

use super::connection::AppState;
pub use dbx_core::cc_switch::CcSwitchImportResult;

#[tauri::command]
pub async fn load_cc_switch_ai_configs(
    state: tauri::State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<CcSwitchImportResult, String> {
    if state.plugins.find_capability(dbx_core::cc_switch::CC_SWITCH_PLUGIN_CAPABILITY)?.is_none() {
        return Err("ccSwitchPluginNotInstalled".to_string());
    }
    let home_dir = app.path().home_dir().map_err(|error| format!("ccSwitchHomeDirectoryFailed:{error}"))?;
    let database_path = home_dir.join(".cc-switch").join("cc-switch.db");
    state
        .plugins
        .invoke_capability(
            dbx_core::cc_switch::CC_SWITCH_PLUGIN_CAPABILITY,
            dbx_core::cc_switch::CC_SWITCH_IMPORT_METHOD,
            serde_json::json!({ "databasePath": database_path }),
        )
        .await
}
