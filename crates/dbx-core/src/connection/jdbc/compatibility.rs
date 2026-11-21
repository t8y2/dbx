//! Installation of reviewed compatibility builds. The application catalog is the
//! trust root; neither a caller nor an archive can supply its own download/hash.
use super::*;
use std::collections::HashSet;
use std::io::{Seek, SeekFrom};
use tokio::io::AsyncWriteExt;

pub const JDBC_COMPATIBILITY_MAX_PACKAGE_SIZE: u64 = 512 * 1024 * 1024;
const CATALOG: &str = include_str!("../../../assets/jdbc-compatibility-runtimes.json");
const REQUIRED_PLUGIN_CAPABILITY: &str = "jdbc.external-classpath-isolation-v1";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    format_version: u32,
    runtimes: Vec<Runtime>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Runtime {
    id: String,
    version: String,
    url: String,
    size: u64,
    sha256: String,
    coordinate: String,
    artifacts: Vec<Artifact>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    file_name: String,
    size: u64,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompatibilityManifest {
    format_version: u32,
    id: String,
    version: String,
    bundles: Vec<OfflineJdbcBundle>,
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn safe_file_name(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['/', '\\', ':', '\0'])
}

fn runtime_for_id(catalog: &str, id: &str) -> Result<Runtime, String> {
    let catalog: Catalog =
        serde_json::from_str(catalog).map_err(|err| format!("Invalid JDBC compatibility catalog: {err}"))?;
    if catalog.format_version != 1 {
        return Err("Unsupported JDBC compatibility catalog version".into());
    }
    let mut ids = HashSet::new();
    let mut coordinates = HashSet::new();
    for runtime in &catalog.runtimes {
        if !ids.insert(&runtime.id) || !coordinates.insert(&runtime.coordinate) {
            return Err("Duplicate JDBC compatibility catalog identity".into());
        }
        let mut names = HashSet::new();
        let valid_url = reqwest::Url::parse(&runtime.url).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("github.com")
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && url.path().starts_with("/t8y2/dbx/releases/download/")
                && !url.path().contains("/latest/")
        });
        if runtime.id.is_empty()
            || runtime.version.is_empty()
            || !valid_url
            || runtime.size == 0
            || runtime.size > JDBC_COMPATIBILITY_MAX_PACKAGE_SIZE
            || !valid_sha256(&runtime.sha256)
            || !runtime.coordinate.starts_with("app.dbx.compat:")
            || runtime.artifacts.is_empty()
            || runtime.artifacts.iter().any(|artifact| {
                !safe_file_name(&artifact.file_name)
                    || !artifact.file_name.ends_with(".jar")
                    || artifact.size == 0
                    || artifact.size > JDBC_COMPATIBILITY_MAX_PACKAGE_SIZE
                    || !valid_sha256(&artifact.sha256)
                    || !names.insert(&artifact.file_name)
            })
        {
            return Err(format!("Invalid JDBC compatibility runtime catalog entry: {}", runtime.id));
        }
    }
    catalog
        .runtimes
        .into_iter()
        .find(|runtime| runtime.id == id)
        .ok_or_else(|| format!("Unknown JDBC compatibility runtime: {id}"))
}

/// Only catalog-owned runtimes have this stronger availability contract; ordinary
/// Maven bundles retain their existing listing behavior. Avoid rehashing large
/// reviewed JARs on every UI refresh, but never advertise missing/partial files.
pub(super) fn bundle_is_complete(maven_dir: &Path, bundle: &JdbcMavenBundleInfo) -> Result<bool, String> {
    let catalog: Catalog = serde_json::from_str(CATALOG).map_err(|err| err.to_string())?;
    let Some(runtime) = catalog.runtimes.iter().find(|runtime| runtime.coordinate == bundle.coordinate) else {
        return Ok(true);
    };
    let expected_dir = maven_dir.join(maven_bundle_id(&runtime.coordinate));
    if bundle.id != maven_bundle_id(&runtime.coordinate)
        || Path::new(&bundle.path) != expected_dir
        || bundle.artifacts.len() != runtime.artifacts.len()
    {
        return Ok(false);
    }
    Ok(runtime.artifacts.iter().all(|expected| {
        let expected_path = expected_dir.join("jars").join(&expected.file_name);
        bundle.artifacts.iter().any(|actual| {
            actual.file_name == expected.file_name
                && actual.size == expected.size
                && actual.sha256.eq_ignore_ascii_case(&expected.sha256)
                && Path::new(&actual.path) == expected_path
                && std::fs::metadata(&expected_path)
                    .is_ok_and(|metadata| metadata.is_file() && metadata.len() == expected.size)
        })
    }))
}

