use std::sync::Arc;
use tauri::State;

use dbx_core::connection::{AppState, SalesforceCurrentUser};
use dbx_core::salesforce_oauth::{
    authorize_with_browser, device_authorization_request, device_poll, password_grant_token, refresh_access_token,
    SfDeviceAuthorization, SfDevicePoll, SfOauthParams, SfRefreshedToken, SfTokenSet,
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

/// Username-password (ROPC) login for orgs that permit it. Returns no refresh
/// token; the saved credentials let the driver re-login when the session dies.
#[tauri::command]
pub async fn salesforce_oauth_password_login(
    params: SfOauthParams,
    username: String,
    password: String,
) -> Result<SfTokenSet, String> {
    password_grant_token(&params, &username, &password).await
}

/// Cached connected-user identity for a Salesforce connection. Read-only
/// metadata call used by the identity badge and admin-detection UI.
#[tauri::command]
pub async fn salesforce_current_user(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<SalesforceCurrentUser, String> {
    state.salesforce_current_user(&connection_id).await
}
