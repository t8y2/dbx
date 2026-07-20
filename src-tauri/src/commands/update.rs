use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

pub use dbx_core::update::UpdateInfo;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

const OFFICIAL_UPDATE_ENDPOINTS: [&str; 2] = [
    "https://dl.dbxio.com/releases/latest/latest.json",
    "https://github.com/t8y2/dbx/releases/latest/download/latest.json",
];
const R2_LATEST_RELEASE_DOWNLOAD_PREFIX: &str = "https://dl.dbxio.com/releases/latest/";
const CNB_RELEASE_DOWNLOAD_PREFIX: &str = "https://cnb.cool/dbxio.com/dbx/-/releases/download/";
const GITHUB_RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/t8y2/dbx/releases/download/";
const UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "update-download-progress";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateDownloadSource {
    Official,
    Cnb,
}

#[derive(Clone, Debug, Serialize)]
pub struct UpdateDownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

enum PendingUpdate {
    Downloading,
    Ready { update: Box<Update>, bytes: Vec<u8> },
}

#[derive(Default)]
pub struct PendingUpdateState {
    pending: Mutex<Option<PendingUpdate>>,
}

impl PendingUpdateState {
    fn begin_download(&self) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        if pending.is_some() {
            return Err("An update is already downloading or ready to install.".to_string());
        }
        *pending = Some(PendingUpdate::Downloading);
        Ok(())
    }

    fn finish_download(&self, update: Update, bytes: Vec<u8>) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        *pending = Some(PendingUpdate::Ready { update: Box::new(update), bytes });
        Ok(())
    }

    fn cancel_download(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            if matches!(pending.as_ref(), Some(PendingUpdate::Downloading)) {
                *pending = None;
            }
        }
    }
}

impl UpdateDownloadSource {
    fn label(&self) -> &'static str {
        match self {
            Self::Official => "official",
            Self::Cnb => "cnb",
        }
    }

    fn endpoints(&self, latest_version: Option<&str>) -> Result<Vec<String>, String> {
        match self {
            Self::Official => Ok(OFFICIAL_UPDATE_ENDPOINTS.iter().map(|endpoint| endpoint.to_string()).collect()),
            Self::Cnb => {
                let version =
                    latest_version.ok_or_else(|| "Latest version is required for CNB updates.".to_string())?;
                Ok(vec![
                    format!("{CNB_RELEASE_DOWNLOAD_PREFIX}{}/latest.json", tag_version(version)),
                    OFFICIAL_UPDATE_ENDPOINTS[0].to_string(),
                ])
            }
        }
    }

    fn rewrite_download_url(&self, url: &str) -> Result<Option<String>, String> {
        let Some(target_prefix) = self.mirror_download_prefix() else { return Ok(None) };

        if url.starts_with(target_prefix) {
            return Ok(None);
        }

        // Mirror latest.json files still contain GitHub asset URLs, so rewrite only that known release prefix.
        let rewritten = url
            .strip_prefix(GITHUB_RELEASE_DOWNLOAD_PREFIX)
            .map(|path| format!("{target_prefix}{path}"))
            .ok_or_else(|| format!("Unsupported update download URL for {} source: {url}", self.label()))?;
        Ok(Some(rewritten))
    }

    fn mirror_download_prefix(&self) -> Option<&'static str> {
        match self {
            Self::Cnb => Some(CNB_RELEASE_DOWNLOAD_PREFIX),
            Self::Official => None,
        }
    }

    fn r2_fallback_url(&self, url: &str) -> Result<Option<String>, String> {
        if matches!(self, Self::Official) || url.starts_with(R2_LATEST_RELEASE_DOWNLOAD_PREFIX) {
            return Ok(None);
        }
        let filename = url
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| format!("Unsupported update download URL for {} source: {url}", self.label()))?;
        Ok(Some(format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}{filename}")))
    }
}

fn tag_version(version: &str) -> String {
    let version = version.trim();
    if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    }
}

#[tauri::command]
pub async fn check_for_updates(locale: Option<String>) -> Result<UpdateInfo, String> {
    let locale = locale.unwrap_or_else(|| "zh-CN".to_string());
    let release = dbx_core::update::fetch_latest_release(&locale).await?;
    let current_version = env!("CARGO_PKG_VERSION");
    let mut info = dbx_core::update::build_update_info(release, current_version);
    info.portable_mode = crate::data_dir::is_portable_mode();
    Ok(info)
}

#[tauri::command]
pub async fn fetch_changelog(lang: Option<String>) -> Result<dbx_core::changelog::ChangelogData, String> {
    let lang = lang.unwrap_or_else(|| "en".to_string());
    dbx_core::changelog::fetch_changelog(&lang).await
}

#[tauri::command]
pub async fn get_system_proxy_url() -> Option<String> {
    tauri::async_runtime::spawn_blocking(dbx_core::update::system_proxy_url).await.ok().flatten()
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    state: tauri::State<'_, PendingUpdateState>,
    source: UpdateDownloadSource,
    latest_version: Option<String>,
) -> Result<(), String> {
    if crate::data_dir::is_portable_mode() {
        return Err("Portable builds cannot use the in-app installer.".to_string());
    }

    state.begin_download()?;
    let result = download_update_inner(&app, &source, latest_version.as_deref()).await;
    match result {
        Ok((update, bytes)) => state.finish_download(update, bytes),
        Err(error) => {
            state.cancel_download();
            Err(error)
        }
    }
}

