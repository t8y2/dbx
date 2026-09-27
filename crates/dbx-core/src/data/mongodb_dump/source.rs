use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use super::{
    archive, catalog, directory, ordered_entries, select_entries, MongoDatabaseRestoreRequest, MongoDumpFormat,
    MongoRestoreSourcePreview, MongoRestoreSourceRequest, PreparedCollection,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDumpFile {
    pub path: String,
    pub size_bytes: u64,
}

pub(super) struct CatalogSource {
    _owner: Option<tempfile::TempDir>,
    request: MongoRestoreSourceRequest,
    pub entries: Vec<PreparedCollection>,
    identities: HashMap<PathBuf, (u64, Option<SystemTime>)>,
    manifest: Option<Vec<MongoDumpFile>>,
    created: Instant,
}

static SOURCES: OnceLock<Mutex<HashMap<String, Arc<CatalogSource>>>> = OnceLock::new();
fn sources() -> &'static Mutex<HashMap<String, Arc<CatalogSource>>> {
    SOURCES.get_or_init(Default::default)
}

pub(super) fn get(reference: &str) -> Result<Arc<CatalogSource>, String> {
    let source = sources()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(reference)
        .cloned()
        .ok_or("Restore source is no longer available")?;
    if source.created.elapsed() >= Duration::from_secs(86400) {
        return Err("Restore source has expired".into());
    }
    Ok(source)
}

pub(super) fn release(reference: &str) -> bool {
    sources().lock().unwrap_or_else(|e| e.into_inner()).remove(reference).is_some()
}

pub(super) fn relative_path(value: &str) -> Result<&Path, String> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains(['\\', ':', '\0'])
        || path.components().count() > 4
        || path.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid dump upload path".into());
    }
    Ok(path)
}

fn identity(path: &Path) -> Result<(u64, Option<SystemTime>), String> {
    directory::regular_file(path)?;
    let info = std::fs::metadata(path).map_err(|e| e.to_string())?;
    Ok((info.len(), info.modified().ok()))
}

