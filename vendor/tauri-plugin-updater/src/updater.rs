// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
    collections::HashMap,
    ffi::OsString,
    io::Cursor,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
    time::Duration,
};

#[cfg(not(target_os = "macos"))]
use std::ffi::OsStr;

use base64::Engine;
use futures_util::StreamExt;
use http::{header::ACCEPT, HeaderName};
use minisign_verify::{PublicKey, Signature};
use percent_encoding::{AsciiSet, CONTROLS};
use reqwest::{
    header::{HeaderMap, HeaderValue},
    ClientBuilder, StatusCode,
};
use semver::Version;
use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize};
use tauri::{
    utils::{
        config::BundleType,
        platform::{bundle_type, current_exe},
    },
    AppHandle, Resource, Runtime,
};
use time::OffsetDateTime;
use url::Url;

use crate::{
    error::{Error, Result},
    Config,
};

const UPDATER_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"),);

#[derive(Copy, Clone)]
pub enum Installer {
    AppImage,
    Deb,
    Rpm,

    App,

    Msi,
    Nsis,
}

impl Installer {
    fn name(self) -> &'static str {
        match self {
            Self::AppImage => "appimage",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
            Self::App => "app",
            Self::Msi => "msi",
            Self::Nsis => "nsis",
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ReleaseManifestPlatform {
    /// Download URL for the platform
    pub url: Url,
    /// Signature for the platform
    pub signature: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(untagged)]
pub enum RemoteReleaseInner {
    Dynamic(ReleaseManifestPlatform),
    Static { platforms: HashMap<String, ReleaseManifestPlatform> },
}

/// Information about a release returned by the remote update server.
///
/// This type can have one of two shapes: Server Format (Dynamic Format) and Static Format.
#[derive(Debug, Clone)]
pub struct RemoteRelease {
    /// Version to install.
    pub version: Version,
    /// Release notes.
    pub notes: Option<String>,
    /// Release date.
    pub pub_date: Option<OffsetDateTime>,
    /// Release data.
    pub data: RemoteReleaseInner,
}

impl RemoteRelease {
    /// The release's download URL for the given target.
    pub fn download_url(&self, target: &str) -> Result<&Url> {
        match self.data {
            RemoteReleaseInner::Dynamic(ref platform) => Ok(&platform.url),
            RemoteReleaseInner::Static { ref platforms } => {
                platforms.get(target).map_or(Err(Error::TargetNotFound(target.to_string())), |p| Ok(&p.url))
            }
        }
    }

    /// The release's signature for the given target.
    pub fn signature(&self, target: &str) -> Result<&String> {
        match self.data {
            RemoteReleaseInner::Dynamic(ref platform) => Ok(&platform.signature),
            RemoteReleaseInner::Static { ref platforms } => platforms
                .get(target)
                .map_or(Err(Error::TargetNotFound(target.to_string())), |platform| Ok(&platform.signature)),
        }
    }
}

pub type OnBeforeExit = Arc<dyn Fn() + Send + Sync + 'static>;
pub type OnBeforeRequest = Arc<dyn Fn(ClientBuilder) -> ClientBuilder + Send + Sync + 'static>;
pub type VersionComparator = Arc<dyn Fn(Version, RemoteRelease) -> bool + Send + Sync>;
type MainThreadClosure = Box<dyn FnOnce() + Send + Sync + 'static>;
type RunOnMainThread = Box<dyn Fn(MainThreadClosure) -> std::result::Result<(), tauri::Error> + Send + Sync + 'static>;

pub struct UpdaterBuilder {
    #[allow(dead_code)]
    run_on_main_thread: RunOnMainThread,
    app_name: String,
    current_version: Version,
    config: Config,
    pub(crate) version_comparator: Option<VersionComparator>,
    executable_path: Option<PathBuf>,
    target: Option<String>,
    endpoints: Option<Vec<Url>>,
    headers: HeaderMap,
    timeout: Option<Duration>,
    proxy: Option<Url>,
    no_proxy: bool,
    installer_args: Vec<OsString>,
    current_exe_args: Vec<OsString>,
    on_before_exit: Option<OnBeforeExit>,
    configure_client: Option<OnBeforeRequest>,
}

impl UpdaterBuilder {
    pub(crate) fn new<R: Runtime>(app: &AppHandle<R>, config: crate::Config) -> Self {
        let app_ = app.clone();
        let run_on_main_thread = move |f| app_.run_on_main_thread(f);
        Self {
            run_on_main_thread: Box::new(run_on_main_thread),
            installer_args: config.windows.as_ref().map(|w| w.installer_args.clone()).unwrap_or_default(),
            current_exe_args: Vec::new(),
            app_name: app.package_info().name.clone(),
            current_version: app.package_info().version.clone(),
            config,
            version_comparator: None,
            executable_path: None,
            target: None,
            endpoints: None,
            headers: Default::default(),
            timeout: None,
            proxy: None,
            no_proxy: false,
            on_before_exit: None,
            configure_client: None,
        }
    }

    pub fn version_comparator<F: Fn(Version, RemoteRelease) -> bool + Send + Sync + 'static>(mut self, f: F) -> Self {
        self.version_comparator = Some(Arc::new(f));
        self
    }

    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target.replace(target.into());
        self
    }

    pub fn endpoints(mut self, endpoints: Vec<Url>) -> Result<Self> {
        crate::config::validate_endpoints(&endpoints, self.config.dangerous_insecure_transport_protocol)?;

        self.endpoints.replace(endpoints);
        Ok(self)
    }

    pub fn executable_path<P: AsRef<Path>>(mut self, p: P) -> Self {
        self.executable_path.replace(p.as_ref().into());
        self
    }

    pub fn header<K, V>(mut self, key: K, value: V) -> Result<Self>
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        let key: std::result::Result<HeaderName, http::Error> = key.try_into().map_err(Into::into);
        let value: std::result::Result<HeaderValue, http::Error> = value.try_into().map_err(Into::into);
        self.headers.insert(key?, value?);

