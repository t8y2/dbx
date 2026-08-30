use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{self, File, Metadata};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

use crate::agent_catalog;
use crate::agent_manager::{AgentManager, AgentState, ArtifactFormat, ArtifactInfo, DriverInfo, JreInfo};
use crate::agent_service::{inspect_offline_package, replace_download, validate_native_agent_binary};

const LOCAL_DRIVER_VERSIONS: &[&str] = &["local", "0.1.0-local"];
const MAX_AGENT_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_EXPORT_ARTIFACT_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_JRE_ENTRY_COUNT: usize = 100_000;
const MAX_JRE_DEPTH: usize = 64;
const MAX_JRE_UNCOMPRESSED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentOfflineArtifactKind {
    Jar,
    Native,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentOfflineExportUnavailableReason {
    UnmanagedInstall,
    LocalInstall,
    LaunchConfig,
    MissingArtifact,
    InvalidArtifact,
    UnsafeSource,
    ExternalDriverRequired,
    MissingManagedJre,
    InvalidManagedJre,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentOfflineExportCandidate {
    pub db_type: String,
    pub label: String,
    pub version: String,
    pub size: u64,
    pub artifact_kind: Option<AgentOfflineArtifactKind>,
    pub required_jre: Option<String>,
    pub eligible: bool,
    pub unavailable_reason: Option<AgentOfflineExportUnavailableReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentOfflineExportPreview {
    pub platform: String,
    pub candidates: Vec<AgentOfflineExportCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentOfflineExportResult {
    pub platform: String,
    pub driver_count: usize,
    pub jre_count: usize,
    pub bytes: u64,
}

#[derive(Debug)]
struct PreparedDriver {
    db_type: String,
    label: String,
    version: String,
    jre: String,
    kind: AgentOfflineArtifactKind,
    source: PathBuf,
    filename: String,
    size: u64,
    sha256: String,
}

#[derive(Debug)]
struct PreparedJre {
    key: String,
    version: String,
    archive: PathBuf,
    filename: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize)]
struct ExportRegistry {
    #[serde(skip_serializing_if = "Option::is_none")]
    jre: Option<JreInfo>,
    jres: BTreeMap<String, JreInfo>,
    drivers: BTreeMap<String, DriverInfo>,
}

pub fn preview_agent_offline_export(am: &AgentManager) -> AgentOfflineExportPreview {
    let _installation_guard = am.installation_operation_lock.blocking_read();
    preview_agent_offline_export_unlocked(am)
}

pub fn export_agents_offline(
    am: &AgentManager,
    destination: &Path,
    selected_driver_keys: &[String],
) -> Result<AgentOfflineExportResult, String> {
    // Driver install/uninstall operations intentionally share the read side of
    // this lock so different drivers can be managed concurrently. Export must
    // take the write side because it reads an arbitrary set of drivers and JREs
    // as one consistent snapshot.
    let _installation_guard = am.installation_operation_lock.blocking_write();
    export_agents_offline_unlocked(am, destination, selected_driver_keys)
}

fn preview_agent_offline_export_unlocked(am: &AgentManager) -> AgentOfflineExportPreview {
    let state = am.load_state();
    let mut jre_validity = HashMap::<String, Result<(), AgentOfflineExportUnavailableReason>>::new();
    let mut candidates = Vec::new();

    for (db_type, label) in agent_catalog::driver_store_entries() {
        if db_type == crate::agent_manager::SQLITE_WORKER_DRIVER_KEY {
            continue;
        }
        let has_artifact = am.driver_launch_config_path(db_type).exists()
            || am.driver_native_path(db_type).exists()
            || am.driver_jar_path(db_type).exists();
        let installed = state.installed_drivers.get(db_type);
        if installed.is_none() && !has_artifact {
            continue;
        }

        candidates.push(classify_candidate(am, &state, db_type, label, &mut jre_validity));
    }

    candidates.sort_by(|left, right| left.label.cmp(&right.label).then(left.db_type.cmp(&right.db_type)));
    AgentOfflineExportPreview { platform: AgentManager::current_platform().to_string(), candidates }
}

fn classify_candidate(
    am: &AgentManager,
    state: &AgentState,
    db_type: &str,
    label: &str,
    jre_validity: &mut HashMap<String, Result<(), AgentOfflineExportUnavailableReason>>,
) -> AgentOfflineExportCandidate {
    let installed = state.installed_drivers.get(db_type);
    let version = installed.map(|driver| driver.version.clone()).unwrap_or_else(|| "unknown".to_string());
    let native_path = am.driver_native_path(db_type);
    let jar_path = am.driver_jar_path(db_type);
    let launch_config_path = am.driver_launch_config_path(db_type);
    let artifact_kind = if native_path.exists() {
        Some(AgentOfflineArtifactKind::Native)
    } else if jar_path.exists() {
        Some(AgentOfflineArtifactKind::Jar)
    } else {
        None
    };
    let required_jre = matches!(artifact_kind, Some(AgentOfflineArtifactKind::Jar))
        .then(|| installed.map(|driver| driver.jre.clone()))
        .flatten();

    let unavailable_reason = if installed.is_none() {
        Some(AgentOfflineExportUnavailableReason::UnmanagedInstall)
    } else if LOCAL_DRIVER_VERSIONS.iter().any(|local| version.eq_ignore_ascii_case(local)) {
        Some(AgentOfflineExportUnavailableReason::LocalInstall)
    } else if launch_config_path.exists() {
        Some(AgentOfflineExportUnavailableReason::LaunchConfig)
    } else {
        match artifact_kind {
            Some(AgentOfflineArtifactKind::Native) => classify_native_source(am, &native_path).err(),
            Some(AgentOfflineArtifactKind::Jar) => {
                let jar_reason = classify_jar_source(am, &jar_path).err();
                if jar_reason.is_some() {
                    jar_reason
                } else if let Some(jre_key) = required_jre.as_deref().filter(|key| !key.is_empty()) {
                    jre_validity
                        .entry(jre_key.to_string())
                        .or_insert_with(|| classify_managed_jre(am, jre_key))
                        .as_ref()
                        .err()
                        .copied()
                } else {
                    Some(AgentOfflineExportUnavailableReason::MissingManagedJre)
                }
            }
            None => Some(AgentOfflineExportUnavailableReason::MissingArtifact),
        }
    };

    let source = match artifact_kind {
        Some(AgentOfflineArtifactKind::Native) => Some(native_path),
        Some(AgentOfflineArtifactKind::Jar) => Some(jar_path),
        None => None,
    };
    let size = source
        .and_then(|path| fs::symlink_metadata(path).ok())
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    AgentOfflineExportCandidate {
        db_type: db_type.to_string(),
        label: label.to_string(),
        version,
        size,
        artifact_kind,
        required_jre,
        eligible: unavailable_reason.is_none(),
        unavailable_reason,
    }
}

fn classify_native_source(am: &AgentManager, path: &Path) -> Result<(), AgentOfflineExportUnavailableReason> {
    validate_managed_regular_file(am, path)?;
    validate_native_agent_binary(path).map_err(|_| AgentOfflineExportUnavailableReason::InvalidArtifact)
}

fn classify_jar_source(am: &AgentManager, path: &Path) -> Result<(), AgentOfflineExportUnavailableReason> {
    validate_managed_regular_file(am, path)?;
    match inspect_agent_jar_manifest(path) {
        Ok(true) => Err(AgentOfflineExportUnavailableReason::ExternalDriverRequired),
        Ok(false) => Ok(()),
        Err(_) => Err(AgentOfflineExportUnavailableReason::InvalidArtifact),
    }
}

fn classify_managed_jre(am: &AgentManager, jre_key: &str) -> Result<(), AgentOfflineExportUnavailableReason> {
    let state = am.load_state();
    if !state.jre_versions.contains_key(jre_key) || !am.is_jre_installed(jre_key) {
        return Err(AgentOfflineExportUnavailableReason::MissingManagedJre);
    }
    validate_managed_jre_tree(am, jre_key)
        .map(|_| ())
        .map_err(|_| AgentOfflineExportUnavailableReason::InvalidManagedJre)
}

fn validate_managed_regular_file(
    am: &AgentManager,
    path: &Path,
) -> Result<Metadata, AgentOfflineExportUnavailableReason> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AgentOfflineExportUnavailableReason::MissingArtifact)?;
    if metadata.file_type().is_symlink() {
        return Err(AgentOfflineExportUnavailableReason::UnsafeSource);
    }
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_EXPORT_ARTIFACT_BYTES {
        return Err(AgentOfflineExportUnavailableReason::InvalidArtifact);
    }
    ensure_path_within_base(am, path).map_err(|_| AgentOfflineExportUnavailableReason::UnsafeSource)?;
    Ok(metadata)
}

fn ensure_path_within_base(am: &AgentManager, path: &Path) -> Result<(), String> {
    let base = am.base_dir().canonicalize().map_err(|error| format!("Failed to resolve Agent store path: {error}"))?;
    let resolved = path.canonicalize().map_err(|error| format!("Failed to resolve export source: {error}"))?;
    if !resolved.starts_with(&base) {
        return Err("Agent export source is outside the managed Agent store".to_string());
    }
    Ok(())
}

fn inspect_agent_jar_manifest(path: &Path) -> Result<bool, String> {
    let file = File::open(path).map_err(|error| format!("Failed to read Agent JAR: {error}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| format!("Invalid Agent JAR: {error}"))?;
    let manifest = archive.by_name("META-INF/MANIFEST.MF").map_err(|_| "Agent JAR manifest is missing".to_string())?;
    if manifest.size() > MAX_AGENT_MANIFEST_BYTES {
        return Err(format!("Agent JAR manifest exceeds the {MAX_AGENT_MANIFEST_BYTES}-byte safety limit"));
    }
    let mut text = String::new();
    manifest
        .take(MAX_AGENT_MANIFEST_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("Failed to read Agent JAR manifest: {error}"))?;
    if text.len() as u64 > MAX_AGENT_MANIFEST_BYTES {
        return Err(format!("Agent JAR manifest exceeds the {MAX_AGENT_MANIFEST_BYTES}-byte safety limit"));
    }
    let logical_lines = unfold_manifest_lines(&text)?;
    let has_main_class = logical_lines.iter().any(|line| {
        line.split_once(':')
            .is_some_and(|(name, value)| name.trim().eq_ignore_ascii_case("Main-Class") && !value.trim().is_empty())
    });
    if !has_main_class {
        return Err("Agent JAR manifest does not declare Main-Class".to_string());
    }
    Ok(logical_lines.iter().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("Agent-External-Driver") && value.trim().eq_ignore_ascii_case("true")
        })
    }))
}

