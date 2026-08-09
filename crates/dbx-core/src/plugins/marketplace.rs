use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use fs2::FileExt;
use futures::StreamExt;
use reqwest::redirect::Policy;
use reqwest::{Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::installer::{validate_key_id, PluginPackageExpectation};
use super::{
    current_plugin_target, PluginInstallResult, PluginPackageInstaller, PluginTrustStore, MAX_PLUGIN_PACKAGE_BYTES,
    SUPPORTED_PLUGIN_PERMISSIONS,
};

pub const SUPPORTED_PLUGIN_CATALOG_VERSION: u32 = 1;
pub const OFFICIAL_PLUGIN_REPOSITORY_ID: &str = "dbx-official";
pub const UNIVERSAL_PLUGIN_TARGET: &str = "universal";
pub const MAX_PLUGIN_CATALOG_BYTES: usize = 4 * 1024 * 1024;

const REPOSITORIES_FILE: &str = ".repositories.json";
const REPOSITORIES_LOCK_FILE: &str = ".repositories.lock";
const OFFICIAL_CATALOG_URL: &str = "https://raw.githubusercontent.com/t8y2/dbx-store/main/catalog/index.json";
const ADDITIONAL_OFFICIAL_TRUSTED_KEYS_JSON: Option<&str> = option_env!("DBX_PLUGIN_MARKETPLACE_TRUSTED_KEYS_JSON");
const BUILTIN_OFFICIAL_TRUSTED_KEYS: &[(&str, &str)] =
    &[("dbx-store-preview-2026", "VRb0VscZfWwuFa7LYfeD/wEOJeyNP8wPGND9br8Icmk=")];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginRepositoryKind {
    Official,
    Custom,
    Enterprise,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRepository {
    pub id: String,
    pub name: String,
    pub kind: PluginRepositoryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_url: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginMarketplaceRepositoryMetadata {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginMarketplaceLocalization {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginMarketplaceArtifact {
    pub target: String,
    pub url: String,
    pub sha256: String,
    pub signing_key_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginMarketplaceVersion {
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<PluginMarketplaceArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginMarketplacePlugin {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub publisher: String,
    #[serde(default)]
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    pub latest_version: String,
    #[serde(default)]
    pub versions: Vec<PluginMarketplaceVersion>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub localizations: BTreeMap<String, PluginMarketplaceLocalization>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceCatalog {
    pub catalog_version: u32,
    pub repository: PluginMarketplaceRepositoryMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub plugins: Vec<PluginMarketplacePlugin>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRepositoryCatalogResult {
    pub repository: PluginRepository,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog: Option<PluginMarketplaceCatalog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceInstallRequest {
    pub repository_id: String,
    pub plugin_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginRepositoryDocument {
    #[serde(default = "supported_repository_document_version")]
    version: u32,
    #[serde(default)]
    repositories: Vec<PluginRepository>,
}

#[derive(Debug, Clone)]
pub struct PluginRepositoryStore {
    root_dir: PathBuf,
}

impl PluginRepositoryStore {
    pub fn new(root_dir: PathBuf) -> Self {
        Self { root_dir }
    }

    pub fn list(&self) -> Result<Vec<PluginRepository>, String> {
        let document = self.read_document()?;
        let mut repositories = vec![official_repository()];
        repositories.extend(document.repositories);
        Ok(repositories)
    }

    pub fn find(&self, repository_id: &str) -> Result<PluginRepository, String> {
        self.list()?
            .into_iter()
            .find(|repository| repository.id == repository_id)
            .ok_or_else(|| format!("Plugin repository '{repository_id}' does not exist"))
    }

    pub fn save(&self, mut repository: PluginRepository) -> Result<Vec<PluginRepository>, String> {
        validate_repository(&repository)?;
        if repository.id == OFFICIAL_PLUGIN_REPOSITORY_ID
            || repository.kind == PluginRepositoryKind::Official
            || repository.managed
        {
            return Err("Managed plugin repositories cannot be modified".to_string());
        }
        repository.managed = false;
        let lock = self.open_lock()?;
        lock.lock_exclusive().map_err(|error| format!("Failed to lock plugin repositories: {error}"))?;
        let result = (|| {
            let mut document = self.read_document()?;
            if let Some(existing) = document.repositories.iter_mut().find(|existing| existing.id == repository.id) {
                *existing = repository;
            } else {
                document.repositories.push(repository);
            }
            document.repositories.sort_by(|left, right| left.id.cmp(&right.id));
            write_json_atomically(&self.document_path(), &document)
        })();
        let _ = FileExt::unlock(&lock);
        result?;
        self.list()
    }

    pub fn remove(&self, repository_id: &str) -> Result<Vec<PluginRepository>, String> {
        validate_repository_id(repository_id)?;
        if repository_id == OFFICIAL_PLUGIN_REPOSITORY_ID {
            return Err("Managed plugin repositories cannot be removed".to_string());
        }
        let lock = self.open_lock()?;
        lock.lock_exclusive().map_err(|error| format!("Failed to lock plugin repositories: {error}"))?;
        let result = (|| {
            let mut document = self.read_document()?;
            document.repositories.retain(|repository| repository.id != repository_id);
            write_json_atomically(&self.document_path(), &document)
        })();
        let _ = FileExt::unlock(&lock);
        result?;
        self.list()
    }

    fn document_path(&self) -> PathBuf {
        self.root_dir.join(REPOSITORIES_FILE)
    }

    fn open_lock(&self) -> Result<File, String> {
        std::fs::create_dir_all(&self.root_dir).map_err(|error| error.to_string())?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(self.root_dir.join(REPOSITORIES_LOCK_FILE))
            .map_err(|error| error.to_string())
    }

    fn read_document(&self) -> Result<PluginRepositoryDocument, String> {
        let path = self.document_path();
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PluginRepositoryDocument {
                    version: supported_repository_document_version(),
                    repositories: vec![],
                });
            }
            Err(error) => return Err(format!("Failed to read plugin repositories {}: {error}", path.display())),
        };
        let document: PluginRepositoryDocument = serde_json::from_slice(&raw)
            .map_err(|error| format!("Failed to parse plugin repositories {}: {error}", path.display()))?;
        if document.version != supported_repository_document_version() {
            return Err(format!("Unsupported plugin repository document version {}", document.version));
        }
        for repository in &document.repositories {
            validate_repository(repository)?;
            if repository.id == OFFICIAL_PLUGIN_REPOSITORY_ID
                || repository.kind == PluginRepositoryKind::Official
                || repository.managed
            {
                return Err(format!("Plugin repository '{}' attempts to override a managed repository", repository.id));
            }
        }
        Ok(document)
    }
}

#[derive(Clone)]
pub struct PluginMarketplace {
    root_dir: PathBuf,
    app_version: String,
    repositories: PluginRepositoryStore,
    client: Client,
}

impl PluginMarketplace {
    pub fn new(root_dir: PathBuf, app_version: impl Into<String>) -> Result<Self, String> {
        let client = Client::builder()
            .redirect(Policy::limited(5))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
            .user_agent(format!("DBX/{}/plugin-marketplace", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("Failed to create plugin marketplace HTTP client: {error}"))?;
        Ok(Self {
            repositories: PluginRepositoryStore::new(root_dir.clone()),
            root_dir,
            app_version: app_version.into(),
            client,
        })
    }

    pub fn repositories(&self) -> &PluginRepositoryStore {
        &self.repositories
    }

    pub async fn fetch_catalogs(&self) -> Vec<PluginRepositoryCatalogResult> {
        let repositories = match self.repositories.list() {
            Ok(repositories) => repositories,
            Err(error) => {
                return vec![PluginRepositoryCatalogResult {
                    repository: official_repository(),
                    target: current_plugin_target(),
                    catalog: None,
                    error: Some(error),
                }];
            }
        };
        self.fetch_catalog_results(repositories).await
    }

    async fn fetch_catalog_results(&self, repositories: Vec<PluginRepository>) -> Vec<PluginRepositoryCatalogResult> {
        let futures = repositories.into_iter().filter(|repository| repository.enabled).map(|repository| async move {
            match self.fetch_catalog(&repository).await {
                Ok(catalog) => PluginRepositoryCatalogResult {
                    repository,
                    target: current_plugin_target(),
                    catalog: Some(catalog),
                    error: None,
                },
                Err(error) => PluginRepositoryCatalogResult {
                    repository,
                    target: current_plugin_target(),
                    catalog: None,
                    error: Some(error),
                },
            }
        });
        futures::future::join_all(futures).await
    }

    pub async fn fetch_catalog(&self, repository: &PluginRepository) -> Result<PluginMarketplaceCatalog, String> {
        validate_repository(repository)?;
        let catalog_url = repository_catalog_url(repository)?;
        let raw = self.download_limited(catalog_url.clone(), MAX_PLUGIN_CATALOG_BYTES, "Plugin catalog").await?;
        let mut catalog: PluginMarketplaceCatalog = serde_json::from_slice(&raw)
            .map_err(|error| format!("Failed to parse plugin catalog from {catalog_url}: {error}"))?;
        validate_and_resolve_catalog(&mut catalog, repository, &catalog_url)?;
        Ok(catalog)
    }

    pub async fn install(&self, request: PluginMarketplaceInstallRequest) -> Result<PluginInstallResult, String> {
        let repository = self.repositories.find(&request.repository_id)?;
        if !repository.enabled {
            return Err(format!("Plugin repository '{}' is disabled", repository.id));
        }
        let catalog = self.fetch_catalog(&repository).await?;
        let plugin =
            catalog.plugins.iter().find(|plugin| plugin.id == request.plugin_id).ok_or_else(|| {
                format!("Plugin '{}' is not listed by repository '{}'", request.plugin_id, repository.id)
            })?;
        let requested_version = request.version.as_deref().unwrap_or(&plugin.latest_version);
        let version = plugin
            .versions
            .iter()
            .find(|version| version.version == requested_version)
            .ok_or_else(|| format!("Plugin '{}' version '{}' is not listed", plugin.id, requested_version))?;
        let target = current_plugin_target();
        let artifact = select_marketplace_artifact(version, &target).ok_or_else(|| {
            format!("Plugin '{}' version '{}' does not support target '{}'", plugin.id, version.version, target)
        })?;
        let artifact_url =
            Url::parse(&artifact.url).map_err(|error| format!("Invalid plugin artifact URL: {error}"))?;
        let package = self.download_limited(artifact_url, MAX_PLUGIN_PACKAGE_BYTES, "Plugin package").await?;
        verify_artifact_bytes(artifact, &package)?;
        let trust_store = marketplace_trust_store(&self.root_dir, repository.kind)?;
        let expectation = PluginPackageExpectation {
            id: plugin.id.clone(),
            version: version.version.clone(),
            publisher: plugin.publisher.clone(),
            permissions: plugin.permissions.iter().cloned().collect(),
            signing_key_id: artifact.signing_key_id.clone(),
        };
        PluginPackageInstaller::with_trust_store(self.root_dir.clone(), self.app_version.clone(), trust_store)
            .install_marketplace_bytes(&package, &expectation)
    }

    async fn download_limited(&self, url: Url, max_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
        let response = self
            .client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| format!("Failed to download {label} from {url}: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("Failed to download {label} from {url}: HTTP {}", response.status()));
        }
        if response.content_length().is_some_and(|length| length > max_bytes as u64) {
            return Err(format!("{label} exceeds {max_bytes} bytes"));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("Failed to read {label} from {url}: {error}"))?;
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                return Err(format!("{label} exceeds {max_bytes} bytes"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

fn select_marketplace_artifact<'a>(
    version: &'a PluginMarketplaceVersion,
    target: &str,
) -> Option<&'a PluginMarketplaceArtifact> {
    version
        .artifacts
        .iter()
        .find(|artifact| artifact.target == target)
        .or_else(|| version.artifacts.iter().find(|artifact| artifact.target == UNIVERSAL_PLUGIN_TARGET))
}

fn default_true() -> bool {
    true
}

fn supported_repository_document_version() -> u32 {
    1
}

fn official_repository() -> PluginRepository {
    PluginRepository {
        id: OFFICIAL_PLUGIN_REPOSITORY_ID.to_string(),
        name: "DBX Marketplace".to_string(),
        kind: PluginRepositoryKind::Official,
        catalog_url: Some(OFFICIAL_CATALOG_URL.to_string()),
        enabled: true,
        managed: true,
    }
}

fn repository_catalog_url(repository: &PluginRepository) -> Result<Url, String> {
    let raw = repository.catalog_url.as_deref().and_then(trimmed_nonempty).ok_or_else(|| {
        if repository.kind == PluginRepositoryKind::Official {
            "Official DBX Marketplace catalog is not configured in this build".to_string()
        } else {
            format!("Plugin repository '{}' has no catalog URL", repository.id)
        }
    })?;
    parse_http_url(raw, "Plugin repository catalog URL")
}

fn validate_repository(repository: &PluginRepository) -> Result<(), String> {
    validate_repository_id(&repository.id)?;
    if repository.name.trim().is_empty() || repository.name.len() > 128 {
        return Err("Plugin repository name must be between 1 and 128 bytes".to_string());
    }
    if let Some(catalog_url) = repository.catalog_url.as_deref().and_then(trimmed_nonempty) {
        parse_http_url(catalog_url, "Plugin repository catalog URL")?;
    } else if repository.kind != PluginRepositoryKind::Official {
        return Err("Custom plugin repositories require a catalog URL".to_string());
    }
    Ok(())
}

fn validate_repository_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Plugin repository id must be between 1 and 128 bytes".to_string());
    }
    let mut characters = id.chars();
    if !matches!(characters.next(), Some(character) if character.is_ascii_lowercase() || character.is_ascii_digit())
        || !characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(format!("Invalid plugin repository id '{id}'"));
    }
    Ok(())
}

fn validate_and_resolve_catalog(
    catalog: &mut PluginMarketplaceCatalog,
    repository: &PluginRepository,
    catalog_url: &Url,
) -> Result<(), String> {
    if catalog.catalog_version != SUPPORTED_PLUGIN_CATALOG_VERSION {
        return Err(format!(
            "Unsupported plugin catalog version {}; this DBX build supports version {}",
            catalog.catalog_version, SUPPORTED_PLUGIN_CATALOG_VERSION
        ));
    }
    if catalog.repository.id != repository.id {
        return Err(format!(
            "Plugin catalog repository id '{}' does not match configured repository '{}'",
            catalog.repository.id, repository.id
        ));
    }
    if catalog.repository.name.trim().is_empty() {
        return Err("Plugin catalog repository name cannot be empty".to_string());
    }
    let mut plugin_ids = BTreeSet::new();
    for plugin in &mut catalog.plugins {
        validate_plugin_id(&plugin.id)?;
        if !plugin_ids.insert(plugin.id.clone()) {
            return Err(format!("Plugin catalog contains duplicate plugin '{}'", plugin.id));
        }
        if plugin.name.trim().is_empty() || plugin.publisher.trim().is_empty() {
            return Err(format!("Plugin '{}' must declare a name and publisher", plugin.id));
        }
        let permissions = plugin.permissions.iter().collect::<BTreeSet<_>>();
        if permissions.len() != plugin.permissions.len() {
            return Err(format!("Plugin '{}' contains duplicate permissions", plugin.id));
        }
        if let Some(permission) =
            plugin.permissions.iter().find(|permission| !SUPPORTED_PLUGIN_PERMISSIONS.contains(&permission.as_str()))
        {
            return Err(format!("Plugin '{}' declares unsupported permission '{}'", plugin.id, permission));
        }
        let latest = Version::parse(&plugin.latest_version)
            .map_err(|error| format!("Plugin '{}' has invalid latestVersion: {error}", plugin.id))?;
        let mut versions = BTreeSet::new();
        let mut contains_latest = false;
        for version in &mut plugin.versions {
            let parsed = Version::parse(&version.version).map_err(|error| {
                format!("Plugin '{}' has invalid version '{}': {error}", plugin.id, version.version)
            })?;
            if !versions.insert(parsed.clone()) {
                return Err(format!("Plugin '{}' contains duplicate version '{}'", plugin.id, version.version));
            }
            contains_latest |= parsed == latest;
            let mut targets = BTreeSet::new();
            for artifact in &mut version.artifacts {
                validate_target(&artifact.target)?;
                if !targets.insert(artifact.target.clone()) {
                    return Err(format!(
                        "Plugin '{}' version '{}' contains duplicate target '{}'",
                        plugin.id, version.version, artifact.target
                    ));
                }
                validate_sha256(&artifact.sha256)?;
                validate_key_id(&artifact.signing_key_id)?;
                if artifact.size.is_some_and(|size| size > MAX_PLUGIN_PACKAGE_BYTES as u64) {
                    return Err(format!(
                        "Plugin '{}' version '{}' target '{}' exceeds the package size limit",
                        plugin.id, version.version, artifact.target
                    ));
                }
                artifact.url = resolve_http_url(catalog_url, &artifact.url, "Plugin artifact URL")?.to_string();
            }
        }
        if !contains_latest {
            return Err(format!(
                "Plugin '{}' latestVersion '{}' is not present in versions",
                plugin.id, plugin.latest_version
            ));
        }
        if let Some(icon) = plugin.icon.as_deref().and_then(trimmed_nonempty) {
            plugin.icon = Some(resolve_http_url(catalog_url, icon, "Plugin icon URL")?.to_string());
        }
    }
    Ok(())
}

fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Marketplace plugin id must be between 1 and 128 bytes".to_string());
    }
    let mut characters = id.chars();
    if !matches!(characters.next(), Some(character) if character.is_ascii_lowercase() || character.is_ascii_digit())
        || !characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(format!("Invalid marketplace plugin id '{id}'"));
    }
    Ok(())
}

fn validate_target(target: &str) -> Result<(), String> {
    if target.is_empty()
        || target.len() > 64
        || !target
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
    {
        return Err(format!("Invalid plugin artifact target '{target}'"));
    }
    Ok(())
}

fn validate_sha256(sha256: &str) -> Result<(), String> {
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Plugin artifact SHA-256 must contain 64 hexadecimal characters".to_string());
    }
    Ok(())
}

fn verify_artifact_bytes(artifact: &PluginMarketplaceArtifact, bytes: &[u8]) -> Result<(), String> {
    if artifact.size.is_some_and(|expected| expected != bytes.len() as u64) {
        return Err(format!(
            "Plugin artifact size mismatch: expected {}, received {}",
            artifact.size.unwrap_or_default(),
            bytes.len()
        ));
    }
    let actual = format!("{:x}", Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(&artifact.sha256) {
        return Err(format!("Plugin artifact SHA-256 mismatch: expected {}, received {actual}", artifact.sha256));
    }
    Ok(())
}

fn marketplace_trust_store(root_dir: &Path, kind: PluginRepositoryKind) -> Result<PluginTrustStore, String> {
    if kind != PluginRepositoryKind::Official {
        return PluginTrustStore::load(root_dir);
    }
    let mut keys = BUILTIN_OFFICIAL_TRUSTED_KEYS
        .iter()
        .map(|(key_id, public_key)| ((*key_id).to_string(), (*public_key).to_string()))
        .collect::<BTreeMap<_, _>>();
    if let Some(raw) = ADDITIONAL_OFFICIAL_TRUSTED_KEYS_JSON.and_then(trimmed_nonempty) {
        let additional: BTreeMap<String, String> = serde_json::from_str(raw)
            .map_err(|error| format!("Failed to parse additional official DBX Marketplace signing keys: {error}"))?;
        for (key_id, public_key) in additional {
            if keys.insert(key_id.clone(), public_key).is_some() {
                return Err(format!("Duplicate official DBX Marketplace signing key '{key_id}'"));
            }
        }
    }
    let store = PluginTrustStore::from_base64_keys(keys)?;
    if store.is_empty() {
        return Err("Official DBX Marketplace signing keys are empty".to_string());
    }
    Ok(store)
}

fn parse_http_url(raw: &str, label: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("Invalid {label}: {error}"))?;
    ensure_http_url(url, label)
}

fn resolve_http_url(base: &Url, raw: &str, label: &str) -> Result<Url, String> {
    let url = base.join(raw).map_err(|error| format!("Invalid {label}: {error}"))?;
    ensure_http_url(url, label)
}

fn ensure_http_url(url: Url, label: &str) -> Result<Url, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("{label} must use HTTP or HTTPS"));
    }
    if url.host_str().is_none() {
        return Err(format!("{label} must include a host"));
    }
    Ok(url)
}

fn trimmed_nonempty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("Plugin repository path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut file =
        OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    use crate::plugins::{PLUGIN_CHECKSUMS_FILE, PLUGIN_SIGNATURE_FILE};

    fn custom_repository(id: &str) -> PluginRepository {
        PluginRepository {
            id: id.to_string(),
            name: format!("Repository {id}"),
            kind: PluginRepositoryKind::Custom,
            catalog_url: Some(format!("https://plugins.example.com/{id}/catalog/index.json")),
            enabled: true,
            managed: false,
        }
    }

    fn catalog(repository_id: &str) -> PluginMarketplaceCatalog {
        PluginMarketplaceCatalog {
            catalog_version: 1,
            repository: PluginMarketplaceRepositoryMetadata {
                id: repository_id.to_string(),
                name: "Example Marketplace".to_string(),
                homepage: None,
            },
            generated_at: None,
            plugins: vec![PluginMarketplacePlugin {
                id: "example.hello".to_string(),
                name: "Hello".to_string(),
                description: "Example".to_string(),
                publisher: "example".to_string(),
                verified: true,
                icon: Some("../assets/icon.svg".to_string()),
                tags: vec!["hello".to_string()],
                permissions: vec!["host.events".to_string()],
                source: None,
                homepage: None,
                license: Some("Apache-2.0".to_string()),
                latest_version: "1.0.0".to_string(),
                versions: vec![PluginMarketplaceVersion {
                    version: "1.0.0".to_string(),
                    released_at: None,
                    release_notes: Some("Initial release".to_string()),
                    artifacts: vec![PluginMarketplaceArtifact {
                        target: current_plugin_target(),
                        url: "../dist/plugin.dbxp".to_string(),
                        sha256: "a".repeat(64),
                        signing_key_id: "example.release".to_string(),
                        size: Some(100),
                    }],
                }],
                localizations: BTreeMap::new(),
            }],
        }
    }

    #[test]
    fn persists_custom_repositories_without_overriding_official() {
        let root = tempfile::tempdir().unwrap();
        let store = PluginRepositoryStore::new(root.path().to_path_buf());
        let repositories = store.save(custom_repository("team-marketplace")).unwrap();
        assert_eq!(repositories.len(), 2);
        assert!(repositories[0].managed);
        assert_eq!(repositories[1].id, "team-marketplace");

        let reloaded = PluginRepositoryStore::new(root.path().to_path_buf()).list().unwrap();
        assert_eq!(reloaded, repositories);
        assert!(store.remove(OFFICIAL_PLUGIN_REPOSITORY_ID).unwrap_err().contains("Managed"));

        let mut override_repository = custom_repository(OFFICIAL_PLUGIN_REPOSITORY_ID);
        override_repository.kind = PluginRepositoryKind::Official;
        override_repository.managed = true;
        assert!(store.save(override_repository).unwrap_err().contains("Managed"));
    }

    #[test]
    fn validates_catalog_and_resolves_relative_urls() {
        let repository = custom_repository("team-marketplace");
        let catalog_url = Url::parse(repository.catalog_url.as_deref().unwrap()).unwrap();
        let mut catalog = catalog(&repository.id);
        validate_and_resolve_catalog(&mut catalog, &repository, &catalog_url).unwrap();

        let plugin = &catalog.plugins[0];
        assert_eq!(plugin.icon.as_deref(), Some("https://plugins.example.com/team-marketplace/assets/icon.svg"));
        assert_eq!(
            plugin.versions[0].artifacts[0].url,
            "https://plugins.example.com/team-marketplace/dist/plugin.dbxp"
        );
    }

    #[test]
    fn selects_exact_marketplace_artifact_before_universal_fallback() {
        let version = PluginMarketplaceVersion {
            version: "1.0.0".to_string(),
            released_at: None,
            release_notes: None,
            artifacts: vec![
                PluginMarketplaceArtifact {
                    target: UNIVERSAL_PLUGIN_TARGET.to_string(),
                    url: "https://plugins.example.com/universal.dbxp".to_string(),
                    sha256: "a".repeat(64),
                    signing_key_id: "example.release".to_string(),
                    size: None,
                },
                PluginMarketplaceArtifact {
                    target: "darwin-arm64".to_string(),
                    url: "https://plugins.example.com/darwin-arm64.dbxp".to_string(),
                    sha256: "b".repeat(64),
                    signing_key_id: "example.release".to_string(),
                    size: None,
                },
            ],
        };

        assert_eq!(
            select_marketplace_artifact(&version, "darwin-arm64").map(|artifact| artifact.target.as_str()),
            Some("darwin-arm64")
        );
    }

    #[test]
    fn falls_back_to_universal_marketplace_artifact() {
        let version = PluginMarketplaceVersion {
            version: "1.0.0".to_string(),
            released_at: None,
            release_notes: None,
            artifacts: vec![PluginMarketplaceArtifact {
                target: UNIVERSAL_PLUGIN_TARGET.to_string(),
                url: "https://plugins.example.com/universal.dbxp".to_string(),
                sha256: "a".repeat(64),
                signing_key_id: "example.release".to_string(),
                size: None,
            }],
        };

        assert_eq!(
            select_marketplace_artifact(&version, "linux-x64").map(|artifact| artifact.target.as_str()),
            Some(UNIVERSAL_PLUGIN_TARGET)
        );
    }

    #[test]
    fn rejects_duplicate_versions_invalid_sha_and_repository_mismatch() {
        let repository = custom_repository("team-marketplace");
        let catalog_url = Url::parse(repository.catalog_url.as_deref().unwrap()).unwrap();

        let mut duplicate = catalog(&repository.id);
        let duplicate_version = duplicate.plugins[0].versions[0].clone();
        duplicate.plugins[0].versions.push(duplicate_version);
        assert!(validate_and_resolve_catalog(&mut duplicate, &repository, &catalog_url)
            .unwrap_err()
            .contains("duplicate version"));

        let mut invalid_sha = catalog(&repository.id);
        invalid_sha.plugins[0].versions[0].artifacts[0].sha256 = "invalid".to_string();
        assert!(validate_and_resolve_catalog(&mut invalid_sha, &repository, &catalog_url)
            .unwrap_err()
            .contains("SHA-256"));

        let mut mismatch = catalog("another-repository");
        assert!(validate_and_resolve_catalog(&mut mismatch, &repository, &catalog_url)
            .unwrap_err()
            .contains("does not match"));
    }

    #[test]
    fn verifies_artifact_size_and_sha256() {
        let bytes = b"plugin-package";
        let artifact = PluginMarketplaceArtifact {
            target: current_plugin_target(),
            url: "https://plugins.example.com/plugin.dbxp".to_string(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            signing_key_id: "example.release".to_string(),
            size: Some(bytes.len() as u64),
        };
        verify_artifact_bytes(&artifact, bytes).unwrap();

        let mut wrong_sha = artifact.clone();
        wrong_sha.sha256 = "0".repeat(64);
        assert!(verify_artifact_bytes(&wrong_sha, bytes).unwrap_err().contains("SHA-256 mismatch"));

        let mut wrong_size = artifact;
        wrong_size.size = Some(1);
        assert!(verify_artifact_bytes(&wrong_size, bytes).unwrap_err().contains("size mismatch"));
    }

    #[test]
    fn exposes_managed_official_repository() {
        let repository = official_repository();
        assert_eq!(repository.id, OFFICIAL_PLUGIN_REPOSITORY_ID);
        assert_eq!(repository.kind, PluginRepositoryKind::Official);
        assert_eq!(repository.catalog_url.as_deref(), Some(OFFICIAL_CATALOG_URL));
        assert!(repository.enabled);
        assert!(repository.managed);
    }

    #[test]
    fn loads_builtin_official_trusted_keys() {
        let root = tempfile::tempdir().unwrap();
        assert!(!marketplace_trust_store(root.path(), PluginRepositoryKind::Official).unwrap().is_empty());
    }

    #[tokio::test]
    async fn isolates_repository_fetch_failures() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let root = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let working = PluginRepository {
            catalog_url: Some(format!("http://{address}/catalog.json")),
            ..custom_repository("working-marketplace")
        };
        let broken = PluginRepository {
            catalog_url: Some("http://127.0.0.1:9/catalog.json".to_string()),
            ..custom_repository("broken-marketplace")
        };
        let store = PluginRepositoryStore::new(root.path().to_path_buf());
        store.save(working.clone()).unwrap();
        store.save(broken.clone()).unwrap();
        let body = serde_json::to_vec(&catalog(&working.id)).unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 2048];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes())
                .await
                .unwrap();
            socket.write_all(&body).await.unwrap();
        });

        let marketplace = PluginMarketplace::new(root.path().to_path_buf(), "0.5.68").unwrap();
        let results = marketplace.fetch_catalog_results(vec![working.clone(), broken.clone()]).await;
        server.await.unwrap();

        assert!(results.iter().any(|result| result.repository.id == working.id && result.catalog.is_some()));
        assert!(results.iter().any(|result| result.repository.id == broken.id && result.error.is_some()));
    }

    #[tokio::test]
    async fn downloads_and_installs_a_signed_universal_marketplace_package() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let root = tempfile::tempdir().unwrap();
        let signing_key = SigningKey::from_bytes(&[42u8; 32]);
        let key_id = "example-marketplace-release";
        PluginTrustStore::save_base64_key(
            root.path(),
            key_id,
            &base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes()),
        )
        .unwrap();
        let package = signed_package(&signing_key, key_id);
        let package_sha256 = format!("{:x}", Sha256::digest(&package));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let repository = PluginRepository {
            catalog_url: Some(format!("http://{address}/catalog.json")),
            ..custom_repository("install-marketplace")
        };
        PluginRepositoryStore::new(root.path().to_path_buf()).save(repository.clone()).unwrap();
        let catalog = PluginMarketplaceCatalog {
            catalog_version: 1,
            repository: PluginMarketplaceRepositoryMetadata {
                id: repository.id.clone(),
                name: repository.name.clone(),
                homepage: None,
            },
            generated_at: None,
            plugins: vec![PluginMarketplacePlugin {
                id: "marketplace.install".to_string(),
                name: "Marketplace Install".to_string(),
                description: String::new(),
                publisher: "example".to_string(),
                verified: false,
                icon: None,
                tags: vec![],
                permissions: vec![],
                source: None,
                homepage: None,
                license: None,
                latest_version: "1.0.0".to_string(),
                versions: vec![PluginMarketplaceVersion {
                    version: "1.0.0".to_string(),
                    released_at: None,
                    release_notes: None,
                    artifacts: vec![PluginMarketplaceArtifact {
                        target: UNIVERSAL_PLUGIN_TARGET.to_string(),
                        url: "package.dbxp".to_string(),
                        sha256: package_sha256,
                        signing_key_id: key_id.to_string(),
                        size: Some(package.len() as u64),
                    }],
                }],
                localizations: BTreeMap::new(),
            }],
        };
        let catalog = serde_json::to_vec(&catalog).unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 2048];
                let read = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..read]);
                let body = if request.starts_with("GET /catalog.json ") { &catalog } else { &package };
                socket
                    .write_all(
                        format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())
                            .as_bytes(),
                    )
                    .await
                    .unwrap();
                socket.write_all(body).await.unwrap();
            }
        });

        let marketplace = PluginMarketplace::new(root.path().to_path_buf(), "0.5.68").unwrap();
        let result = marketplace
            .install(PluginMarketplaceInstallRequest {
                repository_id: repository.id,
                plugin_id: "marketplace.install".to_string(),
                version: None,
            })
            .await
            .unwrap();
        server.await.unwrap();

        assert_eq!(result.plugin.manifest.id, "marketplace.install");
        assert_eq!(result.plugin.manifest.version, "1.0.0");
        assert_eq!(result.signature, crate::plugins::PluginSignatureStatus::Trusted { key_id: key_id.to_string() });
    }

    fn signed_package(signing_key: &SigningKey, key_id: &str) -> Vec<u8> {
        let manifest = serde_json::to_vec_pretty(&serde_json::json!({
            "manifest_version": 1,
            "id": "marketplace.install",
            "name": "Marketplace Install",
            "version": "1.0.0",
            "publisher": "example",
            "engines": { "dbx": ">=0.5.0", "host_api": "^1.0" },
            "entrypoints": {
                "backend": {
                    "protocol_versions": [1],
                    "transport": "stdio-jsonl",
                    "executable": "bin/plugin"
                }
            }
        }))
        .unwrap();
        let backend = b"#!/bin/sh\nexit 0\n".to_vec();
        let files = BTreeMap::from([("bin/plugin".to_string(), backend), ("manifest.json".to_string(), manifest)]);
        let checksums = serde_json::to_vec_pretty(&serde_json::json!({
            "algorithm": "sha256",
            "files": files
                .iter()
                .map(|(path, bytes)| (path.clone(), format!("{:x}", Sha256::digest(bytes))))
                .collect::<BTreeMap<_, _>>()
        }))
        .unwrap();
        let signature = serde_json::to_vec_pretty(&serde_json::json!({
            "algorithm": "ed25519",
            "key_id": key_id,
            "signature": base64::engine::general_purpose::STANDARD.encode(signing_key.sign(&checksums).to_bytes())
        }))
        .unwrap();
        let mut output = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut output);
            for (path, bytes) in files {
                let options = if path == "bin/plugin" {
                    SimpleFileOptions::default().unix_permissions(0o755)
                } else {
                    SimpleFileOptions::default().unix_permissions(0o644)
                };
                archive.start_file(path, options).unwrap();
                archive.write_all(&bytes).unwrap();
            }
            archive.start_file(PLUGIN_CHECKSUMS_FILE, SimpleFileOptions::default()).unwrap();
            archive.write_all(&checksums).unwrap();
            archive.start_file(PLUGIN_SIGNATURE_FILE, SimpleFileOptions::default()).unwrap();
            archive.write_all(&signature).unwrap();
            archive.finish().unwrap();
        }
        output.into_inner()
    }
}