        Ok(self)
    }

    pub fn headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }

    pub fn clear_headers(mut self) -> Self {
        self.headers.clear();
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn proxy(mut self, proxy: Url) -> Self {
        self.proxy.replace(proxy);
        self
    }

    /// Clear all proxies. See [`reqwest::ClientBuilder::no_proxy`](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html#method.no_proxy).
    pub fn no_proxy(mut self) -> Self {
        self.no_proxy = true;
        self
    }

    pub fn pubkey<S: Into<String>>(mut self, pubkey: S) -> Self {
        self.config.pubkey = pubkey.into();
        self
    }

    /// Adds an argument to pass to the Windows installer.
    pub fn installer_arg<S>(mut self, arg: S) -> Self
    where
        S: Into<OsString>,
    {
        self.installer_args.push(arg.into());
        self
    }

    /// Adds multiple arguments to pass to the Windows installer.
    pub fn installer_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.installer_args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Removes all the additional arguments to pass to the Windows installer.
    ///
    /// Note: this only removes the additional arguments added through
    /// [`Self::installer_arg`], [`crate::Builder::installer_arg`]
    /// and the `plugins > updater > windows > installerArgs` config,
    /// not the ones managed by us (e.g. `/UPDATER` flag passed to the NSIS installer)
    pub fn clear_installer_args(mut self) -> Self {
        self.installer_args.clear();
        self
    }

    /// Function to run before we run the installer and exit the app through `std::process::exit(0)` on Windows
    pub fn on_before_exit<F: Fn() + Send + Sync + 'static>(mut self, f: F) -> Self {
        self.on_before_exit.replace(Arc::new(f));
        self
    }

    /// Allows you to modify the `reqwest` client builder before the HTTP request is sent.
    ///
    /// Note that `reqwest` crate may be updated in minor releases of tauri-plugin-updater.
    /// Therefore it's recommended to pin the plugin to at least a minor version when you're using `configure_client`.
    pub fn configure_client<F: Fn(ClientBuilder) -> ClientBuilder + Send + Sync + 'static>(mut self, f: F) -> Self {
        self.configure_client.replace(Arc::new(f));
        self
    }

    pub fn build(self) -> Result<Updater> {
        let endpoints = self.endpoints.unwrap_or_else(|| self.config.endpoints.clone());

        if endpoints.is_empty() {
            return Err(Error::EmptyEndpoints);
        };

        let arch = updater_arch().ok_or(Error::UnsupportedArch)?;

        let executable_path = self.executable_path.clone().unwrap_or(current_exe()?);

        // Get the extract_path from the provided executable_path
        let extract_path =
            if cfg!(target_os = "linux") { executable_path } else { extract_path_from_executable(&executable_path)? };

        Ok(Updater {
            run_on_main_thread: Arc::new(self.run_on_main_thread),
            config: self.config,
            app_name: self.app_name,
            current_version: self.current_version,
            version_comparator: self.version_comparator,
            timeout: self.timeout,
            proxy: self.proxy,
            no_proxy: self.no_proxy,
            endpoints,
            installer_args: self.installer_args,
            current_exe_args: self.current_exe_args,
            arch,
            target: self.target,
            headers: self.headers,
            extract_path,
            on_before_exit: self.on_before_exit,
            configure_client: self.configure_client,
        })
    }
}

impl UpdaterBuilder {
    pub(crate) fn current_exe_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.current_exe_args.extend(args.into_iter().map(Into::into));
        self
    }
}

pub struct Updater {
    #[allow(dead_code)]
    run_on_main_thread: Arc<RunOnMainThread>,
    config: Config,
    app_name: String,
    current_version: Version,
    version_comparator: Option<VersionComparator>,
    timeout: Option<Duration>,
    proxy: Option<Url>,
    no_proxy: bool,
    endpoints: Vec<Url>,
    arch: &'static str,
    // The `{{target}}` variable we replace in the endpoint and serach for in the JSON,
    // this is either the user provided target or the current operating system by default
    target: Option<String>,
    headers: HeaderMap,
    extract_path: PathBuf,
    on_before_exit: Option<OnBeforeExit>,
    configure_client: Option<OnBeforeRequest>,
    #[allow(unused)]
    installer_args: Vec<OsString>,
    #[allow(unused)]
    current_exe_args: Vec<OsString>,
}

impl Updater {
    pub async fn check(&self) -> Result<Option<Update>> {
        // we want JSON only
        let mut headers = self.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        }

        // Set SSL certs for linux if they aren't available.
        #[cfg(target_os = "linux")]
        {
            if std::env::var_os("SSL_CERT_FILE").is_none() {
                std::env::set_var("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt");
            }
            if std::env::var_os("SSL_CERT_DIR").is_none() {
                std::env::set_var("SSL_CERT_DIR", "/etc/ssl/certs");
            }
        }
        let target = if let Some(target) = &self.target { target } else { updater_os().ok_or(Error::UnsupportedOs)? };

        let mut remote_release: Option<RemoteRelease> = None;
        let mut raw_json: Option<serde_json::Value> = None;
        let mut last_error: Option<Error> = None;
        for url in &self.endpoints {
            // replace {{current_version}}, {{target}}, {{arch}} and {{bundle_type}} in the provided URL
            // this is useful if we need to query example
            // https://releases.myapp.com/update/{{target}}/{{arch}}/{{current_version}}
            // will be translated into ->
            // https://releases.myapp.com/update/darwin/aarch64/1.0.0
            // The main objective is if the update URL is defined via the Cargo.toml
            // the URL will be generated dynamically
            let version = self.current_version.to_string();
            let version = version.as_bytes();
            const CONTROLS_ADD: &AsciiSet = &CONTROLS.add(b'+');
            let encoded_version = percent_encoding::percent_encode(version, CONTROLS_ADD);
            let encoded_version = encoded_version.to_string();
            let installer = installer_for_bundle_type(bundle_type()).map(|i| i.name()).unwrap_or("unknown");

            let url: Url = url
                .to_string()
                // url::Url automatically url-encodes the path components
                .replace("%7B%7Bcurrent_version%7D%7D", &encoded_version)
                .replace("%7B%7Btarget%7D%7D", target)
                .replace("%7B%7Barch%7D%7D", self.arch)
                .replace("%7B%7Bbundle_type%7D%7D", installer)
                // but not query parameters
                .replace("{{current_version}}", &encoded_version)
                .replace("{{target}}", target)
                .replace("{{arch}}", self.arch)
                .replace("{{bundle_type}}", installer)
                .parse()?;

            log::debug!("checking for updates {url}");

            #[cfg(feature = "rustls-tls")]
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                // This can only fail if there is already a default provider which we checked for already.
                let _ = rustls::crypto::ring::default_provider().install_default();
            }

            let mut request = ClientBuilder::new().user_agent(UPDATER_USER_AGENT);
            if self.config.dangerous_accept_invalid_certs {
                request = request.danger_accept_invalid_certs(true);
            }
            if self.config.dangerous_accept_invalid_hostnames {
                request = request.danger_accept_invalid_hostnames(true);
            }
            if let Some(timeout) = self.timeout {
                request = request.timeout(timeout);
            }
            if self.no_proxy {
                log::debug!("disabling proxy");
                request = request.no_proxy();
            } else if let Some(ref proxy) = self.proxy {
                log::debug!("using proxy {proxy}");
                let proxy = reqwest::Proxy::all(proxy.as_str())?;
                request = request.proxy(proxy);
            }

