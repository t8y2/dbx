use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use super::update_portable;
pub use dbx_core::update::UpdateInfo;
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const OFFICIAL_UPDATE_ENDPOINTS: [&str; 2] = [
    "https://dl.dbxio.com/releases/latest/latest.json",
    "https://github.com/t8y2/dbx/releases/latest/download/latest.json",
];
const R2_LATEST_RELEASE_DOWNLOAD_PREFIX: &str = "https://dl.dbxio.com/releases/latest/";
const CNB_RELEASE_DOWNLOAD_PREFIX: &str = "https://cnb.cool/dbxio.com/dbx/-/releases/download/";
const GITHUB_RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/t8y2/dbx/releases/download/";
const UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "update-download-progress";
const MAX_PORTABLE_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
const MAX_PORTABLE_SIGNATURE_BYTES: usize = 64 * 1024;

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
    Installing,
    Ready(ReadyUpdate),
}

enum ReadyUpdate {
    Installer { update: Box<Update>, bytes: Vec<u8> },
    Portable { archive: Vec<u8>, version: Version },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PortableAssetCandidate {
    archive_url: String,
    signature_url: String,
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

    fn finish_download(&self, update: ReadyUpdate) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        *pending = Some(PendingUpdate::Ready(update));
        Ok(())
    }

    fn cancel_download(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            if matches!(pending.as_ref(), Some(PendingUpdate::Downloading)) {
                *pending = None;
            }
        }
    }

    fn take_ready(&self) -> Result<ReadyUpdate, String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        match pending.take() {
            Some(PendingUpdate::Ready(update)) => {
                *pending = Some(PendingUpdate::Installing);
                Ok(update)
            }
            other => {
                *pending = other;
                Err("No downloaded update is ready to install.".to_string())
            }
        }
    }

    fn restore_ready(&self, update: ReadyUpdate) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        *pending = Some(PendingUpdate::Ready(update));
        Ok(())
    }

    fn finish_install(&self) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        *pending = None;
        Ok(())
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

    fn portable_asset_candidates(
        &self,
        latest_version: &str,
        arch: &str,
    ) -> Result<Vec<PortableAssetCandidate>, String> {
        let normalized_version = latest_version.trim().trim_start_matches('v');
        let filename = update_portable::portable_asset_name(normalized_version, arch)?;
        let tag = tag_version(normalized_version);
        let archive_urls = match self {
            Self::Official => vec![
                format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}{filename}"),
                format!("{GITHUB_RELEASE_DOWNLOAD_PREFIX}{tag}/{filename}"),
            ],
            Self::Cnb => vec![
                format!("{CNB_RELEASE_DOWNLOAD_PREFIX}{tag}/{filename}"),
                format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}{filename}"),
            ],
        };
        Ok(archive_urls
            .into_iter()
            .map(|archive_url| PortableAssetCandidate { signature_url: format!("{archive_url}.sig"), archive_url })
            .collect())
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
pub async fn check_for_updates(
    locale: Option<String>,
    source: Option<dbx_core::DownloadSource>,
) -> Result<UpdateInfo, String> {
    let locale = locale.unwrap_or_else(|| "zh-CN".to_string());
    let release = dbx_core::update::fetch_latest_release(&locale, source.unwrap_or_default()).await?;
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
    let portable_version = if crate::data_dir::is_portable_mode() {
        let requested_version =
            latest_version.as_deref().ok_or_else(|| "Latest version is required for portable updates.".to_string())?;
        Some(update_portable::validate_requested_portable_version(requested_version, env!("CARGO_PKG_VERSION"))?)
    } else {
        None
    };
    state.begin_download()?;
    let result = if let Some(version) = portable_version {
        download_portable_update_inner(&app, &source, &version)
            .await
            .map(|archive| ReadyUpdate::Portable { archive, version })
    } else {
        download_update_inner(&app, &source, latest_version.as_deref())
            .await
            .map(|(update, bytes)| ReadyUpdate::Installer { update: Box::new(update), bytes })
    };
    match result {
        Ok(update) => state.finish_download(update),
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

async fn download_portable_update_inner(
    app: &AppHandle,
    source: &UpdateDownloadSource,
    latest_version: &Version,
) -> Result<Vec<u8>, String> {
    let latest_version_text = latest_version.to_string();
    let candidates = source.portable_asset_candidates(&latest_version_text, std::env::consts::ARCH)?;
    let client = portable_update_http_client()?;
    let mut failures = Vec::new();

    for candidate in candidates {
        println!("[DBX updater] downloading portable update from {}", candidate.archive_url);
        let result = async {
            let signature =
                download_bounded_bytes(&client, &candidate.signature_url, MAX_PORTABLE_SIGNATURE_BYTES, None).await?;
            let signature = String::from_utf8(signature)
                .map_err(|error| format!("Portable update signature is not valid UTF-8: {error}"))?;
            let archive =
                download_bounded_bytes(&client, &candidate.archive_url, MAX_PORTABLE_ARCHIVE_BYTES, Some(app)).await?;
            update_portable::verify_portable_archive(&archive, &signature, latest_version, std::env::consts::ARCH)?;
            Ok::<Vec<u8>, String>(archive)
        }
        .await;

        match result {
            Ok(archive) => return Ok(archive),
            Err(error) => {
                println!("[DBX updater] portable update candidate failed: {error}");
                failures.push(format!("{}: {error}", candidate.archive_url));
            }
        }
    }

    Err(format!("Failed to download a verified portable update. {}", failures.join("; ")))
}

fn portable_update_http_client() -> Result<reqwest::Client, String> {
    let mut builder =
        reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(15 * 60));
    if let Some(proxy_url) = dbx_core::update::system_proxy_url() {
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|error| format!("Invalid system proxy URL: {error}"))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|error| format!("Failed to create portable update client: {error}"))
}