pub(super) async fn prepare(
    request: MongoRestoreSourceRequest,
    owner: Option<tempfile::TempDir>,
    manifest: Option<Vec<MongoDumpFile>>,
) -> Result<MongoRestoreSourcePreview, String> {
    tokio::task::spawn_blocking(move || {
        if manifest.as_ref().is_some_and(|m| m.len() > 100_000) {
            return Err("Too many dump files".into());
        }
        let path = Path::new(&request.path);
        let entries = match request.format {
            MongoDumpFormat::Directory => directory::inspect(path, request.gzip, manifest.as_deref())?,
            MongoDumpFormat::Archive => archive::inspect(&mut *directory::reader(path, request.gzip)?, || Ok(()))?,
        };
        ordered_entries(&entries)?;
        let mut catalog = catalog(&entries, false);
        let mut identities = HashMap::new();
        for (entry, preview) in entries.iter().zip(catalog.collections.iter_mut()) {
            for file in entry.path.iter().chain(entry.metadata_path.iter()) {
                if manifest.is_none() || entry.metadata_path.as_ref() == Some(file) {
                    identities.insert(file.clone(), identity(file)?);
                }
                if let Ok(relative) = file.strip_prefix(path) {
                    preview.source_files.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        if request.format == MongoDumpFormat::Archive {
            identities.insert(path.to_owned(), identity(path)?);
        }
        let source =
            Arc::new(CatalogSource { _owner: owner, request, entries, identities, manifest, created: Instant::now() });
        let mut sources = sources().lock().unwrap_or_else(|e| e.into_inner());
        sources.retain(|_, s| s.created.elapsed() < Duration::from_secs(86400));
        if sources.len() >= 32 {
            return Err("Too many prepared restores; close or release an existing source".into());
        }
        let source_ref = uuid::Uuid::new_v4().to_string();
        sources.insert(source_ref.clone(), source);
        Ok(MongoRestoreSourcePreview { source_ref, catalog })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn prepare_owned_mongodb_restore_source(
    request: MongoRestoreSourceRequest,
    owner: tempfile::TempDir,
) -> Result<MongoRestoreSourcePreview, String> {
    prepare(request, Some(owner), None).await
}

pub async fn prepare_mongodb_directory_catalog(
    owner: tempfile::TempDir,
    manifest: Vec<MongoDumpFile>,
    gzip: bool,
) -> Result<MongoRestoreSourcePreview, String> {
    let request = MongoRestoreSourceRequest {
        path: owner.path().to_string_lossy().into_owned(),
        format: MongoDumpFormat::Directory,
        gzip,
    };
    prepare(request, Some(owner), Some(manifest)).await
}

fn same_metadata(a: &PreparedCollection, b: &PreparedCollection) -> Result<bool, String> {
    Ok(a.database == b.database && a.metadata.to_json()? == b.metadata.to_json()? && a.size_bytes == b.size_bytes)
}

/// The server, not the upload payload, determines which files the confirmed selection requires.
pub fn mongodb_restore_upload_files(request: &MongoDatabaseRestoreRequest) -> Result<Vec<MongoDumpFile>, String> {
    let source = get(&request.source_ref)?;
    let manifest = source.manifest.as_ref().ok_or("Source does not require a directory upload")?;
    let paths = selected(&source, request)?
        .into_iter()
        .flat_map(|e| e.path.into_iter().chain(e.metadata_path))
        .collect::<Vec<_>>();
    Ok(manifest.iter().filter(|f| paths.contains(&Path::new(&source.request.path).join(&f.path))).cloned().collect())
}

/// Bind the complete selected upload to the reviewed catalog.
pub async fn attach_mongodb_restore_upload(
    request: &MongoDatabaseRestoreRequest,
    owner: tempfile::TempDir,
) -> Result<MongoRestoreSourcePreview, String> {
    let original = get(&request.source_ref)?;
    if original.manifest.is_none() {
        return Err("Source does not require a directory upload".into());
    }
    let selected = selected(&original, request)?;
    let next = prepare_owned_mongodb_restore_source(
        MongoRestoreSourceRequest {
            path: owner.path().to_string_lossy().into_owned(),
            format: MongoDumpFormat::Directory,
            gzip: original.request.gzip,
        },
        owner,
    )
    .await?;
    let uploaded = get(&next.source_ref)?;
    let matches =
        (|| -> Result<bool, String> {
            if selected.len() != uploaded.entries.len() {
                return Ok(false);
            }
            for entry in &selected {
                let Some(found) = uploaded.entries.iter().find(|e| {
                    e.database == entry.database && e.metadata.collection_name == entry.metadata.collection_name
                }) else {
                    return Ok(false);
                };
                if !same_metadata(entry, found)? {
                    return Ok(false);
                }
                let expected = entry
                    .path
                    .iter()
                    .chain(entry.metadata_path.iter())
                    .map(|p| p.strip_prefix(&original.request.path).unwrap().to_owned())
                    .collect::<Vec<_>>();
                let actual = found
                    .path
                    .iter()
                    .chain(found.metadata_path.iter())
                    .map(|p| p.strip_prefix(&uploaded.request.path).unwrap().to_owned())
                    .collect::<Vec<_>>();
                if expected != actual {
                    return Ok(false);
                }
            }
            Ok(true)
        })();
    if matches != Ok(true) {
        release(&next.source_ref);
        return Err("Uploaded files differ from the confirmed catalog; read the backup again".into());
    }
    Ok(next)
}

fn selected(source: &CatalogSource, request: &MongoDatabaseRestoreRequest) -> Result<Vec<PreparedCollection>, String> {
    let entries: Vec<_> = source.entries.iter().filter(|e| e.database == request.source_database).cloned().collect();
    select_entries(&entries, &request.collections)
}

fn unchanged(source: &CatalogSource, path: &Path) -> Result<(), String> {
    if source.identities.get(path) != Some(&identity(path)?) {
        return Err("Backup source changed; read the backup again".into());
    }
    Ok(())
}

impl CatalogSource {
    pub(super) fn format(&self) -> MongoDumpFormat {
        self.request.format
    }

    pub(super) fn check_ready(&self, entries: &[PreparedCollection]) -> Result<(), String> {
        if self.manifest.is_some() {
            return Err("Selected directory data has not been uploaded".into());
        }
        if self.request.format == MongoDumpFormat::Archive {
            unchanged(self, Path::new(&self.request.path))?;
        } else {
            for entry in entries {
                for path in entry.path.iter().chain(entry.metadata_path.iter()) {
                    unchanged(self, path)?;
                }
            }
        }
        Ok(())
    }

    pub(super) fn reader(&self, path: Option<&Path>) -> Result<Box<dyn Read>, String> {
        let path = path.unwrap_or_else(|| Path::new(&self.request.path));
        unchanged(self, path)?;
        directory::reader(path, self.request.gzip)
    }
}