            if let Some(ref configure_client) = self.configure_client {
                request = configure_client(request);
            }

            let response = request.build()?.get(url).headers(headers.clone()).send().await;

            match response {
                Ok(res) => {
                    if res.status().is_success() {
                        // no updates found!
                        if StatusCode::NO_CONTENT == res.status() {
                            log::debug!("update endpoint returned 204 No Content");
                            return Ok(None);
                        };

                        let update_response: serde_json::Value = res.json().await?;
                        log::debug!("update response: {update_response:?}");
                        raw_json = Some(update_response.clone());
                        match serde_json::from_value::<RemoteRelease>(update_response).map_err(Into::into) {
                            Ok(release) => {
                                log::debug!("parsed release response {release:?}");
                                last_error = None;
                                remote_release = Some(release);
                                // we found a release, break the loop
                                break;
                            }
                            Err(err) => {
                                log::error!("failed to deserialize update response: {err}");
                                last_error = Some(err)
                            }
                        }
                    } else {
                        log::error!("update endpoint did not respond with a successful status code");
                    }
                }
                Err(err) => {
                    log::error!("failed to check for updates: {err}");
                    last_error = Some(err.into())
                }
            }
        }

        // Last error is cleaned on success.
        // Shouldn't be triggered if we had a successfull call
        if let Some(error) = last_error {
            return Err(error);
        }

        // Extracted remote metadata
        remote_release.ok_or(Error::ReleaseNotFound)?;

        self.restore_update(raw_json.ok_or(Error::ReleaseNotFound)?)
    }

    /// Construct an installable update from cached release metadata without networking.
    /// Callers must verify the cached bytes with `Update::verify` before using them.
    pub fn package_kind(&self) -> &'static str {
        installer_for_bundle_type(bundle_type()).map(|i| i.name()).unwrap_or("unknown")
    }

    pub fn restore_update(&self, raw_json: serde_json::Value) -> Result<Option<Update>> {
        let release: RemoteRelease = serde_json::from_value(raw_json.clone())?;
        let target = self.target.as_deref().unwrap_or(updater_os().ok_or(Error::UnsupportedOs)?);
        let should_update = match self.version_comparator.as_ref() {
            Some(comparator) => comparator(self.current_version.clone(), release.clone()),
            None => release.version > self.current_version,
        };

        let installer = installer_for_bundle_type(bundle_type());
        let (download_url, signature) = self.get_urls(&release, &installer)?;

        let update = if should_update {
            Some(Update {
                run_on_main_thread: self.run_on_main_thread.clone(),
                config: self.config.clone(),
                on_before_exit: self.on_before_exit.clone(),
                app_name: self.app_name.clone(),
                current_version: self.current_version.to_string(),
                target: target.to_owned(),
                extract_path: self.extract_path.clone(),
                version: release.version.to_string(),
                date: release.pub_date,
                download_url: download_url.clone(),
                signature: signature.to_owned(),
                body: release.notes,
                raw_json,
                timeout: None,
                proxy: self.proxy.clone(),
                no_proxy: self.no_proxy,
                headers: self.headers.clone(),
                installer_args: self.installer_args.clone(),
                current_exe_args: self.current_exe_args.clone(),
                configure_client: self.configure_client.clone(),
            })
        } else {
            None
        };

        Ok(update)
    }

    fn get_urls<'a>(&self, release: &'a RemoteRelease, installer: &Option<Installer>) -> Result<(&'a Url, &'a String)> {
        // Use the user provided target
        if let Some(target) = &self.target {
            return Ok((release.download_url(target)?, release.signature(target)?));
        }

        // Or else we search for [`{os}-{arch}-{installer}`, `{os}-{arch}`] in order
        let os = updater_os().ok_or(Error::UnsupportedOs)?;
        let arch = self.arch;
        let mut targets = Vec::new();
        if let Some(installer) = installer {
            let installer = installer.name();
            targets.push(format!("{os}-{arch}-{installer}"));
        }
        targets.push(format!("{os}-{arch}"));

        for target in &targets {
            log::debug!("Searching for updater target '{target}' in release data");
            if let (Ok(download_url), Ok(signature)) = (release.download_url(target), release.signature(target)) {
                return Ok((download_url, signature));
            };
        }

        Err(Error::TargetsNotFound(targets))
    }
}

#[derive(Clone)]
pub struct Update {
    #[allow(dead_code)]
    run_on_main_thread: Arc<RunOnMainThread>,
    config: Config,
    #[allow(unused)]
    on_before_exit: Option<OnBeforeExit>,
    /// Update description
    pub body: Option<String>,
    /// Version used to check for update
    pub current_version: String,
    /// Version announced
    pub version: String,
    /// Update publish date
    pub date: Option<OffsetDateTime>,
    /// The `{{target}}` variable we replace in the endpoint and search for in the JSON,
    /// this is either the user provided target or the current operating system by default
    pub target: String,
    /// Download URL announced
    pub download_url: Url,
    /// Signature announced
    pub signature: String,
    /// The raw version of server's JSON response. Useful if the response contains additional fields that the updater doesn't handle.
    pub raw_json: serde_json::Value,
    /// Request timeout
    pub timeout: Option<Duration>,
    /// Request proxy
    pub proxy: Option<Url>,
    /// Disable system proxy
    pub no_proxy: bool,
    /// Request headers
    pub headers: HeaderMap,
    /// Extract path
    #[allow(unused)]
    extract_path: PathBuf,
    /// App name, used for creating named tempfiles on Windows
    #[allow(unused)]
    app_name: String,
    #[allow(unused)]
    installer_args: Vec<OsString>,
    #[allow(unused)]
    current_exe_args: Vec<OsString>,
    configure_client: Option<OnBeforeRequest>,
}

impl Resource for Update {}

impl Update {
    /// Verify bytes against the release signature using the current configured public key.
    pub fn verify(&self, bytes: &[u8]) -> Result<()> {
        verify_signature(bytes, &self.signature, &self.config.pubkey).map(|_| ())
    }

    /// Downloads the updater package, verifies it then return it as bytes.
    ///
    /// Use [`Update::install`] to install it
    pub async fn download<C: FnMut(usize, Option<u64>), D: FnOnce()>(
        &self,
        mut on_chunk: C,
        on_download_finish: D,
    ) -> Result<Vec<u8>> {
        // set our headers
        let mut headers = self.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        }