fn unfold_manifest_lines(manifest: &str) -> Result<Vec<String>, String> {
    let mut logical_lines = Vec::<String>::new();
    for physical_line in manifest.split('\n') {
        let line = physical_line.strip_suffix('\r').unwrap_or(physical_line);
        if let Some(continuation) = line.strip_prefix(' ') {
            let previous = logical_lines
                .last_mut()
                .ok_or_else(|| "Agent JAR manifest starts with an invalid continuation line".to_string())?;
            previous.push_str(continuation);
        } else {
            logical_lines.push(line.to_string());
        }
    }
    Ok(logical_lines)
}

fn export_agents_offline_unlocked(
    am: &AgentManager,
    destination: &Path,
    selected_driver_keys: &[String],
) -> Result<AgentOfflineExportResult, String> {
    let selected = selected_driver_keys.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if selected.is_empty() {
        return Err("Select at least one eligible Agent driver to export.".to_string());
    }

    let preview = preview_agent_offline_export_unlocked(am);
    let candidate_by_key =
        preview.candidates.iter().map(|candidate| (candidate.db_type.as_str(), candidate)).collect::<HashMap<_, _>>();
    let state = am.load_state();
    let mut drivers = Vec::with_capacity(selected.len());
    let mut required_jres = BTreeSet::new();

    for db_type in selected {
        let candidate = candidate_by_key
            .get(db_type)
            .ok_or_else(|| format!("Agent driver is not installed or cannot be exported: {db_type}"))?;
        if !candidate.eligible {
            let reason = candidate.unavailable_reason.map(unavailable_reason_label).unwrap_or("unknown reason");
            return Err(format!("{} cannot be exported: {reason}", candidate.label));
        }
        let installed = state
            .installed_drivers
            .get(db_type)
            .ok_or_else(|| format!("Agent driver installation state is missing: {db_type}"))?;
        let kind = candidate.artifact_kind.ok_or_else(|| format!("Agent artifact is missing: {db_type}"))?;
        let source = match kind {
            AgentOfflineArtifactKind::Jar => am.driver_jar_path(db_type),
            AgentOfflineArtifactKind::Native => am.driver_native_path(db_type),
        };
        let filename = match kind {
            AgentOfflineArtifactKind::Jar => format!("dbx-agent-{db_type}.jar"),
            AgentOfflineArtifactKind::Native => {
                let suffix = if cfg!(windows) { ".exe" } else { "" };
                format!("dbx-agent-{db_type}-{}{suffix}", AgentManager::current_platform())
            }
        };
        if kind == AgentOfflineArtifactKind::Jar {
            required_jres.insert(installed.jre.clone());
        }
        drivers.push(PreparedDriver {
            db_type: db_type.to_string(),
            label: candidate.label.clone(),
            version: installed.version.clone(),
            jre: installed.jre.clone(),
            kind,
            source,
            filename,
            size: 0,
            sha256: String::new(),
        });
    }

    validate_export_destination_name(destination)?;
    let destination_parent = normalized_parent(destination)?;
    fs::create_dir_all(&destination_parent)
        .map_err(|error| format!("Failed to create export destination directory: {error}"))?;
    validate_export_destination(am, destination, &destination_parent)?;
    let staging_dir = tempfile::Builder::new()
        .prefix(".dbx-agent-export-")
        .tempdir_in(&destination_parent)
        .map_err(|error| format!("Failed to create export staging directory: {error}"))?;

    let driver_snapshot_dir = staging_dir.path().join("driver-snapshots");
    fs::create_dir(&driver_snapshot_dir)
        .map_err(|error| format!("Failed to create driver snapshot directory: {error}"))?;
    for driver in &mut drivers {
        let snapshot = driver_snapshot_dir.join(&driver.filename);
        let (size, sha256) = snapshot_driver_source(am, &driver.source, &snapshot, driver.kind)
            .map_err(|error| format!("Failed to snapshot {} Agent artifact: {error}", driver.label))?;
        driver.source = snapshot;
        driver.size = size;
        driver.sha256 = sha256;
    }

    let mut jres = Vec::with_capacity(required_jres.len());
    for key in required_jres {
        validate_offline_identifier(&key, "JRE")?;
        let version = state
            .jre_versions
            .get(&key)
            .cloned()
            .ok_or_else(|| format!("Managed JRE {key} installation state is missing"))?;
        validate_managed_jre_tree(am, &key)?;
        let filename =
            format!("dbx-jre-{}-{}-{}.tar.zst", key, safe_filename_token(&version), AgentManager::current_platform());
        let archive = staging_dir.path().join(&filename);
        archive_managed_jre(am, &key, &archive)?;
        let size =
            fs::metadata(&archive).map_err(|error| format!("Failed to inspect archived JRE {key}: {error}"))?.len();
        let sha256 = sha256_file(&archive)?;
        jres.push(PreparedJre { key, version, archive, filename, size, sha256 });
    }

    let registry = build_export_registry(am, &drivers, &jres);
    let registry_json = serde_json::to_vec_pretty(&registry)
        .map_err(|error| format!("Failed to serialize offline Agent registry: {error}"))?;
    let destination_name = destination.file_name().and_then(|name| name.to_str()).unwrap_or("agents-offline.zip");
    let temporary_path = destination_parent.join(format!(".{destination_name}.partial-{}", uuid::Uuid::new_v4()));

    write_and_finalize_export_zip(&temporary_path, destination, &registry_json, &drivers, &jres, |package| {
        let plan = inspect_offline_package(package)?;
        let expected = drivers.iter().map(|driver| driver.db_type.clone()).collect::<BTreeSet<_>>();
        let actual = plan.driver_keys.into_iter().collect::<BTreeSet<_>>();
        if expected != actual || plan.includes_jre != !jres.is_empty() {
            return Err("Generated offline Agent package failed compatibility validation".to_string());
        }
        Ok(())
    })?;

    let bytes =
        fs::metadata(destination).map_err(|error| format!("Failed to inspect exported package: {error}"))?.len();
    Ok(AgentOfflineExportResult {
        platform: AgentManager::current_platform().to_string(),
        driver_count: drivers.len(),
        jre_count: jres.len(),
        bytes,
    })
}