fn require_plugin(plugins_root: &Path) -> Result<(), String> {
    let status = jdbc_plugin_status_from_dir_local(&plugins_root.join("jdbc"))?;
    if !status.installed || !status.compatible {
        return Err("Install a compatible DBX JDBC plugin before installing this compatibility runtime.".into());
    }
    if !status.capabilities.iter().any(|capability| capability == REQUIRED_PLUGIN_CAPABILITY) {
        return Err("Update the DBX JDBC plugin to a build with external classpath isolation before installing this compatibility runtime.".into());
    }
    Ok(())
}

/// A process/file lock also covers desktop and web processes sharing a data dir.
/// Call only from the blocking pool (like the existing synchronous installers).
pub(super) fn lock_bundle(plugins_root: &Path, bundle_id: &str) -> Result<std::fs::File, String> {
    if !is_safe_bundle_id(bundle_id) || matches!(bundle_id, "." | "..") {
        return Err("Invalid JDBC Maven bundle id".into());
    }
    let dir = plugins_root.join("jdbc").join("bundle-locks");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(format!("{bundle_id}.lock")))
        .map_err(|err| err.to_string())?;
    fs2::FileExt::lock_exclusive(&file).map_err(|err| format!("Failed to lock JDBC bundle: {err}"))?;
    Ok(file)
}

pub async fn install_jdbc_compatibility_runtime(plugins_root: &Path, id: &str) -> Result<Vec<JdbcDriverInfo>, String> {
    let runtime = runtime_for_id(CATALOG, id)?;
    let root = plugins_root.to_path_buf();
    let check_root = root.clone();
    tokio::task::spawn_blocking(move || require_plugin(&check_root)).await.map_err(|err| err.to_string())??;
    // TempDir owns cleanup even if the request future is cancelled during download.
    let temp = tempfile::Builder::new().prefix("dbx-jdbc-compat-").tempdir().map_err(|err| err.to_string())?;
    let package = temp.path().join("runtime.zip");
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| err.to_string())?;
    let mut response = client
        .get(&runtime.url)
        .header(reqwest::header::USER_AGENT, "dbx-jdbc-compatibility-installer")
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|err| {
            format!("Could not download the compatibility runtime; its release may not be published yet: {err}")
        })?;
    if response.content_length().is_some_and(|length| length != runtime.size) {
        return Err("JDBC compatibility package download size mismatch".into());
    }
    let mut output = tokio::fs::File::create(&package).await.map_err(|err| err.to_string())?;
    let mut length = 0_u64;
    while let Some(chunk) = response.chunk().await.map_err(|err| format!("Compatibility download failed: {err}"))? {
        length = length.checked_add(chunk.len() as u64).ok_or("Compatibility package size overflow")?;
        if length > runtime.size {
            return Err("JDBC compatibility package exceeds its approved size".into());
        }
        output.write_all(&chunk).await.map_err(|err| err.to_string())?;
    }
    output.flush().await.map_err(|err| err.to_string())?;
    drop(output);
    tokio::task::spawn_blocking(move || {
        let result = install_package(&root, &package, &runtime);
        drop(temp);
        result
    })
    .await
    .map_err(|err| err.to_string())?
}

pub async fn install_jdbc_compatibility_runtime_from_file(
    plugins_root: &Path,
    id: &str,
    file_path: &str,
) -> Result<Vec<JdbcDriverInfo>, String> {
    let runtime = runtime_for_id(CATALOG, id)?;
    let root = plugins_root.to_path_buf();
    let path = PathBuf::from(file_path);
    tokio::task::spawn_blocking(move || install_package(&root, &path, &runtime)).await.map_err(|err| err.to_string())?
}