        let mut request = ClientBuilder::new().user_agent(UPDATER_USER_AGENT);
        if self.config.dangerous_accept_invalid_certs {
            request = request.danger_accept_invalid_certs(true);
        }
        if self.config.dangerous_accept_invalid_hostnames {
            request = request.danger_accept_invalid_hostnames(true);
        }
        if let Some(timeout) = self.timeout {
            request = request.timeout(timeout);
        }
        if self.no_proxy {
            request = request.no_proxy();
        } else if let Some(ref proxy) = self.proxy {
            let proxy = reqwest::Proxy::all(proxy.as_str())?;
            request = request.proxy(proxy);
        }
        if let Some(ref configure_client) = self.configure_client {
            request = configure_client(request);
        }
        let response = request.build()?.get(self.download_url.clone()).headers(headers).send().await?;

        if !response.status().is_success() {
            return Err(Error::Network(format!("Download request failed with status: {}", response.status())));
        }

        let content_length: Option<u64> = response
            .headers()
            .get("Content-Length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());

        const MAX_UPDATE_BYTES: usize = 512 * 1024 * 1024;
        if content_length.is_some_and(|length| length > MAX_UPDATE_BYTES as u64) {
            return Err(Error::Network("Update package exceeds size limit".into()));
        }
        let mut buffer = Vec::new();

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if buffer.len().saturating_add(chunk.len()) > MAX_UPDATE_BYTES {
                return Err(Error::Network("Update package exceeds size limit".into()));
            }
            on_chunk(chunk.len(), content_length);
            buffer.extend(chunk);
        }
        on_download_finish();

        verify_signature(&buffer, &self.signature, &self.config.pubkey)?;

        Ok(buffer)
    }

    /// Installs the updater package downloaded by [`Update::download`]
    pub fn install(&self, bytes: impl AsRef<[u8]>) -> Result<()> {
        self.install_inner(bytes.as_ref())
    }

    /// Downloads and installs the updater package
    pub async fn download_and_install<C: FnMut(usize, Option<u64>), D: FnOnce()>(
        &self,
        on_chunk: C,
        on_download_finish: D,
    ) -> Result<()> {
        let bytes = self.download(on_chunk, on_download_finish).await?;
        self.install(bytes)
    }

    #[cfg(mobile)]
    fn install_inner(&self, _bytes: &[u8]) -> Result<()> {
        Ok(())
    }
}

#[cfg(windows)]
enum WindowsUpdaterType {
    Nsis {
        path: PathBuf,
        #[allow(unused)]
        temp: Option<tempfile::TempPath>,
    },
    Msi {
        path: PathBuf,
        #[allow(unused)]
        temp: Option<tempfile::TempPath>,
    },
}

#[cfg(windows)]
impl WindowsUpdaterType {
    fn nsis(path: PathBuf, temp: Option<tempfile::TempPath>) -> Self {
        Self::Nsis { path, temp }
    }

    fn msi(path: PathBuf, temp: Option<tempfile::TempPath>) -> Self {
        Self::Msi { path: path.wrap_in_quotes(), temp }
    }
}

#[cfg(windows)]
impl Config {
    fn install_mode(&self) -> crate::config::WindowsUpdateInstallMode {
        self.windows.as_ref().map(|w| w.install_mode.clone()).unwrap_or_default()
    }
}

/// Windows
#[cfg(windows)]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_x64.msi              # Application MSI
    /// ├── [AppName]_[version]_x64-setup.exe        # NSIS installer
    /// ├── [AppName]_[version]_x64.msi.zip          # ZIP generated by tauri-bundler
    /// │   └──[AppName]_[version]_x64.msi           # Application MSI
    /// ├── [AppName]_[version]_x64-setup.exe.zip          # ZIP generated by tauri-bundler
    /// │   └──[AppName]_[version]_x64-setup.exe           # NSIS installer
    /// └── ...
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        use std::iter::once;
        use windows_sys::{
            w,
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOW},
        };

        let updater_type = self.extract(bytes)?;

        let install_mode = self.config.install_mode();
        let current_args = &self.current_exe_args()[1..];
        let msi_args;
        let nsis_args;

        let installer_args: Vec<&OsStr> = match &updater_type {
            WindowsUpdaterType::Nsis { .. } => {
                nsis_args = current_args.iter().map(escape_nsis_current_exe_arg).collect::<Vec<_>>();

                install_mode
                    .nsis_args()
                    .iter()
                    .map(OsStr::new)
                    .chain(once(OsStr::new("/UPDATE")))
                    .chain(once(OsStr::new("/ARGS")))
                    .chain(nsis_args.iter().map(OsStr::new))
                    .chain(self.installer_args())
                    .collect()
            }
            WindowsUpdaterType::Msi { path, .. } => {
                let escaped_args = current_args.iter().map(escape_msi_property_arg).collect::<Vec<_>>().join(" ");
                msi_args = OsString::from(format!("LAUNCHAPPARGS=\"{escaped_args}\""));

                [OsStr::new("/i"), path.as_os_str()]
                    .into_iter()
                    .chain(install_mode.msiexec_args().iter().map(OsStr::new))
                    .chain(once(OsStr::new("/promptrestart")))
                    .chain(self.installer_args())
                    .chain(once(OsStr::new("AUTOLAUNCHAPP=True")))
                    .chain(once(msi_args.as_os_str()))
                    .collect()
            }
        };

        let file = match &updater_type {
            WindowsUpdaterType::Nsis { path, .. } => path.as_os_str().to_os_string(),
            WindowsUpdaterType::Msi { .. } => std::env::var("SYSTEMROOT").as_ref().map_or_else(
                |_| OsString::from("msiexec.exe"),
                |p| OsString::from(format!("{p}\\System32\\msiexec.exe")),
            ),
        };
        let file = encode_wide(file);

        let parameters = installer_args.join(OsStr::new(" "));
        let parameters = encode_wide(parameters);

        let launch_result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                w!("open"),
                file.as_ptr(),
                parameters.as_ptr(),
                std::ptr::null(),
                SW_SHOW,
            )
        };

        if launch_result as isize <= 32 {
            return Err(std::io::Error::other(format!("Installer launch failed: {}", launch_result as isize)).into());
        }
        if let Some(on_before_exit) = self.on_before_exit.as_ref() {
            log::debug!("running on_before_exit hook");
            on_before_exit();
        }

        std::process::exit(0);
    }

    fn installer_args(&self) -> Vec<&OsStr> {
        self.installer_args.iter().map(OsStr::new).collect::<Vec<_>>()
    }

    fn current_exe_args(&self) -> Vec<&OsStr> {
        self.current_exe_args.iter().map(OsStr::new).collect::<Vec<_>>()
    }

    fn extract(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        #[cfg(feature = "zip")]
        if infer::archive::is_zip(bytes) {
            return self.extract_zip(bytes);
        }

        self.extract_exe(bytes)
    }

    fn make_temp_dir(&self) -> Result<PathBuf> {
        Ok(tempfile::Builder::new().prefix(&format!("{}-{}-updater-", self.app_name, self.version)).tempdir()?.keep())
    }

    #[cfg(feature = "zip")]
    fn extract_zip(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        let temp_dir = self.make_temp_dir()?;

        let archive = Cursor::new(bytes);
        let mut extractor = zip::ZipArchive::new(archive)?;
        extractor.extract(&temp_dir)?;

        let paths = std::fs::read_dir(&temp_dir)?;
        for path in paths {
            let path = path?.path();
            let ext = path.extension();
            if ext == Some(OsStr::new("exe")) {
                return Ok(WindowsUpdaterType::nsis(path, None));
            } else if ext == Some(OsStr::new("msi")) {
                return Ok(WindowsUpdaterType::msi(path, None));
            }
        }

        Err(crate::Error::BinaryNotFoundInArchive)
    }

    fn extract_exe(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        if infer::app::is_exe(bytes) {
            let (path, temp) = self.write_to_temp(bytes, ".exe")?;
            Ok(WindowsUpdaterType::nsis(path, temp))
        } else if infer::archive::is_msi(bytes) {
            let (path, temp) = self.write_to_temp(bytes, ".msi")?;
            Ok(WindowsUpdaterType::msi(path, temp))
        } else {
            Err(crate::Error::InvalidUpdaterFormat)
        }
    }

    fn write_to_temp(&self, bytes: &[u8], ext: &str) -> Result<(PathBuf, Option<tempfile::TempPath>)> {
        use std::io::Write;

        let temp_dir = self.make_temp_dir()?;
        let mut temp_file = tempfile::Builder::new()
            .prefix(&format!("{}-{}-installer", self.app_name, self.version))
            .suffix(ext)
            .rand_bytes(0)
            .tempfile_in(temp_dir)?;
        temp_file.write_all(bytes)?;

        let temp = temp_file.into_temp_path();
        Ok((temp.to_path_buf(), Some(temp)))
    }
}

