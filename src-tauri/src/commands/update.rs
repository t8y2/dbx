use std::future::Future;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

pub use super::update_cache::DownloadedUpdate;
use super::{
    update_cache::{self, CacheRecord},
    update_portable,
};
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
const DOWNLOAD_CANCELED_ERROR: &str = "Download canceled by user.";
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PORTABLE_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
const MAX_PORTABLE_SIGNATURE_BYTES: usize = 64 * 1024;
const IS_WINDOWS_7_TARGET: bool = cfg!(target_vendor = "win7");

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
    pub attempt_id: String,
    pub version: String,
}

#[derive(Default)]
struct UpdateDownloadProgressGate {
    last_visible_percentage: Option<u128>,
}

impl UpdateDownloadProgressGate {
    fn should_emit(&mut self, downloaded: u64, total: Option<u64>) -> bool {
        let visible_percentage = match total {
            Some(total) if total > 0 => {
                let total = total as u128;
                ((downloaded as u128).saturating_mul(100).saturating_add(total / 2)) / total
            }
            _ => 0,
        };
        if self.last_visible_percentage == Some(visible_percentage) {
            return false;
        }
        self.last_visible_percentage = Some(visible_percentage);
        true
    }
}

enum PendingUpdate {
    Downloading(Arc<DownloadCancellation>),
    Installing,
    Ready(Box<CachedUpdate>),
}

struct CachedUpdate {
    record: CacheRecord,
    ready: ReadyUpdate,
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

#[derive(Debug)]
struct DownloadCancellation {
    canceled: tokio::sync::watch::Sender<bool>,
}

impl Default for DownloadCancellation {
    fn default() -> Self {
        let (canceled, _) = tokio::sync::watch::channel(false);
        Self { canceled }
    }
}

impl DownloadCancellation {
    fn cancel(&self) {
        self.canceled.send_replace(true);
    }

    fn is_canceled(&self) -> bool {
        *self.canceled.borrow()
    }

    async fn canceled(&self) {
        let mut canceled = self.canceled.subscribe();
        if *canceled.borrow() {
            return;
        }
        while canceled.changed().await.is_ok() {
            if *canceled.borrow_and_update() {
                return;
            }
        }
    }
}

#[derive(Default)]
pub struct PendingUpdateState {
    pending: Mutex<Option<PendingUpdate>>,
}

impl PendingUpdateState {
    fn begin_download(&self) -> Result<Arc<DownloadCancellation>, String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        if pending.is_some() {
            return Err("An update is already downloading or ready to install.".to_string());
        }
        let cancellation = Arc::new(DownloadCancellation::default());
        *pending = Some(PendingUpdate::Downloading(Arc::clone(&cancellation)));
        Ok(cancellation)
    }

