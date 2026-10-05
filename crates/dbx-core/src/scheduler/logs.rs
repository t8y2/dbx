//! Run log store (ADR §5.3): JSONL files under
//! `scheduler/logs/YYYY/MM/DD/<run-id>/000001.log`, size-rotated into
//! numbered segments, indexed in `task_log_index` with the composite
//! `(run_id, segment)` key. Logs are persisted before any UI broadcast, so
//! they keep accumulating while no viewer is attached.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::TaskError;

/// Rotate a segment once it reaches ~32 MiB (ADR §3.2 / plan §16).
pub const ROTATION_BYTES: u64 = 32 * 1024 * 1024;

pub const LEVELS: [&str; 4] = ["debug", "info", "warn", "error"];
pub const STREAMS: [&str; 3] = ["stdout", "stderr", "system"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskLogEntry {
    pub seq: u64,
    pub timestamp: String,
    pub level: String,
    pub stream: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskLogQuery {
    pub after_seq: Option<u64>,
    pub limit: Option<u64>,
    pub level: Option<String>,
    pub stream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLogPage {
    pub entries: Vec<TaskLogEntry>,
    pub next_seq: u64,
    pub eof: bool,
}

/// Size/line bookkeeping of one log segment, persisted in `task_log_index`.
#[derive(Debug, Clone, PartialEq)]
pub struct LogSegmentStats {
    pub segment: u32,
    pub byte_size: u64,
    pub line_count: u64,
}

struct LoggerInner {
    directory: PathBuf,
    /// Owning task id, attached by the engine so broadcast `run-log` events
    /// carry the frozen ADR §7.4 `taskId` field. `None` when opened without
    /// task context (e.g. tooling); persistence is unaffected either way.
    task_id: Option<String>,
    file: Option<std::fs::File>,
    segment: u32,
    byte_size: u64,
    line_count: u64,
    next_seq: u64,
}

/// Single-run append-only JSONL logger. `seq` is allocated monotonically per
/// run starting at 1 and survives process restarts by scanning the existing
/// segments on open.
#[derive(Clone)]
pub struct TaskLogger {
    inner: std::sync::Arc<Mutex<LoggerInner>>,
}

impl std::fmt::Debug for TaskLogger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaskLogger").field("directory", &self.inner.lock().map(|l| l.directory.clone())).finish()
    }
}

impl TaskLogger {
    /// Opens (or resumes) the log directory of a run. Existing segments are
    /// scanned so reopening a run never restarts `seq` at 1.
    pub fn open(directory: PathBuf) -> Result<Self, TaskError> {
        Self::open_with_task(directory, None)
    }

    /// [`TaskLogger::open`] with the owning task id attached, so every
    /// appended line also broadcasts a `run-log` event (ADR §5.3: persist
    /// first, broadcast after) with the frozen §7.4 `taskId` field.
    pub fn open_with_task(directory: PathBuf, task_id: Option<String>) -> Result<Self, TaskError> {
        std::fs::create_dir_all(&directory)
            .map_err(|error| TaskError::unavailable(format!("Cannot create log directory: {error}")))?;
        let mut segment = 0u32;
        let mut byte_size = 0u64;
        let mut line_count = 0u64;
        let mut next_seq = 0u64;
        for entry in scan_segments(&directory)? {
            let path = segment_path(&directory, entry.segment);
            let (lines, max_seq) = scan_lines(&path)?;
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            segment = entry.segment;
            byte_size = size;
            line_count = lines;
            next_seq = next_seq.max(max_seq);
        }
        let mut logger = Self {
            inner: std::sync::Arc::new(Mutex::new(LoggerInner {
                directory,
                task_id,
                file: None,
                segment,
                byte_size,
                line_count,
                next_seq,
            })),
        };
        if segment > 0 {
            logger.open_segment(segment)?;
        }
        Ok(logger)
    }

    /// Appends one entry; returns its sequence number. Rotation happens when
    /// the current segment reaches `ROTATION_BYTES`.
    pub fn append(&mut self, level: &str, stream: &str, message: &str) -> Result<u64, TaskError> {
        let mut inner = self.inner.lock().map_err(|_| TaskError::unavailable("Task logger lock poisoned"))?;
        if inner.byte_size >= ROTATION_BYTES {
            inner.file = None;
            inner.byte_size = 0;
            inner.line_count = 0;
        }
        if inner.file.is_none() {
            let next_segment = inner.segment + 1;
            let path = segment_path(&inner.directory, next_segment);
            let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|error| {
                TaskError::unavailable(format!("Cannot open log segment {}: {error}", path.display()))
            })?;
            inner.file = Some(file);
            inner.segment = next_segment;
            inner.byte_size = 0;
            inner.line_count = 0;
        }
        let seq = inner.next_seq + 1;
        let entry = TaskLogEntry {
            seq,
            timestamp: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            level: level.to_owned(),
            stream: stream.to_owned(),
            message: message.to_owned(),
        };
        let mut line = serde_json::to_string(&entry)
            .map_err(|error| TaskError::internal(format!("Cannot encode log entry: {error}")))?;
        line.push('\n');
        let file = inner.file.as_mut().ok_or_else(|| TaskError::unavailable("Log segment not open"))?;
        file.write_all(line.as_bytes())
            .map_err(|error| TaskError::unavailable(format!("Cannot write log entry: {error}")))?;
        inner.next_seq = seq;
        inner.byte_size += line.len() as u64;
        inner.line_count += 1;
        // Persisted first (ADR §5.3); the event broadcast below is fire and
        // forget — log delivery must never depend on a consumer.
        let task_id = inner.task_id.clone();
        let run_id = inner.directory.file_name().and_then(|name| name.to_str()).map(str::to_owned);
        drop(inner);
        super::events::publish(serde_json::json!({
            "type": "run-log",
            "taskId": task_id,
            "runId": run_id,
            "seq": seq,
            "timestamp": entry.timestamp,
            "level": entry.level,
            "stream": entry.stream,
            "message": entry.message,
        }));
        Ok(seq)
    }

    /// Convenience wrapper for the system stream.
    pub fn system(&mut self, message: &str) -> Result<u64, TaskError> {
        self.append("info", "system", message)
    }

    pub fn next_seq(&self) -> u64 {
        self.inner.lock().map(|inner| inner.next_seq).unwrap_or(0)
    }

    /// Stats of the currently open segment, for `task_log_index` upkeep.
    pub fn stats(&self) -> Option<LogSegmentStats> {
        self.inner.lock().ok().and_then(|inner| {
            (inner.segment > 0).then(|| LogSegmentStats {
                segment: inner.segment,
                byte_size: inner.byte_size,
                line_count: inner.line_count,
            })
        })
    }

    fn open_segment(&mut self, segment: u32) -> Result<(), TaskError> {
        let mut inner = self.inner.lock().map_err(|_| TaskError::unavailable("Task logger lock poisoned"))?;
        let path = segment_path(&inner.directory, segment);
        inner.file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| TaskError::unavailable(format!("Cannot open log segment: {error}")))
            .ok();
        Ok(())
    }
}