/// Linux (AppImage, Deb, RPM)
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_amd64.AppImage.tar.gz    # GZ generated by tauri-bundler
    /// │   └──[AppName]_[version]_amd64.AppImage        # Application AppImage
    /// ├── [AppName]_[version]_amd64.deb                # Debian package
    /// ├── [AppName]_[version]_amd64.rpm                # RPM package
    /// └── ...
    ///
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        match installer_for_bundle_type(bundle_type()) {
            Some(Installer::Deb) => self.install_deb(bytes),
            Some(Installer::Rpm) => self.install_rpm(bytes),
            _ => self.install_appimage(bytes),
        }
    }

    fn install_appimage(&self, bytes: &[u8]) -> Result<()> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let extract_path_metadata = self.extract_path.metadata()?;

        let tmp_dir_locations = vec![
            Box::new(|| Some(std::env::temp_dir())) as Box<dyn FnOnce() -> Option<PathBuf>>,
            Box::new(dirs::cache_dir),
            Box::new(|| Some(self.extract_path.parent().unwrap().to_path_buf())),
        ];

        for tmp_dir_location in tmp_dir_locations {
            if let Some(tmp_dir_location) = tmp_dir_location() {
                let tmp_dir = tempfile::Builder::new().prefix("tauri_current_app").tempdir_in(tmp_dir_location)?;
                let tmp_dir_metadata = tmp_dir.path().metadata()?;

                if extract_path_metadata.dev() == tmp_dir_metadata.dev() {
                    let mut perms = tmp_dir_metadata.permissions();
                    perms.set_mode(0o700);
                    std::fs::set_permissions(tmp_dir.path(), perms)?;

                    let tmp_app_image = &tmp_dir.path().join("current_app.AppImage");

                    let permissions = std::fs::metadata(&self.extract_path)?.permissions();

                    // create a backup of our current app image
                    std::fs::rename(&self.extract_path, tmp_app_image)?;

                    #[cfg(feature = "zip")]
                    if infer::archive::is_gz(bytes) {
                        log::debug!("extracting AppImage");
                        // extract the buffer to the tmp_dir
                        // we extract our signed archive into our final directory without any temp file
                        let archive = Cursor::new(bytes);
                        let decoder = flate2::read::GzDecoder::new(archive);
                        let mut archive = tar::Archive::new(decoder);
                        for mut entry in archive.entries()?.flatten() {
                            if let Ok(path) = entry.path() {
                                if path.extension() == Some(OsStr::new("AppImage")) {
                                    // if something went wrong during the extraction, we should restore previous app
                                    if let Err(err) = entry.unpack(&self.extract_path) {
                                        std::fs::rename(tmp_app_image, &self.extract_path)?;
                                        return Err(err.into());
                                    }
                                    // early finish we have everything we need here
                                    return Ok(());
                                }
                            }
                        }
                        // if we have not returned early we should restore the backup
                        std::fs::rename(tmp_app_image, &self.extract_path)?;
                        return Err(Error::BinaryNotFoundInArchive);
                    }

                    log::debug!("rewriting AppImage");
                    return match std::fs::write(&self.extract_path, bytes)
                        .and_then(|_| std::fs::set_permissions(&self.extract_path, permissions))
                    {
                        Err(err) => {
                            // if something went wrong during the extraction, we should restore previous app
                            std::fs::rename(tmp_app_image, &self.extract_path)?;
                            Err(err.into())
                        }
                        Ok(_) => Ok(()),
                    };
                }
            }
        }

        Err(Error::TempDirNotOnSameMountPoint)
    }

    fn install_deb(&self, bytes: &[u8]) -> Result<()> {
        // First verify the bytes are actually a .deb package
        if !infer::archive::is_deb(bytes) {
            log::warn!("update is not a valid deb package");
            return Err(Error::InvalidUpdaterFormat);
        }

        self.try_tmp_locations(bytes, "dpkg", "-i", "deb")
    }

    fn install_rpm(&self, bytes: &[u8]) -> Result<()> {
        // First verify the bytes are actually a .rpm package
        if !infer::archive::is_rpm(bytes) {
            return Err(Error::InvalidUpdaterFormat);
        }
        self.try_tmp_locations(bytes, "rpm", "-U", "rpm")
    }

    fn try_tmp_locations(
        &self,
        bytes: &[u8],
        install_cmd: &str,
        install_arg: &str,
        package_extension: &str,
    ) -> Result<()> {
        // Try different temp directories
        let tmp_dir_locations = vec![
            Box::new(|| Some(std::env::temp_dir())) as Box<dyn FnOnce() -> Option<PathBuf>>,
            Box::new(dirs::cache_dir),
            Box::new(|| Some(self.extract_path.parent().unwrap().to_path_buf())),
        ];

        // Try writing to multiple temp locations until one succeeds
        for tmp_dir_location in tmp_dir_locations {
            if let Some(path) = tmp_dir_location() {
                let prefix = format!("tauri_{package_extension}_update");
                if let Ok(tmp_dir) = tempfile::Builder::new().prefix(&prefix).tempdir_in(path) {
                    let pkg_path = tmp_dir.path().join(format!("package.{package_extension}"));

                    // Try writing the .deb / .rpm file
                    if std::fs::write(&pkg_path, bytes).is_ok() {
                        // If write succeeds, proceed with installation
                        return self.try_install_with_privileges(&pkg_path, install_cmd, install_arg);
                    }
                    // If write fails, continue to next temp location
                }
            }
        }

        // If we get here, all temp locations failed
        Err(Error::TempDirNotFound)
    }

    fn try_install_with_privileges(&self, pkg_path: &Path, install_cmd: &str, install_arg: &str) -> Result<()> {
        // 1. First try using pkexec (graphical sudo prompt)
        if let Ok(status) =
            std::process::Command::new("pkexec").arg(install_cmd).arg(install_arg).arg(pkg_path).status()
        {
            if status.success() {
                log::debug!("installed {pkg_path:?} with pkexec");
                return Ok(());
            }
        }

        // 2. Try zenity or kdialog for a graphical sudo experience
        if let Ok(password) = self.get_password_graphically() {
            if self.install_with_sudo(pkg_path, &password, install_cmd, install_arg)? {
                log::debug!("installed {pkg_path:?} with GUI sudo");
                return Ok(());
            }
        }

        // 3. Final fallback: terminal sudo
        let status = std::process::Command::new("sudo").arg(install_cmd).arg(install_arg).arg(pkg_path).status()?;

        if status.success() {
            log::debug!("installed {pkg_path:?} with sudo");
            Ok(())
        } else {
            Err(Error::PackageInstallFailed)
        }
    }

    fn get_password_graphically(&self) -> Result<String> {
        // Try zenity first
        let zenity_result = std::process::Command::new("zenity")
            .args([
                "--password",
                "--title=Authentication Required",
                "--text=Enter your password to install the update:",
            ])
            .output();

        if let Ok(output) = zenity_result {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
        }

        // Fall back to kdialog if zenity fails or isn't available
        let kdialog_result = std::process::Command::new("kdialog")
            .args(["--password", "Enter your password to install the update:"])
            .output();

        if let Ok(output) = kdialog_result {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
        }

        Err(Error::AuthenticationFailed)
    }

    fn install_with_sudo(&self, pkg_path: &Path, password: &str, install_cmd: &str, install_arg: &str) -> Result<bool> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut child = Command::new("sudo")
            .arg("-S") // read password from stdin
            .arg(install_cmd)
            .arg(install_arg)
            .arg(pkg_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        if let Some(mut stdin) = child.stdin.take() {
            // Write password to stdin
            writeln!(stdin, "{password}")?;
        }

        let status = child.wait()?;
        Ok(status.success())
    }
}

