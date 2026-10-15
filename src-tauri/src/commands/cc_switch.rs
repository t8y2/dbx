use std::{path::PathBuf, sync::Arc};

use tauri::{AppHandle, Manager};

use super::connection::AppState;
pub use dbx_core::cc_switch::CcSwitchImportResult;

#[tauri::command]
pub async fn load_cc_switch_ai_configs(
    state: tauri::State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<CcSwitchImportResult, String> {
    if state
        .plugins
        .find_capability_for_plugin(
            dbx_core::cc_switch::CC_SWITCH_PLUGIN_ID,
            dbx_core::cc_switch::CC_SWITCH_PLUGIN_CAPABILITY,
        )?
        .is_none()
    {
        return Err("ccSwitchPluginNotInstalled".to_string());
    }
    let home_dir = app.path().home_dir().map_err(|error| format!("ccSwitchHomeDirectoryFailed:{error}"))?;
    let database_path = home_dir.join(".cc-switch").join("cc-switch.db");
    let settings_path = home_dir.join(".cc-switch").join("settings.json");
    state
        .plugins
        .invoke_capability_for_plugin(
            dbx_core::cc_switch::CC_SWITCH_PLUGIN_ID,
            dbx_core::cc_switch::CC_SWITCH_PLUGIN_CAPABILITY,
            dbx_core::cc_switch::CC_SWITCH_IMPORT_METHOD,
            serde_json::json!({
                "databasePath": database_path,
                "settingsPath": settings_path,
            }),
        )
        .await
}

#[tauri::command]
pub async fn load_magpie_ai_configs(
    state: tauri::State<'_, Arc<AppState>>,
    app: AppHandle,
) -> Result<CcSwitchImportResult, String> {
    if state
        .plugins
        .find_capability_for_plugin(
            dbx_core::cc_switch::CC_SWITCH_PLUGIN_ID,
            dbx_core::cc_switch::CC_SWITCH_PLUGIN_CAPABILITY,
        )?
        .is_none()
    {
        return Err("ccSwitchPluginNotInstalled".to_string());
    }
    let home_dir = app.path().home_dir().map_err(|error| format!("magpieConfigDirectoryFailed:{error}"))?;
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home_dir.join(".config"));
    let config_path = config_home.join("magpie").join("providers.json");
    state
        .plugins
        .invoke_capability_for_plugin(
            dbx_core::cc_switch::CC_SWITCH_PLUGIN_ID,
            dbx_core::cc_switch::CC_SWITCH_PLUGIN_CAPABILITY,
            dbx_core::cc_switch::MAGPIE_IMPORT_METHOD,
            serde_json::json!({ "configPath": config_path }),
        )
        .await
}