    fn finish_download(
        &self,
        cancellation: &Arc<DownloadCancellation>,
        update: CachedUpdate,
        root: &std::path::Path,
    ) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        let is_current = matches!(
            pending.as_ref(),
            Some(PendingUpdate::Downloading(current))
                if Arc::ptr_eq(current, cancellation) && !cancellation.is_canceled()
        );
        if !is_current {
            return Err(DOWNLOAD_CANCELED_ERROR.to_string());
        }
        let bytes = match &update.ready {
            ReadyUpdate::Installer { bytes, .. } => bytes,
            ReadyUpdate::Portable { archive, .. } => archive,
        };
        update_cache::commit(root, &update.record, bytes)?;
        *pending = Some(PendingUpdate::Ready(Box::new(update)));
        Ok(())
    }

    fn finish_failed_download(&self, cancellation: &Arc<DownloadCancellation>) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        let is_current = matches!(
            pending.as_ref(),
            Some(PendingUpdate::Downloading(current)) if Arc::ptr_eq(current, cancellation)
        );
        if is_current {
            *pending = None;
        }
        Ok(())
    }

    pub fn cancel_download(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(PendingUpdate::Downloading(cancellation)) = pending.as_ref() {
                cancellation.cancel();
                *pending = None;
            }
        }
    }

    fn take_ready(&self, cache_id: &str, expected_version: &str) -> Result<CachedUpdate, String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        match pending.take() {
            Some(PendingUpdate::Ready(update))
                if update.record.info.cache_id == cache_id && update.record.info.version == expected_version =>
            {
                *pending = Some(PendingUpdate::Installing);
                Ok(*update)
            }
            other => {
                *pending = other;
                Err("No downloaded update is ready to install.".to_string())
            }
        }
    }

    fn restore_ready(&self, update: CachedUpdate) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        *pending = Some(PendingUpdate::Ready(Box::new(update)));
        Ok(())
    }

    fn discard_ready(&self, cache_id: &str, root: &std::path::Path) -> Result<(), String> {
        let mut pending = self.pending.lock().map_err(|_| "Update state is unavailable.")?;
        match pending.as_ref() {
            Some(PendingUpdate::Ready(cached)) if cached.record.info.cache_id == cache_id => {}
            _ => return Err("Cached update changed or is busy.".into()),
        }
        // Logical eviction must succeed even if disk cleanup fails. A later download
        // retries cleanup before any network work or cache commit.
        *pending = None;
        update_cache::discard(root)
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

    fn installer_asset_candidates(&self, download_url: &str, latest_version: Option<&str>) -> Vec<String> {
        let filename = download_url.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or("");

        let tag = latest_version.map(tag_version).unwrap_or_else(|| {
            if let Some(pos) = download_url.find("/releases/download/") {
                let rest = &download_url[pos + "/releases/download/".len()..];
                if let Some(tag_end) = rest.find('/') {
                    return rest[..tag_end].to_string();
                }
            }
            "".to_string()
        });

        let raw_candidates = match self {
            Self::Official => {
                let mut urls = Vec::new();
                if !filename.is_empty() {
                    urls.push(format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}{filename}"));
                }
                urls.push(download_url.to_string());
                if !tag.is_empty() && !filename.is_empty() {
                    urls.push(format!("{GITHUB_RELEASE_DOWNLOAD_PREFIX}{tag}/{filename}"));
                }
                urls
            }
            Self::Cnb => {
                let mut urls = Vec::new();
                if let Ok(Some(rewritten)) = self.rewrite_download_url(download_url) {
                    urls.push(rewritten);
                } else if !tag.is_empty() && !filename.is_empty() {
                    urls.push(format!("{CNB_RELEASE_DOWNLOAD_PREFIX}{tag}/{filename}"));
                }
                if !filename.is_empty() {
                    urls.push(format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}{filename}"));
                }
                urls.push(download_url.to_string());
                urls
            }
        };

        let mut unique = Vec::new();
        for url in raw_candidates {
            if !unique.contains(&url) {
                unique.push(url);
            }
        }
        unique
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
    info.manual_update_only = requires_manual_update(IS_WINDOWS_7_TARGET);
    Ok(info)
}

fn requires_manual_update(is_windows_7_target: bool) -> bool {
    is_windows_7_target
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
pub fn cancel_update_download(state: tauri::State<'_, PendingUpdateState>) {
    state.cancel_download();
}

fn package_kind(app: &AppHandle) -> Result<String, String> {
    if crate::data_dir::is_portable_mode() {
        return Ok("portable".into());
    }
    Ok(app.updater_builder().build().map_err(|e| e.to_string())?.package_kind().into())
}

fn validate_cache_target(record: &CacheRecord, portable_mode: bool, package_kind: &str) -> Result<(), String> {
    if record.package_kind != package_kind
        || record.os != std::env::consts::OS
        || record.arch != std::env::consts::ARCH
        || record.info.portable_mode != portable_mode
    {
        return Err("Cached update does not match this installation.".into());
    }
    Ok(())
}

fn restore_cached(app: &AppHandle) -> Result<Option<CachedUpdate>, String> {
    let root = update_cache::root(app)?;
    if requires_manual_update(IS_WINDOWS_7_TARGET) {
        update_cache::discard(&root)?;
        return Ok(None);
    }
    let restored = (|| {
        let Some((record, bytes)) = update_cache::read(&root)? else { return Ok(None) };
        validate_cache_target(&record, crate::data_dir::is_portable_mode(), &package_kind(app)?)?;
        let version =
            update_portable::validate_requested_portable_version(&record.info.version, env!("CARGO_PKG_VERSION"))?;
        let ready = if record.info.portable_mode {
            update_portable::verify_portable_archive(
                &bytes,
                record.signature.as_deref().ok_or("Missing cached signature")?,
                &version,
                std::env::consts::ARCH,
            )?;
            ReadyUpdate::Portable { archive: bytes, version }
        } else {
            let update = app
                .updater_builder()
                .build()
                .map_err(|e| e.to_string())?
                .restore_update(record.manifest.clone().ok_or("Missing cached release metadata")?)
                .map_err(|e| e.to_string())?
                .ok_or("Cached update is no longer newer")?;
            if update.version != record.info.version {
                return Err("Cached release version mismatch".into());
            }
            update.verify(&bytes).map_err(|e| e.to_string())?;
            ReadyUpdate::Installer { update: Box::new(update), bytes }
        };
        Ok(Some(CachedUpdate { record, ready }))
    })();
    if restored.is_err() {
        update_cache::discard(&root)?;
    }
    restored
}

#[tauri::command(async)]
pub fn get_downloaded_update(
    app: AppHandle,
    state: tauri::State<'_, PendingUpdateState>,
) -> Result<Option<DownloadedUpdate>, String> {
    let mut pending = state.pending.lock().map_err(|_| "Update state is unavailable.")?;
    match pending.as_ref() {
        Some(PendingUpdate::Ready(cached)) => return Ok(Some(cached.record.info.clone())),
        Some(_) => return Ok(None),
        None => {}
    }
    update_cache::cleanup_partial(&update_cache::root(&app)?)?;
    match restore_cached(&app) {
        Ok(Some(cached)) => {
            let info = cached.record.info.clone();
            *pending = Some(PendingUpdate::Ready(Box::new(cached)));
            Ok(Some(info))
        }
        Ok(None) => Ok(None),
        Err(error) => {
            eprintln!("[DBX updater] discarded invalid cache: {error}");
            Ok(None)
        }
    }
}

#[tauri::command(async)]
pub fn discard_downloaded_update(
    app: AppHandle,
    state: tauri::State<'_, PendingUpdateState>,
    cache_id: String,
) -> Result<(), String> {
    state.discard_ready(&cache_id, &update_cache::root(&app)?)
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    state: tauri::State<'_, PendingUpdateState>,
    source: UpdateDownloadSource,
    latest_version: String,
    attempt_id: String,
    release_notes: Option<String>,
) -> Result<DownloadedUpdate, String> {
    let portable_mode = crate::data_dir::is_portable_mode();
    if requires_manual_update(IS_WINDOWS_7_TARGET) {
        return Err("Windows 7 builds must be updated with the dedicated Windows 7 offline installer.".to_string());
    }
    let version = update_portable::validate_requested_portable_version(&latest_version, env!("CARGO_PKG_VERSION"))?;
    if attempt_id.is_empty() || attempt_id.len() > 128 {
        return Err("Invalid download attempt identifier.".into());
    }
    let cancellation = state.begin_download()?;
    let result = async {
        update_cache::discard(&update_cache::root(&app)?)?;
        let (ready, manifest, signature, notes) = if portable_mode {
            let (archive, signature) =
                download_portable_update_inner(&app, &source, &version, &attempt_id, &cancellation).await?;
            (ReadyUpdate::Portable { archive, version: version.clone() }, None, Some(signature), String::new())
        } else {
            let (update, bytes) =
                download_update_inner(&app, &source, Some(&latest_version), &attempt_id, &cancellation).await?;
            let manifest = Some(update.raw_json.clone());
            let notes = update.body.clone().unwrap_or_default();
            (ReadyUpdate::Installer { update: Box::new(update), bytes }, manifest, None, notes)
        };
        let info = DownloadedUpdate {
            cache_id: uuid::Uuid::new_v4().to_string(),
            version: version.to_string(),
            portable_mode,
            release_url: format!("https://github.com/t8y2/dbx/releases/tag/v{version}"),
            release_notes: release_notes.unwrap_or(notes),
            downloaded_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis() as u64,
        };
        let bytes = match &ready {
            ReadyUpdate::Installer { bytes, .. } => bytes,
            ReadyUpdate::Portable { archive, .. } => archive,
        };
        let cached = CachedUpdate {
            record: CacheRecord {
                schema_version: 1,
                package_kind: package_kind(&app)?,
                package_length: bytes.len() as u64,
                package_sha256: update_cache::digest(bytes),
                info: info.clone(),
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                manifest,
                signature,
            },
            ready,
        };
        state.finish_download(&cancellation, cached, &update_cache::root(&app)?)?;
        Ok(info)
    }
    .await;
    if result.is_err() {
        state.finish_failed_download(&cancellation)?;
    }
    result
}

async fn download_update_inner(
    app: &AppHandle,
    source: &UpdateDownloadSource,
    latest_version: Option<&str>,
    attempt_id: &str,
    cancellation: &Arc<DownloadCancellation>,
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
    let update = wait_for_download_step(
        updater.check(),
        cancellation,
        Duration::from_secs(30),
        "Update check timed out.".into(),
    )
    .await?
    .map_err(|e| format!("Failed to check updates: {e}"))?;
    let Some(update) = update else {
        return Err("No update available.".to_string());
    };

    if Some(update.version.as_str()) != latest_version.map(|v| v.trim().trim_start_matches('v')) {
        return Err("Update version changed; check for updates again.".into());
    }
    let candidates = source.installer_asset_candidates(update.download_url.as_str(), latest_version);
    println!("[DBX updater] candidates for installer download: {:?}", candidates);

    let mut failures = Vec::new();

    for candidate_url in candidates {
        if cancellation.is_canceled() {
            return Err(DOWNLOAD_CANCELED_ERROR.to_string());
        }
        println!("[DBX updater] downloading installer update from {candidate_url}");
        let parsed_url = match reqwest::Url::parse(&candidate_url) {
            Ok(url) => url,
            Err(e) => {
                failures.push(format!("{candidate_url}: Invalid URL ({e})"));
                continue;
            }
        };

        let downloaded = Arc::new(AtomicU64::new(0));
        let finished_downloaded = Arc::clone(&downloaded);
        let progress_app_chunk = app.clone();
        let progress_app_finish = app.clone();
        let mut progress_gate = UpdateDownloadProgressGate::default();

        let (progress_tx, progress_rx) = tokio::sync::mpsc::channel::<()>(16);

        let attempt_id = attempt_id.to_string();
        let version = update.version.clone();
        let finish_attempt_id = attempt_id.clone();
        let finish_version = version.clone();
        let download_result = {
            let mut candidate_update = update.clone();
            candidate_update.download_url = parsed_url.clone();

            let download_fut = async move {
                candidate_update
                    .download(
                        move |chunk_len, total| {
                            let downloaded = downloaded
                                .fetch_add(chunk_len as u64, Ordering::Relaxed)
                                .saturating_add(chunk_len as u64);
                            if progress_gate.should_emit(downloaded, total) {
                                let _ = progress_app_chunk.emit(
                                    UPDATE_DOWNLOAD_PROGRESS_EVENT,
                                    UpdateDownloadProgress {
                                        downloaded,
                                        total,
                                        attempt_id: attempt_id.clone(),
                                        version: version.clone(),
                                    },
                                );
                            }
                            let _ = progress_tx.try_send(());
                        },
                        move || {
                            let downloaded = finished_downloaded.load(Ordering::Relaxed);
                            let _ = progress_app_finish.emit(
                                UPDATE_DOWNLOAD_PROGRESS_EVENT,
                                UpdateDownloadProgress {
                                    downloaded,
                                    total: Some(downloaded),
                                    attempt_id: finish_attempt_id,
                                    version: finish_version,
                                },
                            );
                        },
                    )
                    .await
                    .map_err(|error| format!("Failed to download update: {error}"))
            };

            wait_for_progressing_download(download_fut, progress_rx, cancellation, DOWNLOAD_STALL_TIMEOUT).await
        };

        match download_result {
            Ok(bytes) => {
                let mut ready_update = update.clone();
                ready_update.download_url = parsed_url;
                return Ok((ready_update, bytes));
            }
            Err(error) => {
                if cancellation.is_canceled() || error.contains("canceled") {
                    return Err(DOWNLOAD_CANCELED_ERROR.to_string());
                }
                println!("[DBX updater] installer candidate failed ({candidate_url}): {error}");
                failures.push(format!("{candidate_url}: {error}"));
            }
        }
    }

    Err(format!("Failed to download update after trying all available mirrors. {}", failures.join("; ")))
}

async fn download_portable_update_inner(
    app: &AppHandle,
    source: &UpdateDownloadSource,
    latest_version: &Version,
    attempt_id: &str,
    cancellation: &Arc<DownloadCancellation>,
) -> Result<(Vec<u8>, String), String> {
    let latest_version_text = latest_version.to_string();
    let candidates = source.portable_asset_candidates(&latest_version_text, std::env::consts::ARCH)?;
    let client = portable_update_http_client()?;
    let mut failures = Vec::new();

    for candidate in candidates {
        if cancellation.is_canceled() {
            return Err(DOWNLOAD_CANCELED_ERROR.to_string());
        }
        println!("[DBX updater] downloading portable update from {}", candidate.archive_url);
        let result = async {
            let signature = download_bounded_bytes(
                &client,
                &candidate.signature_url,
                MAX_PORTABLE_SIGNATURE_BYTES,
                None,
                attempt_id,
                &latest_version_text,
                cancellation,
            )
            .await?;
            let signature = String::from_utf8(signature)
                .map_err(|error| format!("Portable update signature is not valid UTF-8: {error}"))?;
            let archive = download_bounded_bytes(
                &client,
                &candidate.archive_url,
                MAX_PORTABLE_ARCHIVE_BYTES,
                Some(app),
                attempt_id,
                &latest_version_text,
                cancellation,
            )
            .await?;
            update_portable::verify_portable_archive(&archive, &signature, latest_version, std::env::consts::ARCH)?;
            Ok::<(Vec<u8>, String), String>((archive, signature))
        }
        .await;

        match result {
            Ok(archive) => return Ok(archive),
            Err(error) => {
                if cancellation.is_canceled() || error.contains("canceled") {
                    return Err(DOWNLOAD_CANCELED_ERROR.to_string());
                }
                println!("[DBX updater] portable update candidate failed: {error}");
                failures.push(format!("{}: {error}", candidate.archive_url));
            }
        }
    }

    Err(format!("Failed to download a verified portable update. {}", failures.join("; ")))
}

fn portable_update_http_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(15 * 60));
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
    attempt_id: &str,
    version: &str,
    cancellation: &DownloadCancellation,
) -> Result<Vec<u8>, String> {
    if cancellation.is_canceled() {
        return Err(DOWNLOAD_CANCELED_ERROR.to_string());
    }

    let request_fut = client.get(url).send();
    let response_res = wait_for_download_step(
        request_fut,
        cancellation,
        DOWNLOAD_STALL_TIMEOUT,
        format!("Connection stalled while connecting to {url}"),
    )
    .await?;

    let mut response = response_res
        .map_err(|error| format!("Failed to request {url}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to download {url}: {error}"))?;

    let total = response.content_length();
    if total.is_some_and(|total| total > max_bytes as u64) {
        return Err(format!("Update asset exceeds the {max_bytes} byte limit."));
    }

    if let Some(app) = progress_app {
        let _ = app.emit(
            UPDATE_DOWNLOAD_PROGRESS_EVENT,
            UpdateDownloadProgress { downloaded: 0, total, attempt_id: attempt_id.into(), version: version.into() },
        );
    }
    let mut progress_gate = UpdateDownloadProgressGate::default();
    progress_gate.should_emit(0, total);
    let mut bytes = Vec::with_capacity(total.unwrap_or(0).min(max_bytes as u64) as usize);

    loop {
        if cancellation.is_canceled() {
            return Err(DOWNLOAD_CANCELED_ERROR.to_string());
        }

        let chunk_fut = response.chunk();
        let chunk_res = wait_for_download_step(
            chunk_fut,
            cancellation,
            DOWNLOAD_STALL_TIMEOUT,
            format!("Download stalled: no data received for 15 seconds from {url}"),
        )
        .await?;

        let chunk = match chunk_res {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => return Err(format!("Failed while downloading {url}: {error}")),
        };

        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("Update asset exceeds the {max_bytes} byte limit."));
        }
        bytes.extend_from_slice(&chunk);
        if progress_gate.should_emit(bytes.len() as u64, total) {
            if let Some(app) = progress_app {
                let _ = app.emit(
                    UPDATE_DOWNLOAD_PROGRESS_EVENT,
                    UpdateDownloadProgress {
                        downloaded: bytes.len() as u64,
                        total,
                        attempt_id: attempt_id.into(),
                        version: version.into(),
                    },
                );
            }
        }
    }
    Ok(bytes)
}