/// MacOS
#[cfg(target_os = "macos")]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_x64.app.tar.gz       # GZ generated by tauri-bundler
    /// │   └──[AppName].app                         # Main application
    /// │      └── Contents                          # Application contents...
    /// │          └── ...
    /// └── ...
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        use flate2::read::GzDecoder;

        let cursor = Cursor::new(bytes);
        let mut extracted_files: Vec<PathBuf> = Vec::new();

        // Create temp directories for backup and extraction
        let tmp_backup_dir = tempfile::Builder::new().prefix("tauri_current_app").tempdir()?;

        let tmp_extract_dir = tempfile::Builder::new().prefix("tauri_updated_app").tempdir()?;

        let decoder = GzDecoder::new(cursor);
        let mut archive = tar::Archive::new(decoder);

        // Extract files to temporary directory
        for entry in archive.entries()? {
            let mut entry = entry?;
            let collected_path: PathBuf = entry.path()?.iter().skip(1).collect();
            let extraction_path = tmp_extract_dir.path().join(&collected_path);

            // Ensure parent directories exist
            if let Some(parent) = extraction_path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            if let Err(err) = entry.unpack(&extraction_path) {
                // Cleanup on error
                std::fs::remove_dir_all(tmp_extract_dir.path()).ok();
                return Err(err.into());
            }
            extracted_files.push(extraction_path);
        }

        // Try to move the current app to backup
        let move_result = std::fs::rename(&self.extract_path, tmp_backup_dir.path().join("current_app"));
        let need_authorization = if let Err(err) = move_result {
            if err.kind() == std::io::ErrorKind::PermissionDenied {
                true
            } else {
                std::fs::remove_dir_all(tmp_extract_dir.path()).ok();
                return Err(err.into());
            }
        } else {
            false
        };

        if need_authorization {
            log::debug!("app installation needs admin privileges");
            // Use AppleScript to perform moves with admin privileges
            let apple_script = format!(
                "do shell script \"rm -rf '{src}' && mv -f '{new}' '{src}'\" with administrator privileges",
                src = self.extract_path.display(),
                new = tmp_extract_dir.path().display()
            );

            let (tx, rx) = std::sync::mpsc::channel();
            let res = (self.run_on_main_thread)(Box::new(move || {
                let mut script = osakit::Script::new_from_source(osakit::Language::AppleScript, &apple_script);
                script.compile().expect("invalid AppleScript");
                let r = script.execute();
                tx.send(r).unwrap();
            }));
            let result = rx.recv().unwrap();

            if res.is_err() || result.is_err() {
                std::fs::remove_dir_all(tmp_extract_dir.path()).ok();
                return Err(Error::Io(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "Failed to move the new app into place",
                )));
            }
        } else {
            // Remove existing directory if it exists
            if self.extract_path.exists() {
                std::fs::remove_dir_all(&self.extract_path)?;
            }
            // Move the new app to the target path
            std::fs::rename(tmp_extract_dir.path(), &self.extract_path)?;
        }

        let _ = std::process::Command::new("touch").arg(&self.extract_path).status();

        Ok(())
    }
}