async fn download_update_inner(
    app: &AppHandle,
    source: &UpdateDownloadSource,
    latest_version: Option<&str>,
) -> Result<(Update, Vec<u8>), String> {
    let endpoint_urls = source.endpoints(latest_version)?;
    println!("[DBX updater] checking from {} endpoints: {}", source.label(), endpoint_urls.join(", "));
    let mut endpoints = Vec::with_capacity(endpoint_urls.len());
    for endpoint_url in endpoint_urls {
        endpoints.push(endpoint_url.parse().map_err(|e| format!("Invalid update endpoint: {e}"))?);
    }
    let mut builder =
        app.updater_builder().endpoints(endpoints).map_err(|e| format!("Failed to configure updater endpoint: {e}"))?;

    if let Some(proxy_url) = dbx_core::update::system_proxy_url() {
        let proxy = proxy_url.parse().map_err(|e| format!("Invalid system proxy URL: {e}"))?;
        builder = builder.proxy(proxy);
    }

    let updater = builder.build().map_err(|e| format!("Failed to create updater: {e}"))?;
    let update = updater.check().await.map_err(|e| format!("Failed to check updates: {e}"))?;
    let Some(mut update) = update else {
        return Err("No update available.".to_string());
    };
    if let Some(download_url) = source.rewrite_download_url(update.download_url.as_str())? {
        update.download_url = download_url.parse().map_err(|e| format!("Invalid CNB update download URL: {e}"))?;
    }
    if !update_url_is_available(update.download_url.as_str()).await {
        if let Some(fallback_url) = source.r2_fallback_url(update.download_url.as_str())? {
            println!("[DBX updater] {} asset unavailable; falling back to R2: {fallback_url}", source.label());
            update.download_url = fallback_url.parse().map_err(|e| format!("Invalid R2 update download URL: {e}"))?;
        }
    }
    println!("[DBX updater] downloading from {} URL: {}", source.label(), update.download_url);

    let downloaded = Arc::new(AtomicU64::new(0));
    let finished_downloaded = Arc::clone(&downloaded);
    let bytes = update
        .download(
            |chunk_len, total| {
                let downloaded =
                    downloaded.fetch_add(chunk_len as u64, Ordering::Relaxed).saturating_add(chunk_len as u64);
                let _ = app.emit(UPDATE_DOWNLOAD_PROGRESS_EVENT, UpdateDownloadProgress { downloaded, total });
            },
            || {
                let downloaded = finished_downloaded.load(Ordering::Relaxed);
                let _ = app.emit(
                    UPDATE_DOWNLOAD_PROGRESS_EVENT,
                    UpdateDownloadProgress { downloaded, total: Some(downloaded) },
                );
            },
        )
        .await
        .map_err(|e| format!("Failed to download update: {e}"))?;
    Ok((update, bytes))
}

#[tauri::command]
pub fn install_downloaded_update(state: tauri::State<'_, PendingUpdateState>) -> Result<(), String> {
    let mut pending = state.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
    let Some(PendingUpdate::Ready { update, bytes }) = pending.as_ref() else {
        return Err("No downloaded update is ready to install.".to_string());
    };
    update.install(bytes).map_err(|e| format!("Failed to install update: {e}"))?;
    *pending = None;
    Ok(())
}

async fn update_url_is_available(url: &str) -> bool {
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build() {
        Ok(client) => client,
        Err(_) => return false,
    };
    // Request only the first byte because some release hosts do not implement HEAD consistently.
    client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::{
        tag_version, UpdateDownloadSource, CNB_RELEASE_DOWNLOAD_PREFIX, OFFICIAL_UPDATE_ENDPOINTS,
        R2_LATEST_RELEASE_DOWNLOAD_PREFIX,
    };

    #[test]
    fn normalizes_update_tag_versions() {
        assert_eq!(tag_version("0.5.39"), "v0.5.39");
        assert_eq!(tag_version("v0.5.39"), "v0.5.39");
    }

    #[test]
    fn builds_official_update_endpoints() {
        let endpoints = UpdateDownloadSource::Official.endpoints(None).unwrap();
        assert_eq!(endpoints, OFFICIAL_UPDATE_ENDPOINTS);
    }

    #[test]
    fn builds_cnb_update_endpoint_for_tag() {
        let endpoints = UpdateDownloadSource::Cnb.endpoints(Some("0.5.39")).unwrap();
        assert_eq!(
            endpoints,
            vec![format!("{CNB_RELEASE_DOWNLOAD_PREFIX}v0.5.39/latest.json"), OFFICIAL_UPDATE_ENDPOINTS[0].to_string()]
        );
    }

    #[test]
    fn rewrites_github_asset_url_to_cnb() {
        let download_url = UpdateDownloadSource::Cnb
            .rewrite_download_url("https://github.com/t8y2/dbx/releases/download/v0.5.39/DBX_0.5.39_aarch64.dmg")
            .unwrap()
            .unwrap();
        assert_eq!(download_url, "https://cnb.cool/dbxio.com/dbx/-/releases/download/v0.5.39/DBX_0.5.39_aarch64.dmg");
    }

    #[test]
    fn accepts_existing_cnb_asset_url() {
        let download_url = UpdateDownloadSource::Cnb
            .rewrite_download_url("https://cnb.cool/dbxio.com/dbx/-/releases/download/v0.5.39/DBX_0.5.39_aarch64.dmg")
            .unwrap();
        assert_eq!(download_url, None);
    }

    #[test]
    fn builds_r2_fallback_for_mirror_asset() {
        let fallback = UpdateDownloadSource::Cnb
            .r2_fallback_url("https://cnb.cool/dbxio.com/dbx/-/releases/download/v0.5.44/DBX_0.5.44_x64.dmg")
            .unwrap();
        assert_eq!(fallback, Some(format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}DBX_0.5.44_x64.dmg")));
    }
}
