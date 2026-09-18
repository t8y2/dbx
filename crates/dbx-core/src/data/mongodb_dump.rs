//! Database-scoped MongoDB dump/restore; transport adapters own dialogs and uploads.
mod archive;
mod directory;
mod metadata;
mod source;
mod stream;

pub use source::{
    attach_mongodb_restore_upload, mongodb_restore_upload_files, prepare_mongodb_directory_catalog,
    prepare_owned_mongodb_restore_source, MongoDumpFile,
};

use std::collections::{BTreeSet, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use futures::TryStreamExt;
use mongodb::bson::{doc, Document};
use serde::{Deserialize, Serialize};

use crate::connection::{AppState, PoolKind};
use crate::mongodb_import_export::{export_mongodb_query_core, MongoExportFormat, MongoExportRequest};
use metadata::CollectionMetadata;

type CancelFuture = Pin<Box<dyn Future<Output = bool> + Send>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MongoDumpFormat {
    Directory,
    Archive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDumpCollection {
    pub database: String,
    pub name: String,
    pub kind: String,
    pub documents: Option<u64>,
    pub size_bytes: u64,
    pub indexes: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDumpCatalog {
    pub databases: Vec<String>,
    pub collections: Vec<MongoDumpCollection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoRestoreSourceRequest {
    pub path: String,
    pub format: MongoDumpFormat,
    #[serde(default)]
    pub gzip: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoRestoreSourcePreview {
    pub source_ref: String,
    #[serde(flatten)]
    pub catalog: MongoDumpCatalog,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDatabaseDumpRequest {
    pub task_id: String,
    pub connection_id: String,
    pub database: String,
    pub file_path: String,
    pub format: MongoDumpFormat,
    #[serde(default)]
    pub gzip: bool,
    #[serde(default)]
    pub collections: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDatabaseRestoreRequest {
    pub task_id: String,
    pub connection_id: String,
    pub database: String,
    pub source_database: String,
    pub source_ref: String,
    #[serde(default)]
    pub collections: Option<Vec<String>>,
    #[serde(default)]
    pub drop_existing: bool,
    #[serde(default = "yes")]
    pub restore_options: bool,
    #[serde(default = "yes")]
    pub restore_indexes: bool,
    #[serde(default = "yes")]
    pub stop_on_error: bool,
    #[serde(default)]
    pub objcheck: bool,
    #[serde(default = "batch_size")]
    pub batch_size: usize,
    #[serde(default)]
    pub execution_id: Option<String>,
}
fn yes() -> bool {
    true
}
fn batch_size() -> usize {
    500
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoDatabaseDumpProgress {
    pub task_id: String,
    pub status: String,
    pub phase: String,
    pub collection: Option<String>,
    pub collections_done: usize,
    pub collections_total: usize,
    pub documents_read: u64,
    pub documents_written: u64,
    pub documents_failed: u64,
    pub indexes_created: usize,
    pub elapsed_ms: u128,
    pub error_message: Option<String>,
    pub file_path: Option<String>,
    #[serde(default)]
    pub bytes_processed: u64,
    #[serde(default)]
    pub documents_validated: u64,
}

impl MongoDatabaseDumpProgress {
    pub fn initial(task_id: &str) -> Self {
        Self {
            task_id: task_id.into(),
            status: "running".into(),
            phase: "preparing".into(),
            collection: None,
            collections_done: 0,
            collections_total: 0,
            documents_read: 0,
            documents_written: 0,
            documents_failed: 0,
            indexes_created: 0,
            elapsed_ms: 0,
            error_message: None,
            file_path: None,
            bytes_processed: 0,
            documents_validated: 0,
        }
    }
    fn emit(&mut self, started: Instant, callback: &mut impl FnMut(Self)) {
        self.elapsed_ms = started.elapsed().as_millis();
        callback(self.clone());
    }
}

#[derive(Clone)]
struct PreparedCollection {
    database: String,
    metadata: CollectionMetadata,
    path: Option<PathBuf>,
    documents: u64,
    size_bytes: u64,
    metadata_path: Option<PathBuf>,
}

pub fn release_mongodb_restore_source(source_ref: &str) -> bool {
    source::release(source_ref)
}

pub async fn prepare_mongodb_restore_source(
    request: MongoRestoreSourceRequest,
) -> Result<MongoRestoreSourcePreview, String> {
    source::prepare(request, None, None).await
}

fn catalog(entries: &[PreparedCollection], exact: bool) -> MongoDumpCatalog {
    MongoDumpCatalog {
        databases: entries.iter().map(|entry| entry.database.clone()).collect::<BTreeSet<_>>().into_iter().collect(),
        collections: entries
            .iter()
            .map(|entry| MongoDumpCollection {
                database: entry.database.clone(),
                name: entry.metadata.collection_name.clone(),
                kind: entry.metadata.kind.clone(),
                documents: if exact { Some(entry.documents) } else { None },
                size_bytes: entry.size_bytes,
                indexes: entry.metadata.restore_indexes().len(),
                source_files: Vec::new(),
            })
            .collect(),
    }
}

async fn native_client(state: &AppState, id: &str, database: &str) -> Result<mongodb::Client, String> {
    metadata::validate_database(database)?;
    state.get_or_create_pool(id, Some(database)).await?;
    match state.pool_handle(id).await {
        Some(PoolKind::MongoDb(client)) => Ok(client.clone()),
        _ => Err("Database dump/restore requires the native MongoDB driver".into()),
    }
}

async fn database_entries(client: &mongodb::Client, database: &str) -> Result<Vec<PreparedCollection>, String> {
    let db = client.database(database);
    let mut cursor = db.list_collections().await.map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    while let Some(spec) = cursor.try_next().await.map_err(|e| e.to_string())? {
        if spec.name.starts_with("system.") && spec.name != "system.js" {
            continue;
        }
        let mut metadata = CollectionMetadata::empty(&spec.name);
        metadata.kind =
            crate::db::mongo_driver::MongoCollectionKind::from_driver_type(&spec.collection_type).as_str().into();
        metadata.options = mongodb::bson::to_document(&spec.options).map_err(|e| e.to_string())?;
        metadata.validate()?;
        if !metadata.is_view() {
            let mut indexes = db.collection::<Document>(&spec.name).list_indexes().await.map_err(|e| e.to_string())?;
            while let Some(index) = indexes.try_next().await.map_err(|e| e.to_string())? {
                metadata.indexes.push(mongodb::bson::to_document(&index).map_err(|e| e.to_string())?);
            }
        }
        metadata.validate()?;
        entries.push(PreparedCollection {
            database: database.into(),
            metadata,
            path: None,
            documents: 0,
            size_bytes: 0,
            metadata_path: None,
        });
    }
    entries.sort_by(|a, b| a.metadata.collection_name.cmp(&b.metadata.collection_name));
    Ok(entries)
}

pub async fn inspect_mongodb_database_dump(
    state: &AppState,
    id: &str,
    database: &str,
) -> Result<MongoDumpCatalog, String> {
    let client = native_client(state, id, database).await?;
    let entries = database_entries(&client, database).await?;
    let mut catalog = catalog(&entries, false);
    catalog.databases = vec![database.into()];
    Ok(catalog)
}

fn select_entries(
    entries: &[PreparedCollection],
    selected: &Option<Vec<String>>,
) -> Result<Vec<PreparedCollection>, String> {
    match selected {
        None => Ok(entries.to_vec()),
        Some(names) => {
            let mut requested: HashSet<_> = names.iter().collect();
            let chosen =
                entries.iter().filter(|entry| requested.remove(&entry.metadata.collection_name)).cloned().collect();
            if !requested.is_empty() {
                return Err("A selected collection is not present in the dump plan".into());
            }
            Ok(chosen)
        }
    }
}

fn ordered_entries(entries: &[PreparedCollection]) -> Result<Vec<PreparedCollection>, String> {
    let names: HashMap<_, _> = entries
        .iter()
        .enumerate()
        .map(|(i, entry)| ((entry.database.clone(), entry.metadata.collection_name.clone()), i))
        .collect();
    let mut ordered = Vec::with_capacity(entries.len());
    // 0 = unseen, 1 = active dependency, 2 = emitted. Uploaded metadata may
    // contain arbitrarily deep chains, so keep the traversal off the call stack.
    let mut states = vec![0u8; entries.len()];
    for (i, entry) in entries.iter().enumerate().filter(|(_, e)| !e.metadata.is_view()) {
        states[i] = 2;
        ordered.push(entry.clone());
    }
    for i in 0..entries.len() {
        let mut pending = vec![(i, false)];
        while let Some((index, finish)) = pending.pop() {
            if finish {
                states[index] = 2;
                ordered.push(entries[index].clone());
                continue;
            }
            match states[index] {
                2 => continue,
                1 => return Err("Cyclic view dependencies in dump metadata".into()),
                _ => {}
            }
            states[index] = 1;
            pending.push((index, true));
            let entry = &entries[index];
            if let Ok(base) = entry.metadata.options.get_str("viewOn") {
                if let Some(&parent) = names.get(&(entry.database.clone(), base.into())) {
                    pending.push((parent, false));
                }
            }
        }
    }
    Ok(ordered)
}

fn cancelled(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::Relaxed) {
        Err("MongoDB dump/restore cancelled".into())
    } else {
        Ok(())
    }
}

async fn blocking_work<T: Send + 'static>(
    task_id: &str,
    is_cancelled: &mut impl FnMut(&str) -> CancelFuture,
    work: impl FnOnce(Arc<AtomicBool>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if is_cancelled(task_id).await {
        return Err("MongoDB dump/restore cancelled".into());
    }
    struct CancelOnDrop(Arc<AtomicBool>);
    impl Drop for CancelOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }
    let flag = Arc::new(AtomicBool::new(false));
    let _guard = CancelOnDrop(flag.clone());
    let signal = flag.clone();
    let mut task = tokio::task::spawn_blocking(move || work(signal));
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {
            result = &mut task => return result.map_err(|e| e.to_string())?,
            _ = interval.tick() => if is_cancelled(task_id).await { flag.store(true, Ordering::Relaxed); },
        }
    }
}

pub async fn dump_mongodb_database<C, F>(
    state: &AppState,
    request: &MongoDatabaseDumpRequest,
    mut is_cancelled: C,
    mut on_progress: F,
) -> Result<MongoDatabaseDumpProgress, String>
where
    C: FnMut(&str) -> CancelFuture,
    F: FnMut(MongoDatabaseDumpProgress),
{
    let started = Instant::now();
    let mut progress = MongoDatabaseDumpProgress::initial(&request.task_id);
    progress.emit(started, &mut on_progress);
    let result: Result<(), String> = async {
        if is_cancelled(&request.task_id).await {
            return Err("MongoDB dump/restore cancelled".into());
        }
        let client = native_client(state, &request.connection_id, &request.database).await?;
        let mut entries = select_entries(&database_entries(&client, &request.database).await?, &request.collections)?;
        progress.collections_total = entries.len();
        let target = PathBuf::from(&request.file_path);
        if target.exists() {
            return Err(match request.format {
                MongoDumpFormat::Directory => "Dump destination already exists; choose a new directory",
                MongoDumpFormat::Archive => "Dump destination already exists; choose a new archive file",
            }
            .into());
        }
        let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let working =
            tempfile::Builder::new().prefix(".dbx-mongo-dump-").tempdir_in(parent).map_err(|e| e.to_string())?;
        for (index, entry) in entries.iter_mut().enumerate() {
            if is_cancelled(&request.task_id).await {
                return Err("MongoDB dump/restore cancelled".into());
            }
            progress.collection = Some(entry.metadata.collection_name.clone());
            progress.phase = "data".into();
            progress.emit(started, &mut on_progress);
            if !entry.metadata.is_view() {
                let path = working.path().join(format!("{index}.bson"));
                let child = MongoExportRequest {
                    export_id: request.task_id.clone(),
                    connection_id: request.connection_id.clone(),
                    database: request.database.clone(),
                    collection: entry.metadata.collection_name.clone(),
                    filter: None,
                    sort: None,
                    projection: None,
                    collation: None,
                    format: MongoExportFormat::Bson,
                    include_header: false,
                    gzip: false,
                    file_path: path.to_string_lossy().into_owned(),
                    execution_id: None,
                };
                let base = progress.documents_read;
                let summary = export_mongodb_query_core(
                    state,
                    &child,
                    |id| is_cancelled(id),
                    |child| {
                        progress.documents_read = base + child.documents_read;
                        progress.emit(started, &mut on_progress);
                    },
                )
                .await?;
                entry.documents = summary.documents_exported;
                entry.size_bytes = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
                entry.path = Some(path);
            }
            progress.collections_done += 1;
        }
        progress.phase = "archive".into();
        progress.emit(started, &mut on_progress);
        let server_version = client
            .database(&request.database)
            .run_command(doc! { "buildInfo": 1 })
            .await
            .map_err(|e| e.to_string())?
            .get_str("version")
            .unwrap_or("")
            .to_string();
        let database = request.database.clone();
        let gzip = request.gzip;
        let format = request.format;
        blocking_work(&request.task_id, &mut is_cancelled, move |flag| {
            let _working = working;
            let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
            match format {
                MongoDumpFormat::Archive => {
                    let temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
                    directory::write_file(temp.path(), gzip, |writer| {
                        archive::pack(writer, &entries, &server_version, || cancelled(&flag))
                    })?;
                    cancelled(&flag)?;
                    if target.exists() {
                        return Err("Dump destination already exists".into());
                    }
                    temp.persist(&target).map_err(|e| e.to_string())?;
                }
                MongoDumpFormat::Directory => {
                    let output = tempfile::Builder::new()
                        .prefix(".dbx-dump-output-")
                        .tempdir_in(parent)
                        .map_err(|e| e.to_string())?;
                    directory::publish_files(output.path(), &database, &entries, gzip, || cancelled(&flag))?;
                    cancelled(&flag)?;
                    if target.exists() {
                        return Err("Dump destination already exists".into());
                    }
                    std::fs::rename(output.path(), &target).map_err(|e| e.to_string())?;
                }
            }
            Ok(())
        })
        .await?;
        progress.file_path = Some(request.file_path.clone());
        Ok(())
    }
    .await;
    finish_progress(progress, result, started, &mut on_progress)
}

pub async fn restore_mongodb_database<C, F>(
    state: &AppState,
    request: &MongoDatabaseRestoreRequest,
    mut is_cancelled: C,
    mut on_progress: F,
) -> Result<MongoDatabaseDumpProgress, String>
where
    C: FnMut(&str) -> CancelFuture,
    F: FnMut(MongoDatabaseDumpProgress),
{
    let started = Instant::now();
    let mut progress = MongoDatabaseDumpProgress::initial(&request.task_id);
    progress.emit(started, &mut on_progress);
    let result: Result<(), String> = async {
        if let Some(name) = crate::query::connection_readonly_name(state, &request.connection_id).await {
            return Err(format!("Read-only connection '{name}': restore blocked"));
        }
        if is_cancelled(&request.task_id).await {
            return Err("MongoDB dump/restore cancelled".into());
        }
        crate::mongodb_import_export::clamp_batch_size(request.batch_size).map_err(|e| e.display_message())?;
        let source = source::get(&request.source_ref)?;
        let source_entries: Vec<_> =
            source.entries.iter().filter(|entry| entry.database == request.source_database).cloned().collect();
        if source_entries.is_empty() && !source.entries.is_empty() {
            return Err("Source database is not present in the dump".into());
        }
        let entries = ordered_entries(&select_entries(&source_entries, &request.collections)?)?;
        progress.collections_total = entries.len();
        source.check_ready(&entries)?;
        let client = native_client(state, &request.connection_id, &request.database).await?;
        let db = client.database(&request.database);
        let existing = db
            .list_collections()
            .await
            .map_err(|e| e.to_string())?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| e.to_string())?;
        for entry in &entries {
            entry.metadata.validate()?;
            if let Some(target) = existing.iter().find(|target| target.name == entry.metadata.collection_name) {
                if !request.drop_existing
                    && (entry.metadata.is_view()
                        || !matches!(target.collection_type, mongodb::results::CollectionType::Collection))
                {
                    return Err(format!(
                        "{}: replacing an existing view or non-regular collection requires dropExisting",
                        target.name
                    ));
                }
            }
            if let Ok(base) = entry.metadata.options.get_str("viewOn") {
                if !entries.iter().any(|e| e.metadata.collection_name == base)
                    && !existing.iter().any(|e| e.name == base)
                {
                    return Err(format!(
                        "Missing backing collection for view {}: {base}",
                        entry.metadata.collection_name
                    ));
                }
            }
        }
        let existing_names = existing.iter().map(|e| e.name.clone()).collect::<HashSet<_>>();
        stream::restore_data(
            state,
            &client,
            request,
            source,
            &entries,
            &existing_names,
            &mut progress,
            started,
            &mut is_cancelled,
            &mut on_progress,
        )
        .await?;
        for entry in &entries {
            if is_cancelled(&request.task_id).await {
                return Err("MongoDB dump/restore cancelled".into());
            }
            stream::writable(state, &request.connection_id).await?;
            let name = &entry.metadata.collection_name;
            progress.collection = Some(name.clone());
            progress.phase = if entry.metadata.is_view() { "views" } else { "indexes" }.into();
            progress.emit(started, &mut on_progress);
            if entry.metadata.is_view() {
                stream::initialize_collection(&client, request, entry, existing_names.contains(name)).await?;
                progress.collections_done += 1;
            } else if request.restore_indexes {
                for index in entry.metadata.restore_indexes() {
                    if is_cancelled(&request.task_id).await {
                        return Err("MongoDB dump/restore cancelled".into());
                    }
                    db.run_command(doc! { "createIndexes": name, "indexes": [index] })
                        .await
                        .map_err(|e| e.to_string())?;
                    progress.indexes_created += 1;
                }
            }
        }
        Ok(())
    }
    .await;
    finish_progress(progress, result, started, &mut on_progress)
}

fn finish_progress(
    mut progress: MongoDatabaseDumpProgress,
    result: Result<(), String>,
    started: Instant,
    callback: &mut impl FnMut(MongoDatabaseDumpProgress),
) -> Result<MongoDatabaseDumpProgress, String> {
    progress.phase = "done".into();
    progress.status = match &result {
        Ok(()) => "done",
        Err(error)
            if matches!(error.as_str(), "MongoDB dump/restore cancelled" | "Import cancelled" | "Export cancelled") =>
        {
            "cancelled"
        }
        Err(_) => "error",
    }
    .into();
    progress.error_message = result.as_ref().err().cloned();
    progress.emit(started, callback);
    result.map(|_| progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_ordering_handles_deep_dependency_chains() {
        let count = 20_000;
        let entries = (0..count)
            .map(|index| {
                let mut metadata = CollectionMetadata::empty(&format!("view_{index}"));
                if index + 1 < count {
                    metadata.kind = "view".into();
                    metadata.options = doc! { "viewOn": format!("view_{}", index + 1), "pipeline": [] };
                }
                PreparedCollection {
                    database: "source".into(),
                    metadata,
                    path: None,
                    documents: 0,
                    size_bytes: 0,
                    metadata_path: None,
                }
            })
            .collect::<Vec<_>>();
        let ordered = ordered_entries(&entries).unwrap();
        assert_eq!(ordered.len(), count);
        for (entry, index) in ordered.iter().zip((0..count).rev()) {
            assert_eq!(entry.metadata.collection_name, format!("view_{index}"));
        }
    }
}