pub(crate) fn segment_path(directory: &Path, segment: u32) -> PathBuf {
    directory.join(format!("{segment:06}.log"))
}

pub(crate) struct SegmentFile {
    pub segment: u32,
    pub path: PathBuf,
}

/// Lists the numbered segment files of a run directory in order.
pub(crate) fn scan_segments(directory: &Path) -> Result<Vec<SegmentFile>, TaskError> {
    let mut segments = Vec::new();
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(segments),
        Err(error) => return Err(TaskError::unavailable(format!("Cannot read log directory: {error}"))),
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Ok(segment) = u32::from_str_radix(name.trim_end_matches(".log"), 10) {
            if name.ends_with(".log") && name.len() == 10 && format!("{segment:06}.log") == name {
                segments.push(SegmentFile { segment, path: entry.path() });
            }
        }
    }
    segments.sort_by_key(|segment| segment.segment);
    Ok(segments)
}

/// Returns `(line_count, max_seq)` of a segment file. Corrupt lines are
/// skipped so one bad write cannot take down the whole history.
fn scan_lines(path: &Path) -> Result<(u64, u64), TaskError> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(error) => return Err(TaskError::unavailable(format!("Cannot read log segment: {error}"))),
    };
    let mut lines = 0u64;
    let mut max_seq = 0u64;
    for line in content.lines() {
        match serde_json::from_str::<TaskLogEntry>(line) {
            Ok(entry) => {
                lines += 1;
                max_seq = max_seq.max(entry.seq);
            }
            Err(_) if line.trim().is_empty() => {}
            Err(_) => {}
        }
    }
    Ok((lines, max_seq))
}