fn build_export_registry(am: &AgentManager, drivers: &[PreparedDriver], jres: &[PreparedJre]) -> ExportRegistry {
    let platform = AgentManager::current_platform().to_string();
    let mut registry_drivers = BTreeMap::new();
    for driver in drivers {
        let artifact = ArtifactInfo {
            url: format!("offline://{}", driver.filename),
            sha256: Some(driver.sha256.clone()),
            size: driver.size,
            format: None,
        };
        let (jar, native) = match driver.kind {
            AgentOfflineArtifactKind::Jar => (Some(artifact), HashMap::new()),
            AgentOfflineArtifactKind::Native => (None, HashMap::from([(platform.clone(), artifact)])),
        };
        registry_drivers.insert(
            driver.db_type.clone(),
            DriverInfo {
                version: driver.version.clone(),
                label: driver.label.clone(),
                min_app_version: am.agent_app_version().to_string(),
                jar,
                native,
                jre: driver.jre.clone(),
            },
        );
    }

    let mut registry_jres = BTreeMap::new();
    for jre in jres {
        registry_jres.insert(
            jre.key.clone(),
            JreInfo {
                version: jre.version.clone(),
                platforms: HashMap::from([(
                    platform.clone(),
                    ArtifactInfo {
                        url: format!("offline://{}", jre.filename),
                        sha256: Some(jre.sha256.clone()),
                        size: jre.size,
                        format: Some(ArtifactFormat::TarZstd),
                    },
                )]),
            },
        );
    }

    ExportRegistry { jre: None, jres: registry_jres, drivers: registry_drivers }
}

fn write_export_zip(
    path: &Path,
    registry_json: &[u8],
    drivers: &[PreparedDriver],
    jres: &[PreparedJre],
) -> Result<(), String> {
    let file = File::create(path).map_err(|error| format!("Failed to create offline Agent package: {error}"))?;
    let mut archive = zip::ZipWriter::new(file);
    let options =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).unix_permissions(0o644);

    archive
        .start_file("agent-registry.json", options)
        .map_err(|error| format!("Failed to write offline Agent registry: {error}"))?;
    archive.write_all(registry_json).map_err(|error| format!("Failed to write offline Agent registry: {error}"))?;
    for driver in drivers {
        write_zip_file(
            &mut archive,
            &format!("drivers/{}", driver.filename),
            &driver.source,
            driver.size,
            &driver.sha256,
            options,
        )?;
    }
    for jre in jres {
        write_zip_file(&mut archive, &format!("jre/{}", jre.filename), &jre.archive, jre.size, &jre.sha256, options)?;
    }
    let mut file = archive.finish().map_err(|error| format!("Failed to finalize offline Agent package: {error}"))?;
    file.flush().map_err(|error| format!("Failed to flush offline Agent package: {error}"))?;
    file.sync_all().map_err(|error| format!("Failed to sync offline Agent package: {error}"))
}

fn write_and_finalize_export_zip<F>(
    temporary_path: &Path,
    destination: &Path,
    registry_json: &[u8],
    drivers: &[PreparedDriver],
    jres: &[PreparedJre],
    validate: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let result = write_export_zip(temporary_path, registry_json, drivers, jres)
        .and_then(|_| validate(temporary_path))
        .and_then(|_| replace_download(temporary_path, destination));
    if let Err(error) = result {
        fs::remove_file(temporary_path).ok();
        return Err(error);
    }
    Ok(())
}

fn write_zip_file(
    archive: &mut zip::ZipWriter<File>,
    entry_name: &str,
    source: &Path,
    expected_size: u64,
    expected_sha256: &str,
    options: SimpleFileOptions,
) -> Result<(), String> {
    archive
        .start_file(entry_name, options)
        .map_err(|error| format!("Failed to add {entry_name} to offline package: {error}"))?;
    let mut source_file =
        File::open(source).map_err(|error| format!("Failed to open {}: {error}", source.display()))?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read =
            source_file.read(&mut buffer).map_err(|error| format!("Failed to read {}: {error}", source.display()))?;
        if read == 0 {
            break;
        }
        size = size.checked_add(read as u64).ok_or_else(|| format!("{entry_name} size overflow"))?;
        digest.update(&buffer[..read]);
        archive
            .write_all(&buffer[..read])
            .map_err(|error| format!("Failed to add {entry_name} to offline package: {error}"))?;
    }
    let sha256 = format!("{:x}", digest.finalize());
    if size != expected_size || !sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!("Offline export source changed while archiving {entry_name}"));
    }
    Ok(())
}

fn snapshot_driver_source(
    am: &AgentManager,
    source: &Path,
    snapshot: &Path,
    kind: AgentOfflineArtifactKind,
) -> Result<(u64, String), String> {
    let before =
        validate_managed_regular_file(am, source).map_err(|reason| unavailable_reason_label(reason).to_string())?;
    let mut source_file = File::open(source).map_err(|error| format!("Failed to open source: {error}"))?;
    let opened = source_file.metadata().map_err(|error| format!("Failed to inspect opened source: {error}"))?;
    if !opened.is_file() || opened.len() == 0 || opened.len() > MAX_EXPORT_ARTIFACT_BYTES {
        return Err("the opened Agent artifact is invalid".to_string());
    }
    ensure_path_within_base(am, source)?;
    let after = fs::symlink_metadata(source).map_err(|error| format!("Failed to re-inspect source: {error}"))?;
    if after.file_type().is_symlink() || !after.is_file() || !same_opened_file(&opened, &after) {
        return Err("the Agent artifact changed while it was being opened".to_string());
    }
    if !same_opened_file(&before, &opened) {
        return Err("the Agent artifact changed before it could be snapshotted".to_string());
    }

    let mut snapshot_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(snapshot)
        .map_err(|error| format!("Failed to create snapshot: {error}"))?;
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = source_file.read(&mut buffer).map_err(|error| format!("Failed to read source: {error}"))?;
        if read == 0 {
            break;
        }
        size = size.checked_add(read as u64).ok_or_else(|| "Agent artifact size overflow".to_string())?;
        if size > MAX_EXPORT_ARTIFACT_BYTES {
            return Err(format!("Agent artifact exceeds the {MAX_EXPORT_ARTIFACT_BYTES}-byte safety limit"));
        }
        digest.update(&buffer[..read]);
        snapshot_file.write_all(&buffer[..read]).map_err(|error| format!("Failed to write snapshot: {error}"))?;
    }
    if size != opened.len() {
        return Err("the Agent artifact changed while it was being snapshotted".to_string());
    }
    let opened_after =
        source_file.metadata().map_err(|error| format!("Failed to re-inspect opened source: {error}"))?;
    let path_after = fs::symlink_metadata(source).map_err(|error| format!("Failed to re-inspect source: {error}"))?;
    ensure_path_within_base(am, source)?;
    if path_after.file_type().is_symlink()
        || !path_after.is_file()
        || !same_opened_entry(&opened, &opened_after)
        || !same_opened_entry(&opened_after, &path_after)
    {
        return Err("the Agent artifact changed while it was being snapshotted".to_string());
    }
    snapshot_file.flush().map_err(|error| format!("Failed to flush snapshot: {error}"))?;
    snapshot_file.sync_all().map_err(|error| format!("Failed to sync snapshot: {error}"))?;
    drop(snapshot_file);

    match kind {
        AgentOfflineArtifactKind::Jar => match inspect_agent_jar_manifest(snapshot) {
            Ok(false) => {}
            Ok(true) => {
                return Err(
                    unavailable_reason_label(AgentOfflineExportUnavailableReason::ExternalDriverRequired).to_string()
                )
            }
            Err(error) => return Err(format!("invalid Agent JAR: {error}")),
        },
        AgentOfflineArtifactKind::Native => validate_native_agent_binary(snapshot)?,
    }
    Ok((size, format!("{:x}", digest.finalize())))
}

#[cfg(unix)]
fn same_opened_file(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino() && left.len() == right.len()
}

#[cfg(not(unix))]
fn same_opened_file(left: &Metadata, right: &Metadata) -> bool {
    left.len() == right.len()
}

fn archive_managed_jre(am: &AgentManager, key: &str, destination: &Path) -> Result<(), String> {
    let source = am.jre_dir(key);
    validate_managed_jre_tree(am, key)?;
    let file = File::create(destination).map_err(|error| format!("Failed to create JRE archive: {error}"))?;
    let encoder = zstd::stream::write::Encoder::new(file, 6)
        .map_err(|error| format!("Failed to initialize JRE compression: {error}"))?;
    let mut archive = tar::Builder::new(encoder);
    let root_name = PathBuf::from(format!("dbx-jre-{key}"));
    append_jre_tree(&mut archive, &source, &root_name)?;
    let encoder = archive.into_inner().map_err(|error| format!("Failed to finalize JRE archive: {error}"))?;
    let mut file = encoder.finish().map_err(|error| format!("Failed to finish JRE compression: {error}"))?;
    file.flush().map_err(|error| format!("Failed to flush JRE archive: {error}"))?;
    file.sync_all().map_err(|error| format!("Failed to sync JRE archive: {error}"))
}