fn install_package(plugins_root: &Path, path: &Path, runtime: &Runtime) -> Result<Vec<JdbcDriverInfo>, String> {
    require_plugin(plugins_root)?;
    // Copy into a private snapshot so a caller modifying the input during extraction
    // cannot replace bytes after the approved digest has been checked.
    let mut source = std::fs::File::open(path).map_err(|err| format!("Failed to open compatibility package: {err}"))?;
    if source.metadata().map_err(|err| err.to_string())?.len() != runtime.size {
        return Err("JDBC compatibility package size mismatch".into());
    }
    let mut snapshot = tempfile::tempfile().map_err(|err| err.to_string())?;
    let copied =
        std::io::copy(&mut (&mut source).take(runtime.size + 1), &mut snapshot).map_err(|err| err.to_string())?;
    if copied != runtime.size {
        return Err("JDBC compatibility package changed while being read".into());
    }
    snapshot.seek(SeekFrom::Start(0)).map_err(|err| err.to_string())?;
    let mut hash = Sha256::new();
    let mut bytes = [0_u8; 64 * 1024];
    loop {
        let read = snapshot.read(&mut bytes).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&bytes[..read]);
    }
    if !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(&runtime.sha256) {
        return Err("JDBC compatibility package checksum mismatch".into());
    }
    let entry_count = compatibility_zip_entry_count(&mut snapshot)?;
    snapshot.seek(SeekFrom::Start(0)).map_err(|err| err.to_string())?;
    let mut archive = zip::ZipArchive::new(snapshot).map_err(|err| format!("Invalid compatibility ZIP: {err}"))?;
    // zip 4 collapses duplicate central-directory names into an IndexMap.
    // Compare the physical directory count before inspecting that map.
    if archive.len() != entry_count {
        return Err("Unsafe or duplicate compatibility ZIP entries".into());
    }
    validate_archive(&mut archive, runtime)?;
    let id = maven_bundle_id(&runtime.coordinate);
    let expected = OfflineJdbcBundle { id: id.clone(), coordinate: runtime.coordinate.clone() };
    let _lock = lock_bundle(plugins_root, &id)?;
    require_plugin(plugins_root)?;
    let maven_dir = jdbc_maven_drivers_dir(plugins_root);
    std::fs::create_dir_all(&maven_dir).map_err(|err| err.to_string())?;
    let staging = tempfile::Builder::new()
        .prefix(".compat-stage-")
        .tempdir_in(plugins_root.join("jdbc"))
        .map_err(|err| err.to_string())?;
    let staged = stage_offline_jdbc_bundle(&mut archive, &expected, staging.path(), &maven_dir)?;
    commit_bundle(
        &staged,
        &maven_dir.join(id),
        &plugins_root.join("jdbc").join(format!(".compat-backup-{}", uuid::Uuid::new_v4())),
        |from, to| std::fs::rename(from, to),
    )?;
    list_jdbc_drivers(plugins_root)
}

// Compatibility packages are bounded below ZIP64 limits and deliberately use
// no ZIP comment. This narrow format makes the directory count unambiguous.
fn compatibility_zip_entry_count(file: &mut std::fs::File) -> Result<usize, String> {
    let size = file.metadata().map_err(|err| err.to_string())?.len();
    if size < 22 {
        return Err("Invalid compatibility ZIP footer".into());
    }
    file.seek(SeekFrom::End(-22)).map_err(|err| err.to_string())?;
    let mut footer = [0_u8; 22];
    file.read_exact(&mut footer).map_err(|err| err.to_string())?;
    let count = u16::from_le_bytes([footer[10], footer[11]]) as usize;
    let directory_size = u32::from_le_bytes([footer[12], footer[13], footer[14], footer[15]]) as u64;
    let directory_start = u32::from_le_bytes([footer[16], footer[17], footer[18], footer[19]]) as u64;
    if &footer[..4] != b"PK\x05\x06"
        || footer[4..8] != [0, 0, 0, 0]
        || footer[8..10] != footer[10..12]
        || footer[20..22] != [0, 0]
        || count == 0
        || count > 1024
        || directory_start + directory_size != size - 22
    {
        return Err("Unsupported compatibility ZIP directory (ZIP64, multipart, comments or trailing data)".into());
    }
    Ok(count)
}