async fn download_bounded_bytes(
    client: &reqwest::Client,
    url: &str,
    max_bytes: usize,
    progress_app: Option<&AppHandle>,
) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to request {url}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to download {url}: {error}"))?;
    let total = response.content_length();
    if total.is_some_and(|total| total > max_bytes as u64) {
        return Err(format!("Update asset exceeds the {max_bytes} byte limit."));
    }

    if let Some(app) = progress_app {
        let _ = app.emit(UPDATE_DOWNLOAD_PROGRESS_EVENT, UpdateDownloadProgress { downloaded: 0, total });
    }
    let mut bytes = Vec::with_capacity(total.unwrap_or(0).min(max_bytes as u64) as usize);
    while let Some(chunk) =
        response.chunk().await.map_err(|error| format!("Failed while downloading {url}: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("Update asset exceeds the {max_bytes} byte limit."));
        }
        bytes.extend_from_slice(&chunk);
        if let Some(app) = progress_app {
            let _ = app
                .emit(UPDATE_DOWNLOAD_PROGRESS_EVENT, UpdateDownloadProgress { downloaded: bytes.len() as u64, total });
        }
    }
    Ok(bytes)
}

#[tauri::command]
pub fn install_downloaded_update(app: AppHandle, state: tauri::State<'_, PendingUpdateState>) -> Result<(), String> {
    let ready = state.take_ready()?;
    let portable = matches!(&ready, ReadyUpdate::Portable { .. });
    let install_result = match &ready {
        ReadyUpdate::Installer { update, bytes } => {
            update.install(bytes).map_err(|error| format!("Failed to install update: {error}"))
        }
        ReadyUpdate::Portable { archive, version } => {
            update_portable::ensure_portable_version_is_newer(version, env!("CARGO_PKG_VERSION"))
                .and_then(|_| update_portable::launch_portable_update_helper(archive, version))
        }
    };
    if let Err(error) = install_result {
        state.restore_ready(ready)?;
        return Err(error);
    }
    state.finish_install()?;
    if portable {
        schedule_portable_update_exit(app);
    }
    Ok(())
}

fn schedule_portable_update_exit(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(state) = app.try_state::<crate::CloseBehaviorState>() {
            state.allow_next_exit();
        }
        app.exit(0);
    });
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
        tag_version, UpdateDownloadSource, CNB_RELEASE_DOWNLOAD_PREFIX, GITHUB_RELEASE_DOWNLOAD_PREFIX,
        OFFICIAL_UPDATE_ENDPOINTS, R2_LATEST_RELEASE_DOWNLOAD_PREFIX,
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

    #[test]
    fn builds_signed_official_portable_asset_candidates() {
        let candidates = UpdateDownloadSource::Official.portable_asset_candidates("0.5.64", "x86_64").unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates[0].archive_url,
            format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}DBX_0.5.64_x64-portable.zip")
        );
        assert_eq!(
            candidates[1].archive_url,
            format!("{GITHUB_RELEASE_DOWNLOAD_PREFIX}v0.5.64/DBX_0.5.64_x64-portable.zip")
        );
        assert!(candidates.iter().all(|candidate| candidate.signature_url == format!("{}.sig", candidate.archive_url)));
    }

    #[test]
    fn builds_cnb_portable_asset_candidate_with_r2_fallback() {
        let candidates = UpdateDownloadSource::Cnb.portable_asset_candidates("v0.5.64", "aarch64").unwrap();
        assert_eq!(
            candidates[0].archive_url,
            format!("{CNB_RELEASE_DOWNLOAD_PREFIX}v0.5.64/DBX_0.5.64_arm64-portable.zip")
        );
        assert_eq!(
            candidates[1].archive_url,
            format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}DBX_0.5.64_arm64-portable.zip")
        );
    }
}