fn append_jre_tree<W: Write>(
    archive: &mut tar::Builder<W>,
    source_root: &Path,
    archive_root: &Path,
) -> Result<(), String> {
    append_jre_tree_with_limits(
        archive,
        source_root,
        archive_root,
        MAX_JRE_ENTRY_COUNT,
        MAX_JRE_DEPTH,
        MAX_JRE_UNCOMPRESSED_BYTES,
    )
}

fn append_jre_tree_with_limits<W: Write>(
    archive: &mut tar::Builder<W>,
    source_root: &Path,
    archive_root: &Path,
    max_entry_count: usize,
    max_depth: usize,
    max_uncompressed_bytes: u64,
) -> Result<(), String> {
    let canonical_root = source_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve managed JRE root {}: {error}", source_root.display()))?;
    let mut stack = vec![(source_root.to_path_buf(), archive_root.to_path_buf(), 0usize)];
    let mut entry_count = 1usize;
    let mut total_bytes = 0u64;
    while let Some((source, archive_path, depth)) = stack.pop() {
        if depth > max_depth {
            return Err(format!("Managed JRE exceeds the export depth limit of {max_depth}"));
        }
        let canonical_source = source
            .canonicalize()
            .map_err(|error| format!("Failed to resolve managed JRE entry {}: {error}", source.display()))?;
        if !canonical_source.starts_with(&canonical_root) {
            return Err(format!("Managed JRE entry resolves outside the managed JRE root: {}", source.display()));
        }
        let metadata = fs::symlink_metadata(&source)
            .map_err(|error| format!("Failed to inspect managed JRE entry {}: {error}", source.display()))?;
        if metadata.file_type().is_symlink() {
            // Official JRE archives can contain relative links for duplicated
            // license files. Preserve the package's no-symlink extraction
            // contract by copying safe in-tree file targets as regular files.
            let (link_target, resolved_target, target_metadata) =
                resolve_managed_jre_file_symlink(&source, &canonical_root)?;
            if resolved_target != canonical_source {
                return Err(format!(
                    "Managed JRE symbolic link changed while it was being archived: {}",
                    source.display()
                ));
            }
            let file = File::open(&source)
                .map_err(|error| format!("Failed to open managed JRE symbolic link {}: {error}", source.display()))?;
            let opened = file.metadata().map_err(|error| {
                format!("Failed to inspect managed JRE symbolic link target {}: {error}", source.display())
            })?;
            if !opened.is_file() || !same_opened_entry(&target_metadata, &opened) {
                return Err(format!(
                    "Managed JRE symbolic link target changed while it was being opened: {}",
                    source.display()
                ));
            }
            total_bytes = total_bytes
                .checked_add(opened.len())
                .ok_or_else(|| "Managed JRE size overflow during export".to_string())?;
            if total_bytes > max_uncompressed_bytes {
                return Err(format!("Managed JRE exceeds the export size limit of {max_uncompressed_bytes} bytes"));
            }
            let mut header = tar::Header::new_gnu();
            header.set_mtime(0);
            header.set_uid(0);
            header.set_gid(0);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(metadata_mode(&opened));
            header.set_size(opened.len());
            header.set_cksum();
            let mut file = file;
            archive.append_data(&mut header, &archive_path, &mut file).map_err(|error| {
                format!("Failed to archive managed JRE symbolic link {}: {error}", source.display())
            })?;

            let link_metadata_after = fs::symlink_metadata(&source).map_err(|error| {
                format!("Failed to re-inspect managed JRE symbolic link {}: {error}", source.display())
            })?;
            let link_target_after = fs::read_link(&source).map_err(|error| {
                format!("Failed to re-read managed JRE symbolic link {}: {error}", source.display())
            })?;
            let canonical_after = source.canonicalize().map_err(|error| {
                format!("Failed to re-resolve managed JRE symbolic link {}: {error}", source.display())
            })?;
            let opened_after = file.metadata().map_err(|error| {
                format!("Failed to re-inspect managed JRE symbolic link target {}: {error}", source.display())
            })?;
            let target_after = fs::metadata(&source).map_err(|error| {
                format!("Failed to re-inspect managed JRE symbolic link target {}: {error}", source.display())
            })?;
            if !link_metadata_after.file_type().is_symlink()
                || link_target_after != link_target
                || canonical_after != canonical_source
                || !canonical_after.starts_with(&canonical_root)
                || !same_opened_entry(&metadata, &link_metadata_after)
                || !same_opened_entry(&opened, &opened_after)
                || !same_opened_entry(&opened_after, &target_after)
            {
                return Err(format!(
                    "Managed JRE symbolic link changed while it was being archived: {}",
                    source.display()
                ));
            }
            continue;
        }
        let mut header = tar::Header::new_gnu();
        header.set_mtime(0);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mode(metadata_mode(&metadata));
        if metadata.is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_cksum();
            archive
                .append_data(&mut header, &archive_path, std::io::empty())
                .map_err(|error| format!("Failed to archive managed JRE directory: {error}"))?;
            let mut children = Vec::new();
            for child in fs::read_dir(&source)
                .map_err(|error| format!("Failed to read managed JRE directory {}: {error}", source.display()))?
            {
                let child = child
                    .map_err(|error| format!("Failed to read managed JRE directory {}: {error}", source.display()))?;
                entry_count = entry_count
                    .checked_add(1)
                    .ok_or_else(|| "Managed JRE entry count overflow during export".to_string())?;
                if entry_count > max_entry_count {
                    return Err(format!("Managed JRE exceeds the export entry limit of {max_entry_count}"));
                }
                if depth + 1 > max_depth {
                    return Err(format!("Managed JRE exceeds the export depth limit of {max_depth}"));
                }
                children.push(child);
            }
            let after = fs::symlink_metadata(&source)
                .map_err(|error| format!("Failed to re-inspect managed JRE directory {}: {error}", source.display()))?;
            if after.file_type().is_symlink() || !after.is_dir() || !same_opened_entry(&metadata, &after) {
                return Err(format!("Managed JRE directory changed while it was being archived: {}", source.display()));
            }
            let canonical_after = source
                .canonicalize()
                .map_err(|error| format!("Failed to re-resolve managed JRE directory {}: {error}", source.display()))?;
            if canonical_after != canonical_source || !canonical_after.starts_with(&canonical_root) {
                return Err(format!("Managed JRE directory changed while it was being archived: {}", source.display()));
            }
            children.sort_by_key(|entry| entry.file_name());
            for child in children.into_iter().rev() {
                stack.push((child.path(), archive_path.join(child.file_name()), depth + 1));
            }
        } else if metadata.is_file() {
            let file = File::open(&source)
                .map_err(|error| format!("Failed to open managed JRE entry {}: {error}", source.display()))?;
            let opened = file
                .metadata()
                .map_err(|error| format!("Failed to inspect opened managed JRE entry {}: {error}", source.display()))?;
            let after = fs::symlink_metadata(&source)
                .map_err(|error| format!("Failed to re-inspect managed JRE entry {}: {error}", source.display()))?;
            if !opened.is_file()
                || after.file_type().is_symlink()
                || !after.is_file()
                || !same_opened_entry(&metadata, &opened)
                || !same_opened_entry(&opened, &after)
            {
                return Err(format!("Managed JRE entry changed while it was being opened: {}", source.display()));
            }
            total_bytes = total_bytes
                .checked_add(opened.len())
                .ok_or_else(|| "Managed JRE size overflow during export".to_string())?;
            if total_bytes > max_uncompressed_bytes {
                return Err(format!("Managed JRE exceeds the export size limit of {max_uncompressed_bytes} bytes"));
            }
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(metadata_mode(&opened));
            header.set_size(opened.len());
            header.set_cksum();
            let mut file = file;
            archive
                .append_data(&mut header, &archive_path, &mut file)
                .map_err(|error| format!("Failed to archive managed JRE entry {}: {error}", source.display()))?;
            let opened_after = file.metadata().map_err(|error| {
                format!("Failed to re-inspect opened managed JRE entry {}: {error}", source.display())
            })?;
            let path_after = fs::symlink_metadata(&source)
                .map_err(|error| format!("Failed to re-inspect managed JRE entry {}: {error}", source.display()))?;
            let canonical_after = source
                .canonicalize()
                .map_err(|error| format!("Failed to re-resolve managed JRE entry {}: {error}", source.display()))?;
            if path_after.file_type().is_symlink()
                || !path_after.is_file()
                || canonical_after != canonical_source
                || !canonical_after.starts_with(&canonical_root)
                || !same_opened_entry(&opened, &opened_after)
                || !same_opened_entry(&opened_after, &path_after)
            {
                return Err(format!("Managed JRE entry changed while it was being archived: {}", source.display()));
            }
        } else {
            return Err(format!("Managed JRE contains a special file: {}", source.display()));
        }
    }
    Ok(())
}