fn validate_archive(archive: &mut zip::ZipArchive<std::fs::File>, runtime: &Runtime) -> Result<(), String> {
    if archive.len() > 1024 {
        return Err("Too many compatibility ZIP entries".into());
    }
    let bundle_id = maven_bundle_id(&runtime.coordinate);
    let manifest_name = format!("jdbc/maven/{bundle_id}/manifest.json");
    let jars_prefix = format!("jdbc/maven/{bundle_id}/jars/");
    let mut names = HashSet::new();
    let mut total = 0_u64;
    let max_total = runtime
        .artifacts
        .iter()
        .try_fold(16 * 1024 * 1024_u64, |sum, artifact| sum.checked_add(artifact.size))
        .ok_or("Compatibility catalog size overflow")?;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|err| err.to_string())?;
        let name = entry.name();
        if name.is_empty()
            || name.starts_with('/')
            || name.contains(['\\', ':', '\0'])
            || name.split('/').any(|part| matches!(part, "." | ".."))
            || !names.insert(name.to_string())
            || entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("Unsafe or duplicate compatibility ZIP entry: {name}"));
        }
        total = total.checked_add(entry.size()).ok_or("Compatibility ZIP size overflow")?;
        if total > max_total {
            return Err("Compatibility ZIP exceeds its approved expanded size".into());
        }
        if !entry.is_dir()
            && name != "compatibility.json"
            && name != "provenance.json"
            && name != manifest_name
            && !name.starts_with("provenance/")
            && !name.starts_with("licenses/")
            && !runtime.artifacts.iter().any(|artifact| name == format!("{jars_prefix}{}", artifact.file_name))
        {
            return Err(format!("Unexpected compatibility ZIP entry: {name}"));
        }
    }
    let manifest: CompatibilityManifest =
        serde_json::from_slice(&read_zip_entry(archive, "compatibility.json", 1024 * 1024)?)
            .map_err(|err| format!("Invalid compatibility manifest: {err}"))?;
    if manifest.format_version != 1
        || manifest.id != runtime.id
        || manifest.version != runtime.version
        || manifest.bundles.len() != 1
        || manifest.bundles[0].id != bundle_id
        || manifest.bundles[0].coordinate != runtime.coordinate
    {
        return Err("Compatibility package identity does not match the approved runtime".into());
    }
    let bundle: JdbcMavenBundleInfo =
        serde_json::from_slice(&read_zip_entry(archive, &manifest_name, 4 * 1024 * 1024)?)
            .map_err(|err| format!("Invalid compatibility bundle manifest: {err}"))?;
    if bundle.id != bundle_id
        || bundle.coordinate != runtime.coordinate
        || bundle.scope != "runtime"
        || !bundle.repositories.is_empty()
        || bundle.artifacts.len() != runtime.artifacts.len()
    {
        return Err("Compatibility bundle does not match the approved runtime".into());
    }
    let mut artifact_names = HashSet::new();
    for actual in &bundle.artifacts {
        if !safe_file_name(&actual.file_name)
            || !artifact_names.insert(&actual.file_name)
            || actual.extension != "jar"
            || !runtime.artifacts.iter().any(|expected| {
                expected.file_name == actual.file_name
                    && expected.size == actual.size
                    && expected.sha256.eq_ignore_ascii_case(&actual.sha256)
            })
        {
            return Err(format!("Unapproved compatibility artifact: {}", actual.file_name));
        }
    }
    Ok(())
}