async fn wait_for_progressing_download<T>(
    download: impl Future<Output = Result<T, String>>,
    mut progress: tokio::sync::mpsc::Receiver<()>,
    cancellation: &DownloadCancellation,
    stall_timeout: Duration,
) -> Result<T, String> {
    tokio::pin!(download);
    let stall = tokio::time::sleep(stall_timeout);
    tokio::pin!(stall);
    let mut progress_open = true;

    loop {
        tokio::select! {
            biased;
            _ = cancellation.canceled() => return Err(DOWNLOAD_CANCELED_ERROR.to_string()),
            result = &mut download => return result,
            update = progress.recv(), if progress_open => {
                if update.is_some() {
                    stall.as_mut().reset(tokio::time::Instant::now() + stall_timeout);
                } else {
                    progress_open = false;
                }
            }
            _ = &mut stall => return Err("Download stalled: no data received for 15 seconds".to_string()),
        }
    }
}

async fn wait_for_download_step<T>(
    step: impl Future<Output = T>,
    cancellation: &DownloadCancellation,
    stall_timeout: Duration,
    timeout_error: String,
) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = cancellation.canceled() => Err(DOWNLOAD_CANCELED_ERROR.to_string()),
        result = tokio::time::timeout(stall_timeout, step) => result.map_err(|_| timeout_error),
    }
}