fn same_opened_entry(left: &Metadata, right: &Metadata) -> bool {
    same_opened_file(left, right)
        && match (left.modified(), right.modified()) {
            (Ok(left_modified), Ok(right_modified)) => left_modified == right_modified,
            _ => true,
        }
}

fn resolve_managed_jre_file_symlink(
    source: &Path,
    canonical_root: &Path,
) -> Result<(PathBuf, PathBuf, Metadata), String> {
    let link_target = fs::read_link(source)
        .map_err(|error| format!("Failed to read managed JRE symbolic link {}: {error}", source.display()))?;
    if link_target.is_absolute() {
        return Err(format!("Managed JRE contains an absolute symbolic link: {}", source.display()));
    }
    let parent = source
        .parent()
        .ok_or_else(|| format!("Managed JRE symbolic link has no parent directory: {}", source.display()))?;
    let resolved_target = parent
        .join(&link_target)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve managed JRE symbolic link {}: {error}", source.display()))?;
    if !resolved_target.starts_with(canonical_root) {
        return Err(format!("Managed JRE symbolic link resolves outside the managed JRE root: {}", source.display()));
    }
    let target_metadata = fs::metadata(source)
        .map_err(|error| format!("Failed to inspect managed JRE symbolic link target {}: {error}", source.display()))?;
    if !target_metadata.is_file() {
        return Err(format!("Managed JRE symbolic link does not resolve to a regular file: {}", source.display()));
    }
    Ok((link_target, resolved_target, target_metadata))
}

fn validate_managed_jre_tree(am: &AgentManager, key: &str) -> Result<(usize, u64), String> {
    validate_offline_identifier(key, "JRE")?;
    let root = am.jre_dir(key);
    let root_metadata = fs::symlink_metadata(&root).map_err(|_| format!("Managed JRE {key} is not installed"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(format!("Managed JRE {key} directory is not a regular managed directory"));
    }
    ensure_path_within_base(am, &root)?;
    let canonical_root =
        root.canonicalize().map_err(|error| format!("Failed to resolve managed JRE {key} directory: {error}"))?;

    let mut stack = vec![(root.clone(), 0usize)];
    let mut entry_count = 1usize;
    let mut total_bytes = 0u64;
    while let Some((path, depth)) = stack.pop() {
        if depth > MAX_JRE_DEPTH {
            return Err(format!("Managed JRE {key} exceeds the export depth limit"));
        }
        let metadata =
            fs::symlink_metadata(&path).map_err(|error| format!("Failed to inspect managed JRE {key}: {error}"))?;
        if metadata.file_type().is_symlink() {
            let (_, _, target_metadata) = resolve_managed_jre_file_symlink(&path, &canonical_root)?;
            total_bytes = total_bytes
                .checked_add(target_metadata.len())
                .ok_or_else(|| format!("Managed JRE {key} size overflow"))?;
            if total_bytes > MAX_JRE_UNCOMPRESSED_BYTES {
                return Err(format!("Managed JRE {key} exceeds the export size limit"));
            }
            continue;
        }
        if metadata.is_dir() {
            for child in fs::read_dir(&path).map_err(|error| format!("Failed to inspect managed JRE {key}: {error}"))? {
                let child = child.map_err(|error| format!("Failed to inspect managed JRE {key}: {error}"))?;
                entry_count =
                    entry_count.checked_add(1).ok_or_else(|| format!("Managed JRE {key} entry count overflow"))?;
                if entry_count > MAX_JRE_ENTRY_COUNT {
                    return Err(format!("Managed JRE {key} exceeds the export entry limit"));
                }
                if depth + 1 > MAX_JRE_DEPTH {
                    return Err(format!("Managed JRE {key} exceeds the export depth limit"));
                }
                stack.push((child.path(), depth + 1));
            }
        } else if metadata.is_file() {
            total_bytes =
                total_bytes.checked_add(metadata.len()).ok_or_else(|| format!("Managed JRE {key} size overflow"))?;
            if total_bytes > MAX_JRE_UNCOMPRESSED_BYTES {
                return Err(format!("Managed JRE {key} exceeds the export size limit"));
            }
        } else {
            return Err(format!("Managed JRE {key} contains a special file"));
        }
    }
    let java_path = am.jre_java_path(key);
    let java_metadata = fs::symlink_metadata(&java_path)
        .map_err(|_| format!("Managed JRE {key} does not contain a Java executable"))?;
    if java_metadata.file_type().is_symlink() || !java_metadata.is_file() || java_metadata.len() == 0 {
        return Err(format!("Managed JRE {key} Java executable is invalid"));
    }
    Ok((entry_count, total_bytes))
}

#[cfg(unix)]
fn metadata_mode(metadata: &Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o7777
}

#[cfg(not(unix))]
fn metadata_mode(metadata: &Metadata) -> u32 {
    if metadata.is_dir() {
        0o755
    } else {
        0o644
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("Failed to hash {}: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| format!("Failed to hash {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn unavailable_reason_label(reason: AgentOfflineExportUnavailableReason) -> &'static str {
    match reason {
        AgentOfflineExportUnavailableReason::UnmanagedInstall => "the artifact is not tracked as a DBX-managed install",
        AgentOfflineExportUnavailableReason::LocalInstall => "locally imported Agent builds are not redistributable",
        AgentOfflineExportUnavailableReason::LaunchConfig => "custom launch configurations are machine-local",
        AgentOfflineExportUnavailableReason::MissingArtifact => "the installed Agent artifact is missing",
        AgentOfflineExportUnavailableReason::InvalidArtifact => "the installed Agent artifact is invalid or corrupt",
        AgentOfflineExportUnavailableReason::UnsafeSource => {
            "the Agent artifact is outside the managed store or is a symbolic link"
        }
        AgentOfflineExportUnavailableReason::ExternalDriverRequired => {
            "the Agent requires an external user-provided driver and is excluded from offline export"
        }
        AgentOfflineExportUnavailableReason::MissingManagedJre => "the required DBX-managed JRE is not installed",
        AgentOfflineExportUnavailableReason::InvalidManagedJre => "the required DBX-managed JRE is invalid or unsafe",
    }
}

fn normalized_parent(path: &Path) -> Result<PathBuf, String> {
    let parent = path.parent().ok_or_else(|| "Export destination has no parent directory".to_string())?;
    if parent.as_os_str().is_empty() {
        Ok(PathBuf::from("."))
    } else {
        Ok(parent.to_path_buf())
    }
}

fn validate_export_destination(am: &AgentManager, destination: &Path, parent: &Path) -> Result<(), String> {
    validate_export_destination_name(destination)?;

    let managed_base =
        am.base_dir().canonicalize().map_err(|error| format!("Failed to resolve Agent store path: {error}"))?;
    let resolved_parent =
        parent.canonicalize().map_err(|error| format!("Failed to resolve export destination directory: {error}"))?;
    if resolved_parent.starts_with(&managed_base) {
        return Err("Offline Agent packages cannot be written inside the managed Agent store".to_string());
    }
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("Existing export destination must be a regular non-symbolic-link file".to_string());
        }
        Ok(_) => {
            let resolved_destination =
                destination.canonicalize().map_err(|error| format!("Failed to resolve export destination: {error}"))?;
            if resolved_destination.starts_with(&managed_base) {
                return Err("Offline Agent packages cannot replace files in the managed Agent store".to_string());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Failed to inspect export destination: {error}")),
    }
    Ok(())
}

fn validate_export_destination_name(destination: &Path) -> Result<(), String> {
    let file_name = destination
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Export destination must name a ZIP file".to_string())?;
    if file_name == "." || file_name == ".." {
        return Err("Export destination must name a ZIP file".to_string());
    }
    if !destination
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("Export destination must use the .zip extension".to_string());
    }
    Ok(())
}

fn safe_filename_token(value: &str) -> String {
    let token =
        value
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                    character
                } else {
                    '_'
                }
            })
            .collect::<String>();
    if token.is_empty() {
        "unknown".to_string()
    } else {
        token
    }
}