fn commit_bundle(
    staged: &Path,
    target: &Path,
    backup: &Path,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let had_previous = target.exists();
    if had_previous {
        rename(target, backup).map_err(|err| format!("Could not preserve previous JDBC runtime: {err}"))?;
    }
    if let Err(error) = rename(staged, target) {
        if had_previous {
            if let Err(restore) = rename(backup, target) {
                return Err(format!(
                    "JDBC runtime install failed: {error}; restore failed: {restore}. Previous runtime preserved at {}",
                    backup.display()
                ));
            }
        }
        return Err(format!("Could not install JDBC compatibility runtime: {error}"));
    }
    if had_previous {
        std::fs::remove_dir_all(backup).map_err(|err| {
            format!("Runtime installed, but previous backup could not be removed at {}: {err}", backup.display())
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn plugin(root: &Path) {
        let dir = root.join("jdbc");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": "jdbc", "name": "JDBC", "version": "1.0.0", "protocol_version": 1,
                "executable": "bin/dbx-jdbc-plugin", "drivers": [],
                "capabilities": [{"id": REQUIRED_PLUGIN_CAPABILITY, "label": "External JDBC classpath isolation", "kind": "runtime"}]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn fixture(
        directory: &Path,
        change_manifest: impl FnOnce(&mut serde_json::Value),
        extra: Option<(&str, &[u8])>,
        omit_jar: bool,
    ) -> (PathBuf, Runtime) {
        let coordinate = "app.dbx.compat:test:1";
        let id = maven_bundle_id(coordinate);
        let content = b"test-driver-bytes";
        let artifact_hash = format!("{:x}", Sha256::digest(content));
        let mut bundle = serde_json::json!({
            "id":id, "coordinate":coordinate,"scope":"runtime", "repositories":[],
            "installed_at":"", "path":"", "artifacts":[{
                "group_id":"app.dbx.compat", "artifact_id":"test", "version":"1", "classifier":"",
                "extension":"jar", "file_name":"test.jar", "path":"", "size":content.len(), "sha256":artifact_hash,
            }]
        });
        change_manifest(&mut bundle);
        let package = directory.join(format!("package-{}.zip", uuid::Uuid::new_v4()));
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&package).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file("compatibility.json", options).unwrap();
        zip.write_all(
            serde_json::to_string(&serde_json::json!({
                "format_version":1,"id":"test","version":"1","bundles":[{"id":id,"coordinate":coordinate}]
            }))
            .unwrap()
            .as_bytes(),
        )
        .unwrap();
        zip.start_file(format!("jdbc/maven/{id}/manifest.json"), options).unwrap();
        zip.write_all(serde_json::to_string(&bundle).unwrap().as_bytes()).unwrap();
        if !omit_jar {
            zip.start_file(format!("jdbc/maven/{id}/jars/test.jar"), options).unwrap();
            zip.write_all(content).unwrap();
        }
        if let Some((name, bytes)) = extra {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        let runtime = Runtime {
            id: "test".into(),
            version: "1".into(),
            url: "https://github.com/t8y2/dbx/releases/download/test/test.zip".into(),
            size: std::fs::metadata(&package).unwrap().len(),
            sha256: file_sha256(&package).unwrap(),
            coordinate: coordinate.into(),
            artifacts: vec![Artifact {
                file_name: "test.jar".into(),
                size: content.len() as u64,
                sha256: artifact_hash,
            }],
        };
        (package, runtime)
    }

    #[test]
    fn compatibility_catalog_is_pinned_and_rejects_unknown_ids() {
        assert!(runtime_for_id(CATALOG, "phoenix-5.0-hbase-2.0-compat").is_ok());
        assert!(runtime_for_id(CATALOG, "caller-supplied-url").unwrap_err().contains("Unknown"));
        let modified = CATALOG.replace("https://github.com/t8y2/dbx", "https://example.com/evil");
        assert!(runtime_for_id(&modified, "phoenix-5.0-hbase-2.0-compat").is_err());
    }

    #[test]
    fn compatibility_install_is_offline_preserves_plugin_and_other_bundles() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        plugin(&root);
        let plugin_before = std::fs::read(root.join("jdbc/manifest.json")).unwrap();
        let unrelated = jdbc_maven_drivers_dir(&root).join("other");
        std::fs::create_dir_all(&unrelated).unwrap();
        std::fs::write(unrelated.join("keep.txt"), b"keep").unwrap();
        let (package, runtime) = fixture(temp.path(), |_| {}, None, false);
        let drivers = install_package(&root, &package, &runtime).unwrap();
        assert!(drivers.iter().any(|driver| driver.name == "test.jar"));
        let bundles = list_jdbc_maven_bundles(&root).unwrap();
        let installed = bundles.iter().find(|bundle| bundle.coordinate == runtime.coordinate).unwrap();
        assert!(Path::new(&installed.artifacts[0].path).exists());
        assert!(installed.artifacts[0].path.starts_with(installed.path.as_str()));
        install_package(&root, &package, &runtime).unwrap();
        assert_eq!(std::fs::read(root.join("jdbc/manifest.json")).unwrap(), plugin_before);
        delete_jdbc_maven_bundle(&root, &maven_bundle_id(&runtime.coordinate)).unwrap();
        assert!(unrelated.join("keep.txt").exists());
    }

    #[test]
    fn compatibility_requires_exact_plugin_capability_without_mutating_existing_installation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        plugin(&root);
        let (package, runtime) = fixture(temp.path(), |_| {}, None, false);
        install_package(&root, &package, &runtime).unwrap();
        let installed = jdbc_maven_drivers_dir(&root).join(maven_bundle_id(&runtime.coordinate));
        let bundle_before = std::fs::read(installed.join("manifest.json")).unwrap();
        let jar_before = std::fs::read(installed.join("jars/test.jar")).unwrap();
        let manifest_path = root.join("jdbc/manifest.json");
        let capable: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        for capabilities in [
            None,
            Some(serde_json::json!([])),
            Some(serde_json::json!([
                {"id":"jdbc.external-classpath-isolation-v2","label":"Unrelated capability"}
            ])),
        ] {
            let mut legacy = capable.clone();
            legacy.as_object_mut().unwrap().remove("capabilities");
            if let Some(capabilities) = capabilities {
                legacy["capabilities"] = capabilities;
            }
            let plugin_before = serde_json::to_vec(&legacy).unwrap();
            std::fs::write(&manifest_path, &plugin_before).unwrap();
            assert!(jdbc_plugin_status_from_dir_local(&root.join("jdbc")).unwrap().compatible);
            assert!(install_package(&root, &package, &runtime).unwrap_err().contains("external classpath isolation"));
            assert_eq!(std::fs::read(&manifest_path).unwrap(), plugin_before);
            assert_eq!(std::fs::read(installed.join("manifest.json")).unwrap(), bundle_before);
            assert_eq!(std::fs::read(installed.join("jars/test.jar")).unwrap(), jar_before);
        }
        let mut incompatible = capable;
        incompatible["protocol_version"] = (SUPPORTED_PLUGIN_PROTOCOL_VERSION + 1).into();
        std::fs::write(&manifest_path, serde_json::to_vec(&incompatible).unwrap()).unwrap();
        assert!(install_package(&root, &package, &runtime).unwrap_err().contains("compatible DBX JDBC plugin"));
        assert_eq!(std::fs::read(installed.join("jars/test.jar")).unwrap(), jar_before);
    }

    #[tokio::test]
    async fn compatibility_rejects_legacy_plugin_before_download_or_local_package_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        plugin(&root);
        let manifest_path = root.join("jdbc/manifest.json");
        let mut legacy: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        legacy.as_object_mut().unwrap().remove("capabilities");
        let before = serde_json::to_vec(&legacy).unwrap();
        std::fs::write(&manifest_path, &before).unwrap();
        let id = "phoenix-5.0-hbase-2.0-compat";
        let error = install_jdbc_compatibility_runtime(&root, id).await.unwrap_err();
        assert!(error.contains("external classpath isolation"));
        let missing = temp.path().join("missing.zip");
        let error =
            install_jdbc_compatibility_runtime_from_file(&root, id, missing.to_str().unwrap()).await.unwrap_err();
        assert!(error.contains("external classpath isolation"));
        assert_eq!(std::fs::read(&manifest_path).unwrap(), before);
        assert!(!jdbc_maven_drivers_dir(&root).exists());
        assert_eq!(std::fs::read_dir(root.join("jdbc")).unwrap().count(), 1);
    }

    #[test]
    fn compatibility_accepts_release_provenance_layout_and_hides_preserved_backups() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        plugin(&root);
        let (package, runtime) = fixture(temp.path(), |_| {}, Some(("provenance.json", b"{}")), false);
        install_package(&root, &package, &runtime).unwrap();
        let target = jdbc_maven_drivers_dir(&root).join(maven_bundle_id(&runtime.coordinate));
        let staged = root.join("jdbc/staged");
        std::fs::create_dir(&staged).unwrap();
        let backup = root.join("jdbc/.compat-backup-test");
        let mut count = 0;
        let error = commit_bundle(&staged, &target, &backup, |from, to| {
            count += 1;
            if count > 1 {
                return Err(std::io::Error::other("simulated restore failure"));
            }
            std::fs::rename(from, to)
        })
        .unwrap_err();
        assert!(error.contains("Previous runtime preserved"));
        assert!(backup.join("manifest.json").exists());
        assert!(list_jdbc_maven_bundles(&root).unwrap().is_empty());
        assert!(list_jdbc_drivers(&root).unwrap().is_empty());
    }

    #[tokio::test]
    #[ignore = "requires the reviewed release ZIP via DBX_TEST_COMPATIBILITY_PACKAGE"]
    async fn compatibility_installs_reviewed_release_package() {
        let package = std::env::var("DBX_TEST_COMPATIBILITY_PACKAGE").expect("reviewed release ZIP path");
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        plugin(&root);
        let before = std::fs::read(root.join("jdbc/manifest.json")).unwrap();
        let id = "phoenix-5.0-hbase-2.0-compat";
        let runtime = runtime_for_id(CATALOG, id).unwrap();
        let drivers = install_jdbc_compatibility_runtime_from_file(&root, id, &package).await.unwrap();
        assert_eq!(drivers.len(), runtime.artifacts.len());
        for artifact in &runtime.artifacts {
            let driver = drivers.iter().find(|driver| driver.name == artifact.file_name).unwrap();
            assert_eq!(file_sha256(Path::new(&driver.path)).unwrap(), artifact.sha256);
        }
        assert_eq!(std::fs::read(root.join("jdbc/manifest.json")).unwrap(), before);
        let bundles = list_jdbc_maven_bundles(&root).unwrap();
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].coordinate, runtime.coordinate);
        // Real file deletion leaves the stored manifest intact. Listing must
        // still stop advertising this runtime as installed to the frontend.
        delete_jdbc_driver(&root, &drivers[0].path).unwrap();
        assert!(list_jdbc_maven_bundles(&root).unwrap().is_empty());
        delete_jdbc_maven_bundle(&root, &maven_bundle_id(&runtime.coordinate)).unwrap();
        assert!(list_jdbc_drivers(&root).unwrap().is_empty());
    }

    #[test]
    fn compatibility_listing_rejects_missing_files_and_stale_paths() {
        let temp = tempfile::tempdir().unwrap();
        let maven = jdbc_maven_drivers_dir(temp.path());
        let runtime = runtime_for_id(CATALOG, "phoenix-5.0-hbase-2.0-compat").unwrap();
        let id = maven_bundle_id(&runtime.coordinate);
        let dir = maven.join(&id);
        std::fs::create_dir_all(dir.join("jars")).unwrap();
        let artifacts: Vec<_> = runtime.artifacts.iter().map(|artifact| {
            let path = dir.join("jars").join(&artifact.file_name);
            // Sparse files exercise size/existence without copying release bytes.
            std::fs::File::create(&path).unwrap().set_len(artifact.size).unwrap();
            serde_json::json!({"group_id":"fixture","artifact_id":"fixture","version":"1","classifier":"",
                "extension":"jar","file_name":artifact.file_name,"path":path,"size":artifact.size,"sha256":artifact.sha256})
        }).collect();
        let mut manifest = serde_json::json!({"id":id,"coordinate":runtime.coordinate,"scope":"runtime",
            "repositories":[],"installed_at":"","path":dir,"artifacts":artifacts});
        let path = dir.join("manifest.json");
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(list_jdbc_maven_bundles(temp.path()).unwrap().len(), 1);
        manifest["artifacts"][0]["path"] = "/other/location.jar".into();
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(list_jdbc_maven_bundles(temp.path()).unwrap().is_empty());
        manifest["artifacts"][0]["path"] = artifacts[0]["path"].clone();
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        std::fs::remove_file(dir.join("jars").join(&runtime.artifacts[0].file_name)).unwrap();
        assert!(list_jdbc_maven_bundles(temp.path()).unwrap().is_empty());
    }

    #[test]
    fn compatibility_rejects_untrusted_bytes_before_changing_installation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        plugin(&root);
        let (package, mut runtime) = fixture(temp.path(), |_| {}, None, false);
        install_package(&root, &package, &runtime).unwrap();
        let installed = jdbc_maven_drivers_dir(&root).join(maven_bundle_id(&runtime.coordinate)).join("jars/test.jar");
        let old = std::fs::read(&installed).unwrap();
        runtime.sha256 = "0".repeat(64);
        assert!(install_package(&root, &package, &runtime).unwrap_err().contains("checksum"));
        assert_eq!(std::fs::read(&installed).unwrap(), old);
        runtime.size += 1;
        assert!(install_package(&root, &package, &runtime).unwrap_err().contains("size"));
    }

    #[test]
    fn compatibility_rejects_manifest_drift_missing_jar_and_unsafe_entries() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        plugin(&root);
        let (package, runtime) =
            fixture(temp.path(), |bundle| bundle["artifacts"][0]["sha256"] = "0".repeat(64).into(), None, false);
        assert!(install_package(&root, &package, &runtime).unwrap_err().contains("Unapproved"));
        let (package, runtime) = fixture(temp.path(), |_| {}, None, true);
        assert!(install_package(&root, &package, &runtime).unwrap_err().contains("not found"));
        for entry in ["../escape", "a\\escape", "/absolute", "jdbc/plugin.zip", "C:escape"] {
            let (package, runtime) = fixture(temp.path(), |_| {}, Some((entry, b"x")), false);
            assert!(install_package(&root, &package, &runtime).is_err(), "{entry}");
        }
        assert!(list_jdbc_maven_bundles(&root).unwrap().is_empty());
    }

    #[test]
    fn compatibility_requires_plugin_and_preserves_backup_on_failed_restore() {
        let temp = tempfile::tempdir().unwrap();
        let (package, runtime) = fixture(temp.path(), |_| {}, None, false);
        assert!(install_package(&temp.path().join("missing"), &package, &runtime)
            .unwrap_err()
            .contains("compatible DBX JDBC plugin"));
        let staged = temp.path().join("staged");
        let target = temp.path().join("target");
        let backup = temp.path().join("backup");
        std::fs::create_dir(&staged).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("old"), b"original").unwrap();
        let mut count = 0;
        let error = commit_bundle(&staged, &target, &backup, |from, to| {
            count += 1;
            if count == 2 {
                return Err(std::io::Error::other("simulated commit failure"));
            }
            std::fs::rename(from, to)
        })
        .unwrap_err();
        assert!(error.contains("Could not install"));
        assert!(target.join("old").exists());
        let mut count = 0;
        let error = commit_bundle(&staged, &target, &backup, |from, to| {
            count += 1;
            if count > 1 {
                return Err(std::io::Error::other("simulated restore failure"));
            }
            std::fs::rename(from, to)
        })
        .unwrap_err();
        assert!(error.contains("Previous runtime preserved"));
        assert_eq!(std::fs::read(backup.join("old")).unwrap(), b"original");
    }

    #[test]
    fn compatibility_installs_multiple_pinned_artifacts() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        plugin(&root);
        let second = b"dependency";
        let sha = format!("{:x}", Sha256::digest(second));
        let entry = format!("jdbc/maven/{}/jars/dependency.jar", maven_bundle_id("app.dbx.compat:test:1"));
        let (package, mut runtime) = fixture(
            temp.path(),
            |bundle| {
                let mut artifact = bundle["artifacts"][0].clone();
                artifact["file_name"] = "dependency.jar".into();
                artifact["size"] = second.len().into();
                artifact["sha256"] = sha.clone().into();
                bundle["artifacts"].as_array_mut().unwrap().push(artifact);
            },
            Some((&entry, second)),
            false,
        );
        runtime.artifacts.push(Artifact { file_name: "dependency.jar".into(), size: second.len() as u64, sha256: sha });
        let drivers = install_package(&root, &package, &runtime).unwrap();
        assert_eq!(drivers.len(), 2);
        assert!(drivers.iter().all(|driver| Path::new(&driver.path).exists()));
    }

    #[test]
    fn compatibility_rejects_duplicate_and_symlink_zip_entries() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        plugin(&root);
        let (package, mut runtime) = fixture(temp.path(), |_| {}, Some(("compatibilitx.json", b"duplicate")), false);
        // ZIP writer disallows duplicates; replace the equal-length local and central names.
        let raw = std::fs::read(&package).unwrap();
        let mut changed = raw.clone();
        for offset in 0..raw.len() - b"compatibilitx.json".len() {
            if raw[offset..].starts_with(b"compatibilitx.json") {
                changed[offset..offset + b"compatibility.json".len()].copy_from_slice(b"compatibility.json");
            }
        }
        std::fs::write(&package, changed).unwrap();
        runtime.sha256 = file_sha256(&package).unwrap();
        assert!(install_package(&root, &package, &runtime).unwrap_err().contains("duplicate"));
        let (package, mut runtime) = fixture(temp.path(), |_| {}, None, false);
        let file = std::fs::OpenOptions::new().read(true).write(true).open(&package).unwrap();
        let mut writer = zip::ZipWriter::new_append(file).unwrap();
        writer.add_symlink("provenance/link", "../../escape", zip::write::SimpleFileOptions::default()).unwrap();
        writer.finish().unwrap();
        runtime.size = std::fs::metadata(&package).unwrap().len();
        runtime.sha256 = file_sha256(&package).unwrap();
        assert!(install_package(&root, &package, &runtime).unwrap_err().contains("Unsafe"));
    }

    #[test]
    fn compatibility_bundle_lock_serializes_mutations() {
        let temp = tempfile::tempdir().unwrap();
        let first = lock_bundle(temp.path(), "bundle").unwrap();
        let second = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(temp.path().join("jdbc/bundle-locks/bundle.lock"))
            .unwrap();
        assert!(fs2::FileExt::try_lock_exclusive(&second).is_err());
        drop(first);
        fs2::FileExt::try_lock_exclusive(&second).unwrap();
        assert!(lock_bundle(temp.path(), "..").is_err());
    }
}
