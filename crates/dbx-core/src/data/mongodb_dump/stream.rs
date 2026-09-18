use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use mongodb::bson::{Document, RawDocumentBuf};
use tokio::sync::mpsc;

use super::{
    archive, cancelled, source::CatalogSource, CancelFuture, MongoDatabaseDumpProgress, MongoDatabaseRestoreRequest,
    MongoDumpFormat, PreparedCollection,
};
use crate::{connection::AppState, db::mongo_driver::insert_bson_documents};

const BATCH_BYTES: usize = 8 * 1024 * 1024;

enum Event {
    Batch { index: usize, documents: Vec<RawDocumentBuf> },
    End(usize),
}

struct Batcher {
    tx: mpsc::Sender<Event>,
    index: usize,
    documents: Vec<RawDocumentBuf>,
    bytes: usize,
    limit: usize,
    objcheck: bool,
}

impl Batcher {
    fn flush(&mut self) -> Result<(), String> {
        if self.documents.is_empty() {
            return Ok(());
        }
        let documents = std::mem::take(&mut self.documents);
        self.bytes = 0;
        self.tx
            .blocking_send(Event::Batch { index: self.index, documents })
            .map_err(|_| "MongoDB dump/restore cancelled".into())
    }

    fn push(&mut self, index: usize, bytes: Vec<u8>) -> Result<(), String> {
        if index != self.index || self.bytes.saturating_add(bytes.len()) > BATCH_BYTES {
            self.flush()?;
        }
        self.index = index;
        let document = checked_document(bytes, self.objcheck)?;
        self.bytes += document.as_bytes().len();
        self.documents.push(document);
        if self.documents.len() >= self.limit {
            self.flush()?;
        }
        Ok(())
    }

    fn end(&mut self, index: usize) -> Result<(), String> {
        self.flush()?;
        self.tx.blocking_send(Event::End(index)).map_err(|_| "MongoDB dump/restore cancelled".into())
    }
}

// Like mongorestore's objcheck, deep parsing is optional and occurs in the stream,
// immediately before a document is queued for insertion. No whole-backup pass.
fn checked_document(bytes: Vec<u8>, objcheck: bool) -> Result<RawDocumentBuf, String> {
    let raw = RawDocumentBuf::from_bytes(bytes).map_err(|e| format!("Invalid BSON document: {e}"))?;
    if objcheck {
        mongodb::bson::from_slice::<Document>(raw.as_bytes()).map_err(|e| format!("Invalid BSON document: {e}"))?;
    }
    Ok(raw)
}

fn produce(
    source: Arc<CatalogSource>,
    entries: Vec<PreparedCollection>,
    flag: Arc<AtomicBool>,
    bytes_read: Arc<AtomicU64>,
    mut batcher: Batcher,
) -> Result<(), String> {
    let result = (|| {
        source.check_ready(&entries)?;
        if source.format() == MongoDumpFormat::Archive {
            let indices = source
                .entries
                .iter()
                .map(|original| {
                    entries.iter().position(|e| {
                        e.database == original.database
                            && e.metadata.collection_name == original.metadata.collection_name
                            && !e.metadata.is_view()
                    })
                })
                .collect::<Vec<_>>();
            archive::stream(
                &mut *source.reader(None)?,
                &source.entries,
                || cancelled(&flag),
                |event| {
                    match event {
                        archive::StreamEvent::Document(i, bytes) => {
                            bytes_read.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                            if let Some(index) = indices[i] {
                                batcher.push(index, bytes)?;
                            }
                        }
                        archive::StreamEvent::End(i) => {
                            if let Some(index) = indices[i] {
                                batcher.end(index)?;
                            }
                        }
                    }
                    Ok(())
                },
            )?;
        } else {
            for (index, entry) in entries.iter().enumerate().filter(|(_, e)| !e.metadata.is_view()) {
                cancelled(&flag)?;
                let path = entry.path.as_deref().ok_or("Missing collection BSON file")?;
                let mut reader = source.reader(Some(path))?;
                loop {
                    cancelled(&flag)?;
                    match archive::read_raw_frame(&mut *reader)? {
                        archive::Frame::End => break,
                        archive::Frame::Terminator => return Err("Unexpected terminator in collection BSON".into()),
                        archive::Frame::Document(bytes) => {
                            bytes_read.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                            batcher.push(index, bytes)?;
                        }
                    }
                }
                batcher.end(index)?;
            }
        }
        Ok(())
    })();
    // Deliver valid earlier documents even if a later frame is corrupt, matching
    // the streaming import contract and reporting partial writes accurately.
    let flushed = batcher.flush();
    result.and(flushed)
}

