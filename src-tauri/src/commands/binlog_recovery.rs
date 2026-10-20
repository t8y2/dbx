use dbx_binlog::{
    host::{run_worker, WorkerLimits, WorkerRegistry},
    worker,
};
use std::{
    io::{Read, Write},
    sync::OnceLock,
};

static JOBS: OnceLock<WorkerRegistry> = OnceLock::new();

pub fn run_if_requested() -> bool {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new("--binlog-recovery-worker")) {
        return false;
    }
    let result = (|| -> Result<(), String> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .lock()
            .take((worker::MAX_REQUEST_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let output = worker::handle_worker_request(&bytes)?;
        std::io::stdout().lock().write_all(output.as_bytes()).map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        eprintln!("binlog worker failed: {error}");
        std::process::exit(1);
    }
    true
}

#[tauri::command]
pub async fn binlog_recovery_request(request_id: String, request: String) -> Result<String, String> {
    if request.len() > worker::MAX_REQUEST_BYTES {
        return Err("worker request exceeds 64 KiB".into());
    }
    let permit = JOBS.get_or_init(WorkerRegistry::default).admit(&request_id)?;
    let cancelled = permit.cancellation();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let mut command = std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command.arg("--binlog-recovery-worker");
        run_worker(command, request.as_bytes(), WorkerLimits { cancelled: Some(cancelled), ..Default::default() })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn binlog_recovery_cancel(request_id: String) -> bool {
    JOBS.get_or_init(WorkerRegistry::default).cancel(&request_id)
}

#[tauri::command]
pub async fn binlog_recovery_export(path: String, sql: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || dbx_binlog::host::export_sql(std::path::Path::new(&path), &sql))
        .await
        .map_err(|e| e.to_string())?
}