/// Reads a run's entries across all segments, honoring `after_seq`, `limit`,
/// `level` and `stream` filters (ADR §7.3 response shape).
pub fn read_run_logs(directory: &Path, query: &TaskLogQuery) -> Result<TaskLogPage, TaskError> {
    let after_seq = query.after_seq.unwrap_or(0);
    let limit = query.limit.unwrap_or(500).max(1);
    let mut entries = Vec::new();
    let mut eof = true;
    let mut highest_matched = after_seq;
    'segments: for segment in scan_segments(directory)? {
        let content = match std::fs::read_to_string(&segment.path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(TaskError::unavailable(format!("Cannot read log segment: {error}"))),
        };
        for line in content.lines() {
            let Ok(entry) = serde_json::from_str::<TaskLogEntry>(line) else { continue };
            if entry.seq <= after_seq {
                continue;
            }
            if let Some(level) = &query.level {
                if &entry.level != level {
                    continue;
                }
            }
            if let Some(stream) = &query.stream {
                if &entry.stream != stream {
                    continue;
                }
            }
            highest_matched = highest_matched.max(entry.seq);
            if entries.len() as u64 >= limit {
                eof = false;
                break 'segments;
            }
            entries.push(entry);
        }
    }
    let next_seq = entries.last().map(|entry| entry.seq).unwrap_or(highest_matched);
    Ok(TaskLogPage { entries, next_seq, eof })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_rotates_and_sequences_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let run_dir = dir.path().join("2026").join("10").join("05").join("run-1");
        let mut logger = TaskLogger::open(run_dir.clone()).unwrap();
        for index in 0..5 {
            logger.append("info", "stdout", &format!("line {index}")).unwrap();
        }
        assert_eq!(logger.next_seq(), 5);
        drop(logger);

        let mut resumed = TaskLogger::open(run_dir.clone()).unwrap();
        assert_eq!(resumed.next_seq(), 5);
        resumed.append("warn", "stderr", "after restart").unwrap();

        let page = read_run_logs(&run_dir, &TaskLogQuery::default()).unwrap();
        assert_eq!(page.entries.len(), 6);
        assert_eq!(page.entries[5].seq, 6);
        assert_eq!(page.entries[5].message, "after restart");
        assert!(page.eof);

        let tail = read_run_logs(&run_dir, &TaskLogQuery { after_seq: Some(4), ..Default::default() }).unwrap();
        assert_eq!(tail.entries.len(), 2);
        assert_eq!(tail.entries[0].seq, 5);

        let filtered =
            read_run_logs(&run_dir, &TaskLogQuery { level: Some("warn".into()), ..Default::default() }).unwrap();
        assert_eq!(filtered.entries.len(), 1);
        assert_eq!(filtered.entries[0].level, "warn");
    }

    #[test]
    fn read_handles_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let page = read_run_logs(&dir.path().join("missing"), &TaskLogQuery::default()).unwrap();
        assert!(page.entries.is_empty());
        assert!(page.eof);
    }

    #[test]
    fn appends_broadcast_run_log_events_with_task_and_run_ids() {
        use std::sync::{Arc, Mutex};

        let received: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&received);
        // The sink registry is process-global and tests run in parallel, so
        // filter for this test's unique run id before recording.
        super::super::events::register_event_sink(
            "logs-test",
            Arc::new(move |event| {
                if event["runId"] == "log-event-test-run" {
                    sink.lock().unwrap().push(event.clone());
                }
            }),
        );

        let dir = tempfile::tempdir().unwrap();
        let run_dir = dir.path().join("log-event-test-run");
        let mut logger = TaskLogger::open_with_task(run_dir, Some("task-1".into())).unwrap();
        logger.append("warn", "stderr", "hello").unwrap();

        let events = received.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "run-log");
        assert_eq!(events[0]["taskId"], "task-1");
        assert_eq!(events[0]["runId"], "log-event-test-run");
        assert_eq!(events[0]["seq"], 1);
        assert_eq!(events[0]["level"], "warn");
        assert_eq!(events[0]["stream"], "stderr");
        assert_eq!(events[0]["message"], "hello");
    }
}