/// Gets the base target string used by the updater. If bundle type is available it
/// will be added to this string when selecting the download URL and signature.
/// `tauri::utils::platform::bundle_type` method is used to obtain current bundle type.
pub fn target() -> Option<String> {
    if let (Some(target), Some(arch)) = (updater_os(), updater_arch()) {
        Some(format!("{target}-{arch}"))
    } else {
        None
    }
}

fn updater_os() -> Option<&'static str> {
    if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(target_os = "macos") {
        // TODO shouldn't this be macos instead?
        Some("darwin")
    } else if cfg!(target_os = "windows") {
        Some("windows")
    } else {
        None
    }
}

fn updater_arch() -> Option<&'static str> {
    if cfg!(target_arch = "x86") {
        Some("i686")
    } else if cfg!(target_arch = "x86_64") {
        Some("x86_64")
    } else if cfg!(target_arch = "arm") {
        Some("armv7")
    } else if cfg!(target_arch = "aarch64") {
        Some("aarch64")
    } else if cfg!(target_arch = "riscv64") {
        Some("riscv64")
    } else {
        None
    }
}

pub fn extract_path_from_executable(executable_path: &Path) -> Result<PathBuf> {
    // Return the path of the current executable by default
    // Example C:\Program Files\My App\
    let extract_path = executable_path.parent().map(PathBuf::from).ok_or(Error::FailedToDetermineExtractPath)?;

    // MacOS example binary is in /Applications/TestApp.app/Contents/MacOS/myApp
    // We need to get /Applications/<app>.app
    // TODO(lemarier): Need a better way here
    // Maybe we could search for <*.app> to get the right path
    #[cfg(target_os = "macos")]
    if extract_path.display().to_string().contains("Contents/MacOS") {
        return extract_path
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath)?
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath);
    }

    Ok(extract_path)
}

impl<'de> Deserialize<'de> for RemoteRelease {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct InnerRemoteRelease {
            #[serde(alias = "name", deserialize_with = "parse_version")]
            version: Version,
            notes: Option<String>,
            pub_date: Option<String>,
            platforms: Option<HashMap<String, ReleaseManifestPlatform>>,
            // dynamic platform response
            url: Option<Url>,
            signature: Option<String>,
        }

        let release = InnerRemoteRelease::deserialize(deserializer)?;

        let pub_date = if let Some(date) = release.pub_date {
            Some(
                OffsetDateTime::parse(&date, &time::format_description::well_known::Rfc3339)
                    .map_err(|e| DeError::custom(format!("invalid value for `pub_date`: {e}")))?,
            )
        } else {
            None
        };

        Ok(RemoteRelease {
            version: release.version,
            notes: release.notes,
            pub_date,
            data: if let Some(platforms) = release.platforms {
                RemoteReleaseInner::Static { platforms }
            } else {
                RemoteReleaseInner::Dynamic(ReleaseManifestPlatform {
                    url: release
                        .url
                        .ok_or_else(|| DeError::custom("the `url` field was not set on the updater response"))?,
                    signature: release
                        .signature
                        .ok_or_else(|| DeError::custom("the `signature` field was not set on the updater response"))?,
                })
            },
        })
    }
}

fn installer_for_bundle_type(bundle: Option<BundleType>) -> Option<Installer> {
    match bundle? {
        BundleType::Deb => Some(Installer::Deb),
        BundleType::Rpm => Some(Installer::Rpm),
        BundleType::AppImage => Some(Installer::AppImage),
        BundleType::Msi => Some(Installer::Msi),
        BundleType::Nsis => Some(Installer::Nsis),
        BundleType::App => Some(Installer::App), // App is also returned for Dmg type
        _ => None,
    }
}

fn parse_version<'de, D>(deserializer: D) -> std::result::Result<Version, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let str = String::deserialize(deserializer)?;

    Version::from_str(str.trim_start_matches('v')).map_err(serde::de::Error::custom)
}

// Validate signature
fn verify_signature(data: &[u8], release_signature: &str, pub_key: &str) -> Result<bool> {
    // we need to convert the pub key
    let pub_key_decoded = base64_to_string(pub_key)?;
    let public_key = PublicKey::decode(&pub_key_decoded)?;
    let signature_base64_decoded = base64_to_string(release_signature)?;
    let signature = Signature::decode(&signature_base64_decoded)?;

    // Validate signature or bail out
    public_key.verify(data, &signature, true)?;
    Ok(true)
}

fn base64_to_string(base64_string: &str) -> Result<String> {
    let decoded_string = &base64::engine::general_purpose::STANDARD.decode(base64_string)?;
    let result =
        std::str::from_utf8(decoded_string).map_err(|_| Error::SignatureUtf8(base64_string.into()))?.to_string();
    Ok(result)
}

