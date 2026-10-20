use std::sync::Mutex;
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use sysinfo::{Pid, ProcessesToUpdate, System};

#[derive(Clone, Default)]
pub struct WorkerRegistry(Arc<Mutex<RegistryState>>);
#[derive(Default)]
struct RegistryState {
    active: Vec<(String, Arc<AtomicBool>)>,
    cancelled: std::collections::VecDeque<(String, Instant)>,
}
pub struct WorkerPermit {
    registry: WorkerRegistry,
    id: String,
    cancelled: Arc<AtomicBool>,
}
impl WorkerPermit {
    pub fn cancellation(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }
}
impl Drop for WorkerPermit {
    fn drop(&mut self) {
        if let Ok(mut state) = self.registry.0.lock() {
            state.active.retain(|(id, _)| id != &self.id);
        }
    }
}
impl WorkerRegistry {
    pub fn admit(&self, id: &str) -> Result<WorkerPermit, String> {
        if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err("invalid binlog request identity".into());
        }
        let mut state = self.0.lock().map_err(|_| "binlog registry unavailable")?;
        state.cancelled.retain(|(_, time)| time.elapsed() < Duration::from_secs(120));
        if state.cancelled.iter().any(|(cancelled, _)| cancelled == id) {
            return Err("binlog operation cancelled before admission".into());
        }
        if !state.active.is_empty() {
            return Err("another binlog operation is still running".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        state.active.push((id.to_owned(), cancelled.clone()));
        Ok(WorkerPermit { registry: self.clone(), id: id.to_owned(), cancelled })
    }
    pub fn cancel(&self, id: &str) -> bool {
        if id.is_empty() || id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return false;
        }
        if let Ok(mut state) = self.0.lock() {
            if let Some((_, cancelled)) = state.active.iter().find(|(active, _)| active == id) {
                cancelled.store(true, Ordering::Release);
            }
            // Cancellation can arrive before Tauri first polls the async command.
            state.cancelled.retain(|(cancelled, time)| cancelled != id && time.elapsed() < Duration::from_secs(120));
            if state.cancelled.len() >= 128 {
                state.cancelled.pop_front();
            }
            state.cancelled.push_back((id.to_owned(), Instant::now()));
            return true;
        }
        false
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;
    #[test]
    fn cancel_before_admission_prevents_the_worker_and_does_not_block_other_ids() {
        let registry = WorkerRegistry::default();
        assert!(registry.cancel("cancelled-id"));
        assert!(registry.admit("cancelled-id").err().unwrap().contains("cancelled"));
        let permit = registry.admit("next-id").unwrap();
        assert!(!permit.cancellation().load(Ordering::Acquire));
        assert!(registry.admit("other-id").is_err());
        assert!(registry.cancel("next-id"));
        assert!(permit.cancellation().load(Ordering::Acquire));
        drop(permit);
        assert!(registry.admit("next-id").is_err());
        assert!(registry.admit("other-id").is_ok());
    }
}

pub struct WorkerLimits {
    pub timeout: Duration,
    pub max_memory_bytes: u64,
    pub max_output_bytes: usize,
    pub cancelled: Option<Arc<AtomicBool>>,
}

pub fn export_sql(path: &std::path::Path, sql: &str) -> Result<(), String> {
    if sql.is_empty() || sql.len() > crate::worker::MAX_RESPONSE_BYTES {
        return Err("invalid SQL export size".into());
    }
    if !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("sql")) {
        return Err("choose a new .sql file for export".into());
    }
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(sql.as_bytes()).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    // Never replace an existing file, including a source, previous export or symlink.
    file.persist_noclobber(path).map_err(|e| format!("cannot export; choose a new .sql file: {}", e.error))?;
    Ok(())
}

#[cfg(test)]
mod export_tests {
    use super::*;
    #[test]
    fn export_is_private_and_never_replaces_an_existing_source_or_output() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("new.sql");
        export_sql(&path, "SELECT 1;").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "SELECT 1;");
        assert!(export_sql(&path, "OVERWRITE").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "SELECT 1;");
        assert!(export_sql(&directory.path().join("input.binlog"), "x").is_err());
        assert!(export_sql(&directory.path().join("empty.sql"), "").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            let link = directory.path().join("link.sql");
            symlink(&path, &link).unwrap();
            assert!(export_sql(&link, "WRONG").is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "SELECT 1;");
        }
    }
}

impl Default for WorkerLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(60),
            max_memory_bytes: 512 * 1024 * 1024,
            max_output_bytes: crate::worker::MAX_RESPONSE_BYTES,
            cancelled: None,
        }
    }
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|s| s.is_none()) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn read_bounded(reader: impl Read, limit: usize, overflow: Arc<AtomicBool>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader.take(limit.saturating_add(1) as u64).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        overflow.store(true, Ordering::Release);
    }
    Ok(bytes)
}

pub fn run_worker(mut command: Command, request: &[u8], limits: WorkerLimits) -> Result<String, String> {
    if request.len() > crate::worker::MAX_REQUEST_BYTES {
        return Err("worker request exceeds 64 KiB".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = OwnedChild(command.spawn().map_err(|e| e.to_string())?);
    let mut stdin = child.0.stdin.take().ok_or("worker stdin unavailable")?;
    let stdout = child.0.stdout.take().ok_or("worker stdout unavailable")?;
    let stderr = child.0.stderr.take().ok_or("worker stderr unavailable")?;
    let request = request.to_vec();
    let writer = thread::spawn(move || stdin.write_all(&request));
    let overflow = Arc::new(AtomicBool::new(false));
    let out_flag = overflow.clone();
    let out_limit = limits.max_output_bytes.min(crate::worker::MAX_RESPONSE_BYTES);
    let stdout = thread::spawn(move || read_bounded(stdout, out_limit, out_flag));
    let err_flag = overflow.clone();
    let stderr = thread::spawn(move || read_bounded(stderr, 64 * 1024, err_flag));
    let start = Instant::now();
    let pid = Pid::from_u32(child.0.id());
    let mut system = System::new();
    let outcome = loop {
        if limits.cancelled.as_ref().is_some_and(|c| c.load(Ordering::Acquire)) {
            break Err("binlog operation cancelled".to_owned());
        }
        if overflow.load(Ordering::Acquire) {
            break Err("binlog worker output limit exceeded".to_owned());
        }
        if start.elapsed() >= limits.timeout {
            break Err("binlog worker timed out".to_owned());
        }
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        if system.process(pid).is_some_and(|p| p.memory() > limits.max_memory_bytes) {
            break Err("binlog worker memory limit exceeded".to_owned());
        }
        match child.0.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => break Err(error.to_string()),
        }
    };
    if outcome.is_err() {
        let _ = child.0.kill();
    }
    let _ = child.0.wait();
    let written = writer.join().map_err(|_| "worker writer panicked")?;
    let out = stdout.join().map_err(|_| "worker reader panicked")??;
    let err = stderr.join().map_err(|_| "worker error reader panicked")??;
    let status = outcome?;
    if overflow.load(Ordering::Acquire) {
        return Err("binlog worker output limit exceeded".into());
    }
    if !status.success() {
        return Err(format!("binlog worker failed: {}", String::from_utf8_lossy(&err)));
    }
    written.map_err(|e| format!("cannot send worker request: {e}"))?;
    let output = String::from_utf8(out).map_err(|_| "invalid worker response encoding")?;
    serde_json::from_str::<serde_json::Value>(&output).map_err(|_| "invalid worker JSON response")?;
    Ok(output)
}
