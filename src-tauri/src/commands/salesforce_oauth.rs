use std::sync::Arc;
use tauri::State;

use dbx_core::connection::AppState;
use dbx_core::salesforce_oauth::{
    authorize_with_browser, device_authorization_request, device_poll, refresh_access_token, SfDeviceAuthorization,
    SfDevicePoll, SfOauthParams, SfRefreshedToken, SfTokenSet,
};

#[tauri::command]
pub async fn salesforce_oauth_browser_authorize(
    state: State<'_, Arc<AppState>>,
    params: SfOauthParams,
) -> Result<SfTokenSet, String> {
    let opener = state.salesforce_browser_opener().ok_or_else(|| {
        "Browser OAuth is only available in the desktop app. Use the device code flow instead.".to_string()
    })?;
    authorize_with_browser(&params, &opener).await
}

#[tauri::command]
pub async fn salesforce_oauth_device_start(params: SfOauthParams) -> Result<SfDeviceAuthorization, String> {
    device_authorization_request(&params).await
}

#[tauri::command]
pub async fn salesforce_oauth_device_poll(
    params: SfOauthParams,
    device_code: String,
    interval_secs: u64,
) -> Result<SfDevicePoll, String> {
    device_poll(&params, &device_code, interval_secs).await
}

#[tauri::command]
pub async fn salesforce_oauth_refresh(
    params: SfOauthParams,
    refresh_token: String,
) -> Result<SfRefreshedToken, String> {
    refresh_access_token(&params, &refresh_token).await
}