pub(super) async fn initialize_collection(
    client: &mongodb::Client,
    request: &MongoDatabaseRestoreRequest,
    entry: &PreparedCollection,
    exists: bool,
) -> Result<(), String> {
    let db = client.database(&request.database);
    if request.drop_existing && exists {
        db.collection::<Document>(&entry.metadata.collection_name).drop().await.map_err(|e| e.to_string())?;
    }
    if !exists || request.drop_existing {
        db.run_command(entry.metadata.create_command(request.restore_options)).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) async fn writable(state: &AppState, id: &str) -> Result<(), String> {
    if let Some(name) = crate::query::connection_readonly_name(state, id).await {
        return Err(format!("Read-only connection '{name}': restore blocked"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn restore_data(
    state: &AppState,
    client: &mongodb::Client,
    request: &MongoDatabaseRestoreRequest,
    source: Arc<CatalogSource>,
    entries: &[PreparedCollection],
    existing: &HashSet<String>,
    progress: &mut MongoDatabaseDumpProgress,
    started: Instant,
    is_cancelled: &mut impl FnMut(&str) -> CancelFuture,
    on_progress: &mut impl FnMut(MongoDatabaseDumpProgress),
) -> Result<(), String> {
    struct StopOnDrop(Arc<AtomicBool>);
    impl Drop for StopOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }
    let flag = Arc::new(AtomicBool::new(false));
    let _guard = StopOnDrop(flag.clone());
    let (tx, mut rx) = mpsc::channel(2);
    let batcher = Batcher {
        tx,
        index: 0,
        documents: Vec::new(),
        bytes: 0,
        limit: request.batch_size.max(1),
        objcheck: request.objcheck,
    };
    let producer_entries = entries.to_vec();
    let signal = flag.clone();
    let bytes_read = Arc::new(AtomicU64::new(0));
    let reader_progress = bytes_read.clone();
    let producer =
        tokio::task::spawn_blocking(move || produce(source, producer_entries, signal, reader_progress, batcher));
    progress.phase = "data".into();
    progress.emit(started, on_progress);
    let result = async {
        let mut initialized = HashSet::new();
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        loop {
            let event = tokio::select! {
                event = rx.recv() => match event { Some(event) => event, None => break },
                _ = tick.tick() => {
                    if is_cancelled(&request.task_id).await { return Err("MongoDB dump/restore cancelled".into()); }
                    progress.bytes_processed = bytes_read.load(Ordering::Relaxed);
                    progress.emit(started, on_progress);
                    continue;
                },
            };
            if is_cancelled(&request.task_id).await {
                return Err("MongoDB dump/restore cancelled".into());
            }
            writable(state, &request.connection_id).await?;
            let index = match &event {
                Event::Batch { index, .. } | Event::End(index) => *index,
            };
            let entry = &entries[index];
            progress.phase = "data".into();
            progress.collection = Some(entry.metadata.collection_name.clone());
            progress.emit(started, on_progress);
            if initialized.insert(index) {
                initialize_collection(client, request, entry, existing.contains(&entry.metadata.collection_name))
                    .await?;
            }
            match event {
                Event::Batch { documents, .. } => {
                    progress.documents_read += documents.len() as u64;
                    progress.bytes_processed = bytes_read.load(Ordering::Relaxed);
                    if request.objcheck {
                        progress.documents_validated += documents.len() as u64;
                    }
                    let outcome =
                        insert_bson_documents(client, &request.database, &entry.metadata.collection_name, documents)
                            .await
                            .map_err(|e| e.message)?;
                    progress.documents_written += outcome.inserted;
                    progress.documents_failed += outcome.errors.len() as u64;
                    progress.emit(started, on_progress);
                    if let Some(error) = outcome.errors.first().filter(|_| request.stop_on_error) {
                        return Err(error.message.clone());
                    }
                }
                Event::End(_) => {
                    progress.collections_done += 1;
                    progress.emit(started, on_progress);
                }
            }
        }
        Ok(())
    }
    .await;
    flag.store(true, Ordering::Relaxed);
    drop(rx);
    let produced = producer.await.map_err(|e| e.to_string()).and_then(|r| r);
    result.and(produced)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn objcheck_uses_official_bson_parser_only_when_enabled() {
        // Valid outer framing but invalid boolean payload.
        let bytes = vec![9, 0, 0, 0, 8, b'x', 0, 2, 0];
        assert!(checked_document(bytes.clone(), false).is_ok());
        assert!(checked_document(bytes, true).is_err());
        assert!(checked_document(vec![5, 0, 0, 0, 1], false).is_err());
    }

    #[test]
    fn raw_bson_preserves_duplicate_keys_and_exact_bytes() {
        let bytes = vec![19, 0, 0, 0, 16, b'x', 0, 1, 0, 0, 0, 16, b'x', 0, 2, 0, 0, 0, 0];
        for objcheck in [false, true] {
            let raw = checked_document(bytes.clone(), objcheck).unwrap();
            assert_eq!(raw.as_bytes(), bytes);
            assert_eq!(mongodb::bson::to_vec(&raw).unwrap(), bytes);
        }
    }

    #[tokio::test]
    async fn reader_delivers_earlier_batches_before_reporting_corruption() {
        use crate::mongodb_dump::{
            prepare_mongodb_restore_source, release_mongodb_restore_source, MongoRestoreSourceRequest,
        };
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("source");
        std::fs::create_dir(&db).unwrap();
        let mut bytes = mongodb::bson::to_vec(&mongodb::bson::doc! { "_id": 1 }).unwrap();
        bytes.extend_from_slice(b"invalid BSON");
        std::fs::write(db.join("records.bson"), bytes).unwrap();
        let preview = prepare_mongodb_restore_source(MongoRestoreSourceRequest {
            path: db.to_string_lossy().into_owned(),
            format: MongoDumpFormat::Directory,
            gzip: false,
        })
        .await
        .unwrap();
        let source = super::super::source::get(&preview.source_ref).unwrap();
        let entries = source.entries.clone();
        let (tx, mut rx) = mpsc::channel(1);
        let batcher = Batcher { tx, index: 0, documents: Vec::new(), bytes: 0, limit: 1, objcheck: false };
        let worker = tokio::task::spawn_blocking(move || {
            produce(source, entries, Arc::new(AtomicBool::new(false)), Arc::new(AtomicU64::new(0)), batcher)
        });
        assert!(matches!(rx.recv().await, Some(Event::Batch { documents, .. }) if documents.len() == 1));
        assert!(worker.await.unwrap().unwrap_err().contains("BSON"));
        assert!(rx.recv().await.is_none());
        release_mongodb_restore_source(&preview.source_ref);
    }

    #[test]
    fn batches_are_limited_by_bytes_as_well_as_document_count() {
        let bytes = mongodb::bson::to_vec(&mongodb::bson::doc! { "payload": "x".repeat(5 * 1024 * 1024) }).unwrap();
        let (tx, mut rx) = mpsc::channel(2);
        let mut batcher = Batcher { tx, index: 0, documents: Vec::new(), bytes: 0, limit: 500, objcheck: false };
        batcher.push(0, bytes.clone()).unwrap();
        batcher.push(0, bytes).unwrap();
        batcher.flush().unwrap();
        for _ in 0..2 {
            assert!(matches!(rx.try_recv().unwrap(), Event::Batch { documents, .. } if documents.len() == 1));
        }
    }

    #[test]
    #[ignore = "opt-in compressed BSON parser throughput smoke test"]
    fn compressed_bson_parser_throughput() {
        use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};
        use std::io::{BufReader, Cursor, Write};
        let mut document = Document::new();
        document.insert("_id", 1i64);
        for i in 0..64 {
            document.insert(format!("field_{i}"), "value".repeat(8));
        }
        let encoded = mongodb::bson::to_vec(&document).unwrap();
        let documents = 8192;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        for _ in 0..documents {
            encoder.write_all(&encoded).unwrap();
        }
        let compressed = encoder.finish().unwrap();
        for (mode, objcheck, passes) in
            [("raw-stream", false, 1), ("objcheck-stream", true, 1), ("old-double-parse", true, 2)]
        {
            let started = Instant::now();
            let mut count = 0;
            for _ in 0..passes {
                let mut input = BufReader::with_capacity(64 * 1024, MultiGzDecoder::new(Cursor::new(&compressed)));
                loop {
                    match archive::read_raw_frame(&mut input).unwrap() {
                        archive::Frame::Document(bytes) => {
                            checked_document(bytes, objcheck).unwrap();
                            count += 1;
                        }
                        archive::Frame::End => break,
                        _ => panic!("unexpected terminator"),
                    }
                }
            }
            assert_eq!(count, documents * passes);
            eprintln!(
                "{mode}: logical_mib={:.2}, elapsed_ms={}, logical_mib_s={:.2}",
                (documents * encoded.len()) as f64 / 1048576.0,
                started.elapsed().as_millis(),
                (documents * encoded.len()) as f64 / 1048576.0 / started.elapsed().as_secs_f64()
            );
        }
    }
}