#[cfg(windows)]
fn encode_wide(string: impl AsRef<OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    string.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
trait PathExt {
    fn wrap_in_quotes(&self) -> Self;
}

#[cfg(windows)]
impl PathExt for PathBuf {
    fn wrap_in_quotes(&self) -> Self {
        let mut msi_path = OsString::from("\"");
        msi_path.push(self.as_os_str());
        msi_path.push("\"");
        PathBuf::from(msi_path)
    }
}

// adapted from https://github.com/rust-lang/rust/blob/1c047506f94cd2d05228eb992b0a6bbed1942349/library/std/src/sys/args/windows.rs#L174
#[cfg(windows)]
fn escape_nsis_current_exe_arg(arg: &&OsStr) -> String {
    let arg = arg.to_string_lossy();
    let mut cmd: Vec<char> = Vec::new();

    // compared to std we additionally escape `/` so that nsis won't interpret them as a beginning of an nsis argument.
    let quote = arg.chars().any(|c| c == ' ' || c == '\t' || c == '/') || arg.is_empty();
    let escape = true;
    if quote {
        cmd.push('"');
    }
    let mut backslashes: usize = 0;
    for x in arg.chars() {
        if escape {
            if x == '\\' {
                backslashes += 1;
            } else {
                if x == '"' {
                    // Add n+1 backslashes to total 2n+1 before internal '"'.
                    cmd.extend((0..=backslashes).map(|_| '\\'));
                }
                backslashes = 0;
            }
        }
        cmd.push(x);
    }
    if quote {
        // Add n backslashes to total 2n before ending '"'.
        cmd.extend((0..backslashes).map(|_| '\\'));
        cmd.push('"');
    }
    cmd.into_iter().collect()
}

#[cfg(windows)]
fn escape_msi_property_arg(arg: impl AsRef<OsStr>) -> String {
    let mut arg = arg.as_ref().to_string_lossy().to_string();

    // Otherwise this argument will get lost in ShellExecute
    if arg.is_empty() {
        return "\"\"\"\"".to_string();
    } else if !arg.contains(' ') && !arg.contains('"') {
        return arg;
    }

    if arg.contains('"') {
        arg = arg.replace('"', r#""""""#);
    }

    if arg.starts_with('-') {
        if let Some((a1, a2)) = arg.split_once('=') {
            format!("{a1}=\"\"{a2}\"\"")
        } else {
            format!("\"\"{arg}\"\"")
        }
    } else {
        format!("\"\"{arg}\"\"")
    }
}

#[cfg(test)]
mod tests {
    // Public test vector from minisign-verify 0.2.5 (MIT); no production key material.
    #[test]
    fn offline_restore_verifies_signature_and_rejects_tampered_bytes() {
        use super::*;
        use base64::Engine;
        let encode = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        let key = encode("untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3");
        let signature = encode("untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==");
        let updater = Updater {
            run_on_main_thread: Arc::new(Box::new(|_| Ok(()))),
            config: Config { pubkey: key, ..Default::default() },
            app_name: "DBX test".into(),
            current_version: Version::new(1, 0, 0),
            version_comparator: None,
            timeout: None,
            proxy: None,
            no_proxy: true,
            endpoints: vec![],
            arch: std::env::consts::ARCH,
            target: Some("test-target".into()),
            headers: HeaderMap::new(),
            extract_path: PathBuf::from("runtime-path"),
            on_before_exit: None,
            configure_client: None,
            installer_args: vec![],
            current_exe_args: vec![],
        };
        let manifest = serde_json::json!({ "version": "2.0.0", "notes": "cached notes", "platforms": { "test-target": { "url": "https://invalid.test/package", "signature": signature } } });
        // No endpoints and no runtime make network/main-thread calls impossible here.
        let update = updater.restore_update(manifest.clone()).unwrap().unwrap();
        assert_eq!(update.extract_path, PathBuf::from("runtime-path"));
        assert_eq!(update.version, "2.0.0");
        update.verify(b"test").unwrap();
        assert!(update.verify(b"tampered").is_err());
        let mut incompatible = manifest.clone();
        incompatible["platforms"] = serde_json::json!({});
        assert!(updater.restore_update(incompatible).is_err());
        let mut older = manifest;
        older["version"] = serde_json::json!("0.9.0");
        assert!(updater.restore_update(older).unwrap().is_none());
    }

    #[test]
    #[cfg(windows)]
    fn it_wraps_correctly() {
        use super::PathExt;
        use std::path::PathBuf;

        assert_eq!(
            PathBuf::from("C:\\Users\\Some User\\AppData\\tauri-example.exe").wrap_in_quotes(),
            PathBuf::from("\"C:\\Users\\Some User\\AppData\\tauri-example.exe\"")
        )
    }

    #[test]
    #[cfg(windows)]
    fn it_escapes_correctly_for_msi() {
        use crate::updater::escape_msi_property_arg;

        // Explanation for quotes:
        // The output of escape_msi_property_args() will be used in `LAUNCHAPPARGS=\"{HERE}\"`. This is the first quote level.
        // To escape a quotation mark we use a second quotation mark, so "" is interpreted as " later.
        // This means that the escaped strings can't ever have a single quotation mark!
        // Now there are 3 major things to look out for to not break the msiexec call:
        //   1) Wrap spaces in quotation marks, otherwise it will be interpreted as the end of the msiexec argument.
        //   2) Escape escaping quotation marks, otherwise they will either end the msiexec argument or be ignored.
        //   3) Escape emtpy args in quotation marks, otherwise the argument will get lost.
        let cases = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "some space",                     // This simulates `./my-app "some string"`.
            "--arg value", // -> This simulates `./my-app "--arg value"`. Same as above but it triggers the startsWith(`-`) logic.
            "--arg=unwrapped space", // `./my-app --arg="unwrapped space"`
            "--arg=\"wrapped\"", // `./my-app --args=""wrapped""`
            "--arg=\"wrapped space\"", // `./my-app --args=""wrapped space""`
            "--arg=midword\"wrapped space\"", // `./my-app --args=midword""wrapped""`
            "",            // `./my-app '""'`
        ];
        let cases_escaped = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "\"\"some space\"\"",
            "\"\"--arg value\"\"",
            "--arg=\"\"unwrapped space\"\"",
            r#"--arg=""""""wrapped"""""""#,
            r#"--arg=""""""wrapped space"""""""#,
            r#"--arg=""midword""""wrapped space"""""""#,
            "\"\"\"\"",
        ];

        // Just to be sure we didn't mess that up
        assert_eq!(cases.len(), cases_escaped.len());

        for (orig, escaped) in cases.iter().zip(cases_escaped) {
            assert_eq!(escape_msi_property_arg(orig), escaped);
        }
    }

    #[test]
    #[cfg(windows)]
    fn it_escapes_correctly_for_nsis() {
        use crate::updater::escape_nsis_current_exe_arg;
        use std::ffi::OsStr;

        let cases = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "some space",                     // This simulates `./my-app "some string"`.
            "--arg value", // -> This simulates `./my-app "--arg value"`. Same as above but it triggers the startsWith(`-`) logic.
            "--arg=unwrapped space", // `./my-app --arg="unwrapped space"`
            "--arg=\"wrapped\"", // `./my-app --args=""wrapped""`
            "--arg=\"wrapped space\"", // `./my-app --args=""wrapped space""`
            "--arg=midword\"wrapped space\"", // `./my-app --args=midword""wrapped""`
            "",            // `./my-app '""'`
        ];
        // Note: These may not be the results we actually want (monitor this!).
        // We only make sure the implementation doesn't unintentionally change.
        let cases_escaped = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "\"some space\"",
            "\"--arg value\"",
            "\"--arg=unwrapped space\"",
            "--arg=\\\"wrapped\\\"",
            "\"--arg=\\\"wrapped space\\\"\"",
            "\"--arg=midword\\\"wrapped space\\\"\"",
            "\"\"",
        ];

        // Just to be sure we didn't mess that up
        assert_eq!(cases.len(), cases_escaped.len());

        for (orig, escaped) in cases.iter().zip(cases_escaped) {
            assert_eq!(escape_nsis_current_exe_arg(&OsStr::new(orig)), escaped);
        }
    }
}