fn validate_offline_identifier(value: &str, kind: &str) -> Result<(), String> {
    if value.is_empty()
        || matches!(value, "." | "..")
        || !value.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        return Err(format!("Invalid {kind} identifier for offline export: {value}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    use crate::agent_manager::{AgentRegistry, InstalledDriver};
    use crate::agent_service::import_agents_from_package;

    fn manager(root: &Path) -> AgentManager {
        AgentManager::new_with_base_dir_and_app_version(root.to_path_buf(), "9.9.9")
    }

    fn write_agent_jar(path: &Path, external_driver: bool) -> Vec<u8> {
        write_agent_jar_manifest(
            path,
            &format!(
                "Manifest-Version: 1.0\nMain-Class: com.example.Agent\n{}",
                if external_driver { "Agent-External-Driver: true\n" } else { "" }
            ),
        )
    }

    fn write_agent_jar_manifest(path: &Path, manifest: &str) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut bytes);
            archive.start_file("META-INF/MANIFEST.MF", SimpleFileOptions::default()).unwrap();
            archive.write_all(manifest.as_bytes()).unwrap();
            archive.finish().unwrap();
        }
        let bytes = bytes.into_inner();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, &bytes).unwrap();
        bytes
    }

    fn install_managed_jar(am: &AgentManager, db_type: &str, version: &str, jre_key: &str, external: bool) {
        write_agent_jar(&am.driver_jar_path(db_type), external);
        am.mutate_state(|state| {
            state.installed_drivers.insert(
                db_type.to_string(),
                InstalledDriver {
                    version: version.to_string(),
                    installed_at: "ignored".to_string(),
                    jre: jre_key.to_string(),
                },
            );
        })
        .unwrap();
    }

    fn install_managed_jre(am: &AgentManager, key: &str, version: &str) {
        let java = am.jre_java_path(key);
        fs::create_dir_all(java.parent().unwrap()).unwrap();
        fs::write(&java, b"managed-java").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&java, fs::Permissions::from_mode(0o755)).unwrap();
        }
        am.mutate_state(|state| {
            state.jre_versions.insert(key.to_string(), version.to_string());
        })
        .unwrap();
    }

    fn current_platform_native_binary() -> Vec<u8> {
        if cfg!(windows) {
            let mut bytes = vec![0_u8; 0x48];
            bytes[..2].copy_from_slice(b"MZ");
            bytes[0x3c..0x40].copy_from_slice(&(0x40_u32).to_le_bytes());
            bytes[0x40..0x44].copy_from_slice(b"PE\0\0");
            let machine = if cfg!(target_arch = "aarch64") { 0xaa64_u16 } else { 0x8664_u16 };
            bytes[0x44..0x46].copy_from_slice(&machine.to_le_bytes());
            bytes
        } else if cfg!(target_os = "linux") {
            let mut bytes = vec![0_u8; 20];
            bytes[..4].copy_from_slice(b"\x7fELF");
            bytes[4] = 2;
            bytes[5] = 1;
            let machine = if cfg!(target_arch = "aarch64") { 183_u16 } else { 62_u16 };
            bytes[18..20].copy_from_slice(&machine.to_le_bytes());
            bytes
        } else if cfg!(target_os = "macos") {
            let mut bytes = vec![0xcf, 0xfa, 0xed, 0xfe];
            let cpu_type = if cfg!(target_arch = "aarch64") { 0x0100_000c_u32 } else { 0x0100_0007_u32 };
            bytes.extend_from_slice(&cpu_type.to_le_bytes());
            bytes
        } else {
            Vec::new()
        }
    }

    fn install_managed_native(am: &AgentManager, db_type: &str, version: &str) -> Vec<u8> {
        let bytes = current_platform_native_binary();
        let path = am.driver_native_path(db_type);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &bytes).unwrap();
        am.mutate_state(|state| {
            state.installed_drivers.insert(
                db_type.to_string(),
                InstalledDriver {
                    version: version.to_string(),
                    installed_at: "ignored".to_string(),
                    jre: "21".to_string(),
                },
            );
        })
        .unwrap();
        bytes
    }

    fn candidate<'a>(preview: &'a AgentOfflineExportPreview, db_type: &str) -> &'a AgentOfflineExportCandidate {
        preview.candidates.iter().find(|candidate| candidate.db_type == db_type).unwrap()
    }

    #[test]
    fn preview_distinguishes_managed_local_external_and_launch_config_drivers() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(temp.path());
        install_managed_jre(&am, "21", "21.0.7");
        install_managed_jar(&am, "duckdb", "1.2.3", "21", false);
        install_managed_jar(&am, "kafka", "0.1.0-local", "21", false);
        install_managed_jar(&am, "rocketmq", "1.2.3", "21", true);
        fs::create_dir_all(am.driver_dir("rabbitmq")).unwrap();
        fs::write(am.driver_launch_config_path("rabbitmq"), b"{}").unwrap();
        am.mutate_state(|state| {
            state.installed_drivers.insert(
                "rabbitmq".to_string(),
                InstalledDriver {
                    version: "1.2.3".to_string(),
                    installed_at: "ignored".to_string(),
                    jre: "21".to_string(),
                },
            );
        })
        .unwrap();

        let preview = preview_agent_offline_export(&am);
        assert!(candidate(&preview, "duckdb").eligible);
        assert_eq!(
            candidate(&preview, "kafka").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::LocalInstall)
        );
        assert_eq!(
            candidate(&preview, "rocketmq").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::ExternalDriverRequired)
        );
        assert_eq!(
            candidate(&preview, "rabbitmq").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::LaunchConfig)
        );
    }

    #[test]
    fn preview_requires_a_valid_managed_jre_for_java_agents() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(temp.path());
        install_managed_jar(&am, "duckdb", "1.2.3", "21", false);

        let preview = preview_agent_offline_export(&am);
        assert_eq!(
            candidate(&preview, "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::MissingManagedJre)
        );
    }

    #[test]
    fn preview_treats_an_empty_jre_key_as_missing_instead_of_panicking() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(temp.path());
        install_managed_jar(&am, "duckdb", "1.2.3", "", false);

        assert_eq!(
            candidate(&preview_agent_offline_export(&am), "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::MissingManagedJre)
        );
    }

    #[test]
    fn preview_detects_folded_external_driver_manifest_values() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(temp.path());
        install_managed_jre(&am, "21", "21.0.7");
        let path = am.driver_jar_path("duckdb");
        write_agent_jar_manifest(
            &path,
            "Manifest-Version: 1.0\r\nMain-Class: com.example.Agent\r\nAgent-External-Driver: tr\r\n ue\r\n",
        );
        am.mutate_state(|state| {
            state.installed_drivers.insert(
                "duckdb".to_string(),
                InstalledDriver {
                    version: "1.2.3".to_string(),
                    installed_at: "ignored".to_string(),
                    jre: "21".to_string(),
                },
            );
        })
        .unwrap();

        assert_eq!(
            candidate(&preview_agent_offline_export(&am), "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::ExternalDriverRequired)
        );
    }

    #[test]
    fn preview_rejects_a_jar_without_a_main_class_using_the_bounded_manifest_reader() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(temp.path());
        install_managed_jre(&am, "21", "21.0.7");
        let path = am.driver_jar_path("duckdb");
        write_agent_jar_manifest(&path, "Manifest-Version: 1.0\nImplementation-Title: Invalid Agent\n");
        am.mutate_state(|state| {
            state.installed_drivers.insert(
                "duckdb".to_string(),
                InstalledDriver {
                    version: "1.2.3".to_string(),
                    installed_at: "ignored".to_string(),
                    jre: "21".to_string(),
                },
            );
        })
        .unwrap();

        assert_eq!(
            candidate(&preview_agent_offline_export(&am), "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::InvalidArtifact)
        );
    }

    #[test]
    fn preview_prefers_the_current_platform_native_artifact_over_a_jar() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(temp.path());
        install_managed_jre(&am, "21", "21.0.7");
        install_managed_jar(&am, "duckdb", "1.2.3", "21", false);
        install_managed_native(&am, "duckdb", "1.2.3");

        let duckdb = candidate(&preview_agent_offline_export(&am), "duckdb").clone();
        assert!(duckdb.eligible);
        assert_eq!(duckdb.artifact_kind, Some(AgentOfflineArtifactKind::Native));
        assert_eq!(duckdb.required_jre, None);
    }

    #[cfg(unix)]
    #[test]
    fn preview_rejects_symlinked_managed_artifacts() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_jre(&am, "21", "21.0.7");
        let real = temp.path().join("outside.jar");
        write_agent_jar(&real, false);
        fs::create_dir_all(am.driver_dir("duckdb")).unwrap();
        symlink(&real, am.driver_jar_path("duckdb")).unwrap();
        am.mutate_state(|state| {
            state.installed_drivers.insert(
                "duckdb".to_string(),
                InstalledDriver {
                    version: "1.2.3".to_string(),
                    installed_at: "ignored".to_string(),
                    jre: "21".to_string(),
                },
            );
        })
        .unwrap();

        assert_eq!(
            candidate(&preview_agent_offline_export(&am), "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::UnsafeSource)
        );
    }

    #[tokio::test]
    async fn exported_package_round_trips_through_existing_importer_and_deduplicates_jre() {
        let temp = tempfile::tempdir().unwrap();
        let source = manager(&temp.path().join("source"));
        install_managed_jre(&source, "21", "21.0.7");
        let duckdb_bytes = write_agent_jar(&source.driver_jar_path("duckdb"), false);
        let kafka_bytes = write_agent_jar(&source.driver_jar_path("kafka"), false);
        source
            .mutate_state(|state| {
                state.jre_versions.insert("21".to_string(), "21.0.7".to_string());
                for db_type in ["duckdb", "kafka"] {
                    state.installed_drivers.insert(
                        db_type.to_string(),
                        InstalledDriver {
                            version: "1.2.3".to_string(),
                            installed_at: "ignored".to_string(),
                            jre: "21".to_string(),
                        },
                    );
                }
            })
            .unwrap();
        let package = temp.path().join("agents.zip");

        let result =
            export_agents_offline_unlocked(&source, &package, &["kafka".to_string(), "duckdb".to_string()]).unwrap();
        assert_eq!(result.driver_count, 2);
        assert_eq!(result.jre_count, 1);
        let plan = inspect_offline_package(&package).unwrap();
        assert_eq!(
            plan.driver_keys.into_iter().collect::<BTreeSet<_>>(),
            BTreeSet::from(["duckdb".to_string(), "kafka".to_string(),])
        );
        assert!(plan.includes_jre);

        let registry = {
            let file = File::open(&package).unwrap();
            let mut archive = zip::ZipArchive::new(file).unwrap();
            let mut entry = archive.by_name("agent-registry.json").unwrap();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            serde_json::from_slice::<AgentRegistry>(&bytes).unwrap()
        };
        assert!(registry.jre.is_none());
        assert_eq!(registry.jres.keys().cloned().collect::<BTreeSet<_>>(), BTreeSet::from(["21".to_string()]));
        assert_eq!(
            registry.drivers.keys().cloned().collect::<BTreeSet<_>>(),
            BTreeSet::from(["duckdb".to_string(), "kafka".to_string()])
        );
        let duckdb_artifact = registry.drivers["duckdb"].jar.as_ref().unwrap();
        assert_eq!(duckdb_artifact.url, "offline://dbx-agent-duckdb.jar");
        assert_eq!(duckdb_artifact.size, duckdb_bytes.len() as u64);
        assert_eq!(
            duckdb_artifact.sha256.as_deref(),
            Some(sha256_file(&source.driver_jar_path("duckdb")).unwrap().as_str())
        );
        let jre_artifact = &registry.jres["21"].platforms[AgentManager::current_platform()];
        assert!(jre_artifact.url.starts_with("offline://dbx-jre-21-21.0.7-"));
        assert_eq!(jre_artifact.format, Some(ArtifactFormat::TarZstd));
        assert!(jre_artifact.size > 0);
        assert!(jre_artifact.sha256.as_ref().is_some_and(|sha| sha.len() == 64));

        let target = manager(&temp.path().join("target"));
        let imported = import_agents_from_package(&target, &package, |_| {}).await.unwrap();
        assert_eq!(
            imported.drivers_installed.into_iter().collect::<BTreeSet<_>>(),
            BTreeSet::from(["duckdb".to_string(), "kafka".to_string(),])
        );
        assert_eq!(fs::read(target.driver_jar_path("duckdb")).unwrap(), duckdb_bytes);
        assert_eq!(fs::read(target.driver_jar_path("kafka")).unwrap(), kafka_bytes);
        assert_eq!(fs::read(target.jre_java_path("21")).unwrap(), b"managed-java");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_ne!(fs::metadata(target.jre_java_path("21")).unwrap().permissions().mode() & 0o111, 0);
        }

        let file = File::open(&package).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names =
            (0..archive.len()).map(|index| archive.by_index(index).unwrap().name().to_string()).collect::<Vec<_>>();
        assert_eq!(names.iter().filter(|name| name.starts_with("jre/")).count(), 1);
        assert!(!names.iter().any(|name| name.contains("state.json") || name.contains("agent-launch.json")));
    }

    #[tokio::test]
    async fn exported_native_package_round_trips_without_a_jre() {
        let temp = tempfile::tempdir().unwrap();
        let source = manager(&temp.path().join("source"));
        let native_bytes = install_managed_native(&source, "duckdb", "1.2.3");
        let package = temp.path().join("native-agents.zip");

        let result = export_agents_offline_unlocked(&source, &package, &["duckdb".to_string()]).unwrap();
        assert_eq!(result.driver_count, 1);
        assert_eq!(result.jre_count, 0);
        let plan = inspect_offline_package(&package).unwrap();
        assert_eq!(plan.driver_keys, vec!["duckdb"]);
        assert!(!plan.includes_jre);

        let target = manager(&temp.path().join("target"));
        let imported = import_agents_from_package(&target, &package, |_| {}).await.unwrap();
        assert_eq!(imported.drivers_installed, vec!["duckdb"]);
        assert_eq!(fs::read(target.driver_native_path("duckdb")).unwrap(), native_bytes);
        assert!(!target.driver_jar_path("duckdb").exists());
    }

    #[cfg(unix)]
    #[test]
    fn preview_rejects_a_managed_jre_symbolic_link_that_escapes_the_managed_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_jre(&am, "21", "21.0.7");
        install_managed_jar(&am, "duckdb", "1.2.3", "21", false);
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"must-not-export").unwrap();
        symlink(&outside, am.jre_dir("21").join("unsafe-link")).unwrap();

        assert_eq!(
            candidate(&preview_agent_offline_export(&am), "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::InvalidManagedJre)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_dereferences_safe_internal_jre_file_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let source = manager(&temp.path().join("source"));
        install_managed_jre(&source, "21", "21.0.7");
        install_managed_jar(&source, "h2", "1.2.3", "21", false);
        let license = source.jre_dir("21").join("licenses/LICENSE");
        fs::create_dir_all(license.parent().unwrap()).unwrap();
        fs::write(&license, b"managed-license").unwrap();
        let linked_license = source.jre_dir("21").join("legal/LICENSE");
        fs::create_dir_all(linked_license.parent().unwrap()).unwrap();
        symlink("../licenses/LICENSE", &linked_license).unwrap();

        assert!(candidate(&preview_agent_offline_export_unlocked(&source), "h2").eligible);
        let package = temp.path().join("agents.zip");
        let result = export_agents_offline_unlocked(&source, &package, &["h2".to_string()]).unwrap();
        assert_eq!(result.driver_count, 1);
        assert_eq!(result.jre_count, 1);

        let target = manager(&temp.path().join("target"));
        import_agents_from_package(&target, &package, |_| {}).await.unwrap();
        let imported_license = target.jre_dir("21").join("legal/LICENSE");
        assert_eq!(fs::read(&imported_license).unwrap(), b"managed-license");
        assert!(!fs::symlink_metadata(imported_license).unwrap().file_type().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn preview_rejects_a_managed_jre_containing_a_special_file() {
        use std::os::unix::net::UnixListener;

        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_jre(&am, "21", "21.0.7");
        install_managed_jar(&am, "duckdb", "1.2.3", "21", false);
        let _socket = UnixListener::bind(am.jre_dir("21").join("unsafe.sock")).unwrap();

        assert_eq!(
            candidate(&preview_agent_offline_export(&am), "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::InvalidManagedJre)
        );
    }

    #[test]
    fn preview_rejects_a_managed_jre_exceeding_the_depth_limit() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_jre(&am, "21", "21.0.7");
        install_managed_jar(&am, "duckdb", "1.2.3", "21", false);
        let mut nested = am.jre_dir("21");
        for _ in 0..=MAX_JRE_DEPTH {
            nested.push("nested");
        }
        fs::create_dir_all(nested).unwrap();

        assert_eq!(
            candidate(&preview_agent_offline_export(&am), "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::InvalidManagedJre)
        );
    }

    #[test]
    fn preview_rejects_a_managed_jre_exceeding_the_size_limit() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_jre(&am, "21", "21.0.7");
        install_managed_jar(&am, "duckdb", "1.2.3", "21", false);
        let oversized = File::create(am.jre_dir("21").join("oversized.bin")).unwrap();
        oversized.set_len(MAX_JRE_UNCOMPRESSED_BYTES + 1).unwrap();

        assert_eq!(
            candidate(&preview_agent_offline_export(&am), "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::InvalidManagedJre)
        );
    }

    #[test]
    fn jre_archive_enforces_the_entry_count_limit() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("jre");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("first"), b"first").unwrap();
        fs::write(source.join("second"), b"second").unwrap();
        let mut bytes = Vec::new();
        let mut archive = tar::Builder::new(&mut bytes);

        let error = append_jre_tree_with_limits(
            &mut archive,
            &source,
            Path::new("dbx-jre-test"),
            2,
            MAX_JRE_DEPTH,
            MAX_JRE_UNCOMPRESSED_BYTES,
        )
        .unwrap_err();

        assert!(error.contains("entry limit of 2"), "unexpected error: {error}");
    }

    #[test]
    fn stale_preview_is_revalidated_before_export_without_leaving_partial_files() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_native(&am, "duckdb", "1.2.3");
        assert!(candidate(&preview_agent_offline_export(&am), "duckdb").eligible);
        fs::remove_file(am.driver_native_path("duckdb")).unwrap();
        assert_eq!(
            candidate(&preview_agent_offline_export(&am), "duckdb").unavailable_reason,
            Some(AgentOfflineExportUnavailableReason::MissingArtifact)
        );
        let destination = temp.path().join("stale.zip");

        let error = export_agents_offline_unlocked(&am, &destination, &["duckdb".to_string()]).unwrap_err();
        assert!(error.contains("cannot be exported"), "unexpected error: {error}");
        assert!(!destination.exists());
        assert!(!fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".partial-")));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_waits_for_an_in_flight_installation_operation() {
        let temp = tempfile::tempdir().unwrap();
        let am = std::sync::Arc::new(manager(&temp.path().join("agents")));
        install_managed_native(&am, "duckdb", "1.2.3");
        let install_guard = am.installation_operation_lock.read().await;
        let export_manager = std::sync::Arc::clone(&am);
        let destination = temp.path().join("waited.zip");
        let mut export = tokio::task::spawn_blocking(move || {
            export_agents_offline(&export_manager, &destination, &["duckdb".to_string()])
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut export).await.is_err(),
            "export entered while another installation operation held the snapshot lock"
        );
        drop(install_guard);

        let result = tokio::time::timeout(std::time::Duration::from_secs(2), export)
            .await
            .expect("export did not resume after the installation operation finished")
            .expect("export worker panicked")
            .expect("export failed after the installation operation finished");
        assert_eq!(result.driver_count, 1);
    }

    #[test]
    fn failed_export_preserves_existing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        let destination = temp.path().join("existing.zip");
        fs::write(&destination, b"keep-me").unwrap();

        let error = export_agents_offline_unlocked(&am, &destination, &["missing".to_string()]).unwrap_err();
        assert!(error.contains("not installed"));
        assert_eq!(fs::read(destination).unwrap(), b"keep-me");
    }

    #[test]
    fn late_validation_failure_removes_partial_file_and_preserves_destination() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("existing.zip");
        fs::write(&destination, b"keep-me").unwrap();
        let partial = temp.path().join(".existing.zip.partial-test");

        let error = write_and_finalize_export_zip(&partial, &destination, br#"{"drivers":{}}"#, &[], &[], |_| {
            Err("forced compatibility failure".to_string())
        })
        .unwrap_err();

        assert_eq!(error, "forced compatibility failure");
        assert!(!partial.exists());
        assert_eq!(fs::read(destination).unwrap(), b"keep-me");
    }

    #[test]
    fn successful_export_replaces_an_existing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_native(&am, "duckdb", "1.2.3");
        let destination = temp.path().join("existing.zip");
        fs::write(&destination, b"replace-me").unwrap();

        let result = export_agents_offline_unlocked(&am, &destination, &["duckdb".to_string()]).unwrap();
        assert_eq!(result.driver_count, 1);
        assert_ne!(fs::read(&destination).unwrap(), b"replace-me");
        assert_eq!(inspect_offline_package(&destination).unwrap().driver_keys, vec!["duckdb"]);
    }

    #[test]
    fn export_rejects_a_non_zip_destination_before_creating_its_parent() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_native(&am, "duckdb", "1.2.3");
        let parent = temp.path().join("new-directory");
        let destination = parent.join("agents.tar.zst");

        let error = export_agents_offline_unlocked(&am, &destination, &["duckdb".to_string()]).unwrap_err();
        assert!(error.contains(".zip extension"), "unexpected error: {error}");
        assert!(!parent.exists());
    }

    #[test]
    fn export_rejects_an_existing_directory_without_moving_it() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_native(&am, "duckdb", "1.2.3");
        let destination = temp.path().join("existing.zip");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("sentinel"), b"keep-me").unwrap();

        let error = export_agents_offline_unlocked(&am, &destination, &["duckdb".to_string()]).unwrap_err();
        assert!(error.contains("regular non-symbolic-link file"), "unexpected error: {error}");
        assert_eq!(fs::read(destination.join("sentinel")).unwrap(), b"keep-me");
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_an_existing_symlink_without_changing_its_target() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_native(&am, "duckdb", "1.2.3");
        let target = temp.path().join("target.zip");
        fs::write(&target, b"keep-me").unwrap();
        let destination = temp.path().join("existing.zip");
        symlink(&target, &destination).unwrap();

        let error = export_agents_offline_unlocked(&am, &destination, &["duckdb".to_string()]).unwrap_err();
        assert!(error.contains("regular non-symbolic-link file"), "unexpected error: {error}");
        assert_eq!(fs::read(&target).unwrap(), b"keep-me");
        assert!(fs::symlink_metadata(&destination).unwrap().file_type().is_symlink());
    }

    #[test]
    fn export_rejects_an_empty_selection_without_creating_a_destination() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        let destination = temp.path().join("empty.zip");

        let error = export_agents_offline_unlocked(&am, &destination, &[]).unwrap_err();
        assert!(error.contains("Select at least one"));
        assert!(!destination.exists());
    }

    #[test]
    fn export_rejects_a_destination_inside_the_managed_agent_store() {
        let temp = tempfile::tempdir().unwrap();
        let am = manager(&temp.path().join("agents"));
        install_managed_native(&am, "duckdb", "1.2.3");
        let destination = am.base_dir().join("must-not-overwrite.zip");

        let error = export_agents_offline_unlocked(&am, &destination, &["duckdb".to_string()]).unwrap_err();
        assert!(error.contains("managed Agent store"), "unexpected error: {error}");
        assert!(!destination.exists());
    }

    #[test]
    fn preview_contract_uses_camel_case_values() {
        let value = serde_json::to_value(AgentOfflineExportCandidate {
            db_type: "duckdb".to_string(),
            label: "DuckDB".to_string(),
            version: "1".to_string(),
            size: 1,
            artifact_kind: Some(AgentOfflineArtifactKind::Jar),
            required_jre: Some("21".to_string()),
            eligible: false,
            unavailable_reason: Some(AgentOfflineExportUnavailableReason::ExternalDriverRequired),
        })
        .unwrap();
        assert_eq!(value["dbType"], "duckdb");
        assert_eq!(value["artifactKind"], "jar");
        assert_eq!(value["unavailableReason"], "externalDriverRequired");

        let preview = serde_json::to_value(AgentOfflineExportPreview {
            platform: "linux-x64".to_string(),
            candidates: Vec::new(),
        })
        .unwrap();
        assert_eq!(preview["platform"], "linux-x64");
        assert!(preview["candidates"].as_array().unwrap().is_empty());

        let result = serde_json::to_value(AgentOfflineExportResult {
            platform: "linux-x64".to_string(),
            driver_count: 2,
            jre_count: 1,
            bytes: 42,
        })
        .unwrap();
        assert_eq!(result["driverCount"], 2);
        assert_eq!(result["jreCount"], 1);
        assert_eq!(result["bytes"], 42);
    }
}