#[tauri::command(async)]
pub fn install_downloaded_update(
    app: AppHandle,
    state: tauri::State<'_, PendingUpdateState>,
    cache_id: String,
    expected_version: String,
) -> Result<(), String> {
    let cached = state.take_ready(&cache_id, &expected_version)?;
    // Read and reverify disk bytes immediately before installation; never trust memory alone.
    let refreshed = match restore_cached(&app) {
        Ok(Some(ready)) if ready.record.info.cache_id == cache_id && ready.record.info.version == expected_version => {
            ready
        }
        other => {
            state.finish_install()?;
            return Err(match other {
                Err(e) => e,
                _ => "Cached update is missing or changed.".into(),
            });
        }
    };
    let ready = &refreshed.ready;
    let portable = matches!(ready, ReadyUpdate::Portable { .. });
    let install_result = match ready {
        ReadyUpdate::Installer { update, bytes } => {
            update.install(bytes).map_err(|error| format!("Failed to install update: {error}"))
        }
        ReadyUpdate::Portable { archive, version } => {
            update_portable::ensure_portable_version_is_newer(version, env!("CARGO_PKG_VERSION"))
                .and_then(|_| update_portable::launch_portable_update_helper(archive, version))
        }
    };
    if let Err(error) = install_result {
        state.restore_ready(cached)?;
        return Err(error);
    }
    if portable {
        // The helper can still fail or roll back after this process exits. Keep
        // the verified package until the upgraded application validates its version.
        schedule_portable_update_exit(app);
    } else {
        state.finish_install()?;
        let _ = update_cache::discard(&update_cache::root(&app)?);
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

#[cfg(test)]
mod tests {
    use super::{
        requires_manual_update, tag_version, wait_for_download_step, wait_for_progressing_download,
        DownloadCancellation, PendingUpdateState, UpdateDownloadProgressGate, UpdateDownloadSource,
        CNB_RELEASE_DOWNLOAD_PREFIX, DOWNLOAD_CANCELED_ERROR, GITHUB_RELEASE_DOWNLOAD_PREFIX,
        OFFICIAL_UPDATE_ENDPOINTS, R2_LATEST_RELEASE_DOWNLOAD_PREFIX,
    };
    use std::{future::pending, sync::Arc, time::Duration};

    fn cached_fixture() -> super::CachedUpdate {
        super::CachedUpdate {
            record: super::CacheRecord {
                schema_version: 1,
                package_kind: "portable".into(),
                package_length: 0,
                package_sha256: super::update_cache::digest(&[]),
                info: super::DownloadedUpdate {
                    cache_id: "cached-id".into(),
                    version: "99.0.0".into(),
                    portable_mode: true,
                    release_url: String::new(),
                    release_notes: String::new(),
                    downloaded_at: 0,
                },
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                manifest: None,
                signature: None,
            },
            ready: super::ReadyUpdate::Portable { archive: vec![], version: semver::Version::new(99, 0, 0) },
        }
    }

    #[test]
    fn stale_cache_identity_and_double_install_are_rejected() {
        let state = PendingUpdateState::default();
        state.restore_ready(cached_fixture()).unwrap();
        assert!(state.take_ready("wrong-id", "99.0.0").is_err());
        assert!(state.take_ready("cached-id", "98.0.0").is_err());
        let ready = state.take_ready("cached-id", "99.0.0").unwrap();
        assert!(state.take_ready("cached-id", "99.0.0").is_err());
        state.restore_ready(ready).unwrap();
        assert!(state.take_ready("cached-id", "99.0.0").is_ok());
    }

    #[test]
    fn canceled_attempt_cannot_commit_or_publish_cache() {
        let state = PendingUpdateState::default();
        let attempt = state.begin_download().unwrap();
        state.cancel_download();
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        assert!(state.finish_download(&attempt, cached_fixture(), &root).is_err());
        assert!(!root.exists());
        assert!(state.begin_download().is_ok());
    }

    #[test]
    fn cleanup_failure_does_not_leave_ready_state_or_block_new_attempts() {
        let state = PendingUpdateState::default();
        state.restore_ready(cached_fixture()).unwrap();
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        // A file in place of the cache root makes deletion fail on every platform.
        std::fs::write(&root, b"not a directory").unwrap();
        assert!(state.discard_ready("cached-id", &root).is_err());
        assert!(state.take_ready("cached-id", "99.0.0").is_err());
        assert!(state.begin_download().is_ok());
        std::fs::remove_file(root).unwrap();
    }

    #[test]
    fn cache_target_requires_architecture_os_and_installation_type() {
        let record = cached_fixture().record;
        assert!(super::validate_cache_target(&record, true, "portable").is_ok());
        assert!(super::validate_cache_target(&record, false, "portable").is_err());
        assert!(super::validate_cache_target(&record, true, "nsis").is_err());
        let mut wrong_arch = record.clone();
        wrong_arch.arch = "different-architecture".into();
        assert!(super::validate_cache_target(&wrong_arch, true, "portable").is_err());
        let mut wrong_os = record;
        wrong_os.os = "different-os".into();
        assert!(super::validate_cache_target(&wrong_os, true, "portable").is_err());
    }

    #[test]
    fn all_windows_7_builds_require_manual_updates() {
        assert!(requires_manual_update(true));
        assert!(!requires_manual_update(false));
    }

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

    #[test]
    fn builds_installer_asset_candidates_for_cnb_source() {
        let candidates = UpdateDownloadSource::Cnb.installer_asset_candidates(
            "https://github.com/t8y2/dbx/releases/download/v0.5.64/DBX_0.5.64_aarch64.dmg",
            Some("0.5.64"),
        );
        assert_eq!(candidates.len(), 3);
        assert_eq!(candidates[0], "https://cnb.cool/dbxio.com/dbx/-/releases/download/v0.5.64/DBX_0.5.64_aarch64.dmg");
        assert_eq!(candidates[1], format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}DBX_0.5.64_aarch64.dmg"));
        assert_eq!(candidates[2], "https://github.com/t8y2/dbx/releases/download/v0.5.64/DBX_0.5.64_aarch64.dmg");
    }

    #[test]
    fn builds_installer_asset_candidates_for_official_source() {
        let candidates = UpdateDownloadSource::Official.installer_asset_candidates(
            "https://github.com/t8y2/dbx/releases/download/v0.5.64/DBX_0.5.64_aarch64.dmg",
            Some("0.5.64"),
        );
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0], format!("{R2_LATEST_RELEASE_DOWNLOAD_PREFIX}DBX_0.5.64_aarch64.dmg"));
        assert_eq!(candidates[1], "https://github.com/t8y2/dbx/releases/download/v0.5.64/DBX_0.5.64_aarch64.dmg");
        assert!(!candidates.iter().any(|url| url.contains("cnb.cool")));
    }

    #[test]
    fn emits_progress_only_when_the_visible_percentage_changes() {
        let mut gate = UpdateDownloadProgressGate::default();

        assert!(gate.should_emit(0, Some(1_000)));
        assert!(!gate.should_emit(4, Some(1_000)));
        assert!(gate.should_emit(5, Some(1_000)));
        assert!(!gate.should_emit(14, Some(1_000)));
        assert!(gate.should_emit(15, Some(1_000)));
        assert!(gate.should_emit(1_000, Some(1_000)));
    }

    #[test]
    fn keeps_unknown_length_progress_visually_stable_until_completion() {
        let mut gate = UpdateDownloadProgressGate::default();

        assert!(gate.should_emit(0, None));
        assert!(!gate.should_emit(512, None));
        assert!(!gate.should_emit(1_024, Some(0)));
        assert!(gate.should_emit(1_024, Some(1_024)));
    }

    #[test]
    fn handles_large_progress_values_without_overflow() {
        let mut gate = UpdateDownloadProgressGate::default();

        assert!(gate.should_emit(u64::MAX / 2, Some(u64::MAX)));
        assert!(gate.should_emit(u64::MAX, Some(u64::MAX)));
    }

    #[test]
    fn limits_chunk_events_to_visible_percentage_updates() {
        let total = 19_527_892_u64;
        let mut downloaded = 0_u64;
        let mut emitted = 0;
        let mut gate = UpdateDownloadProgressGate::default();

        while downloaded < total {
            downloaded = downloaded.saturating_add(16_384).min(total);
            emitted += usize::from(gate.should_emit(downloaded, Some(total)));
        }

        assert_eq!(emitted, 101);
    }

    #[test]
    fn retry_uses_an_independent_cancellation_token() {
        let state = PendingUpdateState::default();
        let first = state.begin_download().unwrap();

        state.cancel_download();
        let second = state.begin_download().unwrap();

        assert!(first.is_canceled());
        assert!(!second.is_canceled());
    }

    #[test]
    fn stale_attempt_cannot_clear_an_active_retry() {
        let state = PendingUpdateState::default();
        let first = state.begin_download().unwrap();
        state.cancel_download();
        let second = state.begin_download().unwrap();

        state.finish_failed_download(&first).unwrap();

        assert!(state.begin_download().is_err());
        assert!(!second.is_canceled());
    }

    #[tokio::test]
    async fn cancel_wakes_installer_download_without_waiting_for_stall_timeout() {
        let cancellation = Arc::new(DownloadCancellation::default());
        let task_cancellation = Arc::clone(&cancellation);
        let (_progress_tx, progress_rx) = tokio::sync::mpsc::channel(1);
        let task = tokio::spawn(async move {
            wait_for_progressing_download(
                pending::<Result<(), String>>(),
                progress_rx,
                &task_cancellation,
                Duration::from_secs(30),
            )
            .await
        });

        tokio::task::yield_now().await;
        cancellation.cancel();

        let result = tokio::time::timeout(Duration::from_secs(1), task).await.unwrap().unwrap();
        assert_eq!(result.unwrap_err(), DOWNLOAD_CANCELED_ERROR);
    }

    #[tokio::test]
    async fn cancel_wakes_portable_network_read_without_waiting_for_timeout() {
        let cancellation = Arc::new(DownloadCancellation::default());
        let task_cancellation = Arc::clone(&cancellation);
        let task = tokio::spawn(async move {
            wait_for_download_step(
                pending::<()>(),
                &task_cancellation,
                Duration::from_secs(30),
                "network timeout".to_string(),
            )
            .await
        });

        tokio::task::yield_now().await;
        cancellation.cancel();

        let result = tokio::time::timeout(Duration::from_secs(1), task).await.unwrap().unwrap();
        assert_eq!(result.unwrap_err(), DOWNLOAD_CANCELED_ERROR);
    }
}
